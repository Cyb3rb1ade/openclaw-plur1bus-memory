/**
 * engine/memory-ops/proposals.js — E2 Tasks 5 and 6 (spec decision D31):
 * `MemoryOps.propose` and `MemoryOps.proposals.{list, accept, reject}`.
 *
 * A shared (workspace/user) copy is changed directly only by the agent that
 * shared it (`Engine.memory.correct`, engine/memory-ops/write.js). Any other
 * agent who can read the copy instead files a change proposal here; the
 * sharer accepts (refreshing the copy with the proposal's text) or rejects it
 * later (Task 6). Filing never changes the shared copy itself; only the
 * sharer's `accept` does.
 */

import { randomUUID } from "node:crypto";
import { appendDestructiveOpLog, safeUuid } from "../../lib/sql-safety.js";
import { userPoolKey, workspacePoolKey } from "../../lib/memory-request-context.js";
import { emitEngineEvent } from "../events.js";
import { memoryOpError, isMemoryOpError } from "./errors.js";
import { isSharer, isLive } from "./shared.js";
import { MAX_CORRECT_TEXT_LENGTH } from "./write.js";

const MAX_NOTE_LENGTH = 500;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const PROPOSAL_STATUSES = new Set(["pending", "accepted", "rejected", "stale"]);

/**
 * The shared pools a principal can reach — the same keys lib/shared-memory-pool.js
 * leases for it: its workspace pool and, with a user principal, its user pool.
 * A proposal is visible and resolvable only through one of these (anti-oracle:
 * the same agent under another principal cannot reach another user's pool).
 * @param {{workspaceIdentity?: string, userPrincipal?: string}} memoryCtx
 * @returns {Set<string>}
 */
function reachablePoolKeys(memoryCtx) {
  const keys = new Set();
  if (memoryCtx?.workspaceIdentity) keys.add(workspacePoolKey(memoryCtx.workspaceIdentity));
  if (memoryCtx?.userPrincipal) keys.add(userPoolKey(memoryCtx.userPrincipal));
  return keys;
}

/** The pool a shared copy of this scope lives in, for this caller; "" when it has none. */
function poolKeyForScope(scope, memoryCtx) {
  if (scope === "workspace" && memoryCtx?.workspaceIdentity) return workspacePoolKey(memoryCtx.workspaceIdentity);
  if (scope === "user" && memoryCtx?.userPrincipal) return userPoolKey(memoryCtx.userPrincipal);
  return "";
}

/** The contract's MemoryProposal: the internal `poolKey` is never returned. */
function publicProposal(proposal) {
  const { poolKey: _poolKey, ...rest } = proposal;
  return rest;
}

/**
 * @param {{opsContext: object, sharedOps: {findSharedRow: Function, refreshShare: Function}, store: object, memoryDbAdapter: object, host: object, logger?: object, clock?: () => number}} deps
 * @returns {{propose: Function, list: Function, accept: Function, reject: Function}}
 */
export function createMemoryProposals({ opsContext, sharedOps, store, memoryDbAdapter, host, logger, clock = Date.now }) {
  async function propose(sharedId, newText, p, a, opts = {}) {
    const { agentId, memoryCtx, workspaceDir } = await opsContext.resolve(p, a, { destructive: true });

    let safeId;
    try {
      safeId = safeUuid(sharedId);
    } catch {
      throw memoryOpError("invalid-input", "sharedId must be a valid memory id");
    }

    const trimmed = typeof newText === "string" ? newText.trim() : "";
    if (trimmed.length < 1 || trimmed.length > MAX_CORRECT_TEXT_LENGTH) {
      throw memoryOpError("invalid-input", `newText must be between 1 and ${MAX_CORRECT_TEXT_LENGTH} characters after trim`);
    }

    let note = null;
    if (opts?.note !== undefined && opts?.note !== null) {
      if (typeof opts.note !== "string" || opts.note.length > MAX_NOTE_LENGTH) {
        throw memoryOpError("invalid-input", `note must be a string of at most ${MAX_NOTE_LENGTH} characters`);
      }
      note = opts.note;
    }

    // `sharedId` naming one of the caller's own live private cards is a
    // `correct` job, not a proposal (anti-oracle-safe: getCard() is
    // ACL-filtered and answers null for an id that is not this agent's own).
    let ownCard;
    try {
      ownCard = await memoryDbAdapter.getCard(agentId, safeId, { ctx: memoryCtx });
    } catch (err) {
      logger?.warn?.(`memory-ops.propose: getCard failed for agent '${agentId}'/'${safeId}': ${err?.message || err}`);
      throw memoryOpError("storage", "memory read failed");
    }
    if (ownCard && isLive(ownCard)) {
      throw memoryOpError("invalid-input", "propose applies to shared copies; correct your own cards");
    }

    const found = await sharedOps.findSharedRow({ agentId, memoryCtx, id: safeId });
    if (!found) throw memoryOpError("not-found", "memory not found");
    const { card } = found;

    // A legacy shared row that predates share provenance names no sharer to
    // file the proposal under (and no original to refresh on accept).
    if (typeof card.sourceAgentId !== "string" || card.sourceAgentId === ""
      || typeof card.sourceMemoryId !== "string" || card.sourceMemoryId === "") {
      throw memoryOpError("denied", "this shared copy has no recorded sharer");
    }
    const poolKey = poolKeyForScope(card.scope, memoryCtx);
    if (!poolKey) throw memoryOpError("not-found", "memory not found");

    if (isSharer(card, agentId)) {
      throw memoryOpError("invalid-input", "the sharer corrects the original directly");
    }
    if (trimmed === card.text) {
      throw memoryOpError("invalid-input", "no change");
    }

    // In-process claim over findPending → create, so two concurrent filings
    // by the same proposer against the same copy cannot both pass the
    // duplicate check; the loser answers conflict. Released in `finally`.
    const fileKey = `${card.sourceAgentId}\u0000${safeId.toLowerCase()}\u0000${agentId}`;
    if (filing.has(fileKey)) throw memoryOpError("conflict", "a proposal by this agent is already pending");
    filing.add(fileKey);
    try {
      return fileProposal({ agentId, memoryCtx, workspaceDir, safeId, card, poolKey, trimmed, note });
    } finally {
      filing.delete(fileKey);
    }
  }

  // sharer + lowercased sharedId + proposer of every filing in progress.
  const filing = new Set();

  function fileProposal({ agentId, memoryCtx, workspaceDir, safeId, card, poolKey, trimmed, note }) {
    let pending;
    try {
      pending = store.findPending({ sharerAgentId: card.sourceAgentId, sharedId: safeId, proposerAgentId: agentId });
    } catch (err) {
      if (isMemoryOpError(err)) throw err;
      logger?.warn?.(`memory-ops.propose: findPending failed for agent '${agentId}'/'${safeId}': ${err?.message || err}`);
      throw memoryOpError("storage", "proposal read failed");
    }
    if (pending) throw memoryOpError("conflict", "a proposal by this agent is already pending");

    opsContext.assertOpen?.();

    const proposal = {
      id: randomUUID(),
      sharedId: safeId,
      sourceId: card.sourceMemoryId,
      target: card.scope,
      sharerAgentId: card.sourceAgentId,
      proposerAgentId: agentId,
      oldText: card.text,
      newText: trimmed,
      note,
      createdAt: clock(),
      status: "pending",
      resolvedAt: null,
      resultId: null,
      resolutionNote: null,
      poolKey,
    };

    try {
      store.create(proposal);
    } catch (err) {
      if (isMemoryOpError(err)) throw err;
      logger?.warn?.(`memory-ops.propose: store.create failed for agent '${agentId}'/'${safeId}': ${err?.message || err}`);
      throw memoryOpError("storage", "proposal write failed");
    }

    const auditOk = appendDestructiveOpLog(workspaceDir, {
      op: "memory-propose",
      proposalId: proposal.id,
      sharedId: safeId,
      actor: memoryCtx.userPrincipal || `principal:${agentId}`,
      at: new Date().toISOString(),
    });
    if (!auditOk) throw memoryOpError("storage", "audit failed");

    emitEngineEvent(host, "memory.proposal", {
      proposalId: proposal.id,
      status: "pending",
      sharerAgentId: proposal.sharerAgentId,
      proposerAgentId: agentId,
      sharedId: safeId,
    });

    return { proposalId: proposal.id, sharedId: safeId, sharerAgentId: proposal.sharerAgentId };
  }

  async function list(q, p, a) {
    const { agentId, memoryCtx } = await opsContext.resolve(p, a);

    if (q?.status !== undefined && !PROPOSAL_STATUSES.has(q.status)) {
      throw memoryOpError("invalid-input", `status must be one of ${[...PROPOSAL_STATUSES].join(", ")}`);
    }
    let limit = DEFAULT_LIST_LIMIT;
    if (q?.limit !== undefined) {
      if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > MAX_LIST_LIMIT) {
        throw memoryOpError("invalid-input", `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
      }
      limit = q.limit;
    }

    let result;
    try {
      result = store.listFor(agentId, { status: q?.status ?? null, limit, poolKeys: reachablePoolKeys(memoryCtx) });
    } catch (err) {
      if (isMemoryOpError(err)) throw err;
      logger?.warn?.(`memory-ops.proposals.list: listFor failed for agent '${agentId}': ${err?.message || err}`);
      throw memoryOpError("storage", "proposal list failed");
    }

    return { agentId, items: result.items.map(publicProposal), truncated: result.truncated, unreadable: result.unreadable };
  }

  // Proposal ids currently being accepted/rejected in this process: a second
  // accept/reject of the same id while the first is still running is a
  // conflict, not a second refresh. Released in `finally`.
  const resolving = new Set();

  /**
   * The sharer's pending proposal, or the matching MemoryOpError. Proposals
   * are filed under the sharer, so `store.get(agentId, …)` answers null for
   * anyone else — the same anti-oracle `not-found` as an unknown id. A
   * proposal in a pool the caller's principal cannot reach (or with no
   * recorded pool) is the same `not-found`, checked before anything else.
   */
  function loadPending(agentId, memoryCtx, safeId, opName) {
    let proposal;
    try {
      proposal = store.get(agentId, safeId);
    } catch (err) {
      if (isMemoryOpError(err)) throw err;
      logger?.warn?.(`memory-ops.proposals.${opName}: store.get failed for agent '${agentId}'/'${safeId}': ${err?.message || err}`);
      throw memoryOpError("storage", "proposal read failed");
    }
    if (!proposal || proposal.sharerAgentId !== agentId) throw memoryOpError("not-found", "proposal not found");
    if (typeof proposal.poolKey !== "string" || !reachablePoolKeys(memoryCtx).has(proposal.poolKey)) {
      throw memoryOpError("not-found", "proposal not found");
    }
    if (proposal.status !== "pending") throw memoryOpError("conflict", `proposal is ${proposal.status}`);
    return proposal;
  }

  function saveResolved(proposal, opName) {
    try {
      store.update(proposal);
    } catch (err) {
      if (isMemoryOpError(err)) throw err;
      logger?.warn?.(`memory-ops.proposals.${opName}: store.update failed for '${proposal.sharerAgentId}'/'${proposal.id}': ${err?.message || err}`);
      throw memoryOpError("storage", "proposal write failed");
    }
  }

  function emitResolved(proposal) {
    emitEngineEvent(host, "memory.proposal", {
      proposalId: proposal.id,
      status: proposal.status,
      sharerAgentId: proposal.sharerAgentId,
      proposerAgentId: proposal.proposerAgentId,
      sharedId: proposal.sharedId,
    });
  }

  function parseProposalId(proposalId) {
    try {
      return safeUuid(proposalId);
    } catch {
      throw memoryOpError("invalid-input", "proposalId must be a valid proposal id");
    }
  }

  // Keyed on the lowercased id: safeUuid accepts either case, and a
  // case-insensitive filesystem maps both spellings to one proposal file.
  const guardKey = (safeId) => safeId.toLowerCase();

  function claim(safeId) {
    const key = guardKey(safeId);
    if (resolving.has(key)) throw memoryOpError("conflict", "proposal is being resolved");
    resolving.add(key);
  }

  function release(safeId) {
    resolving.delete(guardKey(safeId));
  }

  /**
   * Sharer only. Refreshes the shared copy with the proposal's text through
   * the same path the sharer's own `correct` takes (refreshShare). A copy
   * that is gone or whose text changed since the proposal was filed is never
   * overwritten: the proposal is marked `stale` and the call answers
   * `conflict`. Any refresh failure leaves the proposal `pending`.
   */
  async function accept(proposalId, p, a) {
    const { agentId, memoryCtx, workspaceDir, archiveDir } = await opsContext.resolve(p, a, { destructive: true });
    const safeId = parseProposalId(proposalId);

    loadPending(agentId, memoryCtx, safeId, "accept");
    claim(safeId);
    try {
      // Re-read under the claim: a resolve that finished between the check
      // above and the claim must not be applied twice.
      const proposal = loadPending(agentId, memoryCtx, safeId, "accept");

      // throwOnError: a failed lookup is `storage` (proposal stays pending);
      // only a definite absence marks the proposal stale.
      const found = await sharedOps.findSharedRow({ agentId, memoryCtx, id: proposal.sharedId, throwOnError: true });
      let staleReason = null;
      if (!found || !isSharer(found.card, agentId)) staleReason = "shared copy is gone; proposal marked stale";
      else if (found.card.text !== proposal.oldText) staleReason = "shared copy changed since the proposal";
      if (staleReason) {
        opsContext.assertOpen?.();
        const stale = { ...proposal, status: "stale", resolvedAt: clock() };
        saveResolved(stale, "accept");
        emitResolved(stale);
        throw memoryOpError("conflict", staleReason);
      }

      opsContext.assertOpen?.();
      let refreshed;
      try {
        refreshed = await sharedOps.refreshShare({
          agentId, memoryCtx, workspaceDir, archiveDir,
          card: found.card, newText: proposal.newText, reason: "MemoryOps.proposals.accept",
        });
      } catch (err) {
        // The proposal stays pending; the error (and its detail naming the
        // ids a partial refresh left behind) reaches the caller unchanged.
        const detail = err?.detail ? ` detail=${JSON.stringify(err.detail)}` : "";
        logger?.warn?.(`memory-ops.proposals.accept: refresh failed for proposal '${safeId}' (agent '${agentId}', shared copy '${proposal.sharedId}'), left pending: ${err?.code || ""} ${err?.message || err}${detail}`);
        throw err;
      }
      const { sourceId, sharedId } = refreshed;

      // The shared copy has changed from here on: a failure to record that
      // names the ids so the caller is not left with a bare storage error.
      const appliedDetail = { proposalId: safeId, id: sharedId, sourceId };
      const accepted = { ...proposal, status: "accepted", resolvedAt: clock(), resultId: sharedId };
      try {
        saveResolved(accepted, "accept");
      } catch (err) {
        logger?.warn?.(`memory-ops.proposals.accept: proposal '${safeId}' was applied (new original '${sourceId}', new shared copy '${sharedId}') but recording it as accepted failed: ${err?.message || err}`);
        throw memoryOpError("storage", "proposal applied but not recorded as accepted", appliedDetail);
      }

      const auditOk = appendDestructiveOpLog(workspaceDir, {
        op: "memory-proposal-accept",
        proposalId: safeId,
        resultId: sharedId,
        actor: memoryCtx.userPrincipal || `principal:${agentId}`,
        at: new Date().toISOString(),
      });
      if (!auditOk) {
        logger?.warn?.(`memory-ops.proposals.accept: proposal '${safeId}' was accepted (new original '${sourceId}', new shared copy '${sharedId}') but the audit append failed`);
        throw memoryOpError("storage", "audit failed", appliedDetail);
      }

      emitResolved(accepted);
      return { proposalId: safeId, id: sharedId, sourceId };
    } finally {
      release(safeId);
    }
  }

  /** Sharer only. Records the rejection (and an optional note); never touches the shared copy. */
  async function reject(proposalId, p, a, opts = {}) {
    const { agentId, memoryCtx, workspaceDir } = await opsContext.resolve(p, a, { destructive: true });
    const safeId = parseProposalId(proposalId);

    let note = null;
    if (opts?.note !== undefined && opts?.note !== null) {
      if (typeof opts.note !== "string" || opts.note.length > MAX_NOTE_LENGTH) {
        throw memoryOpError("invalid-input", `note must be a string of at most ${MAX_NOTE_LENGTH} characters`);
      }
      note = opts.note;
    }

    loadPending(agentId, memoryCtx, safeId, "reject");
    claim(safeId);
    try {
      const proposal = loadPending(agentId, memoryCtx, safeId, "reject");
      opsContext.assertOpen?.();
      const rejected = { ...proposal, status: "rejected", resolvedAt: clock(), resolutionNote: note };
      saveResolved(rejected, "reject");

      const auditOk = appendDestructiveOpLog(workspaceDir, {
        op: "memory-proposal-reject",
        proposalId: safeId,
        actor: memoryCtx.userPrincipal || `principal:${agentId}`,
        at: new Date().toISOString(),
      });
      if (!auditOk) {
        // The rejection is already recorded: name it so the caller is not
        // left with a bare storage error (mirrors accept's appliedDetail).
        logger?.warn?.(`memory-ops.proposals.reject: proposal '${safeId}' was rejected but the audit append failed`);
        throw memoryOpError("storage", "audit failed", { proposalId: safeId });
      }

      emitResolved(rejected);
      return { proposalId: safeId, status: "rejected" };
    } finally {
      release(safeId);
    }
  }

  return { propose, list, accept, reject };
}

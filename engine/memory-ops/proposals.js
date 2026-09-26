/**
 * engine/memory-ops/proposals.js — E2 Task 5 (spec decision D31): `MemoryOps.propose`
 * and `MemoryOps.proposals.list`.
 *
 * A shared (workspace/user) copy is changed directly only by the agent that
 * shared it (`Engine.memory.correct`, engine/memory-ops/write.js). Any other
 * agent who can read the copy instead files a change proposal here; the
 * sharer accepts or rejects it later (Task 6 — `accept`/`reject` are stubs in
 * this task and are not wired onto `Engine.memory.proposals`). Filing never
 * changes the shared copy itself.
 */

import { randomUUID } from "node:crypto";
import { appendDestructiveOpLog, safeUuid } from "../../lib/sql-safety.js";
import { emitEngineEvent } from "../events.js";
import { memoryOpError, isMemoryOpError } from "./errors.js";
import { isSharer, isLive } from "./shared.js";
import { MAX_CORRECT_TEXT_LENGTH } from "./write.js";

const MAX_NOTE_LENGTH = 500;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const PROPOSAL_STATUSES = new Set(["pending", "accepted", "rejected", "stale"]);

/**
 * @param {{opsContext: object, sharedOps: {findSharedRow: Function}, store: object, memoryDbAdapter: object, host: object, logger?: object, clock?: () => number}} deps
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

    if (isSharer(card, agentId)) {
      throw memoryOpError("invalid-input", "the sharer corrects the original directly");
    }
    if (trimmed === card.text) {
      throw memoryOpError("invalid-input", "no change");
    }

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
    const { agentId } = await opsContext.resolve(p, a);

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
      result = store.listFor(agentId, { status: q?.status ?? null, limit });
    } catch (err) {
      if (isMemoryOpError(err)) throw err;
      logger?.warn?.(`memory-ops.proposals.list: listFor failed for agent '${agentId}': ${err?.message || err}`);
      throw memoryOpError("storage", "proposal list failed");
    }

    return { agentId, items: result.items, truncated: result.truncated, unreadable: result.unreadable };
  }

  /** Implemented in Task 6; not wired onto Engine.memory.proposals in this task. */
  async function accept() {
    throw memoryOpError("storage", "not implemented");
  }

  /** Implemented in Task 6; not wired onto Engine.memory.proposals in this task. */
  async function reject() {
    throw memoryOpError("storage", "not implemented");
  }

  return { propose, list, accept, reject };
}

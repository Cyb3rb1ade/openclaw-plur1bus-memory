/**
 * engine/memory-ops/link.js — `MemoryOps.link` (contract 1.16.0).
 *
 * Lets an importer attach an imported card that duplicates an existing memory
 * to that memory, instead of storing a duplicate row: the existing card gains
 * an additional source (`sourceRef`, provenance, optional import run). The
 * card's row is never written — text, vector, `updatedAt` and the import
 * digest stay untouched — the link lives in the per-agent sidecar
 * `_links/<agentId>.jsonl` (engine/memory-ops/link-ledger.js).
 *
 * - Idempotent: the link id is deterministic over (agentId, cardId, sourceRef);
 *   linking the same sourceRef again is `already-linked`, a sourceRef equal to
 *   the card's own import sourceRef is `already-source`. Neither writes.
 * - Scope isolation: the target must be a card the caller can `show` (same
 *   access pools, ACL and liveness test); anything else, including an unknown
 *   id, is `not-found` (anti-oracle). The link is recorded under the caller's
 *   agent and only that agent's show/list report it.
 * - Rollback: a link carries the import run (`importRunId`, else the run its
 *   sourceRef names, `;run=<id>`); `memory.unimport` of that run appends an
 *   `unlinked` line and leaves the card alone.
 * - Apply runs under the per-agent import lock, so link and unimport of one
 *   agent never interleave; every write is fenced on the lock nonce.
 * - Audit: a `memory.linked` line in the workspace destructive-ops log. Logs,
 *   results and audit lines carry ids, run ids and outcomes — never card text
 *   or sourceRef.
 */

import { findMemoryAcrossAccessPools } from "../../lib/telegram-commands/memory-query.js";
import { appendDestructiveOpLog, safeUuid } from "../../lib/sql-safety.js";
import { memoryOpError } from "./errors.js";
import { IMPORT_IDEMPOTENCY_KEY_MAX, IMPORT_RUN_ID_RE, IMPORT_SOURCE_REF_MAX, sourceRefRunId } from "./import.js";
import { withImportLock } from "./import-lock.js";
import { createLinkLedger, linkIdFor } from "./link-ledger.js";

/** At most this many active links per card; one more is `conflict`. */
export const MEMORY_LINK_MAX_PER_CARD = 100;

/**
 * @param {object} deps
 * @param {object} deps.opsContext shared MemoryOps context
 * @param {object} deps.pool agent-private pool
 * @param {object} [deps.sharedMemoryPool] workspace/user pools
 * @param {string} deps.baseDbPath
 * @param {object} [deps.importLedger] the `memory.import` ledger (own-source check)
 * @param {object} [deps.linkLedger] shared link ledger instance (default: a new one)
 * @param {object} [deps.importLock] test seam: withImportLock options
 * @returns {{link: Function, ledger: object, importLock: object}}
 */
export function createMemoryLink({
  opsContext,
  pool,
  sharedMemoryPool,
  baseDbPath,
  logger,
  clock = Date.now,
  importLedger = null,
  linkLedger = null,
  importLock = {},
} = {}) {
  const ledger = linkLedger ?? createLinkLedger({ baseDbPath, logger });

  function validate(id, req) {
    let cardId;
    try {
      cardId = safeUuid(id);
    } catch {
      throw memoryOpError("invalid-input", "id must be a valid memory id");
    }
    if (!req || typeof req !== "object" || Array.isArray(req)) {
      throw memoryOpError("invalid-input", "link request is required");
    }
    if (req.provenance !== "imported") {
      throw memoryOpError("invalid-input", "provenance must be \"imported\"");
    }
    const sourceRef = typeof req.sourceRef === "string" ? req.sourceRef.trim() : "";
    if (!sourceRef) throw memoryOpError("invalid-input", "sourceRef is required");
    if (sourceRef.length > IMPORT_SOURCE_REF_MAX) {
      throw memoryOpError("invalid-input", `sourceRef exceeds ${IMPORT_SOURCE_REF_MAX} characters`);
    }
    let importRunId = "";
    if (req.importRunId != null) {
      if (typeof req.importRunId !== "string" || !IMPORT_RUN_ID_RE.test(req.importRunId)) {
        throw memoryOpError("invalid-input", "importRunId is invalid");
      }
      importRunId = req.importRunId;
    } else {
      importRunId = sourceRefRunId(sourceRef);
    }
    let idempotencyKey = "";
    if (req.idempotencyKey != null) {
      const key = typeof req.idempotencyKey === "string" ? req.idempotencyKey.trim() : "";
      if (!key || key.length > IMPORT_IDEMPOTENCY_KEY_MAX) {
        throw memoryOpError("invalid-input", "idempotencyKey is empty or too long");
      }
      idempotencyKey = key;
    }
    return { cardId, sourceRef, importRunId, idempotencyKey, dryRun: req.dryRun === true };
  }

  async function findVisible(agentId, memoryCtx, cardId) {
    let found;
    try {
      found = await findMemoryAcrossAccessPools({
        privatePool: pool,
        sharedPool: sharedMemoryPool,
        agent: agentId,
        id: cardId,
        ctx: memoryCtx,
        now: Date.now(),
      });
    } catch (err) {
      logger?.warn?.(`memory-ops.link: lookup failed for agent '${agentId}' id='${cardId}': ${err?.code || "error"}`);
      throw memoryOpError("storage", "memory read failed");
    }
    if (!found) throw memoryOpError("not-found", "memory not found");
    return found;
  }

  function importSourceOf(agentId, cardId) {
    if (!importLedger || typeof importLedger.load !== "function") return "";
    const row = importLedger.load(agentId).byCardId.get(cardId);
    return typeof row?.sourceRef === "string" ? row.sourceRef : "";
  }

  /** What a link call would do now, from the current ledgers. */
  function classify(agentId, plan, linkId) {
    if (importSourceOf(agentId, plan.cardId) === plan.sourceRef) return { outcome: "already-source", existing: null };
    const state = ledger.load(agentId);
    const existing = state.active.get(linkId);
    if (existing) return { outcome: "already-linked", existing };
    if ((state.byCardId.get(plan.cardId)?.length ?? 0) >= MEMORY_LINK_MAX_PER_CARD) {
      throw memoryOpError("conflict", `a memory carries at most ${MEMORY_LINK_MAX_PER_CARD} links`);
    }
    return { outcome: "linked", existing: null };
  }

  function resultOf(plan, linkId, decision, dryRun) {
    const runOf = decision.existing
      ? (typeof decision.existing.importRunId === "string" && decision.existing.importRunId ? decision.existing.importRunId : null)
      : (plan.importRunId || null);
    return {
      id: plan.cardId,
      linkId,
      outcome: decision.outcome,
      importRunId: decision.outcome === "already-source" ? null : runOf,
      dryRun,
    };
  }

  /**
   * @param {string} id the existing card
   * @param {{sourceRef: string, provenance: "imported", importRunId?: string, idempotencyKey?: string, dryRun?: boolean}} req
   * @param {object} p operator principal
   * @param {object} a agent context; must be origin "system", background false
   * @returns {Promise<{id: string, linkId: string, outcome: "linked"|"already-linked"|"already-source", importRunId: string|null, dryRun: boolean}>}
   */
  async function link(id, req, p, a) {
    if (!a || a.origin !== "system" || a.background !== false) {
      throw memoryOpError("denied", "link requires origin \"system\" and background false");
    }
    const resolved = await opsContext.resolve(p, a);
    const plan = validate(id, req);
    const { agentId, memoryCtx, workspaceDir } = resolved;
    const linkId = linkIdFor(agentId, plan.cardId, plan.sourceRef);

    if (plan.dryRun) {
      await findVisible(agentId, memoryCtx, plan.cardId);
      return resultOf(plan, linkId, classify(agentId, plan, linkId), true);
    }

    let entered = false;
    try {
      return await withImportLock(baseDbPath, agentId, async ({ assertHeld }) => {
        entered = true;
        const fence = () => {
          try {
            assertHeld();
          } catch (err) {
            if (err?.code === "IMPORT_LOCK_LOST") throw memoryOpError("lock-lost", "import lock was lost");
            throw err;
          }
          opsContext.assertOpen?.();
        };
        fence();
        // Looked up under the lock: an unimport of this agent cannot remove the card in between.
        await findVisible(agentId, memoryCtx, plan.cardId);
        const decision = classify(agentId, plan, linkId);
        if (decision.outcome !== "linked") {
          logger?.debug?.(`memory-ops.link: agent='${agentId}' id='${plan.cardId}' link='${linkId}' ${decision.outcome}`);
          return resultOf(plan, linkId, decision, false);
        }
        const at = clock();
        fence();
        ledger.append(agentId, {
          kind: "linked",
          linkId,
          cardId: plan.cardId,
          sourceRef: plan.sourceRef,
          provenance: "imported",
          ...(plan.importRunId ? { importRunId: plan.importRunId } : {}),
          ...(plan.idempotencyKey ? { idempotencyKey: plan.idempotencyKey } : {}),
          at,
        });
        const audited = appendDestructiveOpLog(workspaceDir, {
          event: "memory.linked",
          source: "memory_link",
          agentId,
          memoryId: plan.cardId,
          linkId,
          importRunId: plan.importRunId,
          result: "committed",
          timestamp: new Date(at).toISOString(),
        });
        if (!audited && workspaceDir) {
          logger?.warn?.(`memory-ops.link: audit line not written for agent '${agentId}' id='${plan.cardId}'`);
        }
        logger?.debug?.(`memory-ops.link: linked agent='${agentId}' id='${plan.cardId}' link='${linkId}' run='${plan.importRunId}'`);
        return resultOf(plan, linkId, decision, false);
      }, { ...importLock });
    } catch (err) {
      if (err?.name === "MemoryOpError") throw err;
      if (entered) {
        if (err?.code === "IMPORT_LOCK_LOST") throw memoryOpError("lock-lost", "import lock was lost");
        logger?.warn?.(`memory-ops.link: apply failed for agent '${agentId}': ${err?.code || "error"}`);
        throw memoryOpError("storage", "link failed");
      }
      if (err?.code === "IMPORT_LOCK_BUSY") {
        throw memoryOpError("lock-busy", "an import, unimport or link of this agent is running");
      }
      logger?.warn?.(`memory-ops.link: import lock unavailable for agent '${agentId}': ${err?.code || "error"}`);
      throw memoryOpError("storage", "link lock unavailable");
    }
  }

  // `importLock` is returned by reference as a test seam.
  return { link, ledger, importLock };
}

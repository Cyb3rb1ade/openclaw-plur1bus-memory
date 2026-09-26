/**
 * engine/memory-ops/shared.js — E2 Task 4 (spec decision D31): shared copies.
 *
 * A shared copy is a row in a workspace or user pool that `share` wrote from
 * an agent's private card (lib/shared-memory.js storeSharedMemory: it carries
 * `sourceAgentId` and `sourceMemoryId`). Only the sharing agent changes it:
 *   - retract (forget): archive-first, then a soft delete of the pool row —
 *     the same `status: "deleted"`, `epistemicStatus: "invalidated"` patch
 *     db-adapter's tombstoneCard writes — plus a destructive-op audit line.
 *     Deliberately NOT written to lib/tombstone.js's registry: the registry
 *     blocks re-capture of forgotten content, and the original stays live.
 *   - refresh (correct): correct the private original (archive-first, like
 *     E1's correct), share the corrected original to the same scope, then
 *     retract the old copy.
 * Every other agent changes a shared copy through a proposal (Tasks 5, 6).
 */

import { archiveCard, correctCard, shareCard } from "../../lib/telegram-commands/memory-edit.js";
import { findMemoryAcrossAccessPools, projectMemoryQueryCard } from "../../lib/telegram-commands/memory-query.js";
import { isRecallEntryLive } from "../../lib/recall-pipeline.js";
import { appendDestructiveOpLog, safeUuid } from "../../lib/sql-safety.js";
import { isMemoryOpError, memoryOpError } from "./errors.js";

const ORIGINAL_NOT_LIVE = "the original of this shared copy is no longer live; retract it instead";

/**
 * The same liveness gate `show` applies (engine/memory-ops/read.js): a
 * non-"active" status other than "deleted" (superseded, archived, …), an
 * invalidated epistemic status, an expired TTL, or a Valid-Time window that
 * excludes "now" are all indistinguishable "not-found" (fix round 1, E1-R7,
 * anti-oracle). `forget`'s own idempotency/crash-backfill path needs a
 * `status === "deleted"` card to keep reaching `forgetCard`, so that one
 * status is the caller's job to special-case, not this helper's.
 * @param {object} card A stored or projected memory row.
 * @returns {boolean}
 */
export function isLive(card) {
  return isRecallEntryLive(projectMemoryQueryCard(card), Date.now());
}

/**
 * @param {{sourceAgentId?: string}} card A projected shared-pool card.
 * @param {string} agentId
 * @returns {boolean} true when `agentId` is the agent that shared this copy.
 */
export function isSharer(card, agentId) {
  return typeof card?.sourceAgentId === "string" && card.sourceAgentId !== "" && card.sourceAgentId === agentId;
}

/**
 * @param {{opsContext: object, pool: object, sharedMemoryPool: object, memoryDbAdapter: object, embeddings: object, baseDbPath: string, applyCorrection: Function, logger?: object, shareCopy?: Function, findAcrossPools?: Function}} deps
 *   `shareCopy` has shareCard's signature and defaults to it; it is the seam
 *   tests use to make the re-share step of a refresh fail. `findAcrossPools`
 *   has findMemoryAcrossAccessPools's signature and defaults to it; it is the
 *   seam tests use to make the shared-copy lookup fail.
 * @returns {{findSharedRow: Function, retractSharedRow: Function, refreshShare: Function}}
 */
export function createSharedMemoryOps({ opsContext, pool, sharedMemoryPool, memoryDbAdapter, embeddings, baseDbPath, applyCorrection, logger, shareCopy = shareCard, findAcrossPools = findMemoryAcrossAccessPools }) {
  /**
   * The live, ACL-visible workspace/user copy with this id, or null. A failed
   * lookup is logged and, by default, answers null, so the caller's answer
   * stays the anti-oracle "not-found". With `throwOnError: true` a failed
   * lookup throws `storage` instead, for callers (proposals.accept) that act
   * on a definite absence and must not mistake a read error for one.
   * @returns {Promise<{card: object, sourceKind: string} | null>}
   */
  async function findSharedRow({ agentId, memoryCtx, id, throwOnError = false }) {
    try {
      return await findAcrossPools({
        privatePool: pool,
        sharedPool: sharedMemoryPool,
        agent: agentId,
        id,
        ctx: memoryCtx,
        now: Date.now(),
        sourceKinds: ["workspace", "user"],
      });
    } catch (err) {
      logger?.warn?.(`memory-ops.shared: shared-pool lookup failed for agent '${agentId}'/'${id}': ${err?.message || err}`);
      if (throwOnError) throw memoryOpError("storage", "memory read failed");
      return null;
    }
  }

  /**
   * Archives, then soft-deletes one shared copy in the pool it lives in.
   * The caller has already checked isSharer.
   * @returns {Promise<{id: string, archived: true, tombstoneId: null, alreadyForgotten: boolean}>}
   */
  async function retractSharedRow({ agentId, memoryCtx, workspaceDir, archiveDir, card, reason }) {
    const safe = safeUuid(card.id);
    const scope = card.scope;
    const lease = scope === "workspace" ? sharedMemoryPool?.withWorkspaceDb : scope === "user" ? sharedMemoryPool?.withUserDb : null;
    if (typeof lease !== "function") {
      logger?.warn?.(`memory-ops.shared.retract: no shared pool for scope '${scope}' (agent '${agentId}'/'${safe}')`);
      throw memoryOpError("storage", "memory write failed");
    }

    try {
      archiveCard(card, agentId, archiveDir);
    } catch (err) {
      logger?.warn?.(`memory-ops.shared.retract: archive failed for agent '${agentId}'/'${safe}': ${err?.message || err}`);
      throw memoryOpError("storage", "archive failed");
    }

    let alreadyForgotten;
    try {
      alreadyForgotten = await lease.call(sharedMemoryPool, memoryCtx, async (db) => {
        if (!db) throw new Error("shared pool unavailable");
        await db.init();
        opsContext.assertOpen?.();
        if (typeof db.table?.checkoutLatest === "function") await db.table.checkoutLatest();
        const where = `id = "${safe}"`;
        const rows = await db.table.query().where(where).limit(1).toArray();
        // The row vanished between findSharedRow and this lease: same anti-oracle answer as an unknown id.
        if (rows.length === 0) throw memoryOpError("not-found", "memory not found");
        if (String(rows[0].status || "") === "deleted") return true;
        await db.table.update({ where, values: { status: "deleted", epistemicStatus: "invalidated" } });
        return false;
      });
    } catch (err) {
      if (isMemoryOpError(err)) throw err;
      logger?.warn?.(`memory-ops.shared.retract: soft delete failed for agent '${agentId}'/'${safe}': ${err?.message || err}`);
      throw memoryOpError("storage", "memory write failed");
    }

    if (!alreadyForgotten) {
      const auditOk = appendDestructiveOpLog(workspaceDir, {
        op: "share-retract",
        id: safe,
        scope,
        sourceMemoryId: card.sourceMemoryId || "",
        actor: memoryCtx.userPrincipal || `principal:${agentId}`,
        at: new Date().toISOString(),
        ...(reason ? { reason } : {}),
      });
      if (!auditOk) throw memoryOpError("storage", "audit failed");
    }
    return { id: safe, archived: true, tombstoneId: null, alreadyForgotten };
  }

  /**
   * Refreshes a shared copy (the sharer's `correct`), in this order:
   *   1. correct the private original through the same archive-first path
   *      E1's `correct` uses (correctCard: archive, safeUpdate via
   *      applyCorrection, `memory.updated` audit line) — ruling R7;
   *   2. share the corrected original to the same scope (the content was
   *      already shared with approval; the sharer's refresh renews it);
   *   3. retract the old copy.
   * Sharing before retracting means a failure leaves at worst two copies,
   * never none; the retract can always be repeated. A failure after step 1
   * throws `storage` with a fixed message and `detail` naming the ids left
   * behind: `{ sourceId, sharedId }` where sharedId is the copy that is
   * still live (the old one if step 2 failed, the new one if step 3
   * failed), plus `staleSharedId` (the old copy) when step 3 failed.
   * @returns {Promise<{sourceId: string, sharedId: string, retractedId: string}>}
   */
  async function refreshShare({ agentId, memoryCtx, workspaceDir, archiveDir, card, newText, reason }) {
    let original = null;
    if (card.sourceMemoryId) {
      try {
        original = await memoryDbAdapter.getCard(agentId, safeUuid(card.sourceMemoryId), { ctx: memoryCtx });
      } catch (err) {
        logger?.warn?.(`memory-ops.shared.refresh: getCard failed for agent '${agentId}'/'${card.sourceMemoryId}': ${err?.message || err}`);
        throw memoryOpError("storage", "memory write failed");
      }
    }
    if (!original || !isLive(original)) {
      throw memoryOpError("conflict", ORIGINAL_NOT_LIVE);
    }

    opsContext.assertOpen?.();
    const corrected = await correctCard(memoryDbAdapter, agentId, original.id, newText, {
      lang: "en",
      workspaceDir,
      logger,
      ctx: memoryCtx,
      baseDbPath,
      archiveDir,
      actor: memoryCtx.userPrincipal || `principal:${agentId}`,
      actorType: "human",
      reason: reason || "MemoryOps.correct",
      updateMemory: ({ id: targetId, newContent, card: stored }) => applyCorrection({ agentId, memoryCtx, workspaceDir, id: targetId, newContent, card: stored }),
    });
    if (!corrected.ok) {
      // Same mapping as write.js's correct; a not-found here means the
      // original died between the liveness check and correctCard.
      if (corrected.code === "conflict") throw memoryOpError("conflict", "memory update conflicts with an existing tombstone");
      if (corrected.code === "not-found") throw memoryOpError("conflict", ORIGINAL_NOT_LIVE);
      throw memoryOpError("storage", "memory write failed");
    }
    const newId = corrected.newId ?? corrected.id;

    let shared;
    try {
      shared = await shareCopy(pool, sharedMemoryPool, embeddings, agentId, newId, {
        targetScope: card.scope,
        allowSensitiveShare: true,
        ctx: memoryCtx,
        logger,
      });
    } catch (err) {
      shared = { ok: false, error: err?.message || String(err) };
    }
    if (!shared?.ok) {
      logger?.warn?.(`memory-ops.shared.refresh: re-share failed for agent '${agentId}' (corrected original '${newId}', old copy '${card.id}' still live): ${shared?.error || shared?.code || "unknown"}`);
      throw memoryOpError("storage", "share refresh failed after correcting the original", { sourceId: newId, sharedId: card.id });
    }

    try {
      await retractSharedRow({ agentId, memoryCtx, workspaceDir, archiveDir, card, reason });
    } catch (err) {
      logger?.warn?.(`memory-ops.shared.refresh: retracting old copy '${card.id}' failed for agent '${agentId}' (new copy '${shared.sharedId}'): ${err?.message || err}`);
      throw memoryOpError("storage", "share refresh failed to retract the previous copy", { sourceId: newId, sharedId: shared.sharedId, staleSharedId: card.id });
    }
    return { sourceId: newId, sharedId: shared.sharedId, retractedId: card.id };
  }

  return { findSharedRow, retractSharedRow, refreshShare };
}

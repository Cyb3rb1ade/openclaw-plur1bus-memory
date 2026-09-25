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
 *   - refresh (correct): correct the private original, retract the old copy,
 *     share the corrected original to the same scope.
 * Every other agent changes a shared copy through a proposal (Tasks 5, 6).
 */

import { archiveCard, shareCard } from "../../lib/telegram-commands/memory-edit.js";
import { findMemoryAcrossAccessPools, projectMemoryQueryCard } from "../../lib/telegram-commands/memory-query.js";
import { isRecallEntryLive } from "../../lib/recall-pipeline.js";
import { appendDestructiveOpLog, safeUuid } from "../../lib/sql-safety.js";
import { isMemoryOpError, memoryOpError } from "./errors.js";

/**
 * @param {{sourceAgentId?: string}} card A projected shared-pool card.
 * @param {string} agentId
 * @returns {boolean} true when `agentId` is the agent that shared this copy.
 */
export function isSharer(card, agentId) {
  return typeof card?.sourceAgentId === "string" && card.sourceAgentId !== "" && card.sourceAgentId === agentId;
}

/**
 * @param {{opsContext: object, pool: object, sharedMemoryPool: object, memoryDbAdapter: object, embeddings: object, applyCorrection: Function, logger?: object}} deps
 * @returns {{findSharedRow: Function, retractSharedRow: Function, refreshShare: Function}}
 */
export function createSharedMemoryOps({ opsContext, pool, sharedMemoryPool, memoryDbAdapter, embeddings, applyCorrection, logger }) {
  /**
   * The live, ACL-visible workspace/user copy with this id, or null. A failed
   * lookup is logged and answers null, so the caller's answer stays the
   * anti-oracle "not-found".
   * @returns {Promise<{card: object, sourceKind: string} | null>}
   */
  async function findSharedRow({ agentId, memoryCtx, id }) {
    try {
      return await findMemoryAcrossAccessPools({
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
   * Corrects the sharer's private original, retracts the old copy and shares
   * the corrected original to the same scope. The content was already shared
   * with approval; the sharer's refresh renews it (allowSensitiveShare).
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
    if (!original || !isRecallEntryLive(projectMemoryQueryCard(original), Date.now())) {
      throw memoryOpError("conflict", "the original of this shared copy is no longer live; retract it instead");
    }

    opsContext.assertOpen?.();
    let corrected;
    try {
      corrected = await applyCorrection({ agentId, memoryCtx, workspaceDir, id: original.id, newContent: newText, card: original });
    } catch (err) {
      logger?.warn?.(`memory-ops.shared.refresh: correcting the original failed for agent '${agentId}'/'${original.id}': ${err?.message || err}`);
      throw memoryOpError("storage", "memory write failed");
    }
    if (!corrected?.ok) {
      if (corrected?.action === "tombstone_blocked") throw memoryOpError("conflict", "memory update conflicts with an existing tombstone");
      throw memoryOpError("storage", "memory write failed");
    }
    const newId = corrected.newId;

    await retractSharedRow({ agentId, memoryCtx, workspaceDir, archiveDir, card, reason });

    const shared = await shareCard(pool, sharedMemoryPool, embeddings, agentId, newId, {
      targetScope: card.scope,
      allowSensitiveShare: true,
      ctx: memoryCtx,
      logger,
    });
    if (!shared.ok) {
      logger?.warn?.(`memory-ops.shared.refresh: re-share failed for agent '${agentId}' (old copy '${card.id}' retracted, corrected original '${newId}'): ${shared.error || shared.code || "unknown"}`);
      throw memoryOpError("storage", "share refresh failed after correcting the original");
    }
    return { sourceId: newId, sharedId: shared.sharedId, retractedId: card.id };
  }

  return { findSharedRow, retractSharedRow, refreshShare };
}

/**
 * engine/memory-ops/write.js — E1 Task 5: typed MemoryOps `forget` and `correct`.
 *
 * Both members are thin, typed wrappers over the same archive-first,
 * tombstone-backed primitives the legacy `/forget` and `/correct` telegram
 * commands use (`lib/telegram-commands/memory-edit.js`), reshaped into the
 * `MemoryForgetResult`/`MemoryCorrectResult` contract (contract 1.5.0). Both
 * are destructive: `opsContext.resolve(p, a, { destructive: true })` enforces
 * origin "user" + background false before either does anything.
 */

import { forgetCard, correctCard, shareCard } from "../../lib/telegram-commands/memory-edit.js";
import { safeUuid } from "../../lib/sql-safety.js";
import { safeUpdate } from "../../lib/safe-update.js";
import { applyRetrievalReinforcement } from "../../lib/memory-dynamics.js";
import { sanitizeMemoryTextForPrompt } from "../../lib/memory-context-sanitize.js";
import { CORRECTION_PREVIEW_CHARS } from "../runtime/constants.js";
import { memoryOpError } from "./errors.js";
import { createSharedMemoryOps, isSharer, isLive } from "./shared.js";

const MAX_CORRECT_TEXT_LENGTH = 8_000;

/** English messages for each machine-readable failure code (log-safe; a raw error/reason string never reaches the thrown MemoryOpError's message — fix round 1, E1-R10). */
function messageForCode(code) {
  switch (code) {
    case "not-found": return "memory not found";
    case "storage": return "memory write failed";
    case "conflict": return "memory update conflicts with an existing tombstone";
    case "approval-required": return "sharing this memory requires explicit approval";
    default: return "memory operation failed";
  }
}

/**
 * @param {{opsContext: object, memoryDbAdapter: object, baseDbPath: string, pool: object, sharedMemoryPool: object, embeddings: object, getNeoStore?: Function, logger?: object, shareCopy?: Function}} deps
 *   `shareCopy` is a test seam for the re-share step of a shared-copy refresh (defaults to shareCard).
 * @returns {{forget: Function, correct: Function, share: Function, shared: {findSharedRow: Function, retractSharedRow: Function, refreshShare: Function}}}
 */
export function createMemoryWrite({ opsContext, memoryDbAdapter, baseDbPath, pool, sharedMemoryPool, embeddings, getNeoStore, logger, shareCopy }) {
  // Shared copies (E2 Task 4, D31): retract/refresh by the sharer. Consumed
  // here by forget/correct/share and by later tasks through `.shared`.
  const sharedOps = createSharedMemoryOps({ opsContext, pool, sharedMemoryPool, memoryDbAdapter, embeddings, baseDbPath, applyCorrection, logger, ...(shareCopy ? { shareCopy } : {}) });

  /**
   * The shared copy behind an id the caller's private pool does not hold as a
   * live card (E1 final review I3, ruling E1-R13; E2 Task 4, D31). When the id
   * is a live workspace/user copy the principal can reach, each op decides
   * what the sharer and everyone else may do with it. An id the principal
   * cannot see anywhere stays "not-found" (anti-oracle); a failed shared-pool
   * lookup is logged by findSharedRow and also answers "not-found".
   * @returns {Promise<{card: object, sourceKind: string}>}
   */
  async function requireSharedRow(agentId, safeId, memoryCtx) {
    const found = await sharedOps.findSharedRow({ agentId, memoryCtx, id: safeId });
    if (!found) throw memoryOpError("not-found", messageForCode("not-found"));
    return found;
  }

  /**
   * The version write behind `correct` (E1 Task 8): the same safeUpdate path
   * the OpenClaw `/correct` command has always used, moved here so the
   * command can run through `Engine.memory.correct` without losing it —
   * a fresh summary from the new text, an evidence line naming the stored
   * before-text, the Neo reconsolidation event and graph-edge rewrite, and
   * retrieval reinforcement of the new version. `db-adapter.updateCard`
   * (the previous engine path) kept the stale summary and wrote none of that.
   * A tombstone refusal from the store comes back as a non-throwing
   * `tombstone_blocked` result, which correctCard maps to "conflict".
   * @returns {Promise<{ok: false, action: string} | {ok: true, newId: string}>}
   */
  async function applyCorrection({ agentId, memoryCtx, workspaceDir, id, newContent, card }) {
    return pool.withDb(agentId, async (rawDb) => {
      await rawDb.init();
      const vector = await embeddings.embed(newContent, { agentId });
      const neoStore = typeof getNeoStore === "function" ? getNeoStore({ agentId, workspaceDir }, {}) : undefined;
      const oldText = card?.text || card?.summary || "";
      let newId;
      try {
        ({ newId } = await safeUpdate(
          rawDb,
          id,
          { text: newContent, summary: newContent.split(/\r?\n/)[0].slice(0, 200), vector },
          {
            updateSource: "user_correction",
            updateEvidence: oldText
              ? `User corrected "${sanitizeMemoryTextForPrompt(oldText, CORRECTION_PREVIEW_CHARS)}" to "${newContent}"`
              : "User correction via /correct",
            confidence: 1,
          },
          {
            neoStore,
            logger,
            // A correction is a confirmed user action whose confirmation shows
            // old and new text in full: high semantic drift is intended there,
            // and the gate would block legitimate large corrections. The drift
            // is still recorded as `semanticDrift` on the reconsolidation event.
            skipDriftGate: true,
            workspaceAliases: memoryCtx.workspaceAliases,
          },
        ));
      } catch (err) {
        if (err?.action === "tombstone_blocked" || err?.reason === "tombstone_blocked") {
          return { ok: false, action: "tombstone_blocked" };
        }
        throw err;
      }
      // newId === id on an idempotent skip; reinforcement is still valid.
      try {
        const corrected = await rawDb.getById(newId);
        if (corrected) await rawDb.update(newId, applyRetrievalReinforcement(corrected, Date.now()));
      } catch (err) {
        logger?.warn?.(`memory-ops.correct: reinforcement failed: ${err?.message || err}`);
      }
      return { ok: true, newId };
    });
  }

  async function forget(id, p, a) {
    const { agentId, memoryCtx, workspaceDir, archiveDir } = await opsContext.resolve(p, a, { destructive: true });

    let safeId;
    try {
      safeId = safeUuid(id);
    } catch {
      throw memoryOpError("invalid-input", "id must be a valid memory id");
    }

    let card;
    try {
      // Same call show() makes: ACL-filtered (returns null for a denied card).
      card = await memoryDbAdapter.getCard(agentId, safeId, { ctx: memoryCtx });
    } catch (err) {
      logger?.warn?.(`memory-ops.forget: getCard failed for agent '${agentId}'/'${safeId}': ${err?.message || err}`);
      throw memoryOpError("storage", messageForCode("storage"));
    }
    // A "deleted" card must still reach forgetCard below (idempotency +
    // crash-backfill of a half-committed forget). Any other non-live state
    // is not-found, same as show() — unless the id is a shared copy.
    if (!card || (card.status !== "deleted" && !isLive(card))) {
      const shared = await requireSharedRow(agentId, safeId, memoryCtx);
      if (!isSharer(shared.card, agentId)) throw memoryOpError("denied", "only the sharing agent can retract a shared copy");
      opsContext.assertOpen?.();
      return sharedOps.retractSharedRow({ agentId, memoryCtx, workspaceDir, archiveDir, card: shared.card, reason: "MemoryOps.forget" });
    }

    opsContext.assertOpen?.();
    const result = await forgetCard(memoryDbAdapter, agentId, safeId, {
      lang: "en",
      workspaceDir,
      logger,
      ctx: memoryCtx,
      baseDbPath,
      archiveDir,
      actor: memoryCtx.userPrincipal || `principal:${agentId}`,
      actorType: "human",
      reason: "MemoryOps.forget",
    });

    if (!result.ok) {
      throw memoryOpError(result.code ?? "storage", messageForCode(result.code ?? "storage"));
    }
    return {
      id: result.id ?? safeId,
      archived: !result.alreadyTombstoned,
      tombstoneId: result.tombstoneId ?? null,
      alreadyForgotten: Boolean(result.alreadyTombstoned),
    };
  }

  async function correct(id, newText, p, a) {
    const { agentId, memoryCtx, workspaceDir, archiveDir } = await opsContext.resolve(p, a, { destructive: true });

    let safeId;
    try {
      safeId = safeUuid(id);
    } catch {
      throw memoryOpError("invalid-input", "id must be a valid memory id");
    }

    const trimmed = typeof newText === "string" ? newText.trim() : "";
    if (trimmed.length < 1 || trimmed.length > MAX_CORRECT_TEXT_LENGTH) {
      throw memoryOpError("invalid-input", `newText must be between 1 and ${MAX_CORRECT_TEXT_LENGTH} characters after trim`);
    }

    let card;
    try {
      // Same call show() makes: ACL-filtered (returns null for a denied card).
      card = await memoryDbAdapter.getCard(agentId, safeId, { ctx: memoryCtx });
    } catch (err) {
      logger?.warn?.(`memory-ops.correct: getCard failed for agent '${agentId}'/'${safeId}': ${err?.message || err}`);
      throw memoryOpError("storage", messageForCode("storage"));
    }
    if (!card || !isLive(card)) {
      const shared = await requireSharedRow(agentId, safeId, memoryCtx);
      if (!isSharer(shared.card, agentId)) throw memoryOpError("denied", "shared copies are changed through a proposal (memory.propose)");
      opsContext.assertOpen?.();
      const { sharedId } = await sharedOps.refreshShare({ agentId, memoryCtx, workspaceDir, archiveDir, card: shared.card, newText: trimmed, reason: "MemoryOps.correct" });
      return { id: sharedId, archived: true };
    }

    opsContext.assertOpen?.();
    const result = await correctCard(memoryDbAdapter, agentId, safeId, trimmed, {
      lang: "en",
      workspaceDir,
      logger,
      ctx: memoryCtx,
      baseDbPath,
      archiveDir,
      actor: memoryCtx.userPrincipal || `principal:${agentId}`,
      actorType: "human",
      reason: "MemoryOps.correct",
      updateMemory: ({ id: targetId, newContent, card: stored }) => applyCorrection({ agentId, memoryCtx, workspaceDir, id: targetId, newContent, card: stored }),
    });

    if (!result.ok) {
      throw memoryOpError(result.code ?? "storage", messageForCode(result.code ?? "storage"));
    }
    // fix round 1, E1-R8: MemoryCorrectResult.id is the id of the new, live
    // version (correctCard's version-chain update returns it additively as
    // `newId`), not the now-superseded id the caller passed in.
    return { id: result.newId ?? result.id ?? safeId, archived: true };
  }

  /**
   * @param {string} id
   * @param {"workspace"|"user"} target
   * @param {object} p Principal
   * @param {object} a AgentContext
   * @param {{allowSensitive?: boolean}} [opts]
   * @returns {Promise<{sourceId: string, sharedId: string, target: "workspace"|"user"}>} MemoryShareResult
   */
  async function share(id, target, p, a, { allowSensitive = false } = {}) {
    if (target !== "workspace" && target !== "user") {
      throw memoryOpError("invalid-input", "target must be \"workspace\" or \"user\"");
    }

    const { agentId, memoryCtx } = await opsContext.resolve(p, a, { destructive: true, target });

    // Mirrors the adapter's requireWorkspace/requireUser (E1 Task 6): the
    // resolved memory context must actually carry the identity `target`
    // names, not merely a proved principal (which opsContext.resolve already
    // enforced above via its own `target` check).
    if (target === "workspace" && !memoryCtx.workspaceIdentity) {
      throw memoryOpError("denied", "sharing to a workspace requires a workspace-bound principal");
    }
    if (target === "user" && !memoryCtx.userPrincipal) {
      throw memoryOpError("denied", "sharing to a user requires a channel/account-bound authenticated user");
    }

    let safeId;
    try {
      safeId = safeUuid(id);
    } catch {
      throw memoryOpError("invalid-input", "id must be a valid memory id");
    }

    let card;
    try {
      // Same call show()/forget()/correct() make: ACL-filtered (returns null
      // for a denied card), then the same liveness gate as show() — a
      // superseded/archived/invalidated/expired/already-forgotten source is
      // not-found, same anti-oracle answer shareCard's own "active"-only
      // check does not by itself provide (E1-R6/E1-R7).
      card = await memoryDbAdapter.getCard(agentId, safeId, { ctx: memoryCtx });
    } catch (err) {
      logger?.warn?.(`memory-ops.share: getCard failed for agent '${agentId}'/'${safeId}': ${err?.message || err}`);
      throw memoryOpError("storage", messageForCode("storage"));
    }
    if (!card || !isLive(card)) {
      await requireSharedRow(agentId, safeId, memoryCtx);
      throw memoryOpError("denied", "a shared copy cannot be shared again");
    }

    opsContext.assertOpen?.();
    const result = await shareCard(pool, sharedMemoryPool, embeddings, agentId, safeId, {
      targetScope: target,
      allowSensitiveShare: allowSensitive === true,
      ctx: memoryCtx,
      logger,
    });

    if (!result.ok) {
      throw memoryOpError(result.code ?? "storage", messageForCode(result.code ?? "storage"));
    }
    return { sourceId: safeId, sharedId: result.sharedId, target };
  }

  return { forget, correct, share, shared: sharedOps };
}

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

import { forgetCard, correctCard } from "../../lib/telegram-commands/memory-edit.js";
import { projectMemoryQueryCard } from "../../lib/telegram-commands/memory-query.js";
import { isRecallEntryLive } from "../../lib/recall-pipeline.js";
import { safeUuid } from "../../lib/sql-safety.js";
import { memoryOpError } from "./errors.js";

const MAX_CORRECT_TEXT_LENGTH = 8_000;

/** English messages for each machine-readable failure code (log-safe; a raw error/reason string never reaches the thrown MemoryOpError's message — fix round 1, E1-R10). */
function messageForCode(code) {
  switch (code) {
    case "not-found": return "memory not found";
    case "storage": return "memory write failed";
    case "conflict": return "memory update conflicts with an existing tombstone";
    default: return "memory operation failed";
  }
}

/**
 * The same liveness gate `show` applies (engine/memory-ops/read.js): a
 * non-"active" status other than "deleted" (superseded, archived, …), an
 * invalidated epistemic status, an expired TTL, or a Valid-Time window that
 * excludes "now" are all indistinguishable "not-found" (fix round 1, E1-R7,
 * anti-oracle). `forget`'s own idempotency/crash-backfill path needs a
 * `status === "deleted"` card to keep reaching `forgetCard`, so that one
 * status is the caller's job to special-case, not this helper's.
 */
function isLive(card) {
  return isRecallEntryLive(projectMemoryQueryCard(card), Date.now());
}

/**
 * @param {{opsContext: object, memoryDbAdapter: object, baseDbPath: string, logger?: object}} deps
 * @returns {{forget: Function, correct: Function}}
 */
export function createMemoryWrite({ opsContext, memoryDbAdapter, baseDbPath, logger }) {
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
    if (!card) {
      throw memoryOpError("not-found", messageForCode("not-found"));
    }
    // A "deleted" card must still reach forgetCard below (idempotency +
    // crash-backfill of a half-committed forget). Any other non-live state
    // is not-found, same as show().
    if (card.status !== "deleted" && !isLive(card)) {
      throw memoryOpError("not-found", messageForCode("not-found"));
    }

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
      throw memoryOpError("not-found", messageForCode("not-found"));
    }

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
    });

    if (!result.ok) {
      throw memoryOpError(result.code ?? "storage", messageForCode(result.code ?? "storage"));
    }
    // fix round 1, E1-R8: MemoryCorrectResult.id is the id of the new, live
    // version (correctCard's version-chain update returns it additively as
    // `newId`), not the now-superseded id the caller passed in.
    return { id: result.newId ?? result.id ?? safeId, archived: true };
  }

  return { forget, correct };
}

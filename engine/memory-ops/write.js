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
import { safeUuid } from "../../lib/sql-safety.js";
import { memoryOpError } from "./errors.js";

const MAX_CORRECT_TEXT_LENGTH = 8_000;

/** English messages for each machine-readable failure code (log-safe, no user text leaks into them). */
function messageForCode(code, fallback) {
  switch (code) {
    case "not-found": return "memory not found";
    case "storage": return "memory write failed";
    default: return fallback || "memory operation failed";
  }
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
      throw memoryOpError(result.code ?? "storage", messageForCode(result.code, result.error));
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
      throw memoryOpError(result.code ?? "storage", messageForCode(result.code, result.error));
    }
    return { id: result.id ?? safeId, archived: true };
  }

  return { forget, correct };
}

/**
 * lib/jobs/apply-conflict-resolution.js — confirm-gated safeUpdate apply.
 */

import { join } from "node:path";
import { readJsonl } from "../jsonl-utils.js";
import { safeUpdate } from "../safe-update.js";

const MAX_LOG_SIZE_MB = 50;

/**
 * @param {object} db
 * @param {object} conflict
 * @param {{confirm?: boolean, vector?: number[], neoStore?: object, logger?: object, agentId?: string}} [opts]
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function applyConflictViaSafeUpdate(db, conflict, opts = {}) {
  if (opts.confirm !== true) return { ok: false, reason: "confirm_required" };
  const id = conflict?.existingMemoryId || conflict?.newMemoryId;
  const text = conflict?.mergedText || conflict?.resolutionText;
  const vector = opts.vector || conflict?.vector;
  if (!id || !text || !vector) return { ok: false, reason: "incomplete_patch" };
  try {
    await safeUpdate(
      db,
      id,
      { text, vector },
      { updateSource: "conflict-resolver", updateEvidence: String(conflict?.reason || "conflict apply") },
      { neoStore: opts.neoStore, logger: opts.logger, agentId: opts.agentId },
    );
    return { ok: true };
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("Semantic drift too high")) {
      return { ok: false, reason: "review_only" };
    }
    return { ok: false, reason: message };
  }
}

/**
 * @param {string} workspaceDir
 * @param {string} memoryId
 * @returns {object|null}
 */
export function findResolvableConflict(workspaceDir, memoryId) {
  if (!workspaceDir || !memoryId) return null;
  const path = join(workspaceDir, ".adaptive-learning", "conflict-resolved.jsonl");
  const rows = readJsonl(path, {
    maxBytes: MAX_LOG_SIZE_MB * 1024 * 1024,
    onSkip: () => {},
  });
  return [...rows].reverse().find((row) =>
    row?.recommendation === "apply_via_safe_reconsolidation"
    && (row?.original?.existingMemoryId === memoryId || row?.original?.newMemoryId === memoryId),
  ) || null;
}

/**
 * @param {object} entry
 * @returns {string}
 */
export function resolutionApplyId(entry) {
  return entry?.original?.existingMemoryId || entry?.original?.newMemoryId || "";
}

/**
 * @param {object} entry
 * @returns {string}
 */
export function resolutionApplyText(entry) {
  if (!entry) return "";
  if (entry.resolution === "keep_a") return String(entry.original?.existingText || "");
  if (entry.resolution === "keep_b") return String(entry.original?.newText || "");
  return String(entry.mergedText || entry.original?.mergedText || "");
}

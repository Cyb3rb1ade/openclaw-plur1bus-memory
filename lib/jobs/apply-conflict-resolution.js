/**
 * lib/jobs/apply-conflict-resolution.js — confirm-gated safeUpdate apply.
 */

import { safeUpdate } from "../safe-update.js";

/**
 * @param {object} db
 * @param {object} conflict
 * @param {{confirm?: boolean, neoStore?: object, logger?: object, agentId?: string}} [opts]
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

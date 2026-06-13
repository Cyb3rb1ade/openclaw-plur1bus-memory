import { computeDecayedStrength, isCoreMemory } from "./memory-dynamics.js";

/**
 * Weakens older similar non-core memories after a new memory is stored.
 *
 * @param {Object} db - Memory DB adapter with search() and update()
 * @param {Object} newEntry - Newly stored memory entry
 * @param {Object} opts - Runtime options
 * @returns {Promise<{ok: boolean, affected: number, skipped?: boolean, reason?: string, error?: string}>}
 */
export async function applyRetroactiveInterference(db, newEntry, opts = {}) {
  const { threshold = 0.65, multiplier = 0.9, maxAffected = 5 } = opts;

  if (opts.enabled === false) {
    return { ok: true, affected: 0, skipped: true, reason: "disabled" };
  }
  if (!db || typeof db.search !== "function" || typeof db.update !== "function") {
    return { ok: true, affected: 0, skipped: true, reason: "missing_db" };
  }
  if (!newEntry?.id || !newEntry?.vector) {
    return { ok: true, affected: 0, skipped: true, reason: "missing_entry" };
  }

  try {
    const candidates = await db.search(newEntry.vector, maxAffected + 1, threshold);
    const now = Date.now();
    let affected = 0;

    for (const { entry: candidate } of Array.isArray(candidates) ? candidates : []) {
      if (affected >= maxAffected) break;
      if (!candidate?.id || candidate.id === newEntry.id) continue;
      if (isCoreMemory(candidate)) continue;

      const decayed = computeDecayedStrength(candidate, now);
      const next = Math.max(0.01, decayed * multiplier);
      await db.update(candidate.id, { memoryStrength: next, lastDynamicsAt: now });
      affected++;
    }

    return { ok: true, affected };
  } catch (err) {
    opts.logger?.warn?.("[retroactive-interference] failed", err?.message ?? err);
    return { ok: false, affected: 0, error: String(err?.message ?? err) };
  }
}

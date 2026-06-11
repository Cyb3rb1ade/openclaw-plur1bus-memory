import { isCoreMemory, computeDecayedStrength } from "./memory-dynamics.js";

export async function applyRetroactiveInterference(db, newEntry, opts = {}) {
  const { threshold = 0.65, multiplier = 0.9, maxAffected = 5 } = opts;
  if (!newEntry?.id || !newEntry?.vector) return;

  const candidates = await db.search(newEntry.vector, maxAffected + 1, threshold);
  const now = Date.now();
  let affectedCount = 0;

  for (const { entry: candidate } of candidates) {
    if (affectedCount >= maxAffected) break;
    if (candidate.id === newEntry.id) continue;
    if (isCoreMemory(candidate)) continue;

    const decayed = computeDecayedStrength(candidate, now);
    const next = Math.max(0.01, decayed * multiplier);
    await db.update(candidate.id, { memoryStrength: next, lastDynamicsAt: now });
    affectedCount++;
  }
}

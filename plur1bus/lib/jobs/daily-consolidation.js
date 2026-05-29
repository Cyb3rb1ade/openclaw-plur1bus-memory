/**
 * lib/jobs/daily-consolidation.js
 *
 * Phase 5 Task 5.1 — stille tägliche Konsolidierung.
 *
 * Bereinigt die neo-JSONL-Stores des Workspaces (injizierten Recall-/System-/
 * Cron-Kontext entfernen, Duplikate zusammenführen, auf Obergrenze kappen) und
 * meldet einen strukturierten Report. Pusht NICHTS an Telegram — der Aufrufer
 * loggt deterministisch. Verhindert das erneute Auflaufen der Recall/Capture-
 * Rückkopplung (Performance-Analysis 2026-05-29).
 */

export async function runConsolidation(db, agent, opts = {}) {
  const logger = opts.logger || { info: () => {}, warn: () => {} };
  const timestamp = new Date().toISOString();
  const neoStore = opts.neoStore;

  // Neo-JSONL-Wartung: injizierten Kontext filtern, dedupen, cappen.
  let neoPrune = null;
  if (neoStore && typeof neoStore.pruneAll === "function") {
    try {
      neoPrune = neoStore.pruneAll({ dryRun: opts.dryRun === true });
      const totals = Object.values(neoPrune).reduce((acc, s) => ({
        removedInjected: acc.removedInjected + (s.removedInjected || 0),
        removedDup: acc.removedDup + (s.removedDup || 0),
        removedCap: acc.removedCap + (s.removedCap || 0),
      }), { removedInjected: 0, removedDup: 0, removedCap: 0 });
      logger.info?.(`daily-consolidation[${agent}]: neo prune removedInjected=${totals.removedInjected} removedDup=${totals.removedDup} removedCap=${totals.removedCap}`);
    } catch (err) {
      logger.warn?.(`daily-consolidation[${agent}]: neo prune threw: ${err.message}`);
    }
  }

  if (!db || typeof db.isAvailable !== "function") {
    logger.warn?.(`daily-consolidation[${agent}]: db adapter missing`);
    return {
      timestamp,
      agent,
      adversarial: 0,
      duplicates: 0,
      conflicts: 0,
      neoPrune,
      note: "db adapter missing — neo prune only",
    };
  }

  let available = false;
  try {
    available = await db.isAvailable(agent);
  } catch (err) {
    logger.warn?.(`daily-consolidation[${agent}]: isAvailable threw: ${err.message}`);
  }

  return {
    timestamp,
    agent,
    adversarial: 0,
    duplicates: 0,
    conflicts: 0,
    dbAvailable: available,
    neoPrune,
    note: "neo prune active; lancedb dedup/conflict wiring in next iteration",
  };
}

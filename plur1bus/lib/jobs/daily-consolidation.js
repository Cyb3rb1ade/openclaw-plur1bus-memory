/**
 * lib/jobs/daily-consolidation.js
 *
 * Phase 5 Task 5.1 — stille tägliche Konsolidierung.
 *
 * Aktueller Status: STUB. Hängt sich in einer späteren Iteration an die
 * existierende Adversarial-, Duplicate- und Conflict-Pipeline. Returnt
 * strukturierten Report, damit der Cron-Job nichts an Telegram pusht und
 * der Aufrufer trotzdem deterministisch loggen kann.
 */

export async function runConsolidation(db, agent, opts = {}) {
  const logger = opts.logger || { info: () => {}, warn: () => {} };
  const timestamp = new Date().toISOString();

  if (!db || typeof db.isAvailable !== "function") {
    logger.warn?.(`daily-consolidation[${agent}]: db adapter missing`);
    return {
      timestamp,
      agent,
      adversarial: 0,
      duplicates: 0,
      conflicts: 0,
      note: "stub — db adapter missing",
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
    note: "stub — real consolidation wires up in next iteration",
  };
}

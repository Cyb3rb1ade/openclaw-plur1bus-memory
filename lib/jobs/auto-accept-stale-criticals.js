/**
 * lib/jobs/auto-accept-stale-criticals.js
 *
 * Phase 5 Task 5.3 — täglich 03:1x, akzeptiert critical cards die seit
 * `hours` Stunden unconfirmed sind.
 *
 * Hängt von db-adapter-Methoden ab, die in Phase 6 nachgezogen werden:
 *   - db.findUnconfirmedCritical(agent, { olderThan })
 *   - db.markConfirmed(agent, id)
 *
 * Solange diese Methoden fehlen → no-op + { autoAccepted: 0, note: 'db method missing' }.
 */

export async function autoAcceptStale(db, agent, opts = {}) {
  const { hours = 24, logger = { info: () => {}, warn: () => {} } } = opts;

  if (!db || typeof db.findUnconfirmedCritical !== "function") {
    return { autoAccepted: 0, note: "db method findUnconfirmedCritical missing — Phase 6 wiring pending" };
  }

  const cutoff = Date.now() - hours * 3600000;
  let pending = [];
  try {
    pending = await db.findUnconfirmedCritical(agent, { olderThan: cutoff });
  } catch (err) {
    logger.warn?.(`auto-accept-stale[${agent}]: findUnconfirmedCritical failed: ${err.message}`);
    return { autoAccepted: 0, error: err.message };
  }

  if (!Array.isArray(pending) || pending.length === 0) {
    return { autoAccepted: 0, note: "no stale unconfirmed criticals" };
  }

  let accepted = 0;
  const errors = [];
  for (const card of pending) {
    if (typeof db.markConfirmed !== "function") break;
    try {
      await db.markConfirmed(agent, card.id);
      accepted += 1;
    } catch (err) {
      logger.warn?.(`auto-accept-stale[${agent}]: markConfirmed failed for ${card.id}: ${err.message}`);
      errors.push({ id: card.id, error: err.message });
    }
  }

  return {
    autoAccepted: accepted,
    scanned: pending.length,
    cutoffMs: cutoff,
    errors: errors.length,
    errorDetails: errors.slice(0, 5),
  };
}

/**
 * Lets unconfirmed critical cards lapse to plain notes after `hours` hours.
 * Replaces the automatic accept (7.16.10): a card nobody confirmed was only
 * the classifier's guess, so it stays a normal memory rather than keeping
 * the critical type. Uses the same write as a manual reject, which never
 * deletes (`confirmed=1`, `type="note"`).
 *
 * @param {object} db - db adapter with findUnconfirmedCritical and markCriticalRejected
 * @param {string} agent - agent id
 * @param {{hours?: number, logger?: object}} [opts]
 * @returns {Promise<object>} counts of scanned, expired and failed cards
 */
export async function expireStaleCriticals(db, agent, opts = {}) {
  const { hours = 24, logger = { info: () => {}, warn: () => {} } } = opts;

  if (!db || typeof db.findUnconfirmedCritical !== "function" || typeof db.markCriticalRejected !== "function") {
    return { expired: 0, note: "db methods findUnconfirmedCritical/markCriticalRejected missing" };
  }

  const cutoff = Date.now() - hours * 3600000;
  let pending = [];
  try {
    pending = await db.findUnconfirmedCritical(agent, { olderThan: cutoff });
  } catch (err) {
    logger.warn?.(`expire-stale-criticals[${agent}]: findUnconfirmedCritical failed: ${err.message}`);
    return { expired: 0, error: err.message };
  }

  if (!Array.isArray(pending) || pending.length === 0) {
    return { expired: 0, note: "no stale unconfirmed criticals" };
  }

  let expired = 0;
  const errors = [];
  for (const card of pending) {
    try {
      await db.markCriticalRejected(agent, card.id);
      expired += 1;
    } catch (err) {
      logger.warn?.(`expire-stale-criticals[${agent}]: markCriticalRejected failed for ${card.id}: ${err.message}`);
      errors.push({ id: card.id, error: err.message });
    }
  }

  return {
    expired,
    scanned: pending.length,
    cutoffMs: cutoff,
    errors: errors.length,
    errorDetails: errors.slice(0, 5),
  };
}

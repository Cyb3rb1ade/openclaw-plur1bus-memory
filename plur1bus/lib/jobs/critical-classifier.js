/**
 * lib/jobs/critical-classifier.js
 *
 * Phase 5 Task 5.2 — klassifiziert frisch erstellte Memory-Cards der
 * letzten 30 Minuten und sendet bis zu N Telegram-Pushes pro Tag.
 *
 * Hängt von db-adapter-Methoden ab, die in Phase 6 nachgezogen werden:
 *   - db.findRecentUnclassified(agent, { sinceMinutes })
 *   - db.updateCardType(agent, id, type)
 *
 * Solange diese Methoden fehlen → Job antwortet mit
 * { processed: 0, pushed: 0, note: 'db method missing' } und no-ops.
 */

import {
  classifyMemory,
  shouldPush,
  buildPushMessage,
} from "../critical-push-classifier.js";
import {
  loadCounts,
  incrementCount,
} from "../critical-push-state.js";

export async function runClassifier(db, agent, opts = {}) {
  const {
    model,
    telegramSend,
    sinceMinutes = 30,
    maxPerDay = 3,
    statePath,
    logger = { info: () => {}, warn: () => {} },
  } = opts;

  if (!db || typeof db.findRecentUnclassified !== "function") {
    return {
      processed: 0,
      pushed: 0,
      note: "db method findRecentUnclassified missing — Phase 6 wiring pending",
    };
  }

  let recent = [];
  try {
    recent = await db.findRecentUnclassified(agent, { sinceMinutes });
  } catch (err) {
    logger.warn?.(`critical-classifier[${agent}]: findRecentUnclassified failed: ${err.message}`);
    return { processed: 0, pushed: 0, error: err.message };
  }

  if (!Array.isArray(recent) || recent.length === 0) {
    return { processed: 0, pushed: 0, note: "no recent unclassified cards" };
  }

  const today = new Date().toISOString().slice(0, 10);
  const counts = loadCounts(agent, statePath ? { dir: statePath } : {});

  let pushed = 0;
  let processed = 0;
  let classified = 0;
  const errors = [];

  for (const card of recent) {
    let type = "info";
    try {
      type = await classifyMemory(card.content || card.title || "", model);
    } catch (err) {
      logger.warn?.(`critical-classifier[${agent}]: classifyMemory failed for ${card.id}: ${err.message}`);
      errors.push({ stage: "classify", id: card.id, error: err.message });
      continue;
    }

    if (typeof db.updateCardType === "function") {
      try {
        await db.updateCardType(agent, card.id, type);
        classified += 1;
      } catch (err) {
        logger.warn?.(`critical-classifier[${agent}]: updateCardType failed for ${card.id}: ${err.message}`);
        errors.push({ stage: "updateCardType", id: card.id, error: err.message });
      }
    }
    processed += 1;

    const eligible = shouldPush({ ...card, type, date: today }, counts, { maxPerDay });
    if (eligible && typeof telegramSend === "function") {
      try {
        await telegramSend(buildPushMessage({ ...card, type }));
        incrementCount(agent, today, statePath ? { dir: statePath } : {});
        counts[today] = (counts[today] || 0) + 1;
        pushed += 1;
      } catch (err) {
        logger.warn?.(`critical-classifier[${agent}]: telegramSend failed for ${card.id}: ${err.message}`);
        errors.push({ stage: "telegramSend", id: card.id, error: err.message });
      }
    }
  }

  return { processed, pushed, classified, errors: errors.length, errorDetails: errors.slice(0, 5) };
}

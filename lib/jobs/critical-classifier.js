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
  isEligibleForCriticalHighlight,
  assignShortRefs,
} from "../critical-review.js";
import {
  loadCounts,
  incrementCount,
} from "../critical-push-state.js";

function errorClass(error) {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error?.name === "TimeoutError" && error?.code === "ETIMEOUT") return "TimeoutError";
  if (typeof DOMException === "function"
    && error instanceof DOMException
    && error.name === "AbortError") {
    return "AbortError";
  }
  if (error instanceof Error) return "Error";
  return "NonError";
}

/**
 * Classify recent untyped cards without mutating cards when classification fails.
 * @param {object} db
 * @param {string} agent
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
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

  // No-Poison-Guard: Ohne Klassifikations-Modell würde classifyMemory jede
  // Karte als "fakt" markieren — und updateCardType würde sie damit dauerhaft
  // aus findRecentUnclassified ausschließen. Lieber no-op, bis ein Modell da
  // ist, statt den Backlog unwiederbringlich als "fakt" zu verbrennen.
  if (!model || typeof model.complete !== "function") {
    return {
      processed: 0,
      pushed: 0,
      note: "no classification model configured — skipping to avoid mislabeling cards as 'fakt'",
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
  const counts = loadCounts(agent, statePath ? { stateDir: statePath } : {});

  let pushed = 0;
  let processed = 0;
  let classified = 0;
  const errors = [];
  // Eligible Push-Karten. Wenn kein direkter telegramSend verfügbar ist (das
  // OpenClaw-Plugin-SDK hat aktuell keine outbound-Sende-API), werden diese
  // im Ergebnis zurückgegeben. Der Plugin-Command formatiert sie direkt als
  // zustellbare Cron-Antwort, ohne einen Modell-Carrier zu starten.
  const pushMessages = [];
  const pushedCards = [];

  // Pending-Review-Ledger vorab laden, damit Kurzreferenzen über alle
  // ausstehenden Reviews des Agenten eindeutig bleiben (Scope-Isolation).
  let pendingIds = [];
  if (typeof db.findPendingCriticalReviews === "function") {
    try {
      const pendingReviews = await db.findPendingCriticalReviews(agent);
      pendingIds = (Array.isArray(pendingReviews) ? pendingReviews : []).map((r) => r.id).filter(Boolean);
    } catch (err) {
      logger.warn?.(`critical-classifier[${agent}]: findPendingCriticalReviews failed: ${err.message}`);
    }
  }

  for (const card of recent) {
    let type = "info";
    try {
      type = await classifyMemory(card.content || card.title || "", model);
    } catch (err) {
      const classificationErrorClass = errorClass(err);
      logger.warn?.(`critical-classifier[${agent}]: classifyMemory failed for ${card.id} (${classificationErrorClass})`);
      errors.push({
        stage: "classify",
        id: card.id,
        error: "classification transport failed",
        errorClass: classificationErrorClass,
      });
      continue;
    }

    // Source-Role-/Provenienz-Gate: ein bloßer Klassifikations-Treffer in einer
    // Assistentenantwort (z. B. „Dein API-Key ist nicht konfiguriert.") reicht
    // nicht für eine Critical-Klassifikation. Der Treffer wird auf eine
    // gewöhnliche Notiz deklassifiziert, damit er weder gepusht noch als
    // Pending-Review geführt wird. Explizite Wichtigkeitssignale (neverForget /
    // hohe Importance) bleiben wirksam.
    if (type !== "fakt" && !isEligibleForCriticalHighlight(card)) {
      type = "note";
    }

    let reclassified = false;
    if (typeof db.updateCardType === "function") {
      try {
        await db.updateCardType(agent, card.id, type);
        classified += 1;
        reclassified = true;
      } catch (err) {
        logger.warn?.(`critical-classifier[${agent}]: updateCardType failed for ${card.id}: ${err.message}`);
        errors.push({ stage: "updateCardType", id: card.id, error: err.message });
      }
    }
    processed += 1;

    // Only push once the card was actually reclassified. The no-double-push
    // invariant relies on the card dropping out of findRecentUnclassified after
    // updateCardType — if that failed or is unwired, pushing here would re-fire
    // the same card on every subsequent run (bounded only by maxPerDay).
    if (!reclassified) continue;

    const eligible = shouldPush({ ...card, type, date: today }, counts, { maxPerDay });
    if (!eligible) continue;

    pushedCards.push({ ...card, type });
  }

  // Kurzreferenzen über die Vereinigungsmenge (bestehende Pending + neue) zuweisen.
  const allIds = [...pendingIds, ...pushedCards.map((c) => c.id)];
  const refMap = assignShortRefs(allIds);

  for (const card of pushedCards) {
    const shortRef = refMap.get(card.id) || "";
    const message = buildPushMessage({ ...card, shortRef });

    if (typeof telegramSend === "function") {
      // Direkter Versand (sobald das SDK eine outbound-API bereitstellt).
      try {
        await telegramSend(message);
      } catch (err) {
        logger.warn?.(`critical-classifier[${agent}]: telegramSend failed for ${card.id}: ${err.message}`);
        errors.push({ stage: "telegramSend", id: card.id, error: err.message });
        continue;
      }
    }

    // Tageszähler erhöhen (sowohl bei Direktversand als auch bei Carrier-
    // Delivery), damit maxPerDay über Läufe hinweg respektiert wird. Da jede
    // Karte nach updateCardType aus findRecentUnclassified herausfällt, kann
    // dieselbe Karte nicht doppelt gepusht werden.
    incrementCount(agent, today, statePath ? { stateDir: statePath } : {});
    counts[today] = (counts[today] || 0) + 1;
    pushMessages.push({
      id: card.id,
      type: card.type,
      shortRef,
      text: message.text,
      inline_keyboard: message.inline_keyboard,
    });
    pushed += 1;
  }

  return { processed, pushed, classified, pushMessages, errors: errors.length, errorDetails: errors.slice(0, 5) };
}

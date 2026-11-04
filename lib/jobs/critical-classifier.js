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
  isDreamCard,
  assignShortRefs,
} from "../critical-review.js";
import {
  loadCounts,
  incrementCount,
} from "../critical-push-state.js";
import { buildCriticalButtonCardText } from "../critical-buttons.js";
import { describeError } from "../log-redact.js";

/**
 * Lebende Karte: status "active", leer oder fehlend (dieselbe Lesart wie
 * db-adapter.findPendingCriticalReviews). Alles andere ist ein Tombstone
 * oder ein archivierter Stand und kein Prüfkandidat.
 */
function isActiveCard(card) {
  const status = card?.status;
  return status == null || status === "" || String(status) === "active";
}

// Nur Buchstaben und Ziffern vergleichen: die Teile weichen in Satzzeichen
// und Markdown vom Ganzen ab (Anführungszeichen, Listenmarker).
const normalizeText = (value) => String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Teilstücke, deren Ganzes unter den Kandidaten liegt.
 *
 * Die Aufteilung (memory-chunking.expandForCapture, `keepWhole`) speichert
 * eine lange Nachricht als Ganzes UND als Teile. Beide landen im selben
 * Capture-Batch, und der Cron hat jedes einzeln klassifiziert: dieselbe
 * Aussage kam als zwei Critical-Pushes mit zwei Referenzen (Bernd,
 * 01.10.2026) und verbrauchte den Tagesdeckel doppelt.
 *
 * Zuordnung: gleiche nicht-leere sourceTurnId, und das Ganze enthält
 * mindestens die Hälfte der Teiltexte. Nicht alle: an Bernds Daten fehlte je
 * Gruppe meist ein Teil wörtlich im Ganzen (oft das erste). Abgedeckt ist
 * aber nur ein Teil, dessen Text im Ganzen tatsächlich vorkommt: ein Teil, der
 * dort fehlt, wurde vom Modell nie gesehen und darf nicht ohne Klassifikation
 * als "fakt" enden; er wird wie ein Teil ohne Ganzes einzeln klassifiziert.
 * Findet sich kein Ganzes, bleibt es beim bisherigen Verhalten (Teile
 * einzeln). Im Modus „geteilt“ gibt es kein Ganzes; dann greift die Regel
 * nicht, und die Teile werden wie bisher klassifiziert.
 *
 * @param {Array<object>} cards
 * @returns {Map<string, Set<number>>} abgedecktes Teilstück -> Indizes (in
 *   `cards`) der Ganzen, die es abdecken
 */
function chunkCoverage(cards) {
  const list = Array.isArray(cards) ? cards : [];
  const groups = new Map();
  const wholesByTurn = new Map();
  list.forEach((card, index) => {
    const turn = typeof card?.sourceTurnId === "string" ? card.sourceTurnId : "";
    if (!turn) return;
    if (card.chunkGroupId) {
      const group = groups.get(card.chunkGroupId) || [];
      group.push(card);
      groups.set(card.chunkGroupId, group);
    } else {
      const wholes = wholesByTurn.get(turn) || [];
      wholes.push({ card, text: normalizeText(card.content || card.text) });
      wholesByTurn.set(turn, wholes);
    }
  });
  const covered = new Map();
  for (const parts of groups.values()) {
    const turn = parts[0].sourceTurnId;
    if (parts.some((part) => part.sourceTurnId !== turn)) continue;
    const texts = parts.map((part) => normalizeText(part.content || part.text));
    const nonEmpty = texts.filter(Boolean);
    if (nonEmpty.length === 0) continue;
    for (const whole of wholesByTurn.get(turn) || []) {
      const hits = nonEmpty.filter((text) => whole.text.includes(text)).length;
      if (hits * 2 < nonEmpty.length) continue;
      parts.forEach((part, i) => {
        if (!texts[i] || !whole.text.includes(texts[i])) return;
        const owners = covered.get(part.id) || new Set();
        owners.add(whole.card.id);
        covered.set(part.id, owners);
      });
    }
  }
  return covered;
}

/**
 * @param {Array<object>} cards
 * @returns {Set<string>} IDs der abgedeckten Teilstücke
 */
export function findCoveredChunkIds(cards) {
  return new Set(chunkCoverage(cards).keys());
}

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
    // Kein eigener Default mehr: die Rückschau gehört zum Scan und wird in
    // db-adapter.findRecentUnclassified festgelegt (muss das Cron-Intervall
    // überdecken). Ein Default hier hätte den dortigen still überschrieben.
    sinceMinutes,
    maxPerDay = 3,
    // Konfigurierte Ergänzung der ausgeblendeten Typen (criticalPush.hideTypes);
    // Zugangsdaten sind immer ausgeblendet.
    hideTypes,
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
    recent = await db.findRecentUnclassified(agent, sinceMinutes ? { sinceMinutes } : {});
  } catch (err) {
    logger.warn?.(`critical-classifier[${agent}]: findRecentUnclassified failed: ${describeError(err)}`);
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
  let skippedInactive = 0;
  let skippedDreams = 0;
  let skippedChunks = 0;
  let skippedDeferred = 0;
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
      logger.warn?.(`critical-classifier[${agent}]: findPendingCriticalReviews failed: ${describeError(err)}`);
    }
  }

  // Nur lebende Nicht-Traum-Karten zählen als Ganzes, sonst bliebe ein Teil
  // ohne klassifizierbares Gegenstück ungeprüft.
  const coverage = chunkCoverage(recent.filter((card) => isActiveCard(card) && !isDreamCard(card)));
  const coveredChunkIds = new Set(coverage.keys());

  // Teilstücke eines Ganzen, das selbst klassifiziert wird: ohne Modellaufruf
  // als "fakt" typen, und zwar VOR dem Ganzen. Nur überspringen reicht nicht —
  // das Teil bliebe unklassifiziert und käme im nächsten Lauf allein, also
  // wieder doppelt. Dieselbe Folge hat ein gescheitertes Update, wenn das
  // Ganze schon klassifiziert (und damit aus den Kandidaten) ist: Ganze, deren
  // Teile sich nicht typen ließen, bleiben in diesem Lauf unangetastet, damit
  // der nächste Lauf sie wieder mit ihren Teilen sieht.
  const deferredWholeIds = new Set();
  const typedChunkIds = new Set();
  if (typeof db.updateCardType === "function") {
    for (const card of recent) {
      if (!coveredChunkIds.has(card.id)) continue;
      try {
        await db.updateCardType(agent, card.id, "fakt");
        typedChunkIds.add(card.id);
        skippedChunks += 1;
      } catch (err) {
        logger.warn?.(`critical-classifier[${agent}]: updateCardType failed for ${card.id}: ${describeError(err)}`);
        errors.push({ stage: "updateCardType", id: card.id, error: err.message });
        for (const wholeId of coverage.get(card.id) || []) deferredWholeIds.add(wholeId);
      }
    }
  }

  for (const card of recent) {
    // Zweite Sperre neben der Kandidatenabfrage: eine getombstonte Karte
    // (status "deleted", siehe MemoryDB.tombstone) wird weder klassifiziert
    // noch gepusht. Ein Push würde eine Referenz nennen, die der Review-Pfad
    // nicht kennt, und der Klassifikator würde einen Löscheintrag umtypen.
    if (!isActiveCard(card)) {
      skippedInactive += 1;
      continue;
    }
    // Zweite Sperre für Träume neben der Kandidatenabfrage: ein Traum wird nie
    // klassifiziert und nie gepusht, auch nicht mit Wichtigkeitssignal.
    if (isDreamCard(card)) {
      skippedDreams += 1;
      continue;
    }
    // Bereits im Vorlauf behandelt (oder dort gescheitert und beim nächsten Lauf
    // erneut dran): ein abgedecktes Teil wird nie einzeln klassifiziert.
    if (coveredChunkIds.has(card.id)) continue;
    if (deferredWholeIds.has(card.id)) {
      skippedDeferred += 1;
      continue;
    }
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
        logger.warn?.(`critical-classifier[${agent}]: updateCardType failed for ${card.id}: ${describeError(err)}`);
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
    const message = buildPushMessage({ ...card, shortRef }, { hideTypes });

    if (typeof telegramSend === "function") {
      // Direkter Versand (sobald das SDK eine outbound-API bereitstellt).
      try {
        await telegramSend(message);
      } catch (err) {
        logger.warn?.(`critical-classifier[${agent}]: telegramSend failed for ${card.id}: ${describeError(err)}`);
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
      // Kompakter Text für die Knopf-Variante (7.16.10), ohne Befehlszeilen.
      buttonText: buildCriticalButtonCardText({ ...card, shortRef }, { hideTypes }),
    });
    pushed += 1;
  }

  return {
    processed,
    pushed,
    classified,
    ...(skippedInactive > 0 ? { skippedInactive } : {}),
    ...(skippedDreams > 0 ? { skippedDreams } : {}),
    ...(skippedChunks > 0 ? { skippedChunks } : {}),
    ...(skippedDeferred > 0 ? { skippedDeferred } : {}),
    pushMessages,
    errors: errors.length,
    errorDetails: errors.slice(0, 5),
  };
}

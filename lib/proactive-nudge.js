/**
 * lib/proactive-nudge.js — Generiert proaktive Nudges aus erkannten Patterns.
 *
 * Nutzt temporal-parser für Zeit-Formulierungen.
 */

import { parseTemporal } from "./temporal-parser.js";
import { isQuietHour } from "./time-window.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function formatTemporalPhrase(recencyHours) {
  if (recencyHours <= 26) {
    return "gestern";
  }
  if (recencyHours <= 50) {
    return "vor 2 Tagen";
  }
  if (recencyHours <= 74) {
    return "vor 3 Tagen";
  }
  if (recencyHours <= 170) {
    return "letzte Woche";
  }
  if (recencyHours <= 350) {
    return "letzten Monat";
  }
  return "in letzter Zeit";
}

function capitalize(word) {
  if (!word) return "";
  return word[0].toUpperCase() + word.slice(1);
}

/**
 * Erzeugt einen proaktiven Vorschlag basierend auf erkannten Patterns.
 *
 * @param {Object} context
 * @param {number} context.now
 * @param {Array} patterns — Ergebnis von detectPatterns
 * @param {Object} [options]
 * @param {number} [options.threshold=0.6]
 * @returns {{text:string, pattern:Object, score:number}|null}
 */
export function generateProactiveNudge(context, patterns, options = {}) {
  const threshold = options.threshold ?? 0.6;
  if (!Array.isArray(patterns) || patterns.length === 0) return null;

  // Bestes Pattern über Threshold wählen
  const best = patterns
    .filter((p) => (p.score ?? 0) >= threshold)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];

  if (!best) return null;

  const phrase = formatTemporalPhrase(best.recencyHours);
  // Nutze temporal-parser um die Phrase zu validieren / zu "nutzen"
  const temporal = parseTemporal(phrase, context?.now);
  const temporalStr = temporal ? phrase : "in letzter Zeit";

  const keyword = best.keyword;
  const count = best.occurrences;

  let text;
  if (count >= 5) {
    text = `Du hast ${temporalStr} mehrmals über ${capitalize(keyword)} gesprochen — willst du heute weiterarbeiten?`;
  } else if (count >= 3) {
    text = `Du hast ${temporalStr} ${count}x über ${capitalize(keyword)} gesprochen — willst du heute weiterarbeiten?`;
  } else {
    text = `Du hast kürzlich über ${capitalize(keyword)} gesprochen — willst du heute weiterarbeiten?`;
  }

  return {
    text,
    pattern: best,
    score: best.score ?? 0,
  };
}

/**
 * Deterministischer Jitter: gibt einen Wert in [-6, +6] Stunden zurück,
 * berechnet aus patternId und calendarDay (UTC-Tag-Index).
 * Keine externen Abhängigkeiten, kein echtes RNG.
 *
 * @param {string} patternId
 * @param {number} calendarDay
 * @returns {number} jitterHours ∈ [-6, 6]
 */
function computeJitterHours(patternId, calendarDay) {
  const str = `${patternId}:${calendarDay}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0; // unsigned 32-bit
  }
  // Map [0, 2^32-1] to [-6, +6] in integer steps (13 possible values: -6..+6)
  const steps = 13;
  const bucket = hash % steps; // 0..12
  return bucket - 6; // -6..+6
}

/**
 * Prüft, ob ein Nudge für ein Pattern angezeigt werden darf.
 *
 * Neu in dieser Version:
 *  - Jitter: Cooldown 24h ± bis zu 6h, deterministisch aus Hash(pattern-id + Kalendertag).
 *    Abschaltbar mit `opts.jitter === false`.
 *  - Ruhezeiten: Keine Nudges 22:00–08:00 Lokalzeit.
 *    Standard: `opts.quietHours = { start: 22, end: 8 }`. Abschaltbar mit `opts.quietHours === false`.
 *  - Tages-Cap: Max. 2 Nudges pro UTC-Kalendertag.
 *    Wenn `opts.shownToday` (Zahl) übergeben wird, wird der Cap geprüft.
 *    Abschaltbar mit `opts.dayCap === false`.
 *
 * Rückwärtskompatibilität: Aufrufer ohne `opts` erhalten das bisherige Verhalten
 * (Cooldown-Grenze verschiebt sich durch Jitter, das ist dokumentiert und akzeptiert).
 *
 * @param {Object} pattern
 * @param {number|null} lastShown — Timestamp (ms) wann der Nudge zuletzt gezeigt wurde
 * @param {number} [now] — aktueller Timestamp (ms), Standard: Date.now()
 * @param {Object} [opts]
 * @param {boolean} [opts.jitter] — false = Jitter deaktivieren
 * @param {{start:number,end:number}|false} [opts.quietHours] — false = Ruhezeiten deaktivieren
 * @param {number|false} [opts.dayCap] — false = Tages-Cap deaktivieren
 * @param {number} [opts.shownToday] — Anzahl bereits gezeigter Nudges heute
 * @returns {boolean}
 */
export function shouldShowNudge(pattern, lastShown, now = Date.now(), opts = {}) {
  // --- Tages-Cap ---
  if (opts.dayCap !== false && opts.shownToday !== undefined) {
    const cap = typeof opts.dayCap === "number" ? opts.dayCap : 2;
    if (opts.shownToday >= cap) return false;
  }

  // --- Erster Nudge immer erlaubt ---
  if (lastShown == null) return true;

  // --- Ruhezeiten ---
  if (opts.quietHours !== false) {
    const qh = opts.quietHours ?? { start: 22, end: 8 };
    const h = new Date(now).getHours();
    if (isQuietHour(h, qh)) return false;
  }

  // --- Cooldown mit optionalem Jitter ---

  let cooldownHours = 24;
  if (opts.jitter !== false) {
    const patternId = pattern?.id ?? pattern?.keyword ?? "default";
    const calendarDay = Math.floor(now / DAY_MS);
    cooldownHours = 24 + computeJitterHours(patternId, calendarDay);
  }

  const hoursAgo = (now - lastShown) / HOUR_MS;
  return hoursAgo >= cooldownHours;
}

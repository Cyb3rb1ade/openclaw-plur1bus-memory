/**
 * lib/proactive-nudge.js — Generiert proaktive Nudges aus erkannten Patterns.
 *
 * Nutzt temporal-parser für Zeit-Formulierungen.
 */

import { parseTemporal } from "./temporal-parser.js";

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
 * Prüft, ob ein Nudge für ein Pattern angezeigt werden darf.
 *
 * @param {Object} pattern
 * @param {number|null} lastShown — Timestamp (ms) wann der Nudge zuletzt gezeigt wurde
 * @returns {boolean}
 */
export function shouldShowNudge(pattern, lastShown, now = Date.now()) {
  if (lastShown == null) return true;
  const hoursAgo = (now - lastShown) / HOUR_MS;
  return hoursAgo >= 24;
}

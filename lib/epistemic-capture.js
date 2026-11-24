/**
 * lib/epistemic-capture.js — decide observed vs untrusted for new writes.
 */

import { isInjectedContextText, looksLikePromptInjection } from "./neo-arch.js";

// Die Capture-Herkünfte aus 7.20.10 (subagent, helper, inter_session; siehe
// CAPTURE_ORIGINS in lib/categorize.js) gehören bewusst nicht dazu: Sie sind
// nur eine Kennzeichnung. Als "untrusted" bekämen sie −0,15 in jedem Recall-
// Pfad und fielen als Skill-Miner-Beleg weg; abgewertet werden darf nur
// inhaltsleeres im Auto-Recall (lib/recall-quality.js). Ob inter_session aus
// Sicherheitsgründen untrusted sein soll, ist eine eigene Entscheidung.
const NON_USER_ORIGINS = new Set(["cron", "internal", "dream"]);

/**
 * @param {object} input
 * @param {string} [input.text]
 * @param {string} [input.sourceMessageRole]
 * @param {string} [input.origin]
 * @returns {"observed"|"untrusted"}
 */
export function decideEpistemicStatusForCapture(input = {}) {
  if (input.cutoffFailed === true) return "untrusted";
  const role = String(input.sourceMessageRole || "").trim().toLowerCase();
  const origin = String(input.origin || "").trim().toLowerCase();
  const text = String(input.text || "");
  if (role !== "user") return "untrusted";
  if (NON_USER_ORIGINS.has(origin)) return "untrusted";
  if (isInjectedContextText(text)) return "untrusted";
  if (looksLikePromptInjection(text)) return "untrusted";
  return "observed";
}

/**
 * Last-line store default: never persist "".
 * @param {*} value
 * @returns {string}
 */
export function coerceNewWriteEpistemicStatus(value) {
  if (value == null || value === "") return "untrusted";
  return String(value);
}

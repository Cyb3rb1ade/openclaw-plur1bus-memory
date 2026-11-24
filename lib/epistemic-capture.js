/**
 * lib/epistemic-capture.js — decide observed vs untrusted for new writes.
 */

import { isInjectedContextText, looksLikePromptInjection } from "./neo-arch.js";

// 7.20.10: auch die Capture-Herkünfte aus lib/categorize.js (CAPTURE_ORIGINS).
// Der "User" einer Subagent-Sitzung ist der Auftrag des Elternagenten, eine
// inter_session-Eingabe kommt aus einer anderen Sitzung — beides hat kein
// Mensch gesagt, also nicht "observed".
const NON_USER_ORIGINS = new Set(["cron", "internal", "dream", "subagent", "helper", "inter_session"]);

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

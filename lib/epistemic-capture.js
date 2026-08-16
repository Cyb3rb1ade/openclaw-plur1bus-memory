/**
 * lib/epistemic-capture.js — decide observed vs untrusted for new writes.
 */

import { isInjectedContextText, looksLikePromptInjection } from "./neo-arch.js";

const NON_USER_ORIGINS = new Set(["cron", "internal", "dream"]);

/**
 * @param {object} input
 * @param {string} [input.text]
 * @param {string} [input.sourceMessageRole]
 * @param {string} [input.origin]
 * @returns {"observed"|"untrusted"}
 */
export function decideEpistemicStatusForCapture(input = {}) {
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

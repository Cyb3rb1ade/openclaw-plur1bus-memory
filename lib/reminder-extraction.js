/**
 * lib/reminder-extraction.js
 * Gate-Logik für die Reminder-Extraktion aus Auto-Capture-Items.
 *
 * Bündelt die drei Bedingungen, unter denen aus einer erfassten Nachricht ein
 * Reminder entstehen darf. Vorher lief das ungefiltert über jedes Item — auch
 * über die eigenen Antworten des Agenten, was eine Schleife ergab: der Agent
 * schreibt "ich melde mich in einer halben Stunde", bekommt 30 Minuten später
 * einen fälligen Reminder ohne Thema und schreibt darauf erneut.
 */

import { parseReminderIntent } from "./reminder-parser.js";

/**
 * @param {{role?: string, text?: string}} item — Capture-Item
 * @param {Object} opts
 * @param {boolean} [opts.enabled=true] — Feature-Schalter (reminders.autoExtract)
 * @param {number} [opts.now] — epoch ms
 * @returns {{skip: true, reason: "disabled"|"not_user_role"|"no_time"}
 *          |{skip: false, parsed: ReturnType<typeof parseReminderIntent>}}
 */
export function planReminderExtraction(item, opts = {}) {
  const { enabled = true, now = Date.now() } = opts;

  if (enabled === false) return { skip: true, reason: "disabled" };

  // Nur echte User-Aussagen. Agent-, System- und Tool-Turns nie.
  if (item?.role !== "user") return { skip: true, reason: "not_user_role" };

  const parsed = parseReminderIntent(item?.text, { now });
  if (!parsed.remindAt || parsed.timePrecision === "none") {
    return { skip: true, reason: "no_time" };
  }

  return { skip: false, parsed };
}

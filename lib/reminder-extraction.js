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

/** Obergrenze fuer den gespeicherten Reminder-Text. */
const MAX_REMINDER_TEXT = 200;

/**
 * Baut den Reminder-Text aus dem Ursprungssatz statt aus der blossen
 * Zeitfloskel. Vorher wurde nur `parsed.evidence` gespeichert ("in 10 minuten"),
 * der Reminder hatte also kein Thema und der Agent erfand beim faelligen Nudge
 * eines dazu. Genommen wird der Satz, der die Zeitangabe traegt — nicht die
 * ganze Nachricht, damit der Nudge knapp bleibt.
 *
 * @param {string} fullText — Text des Capture-Items
 * @param {string} evidence — erkannte Zeitfloskel
 * @returns {string} Ursprungssatz (max. MAX_REMINDER_TEXT Zeichen), sonst evidence
 */
export function buildReminderText(fullText, evidence) {
  const text = String(fullText ?? "").replace(/\s+/g, " ").trim();
  const ev = String(evidence ?? "").trim();
  if (!text || !ev) return ev;

  const idx = text.toLowerCase().indexOf(ev.toLowerCase());
  if (idx === -1) return ev;

  const before = text.slice(0, idx);
  const lastEnd = Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? "));
  const startIdx = lastEnd === -1 ? 0 : lastEnd + 2;

  const after = text.slice(idx);
  const endRel = after.search(/[.!?](\s|$)/);
  const endIdx = endRel === -1 ? text.length : idx + endRel + 1;

  let sentence = text.slice(startIdx, endIdx).trim();
  if (!sentence) return ev;
  if (sentence.length > MAX_REMINDER_TEXT) {
    sentence = sentence.slice(0, MAX_REMINDER_TEXT - 1).replace(/\s+\S*$/, "") + "\u2026";
  }
  return sentence;
}

/**
 * @param {{role?: string, text?: string}} item — Capture-Item
 * @param {Object} opts
 * @param {boolean} [opts.enabled=true] — Feature-Schalter (reminders.autoExtract)
 * @param {number} [opts.now] — epoch ms
 * @returns {{skip: true, reason: "disabled"|"not_user_role"|"no_time"}
 *          |{skip: false, parsed: ReturnType<typeof parseReminderIntent>, reminderText: string}}
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

  return { skip: false, parsed, reminderText: buildReminderText(item?.text, parsed.evidence) };
}

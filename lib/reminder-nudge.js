/**
 * lib/reminder-nudge.js
 * Formats due reminders into a prependContext nudge string.
 */

import { t } from "./i18n.js";

function xmlEscape(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatReminderNudge(reminders, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  if (!reminders || reminders.length === 0) return "";

  const now = Date.now();
  const lines = [t("reminder.due_header", { lang, tone })];

  for (const r of reminders) {
    const dueMs = now - (r.remindAt || 0);
    const dueMin = Math.max(0, Math.floor(dueMs / 60000));
    const dueHours = Math.floor(dueMin / 60);
    const elapsed = dueHours > 0 ? `${dueHours}h ${dueMin % 60}m` : `${dueMin}m`;

    lines.push(t("reminder.due_item", { lang, tone, vars: { text: xmlEscape(r.text), elapsed } }));
  }

  return `<reminder-nudge>\n${lines.join("\n")}\n</reminder-nudge>`;
}

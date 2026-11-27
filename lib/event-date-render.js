/**
 * lib/event-date-render.js — `event-date` / `event-ago` attributes for a
 * recalled record (V3a, recall.eventDateRender, default off).
 *
 * The event date is the resolved date of what a record describes ("last
 * weekend" said on 2026-10-19 → 2026-10-17..2026-10-18), taken from the
 * enrichment sidecar. It is rendered only when the sidecar has a resolved
 * date for the record's current text; it never replaces `created-at` (when
 * the record was written) and never touches validFrom/validUntil.
 */

import { DEFAULT_EVENT_TIME_ZONE, civilDayInZone, parseYmd } from "./enrichment/date-resolver.js";

const DAY_MS = 86_400_000;

/** Prompt line added once when at least one record carries an event date. */
export const EVENT_DATE_INSTRUCTION = "EVENT DATE: event-date is the resolved date of the event a record describes (when it happened or is planned; a month or a span when only that is known), event-ago its distance from today. Prefer it over created-at when asked when something happened.";

/**
 * Normalised recall.eventDateRender.
 *
 * @param {unknown} cfg
 * @returns {{enabled: boolean, timeZone: string}}
 */
export function normalizeEventDateRenderConfig(cfg) {
  const s = cfg && typeof cfg === "object" ? cfg : {};
  return {
    enabled: s.enabled === true,
    timeZone: typeof s.timeZone === "string" && s.timeZone ? s.timeZone : DEFAULT_EVENT_TIME_ZONE,
  };
}

function plural(n, unit) {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function monthIndex(cd) {
  const d = new Date(cd);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

function relativeDays(days) {
  const n = Math.abs(days);
  if (n === 0) return "today";
  if (n === 1) return days < 0 ? "yesterday" : "tomorrow";
  let label;
  if (n < 14) label = plural(n, "day");
  else if (n < 60) label = plural(Math.round(n / 7), "week");
  else if (n < 730) label = plural(Math.round(n / 30.4375), "month");
  else label = plural(Math.round(n / 365.25), "year");
  return days < 0 ? `${label} ago` : `in ${label}`;
}

function relativeMonths(months, unitLabels) {
  if (months === 0) return unitLabels.current;
  if (months === -1) return unitLabels.previous;
  if (months === 1) return unitLabels.next;
  const n = Math.abs(months);
  const label = unitLabels.unit === "year" ? plural(n, "year") : n < 24 ? plural(n, "month") : plural(Math.round(n / 12), "year");
  return months < 0 ? `${label} ago` : `in ${label}`;
}

/**
 * The two attribute values for one event, or null when the event has no
 * valid resolved date.
 *
 * @param {{from?: string, until?: string, precision?: string}|null|undefined} event sidecar event
 * @param {{now?: number, timeZone?: string, onError?: Function}} [opts] `onError` receives
 *   the error of an invalid zone (today is then taken in UTC)
 * @returns {{date: string, ago: string}|null} `date` is "YYYY-MM-DD", "YYYY-MM", "YYYY" or
 *   "YYYY-MM-DD..YYYY-MM-DD" for a span
 */
export function formatEventDate(event, { now = Date.now(), timeZone = DEFAULT_EVENT_TIME_ZONE, onError = null } = {}) {
  if (!event || typeof event !== "object") return null;
  const fromCd = parseYmd(event.from);
  const untilCd = parseYmd(event.until);
  if (fromCd == null || untilCd == null || untilCd < fromCd) return null;
  let todayCd;
  try {
    todayCd = parseYmd(civilDayInZone(now, timeZone));
  } catch (error) {
    // Invalid zone: reported to the caller, today taken in UTC (as formatStateDate does).
    if (typeof onError === "function") onError(error);
    todayCd = parseYmd(civilDayInZone(now, "UTC"));
  }
  if (todayCd == null) return null;
  const precision = event.precision;
  if (precision === "year") {
    const year = event.from.slice(0, 4);
    const years = Number(year) - new Date(todayCd).getUTCFullYear();
    return { date: year, ago: relativeMonths(years, { unit: "year", current: "this year", previous: "last year", next: "next year" }) };
  }
  if (precision === "month") {
    const months = monthIndex(fromCd) - monthIndex(todayCd);
    return { date: event.from.slice(0, 7), ago: relativeMonths(months, { unit: "month", current: "this month", previous: "last month", next: "next month" }) };
  }
  if (fromCd === untilCd) {
    return { date: event.from, ago: relativeDays(Math.round((fromCd - todayCd) / DAY_MS)) };
  }
  // A span (week, range): distance to its nearer end, "current" inside it.
  const date = `${event.from}..${event.until}`;
  if (todayCd >= fromCd && todayCd <= untilCd) return { date, ago: "current" };
  const days = todayCd > untilCd ? Math.round((untilCd - todayCd) / DAY_MS) : Math.round((fromCd - todayCd) / DAY_MS);
  return { date, ago: relativeDays(days) };
}

/**
 * ` event-date="…" event-ago="…"` for a record, or "" when the record has no
 * resolved event date.
 *
 * Both values are built here from validated dates and a fixed vocabulary,
 * so they need no escaping; anything else is dropped.
 *
 * @param {object|null|undefined} event
 * @param {{now?: number, timeZone?: string, onError?: Function}} [opts]
 * @returns {string}
 */
export function buildEventDateAttributes(event, opts = {}) {
  const formatted = formatEventDate(event, opts);
  if (!formatted || !SAFE_VALUE.test(formatted.date) || !SAFE_VALUE.test(formatted.ago)) return "";
  return ` event-date="${formatted.date}" event-ago="${formatted.ago}"`;
}

const SAFE_VALUE = /^[A-Za-z0-9 .-]{1,40}$/;

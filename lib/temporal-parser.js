/**
 * lib/temporal-parser.js — Extrahiert Zeit-Anchor aus natürlichsprachigen Queries.
 *
 * Unterstützt deutsche und englische Zeit-Ausdrücke.
 * Rückgabe:
 *   { type: "range", from: number, to: number }
 *   { type: "anchor", referenceQuery: string }
 *   null
 */

const DAY_MS = 86400_000;
const HOUR_MS = 3600_000;

const DE_MONTHS = {
  januar: 0, februar: 1, märz: 2, maerz: 2, april: 3, mai: 4, juni: 5,
  juli: 6, august: 7, september: 8, oktober: 9, november: 10, dezember: 11,
};

const EN_MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

const WEEKDAYS = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0,
  montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonntag: 0,
};

function startOfUTCDay(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function previousWeekdayUTC(ts, targetDay) {
  const d = new Date(ts);
  const currentDay = d.getUTCDay(); // 0=Sun ... 6=Sat
  let diff = currentDay - targetDay;
  if (diff <= 0) diff += 7;
  const result = new Date(ts);
  result.setUTCDate(result.getUTCDate() - diff);
  result.setUTCHours(0, 0, 0, 0);
  return result.getTime();
}

/**
 * Extrahiert einen temporalen Anchor aus einem Query-String.
 *
 * @param {string} query
 * @param {number} [now=Date.now()]
 * @returns {{type:"range",from:number,to:number}|{type:"anchor",referenceQuery:string}|null}
 */
export function parseTemporal(query, now = Date.now()) {
  if (!query || typeof query !== "string") return null;
  const lower = query.toLowerCase();

  // ─── Anchor: "nach dem X" / "after the X" ────────────────────────────────
  // Nutze original-cased query, damit der Begriff erhalten bleibt.
  const anchorMatch =
    query.match(/nach\s+dem\s+(.+)$/i) ||
    query.match(/after\s+the\s+(.+)$/i);
  if (anchorMatch) {
    const ref = anchorMatch[1].trim();
    if (ref) {
      return { type: "anchor", referenceQuery: ref };
    }
  }

  // ─── Heute / Today ───────────────────────────────────────────────────────
  if (/\b(heute|today)\b/.test(lower)) {
    const from = startOfUTCDay(now);
    return { type: "range", from, to: now };
  }

  // ─── Gestern / Yesterday ─────────────────────────────────────────────────
  if (/\b(gestern|yesterday)\b/.test(lower)) {
    const todayStart = startOfUTCDay(now);
    return { type: "range", from: todayStart - DAY_MS, to: todayStart };
  }

  // ─── Relativ: "vor N Tagen" / "N days ago" ───────────────────────────────
  // Das soll den EINZELNEN Tag abdecken (von 00:00 UTC bis 00:00 UTC+1)
  const daysAgoMatch =
    lower.match(/\b(vor\s+(\d+)\s+tagen)\b/) ||
    lower.match(/\b((\d+)\s+days?\s+ago)\b/);
  if (daysAgoMatch) {
    const n = parseInt(daysAgoMatch[2], 10);
    if (n > 0 && n < 10000) {
      const target = new Date(now);
      target.setUTCDate(target.getUTCDate() - n);
      target.setUTCHours(0, 0, 0, 0);
      const from = target.getTime();
      return { type: "range", from, to: from + DAY_MS };
    }
  }

  // ─── Relativ: "vor N Stunden" / "N hours ago" ────────────────────────────
  const hoursAgoMatch =
    lower.match(/\b(vor\s+(\d+)\s+stunden)\b/) ||
    lower.match(/\b((\d+)\s+hours?\s+ago)\b/);
  if (hoursAgoMatch) {
    const n = parseInt(hoursAgoMatch[2], 10);
    if (n > 0 && n < 10000) {
      return { type: "range", from: now - n * HOUR_MS, to: now };
    }
  }

  // ─── Relativ: "letzte Woche" / "last week" ───────────────────────────────
  if (/\b(letzte\s+woche|last\s+week)\b/.test(lower)) {
    return { type: "range", from: now - 7 * DAY_MS, to: now };
  }

  // ─── Relativ: "letzten Monat" / "last month" ─────────────────────────────
  if (/\b(letzten?\s+monat|last\s+month)\b/.test(lower)) {
    return { type: "range", from: now - 30 * DAY_MS, to: now };
  }

  // ─── Absolut: Monat + Jahr "im Mai 2026" / "in May 2026" ─────────────────
  const monthYearMatch =
    lower.match(/\b(im\s+([a-zäöüß]+)\s+(\d{4}))\b/) ||
    lower.match(/\b(in\s+([a-z]+)\s+(\d{4}))\b/);
  if (monthYearMatch) {
    const monthName = monthYearMatch[2];
    const year = parseInt(monthYearMatch[3], 10);
    const idx = DE_MONTHS[monthName] ?? EN_MONTHS[monthName];
    if (idx !== undefined && year >= 1970 && year < 3000) {
      const from = Date.UTC(year, idx, 1);
      const to = Date.UTC(year, idx + 1, 1);
      return { type: "range", from, to };
    }
  }

  // ─── Absolut: Monat allein "im Mai" / "in May" (aktueller Kontext) ───────
  const monthOnlyMatch =
    lower.match(/\b(im\s+([a-zäöüß]+))\b/) ||
    lower.match(/\b(in\s+([a-z]+))\b/);
  if (monthOnlyMatch) {
    const monthName = monthOnlyMatch[2];
    const idx = DE_MONTHS[monthName] ?? EN_MONTHS[monthName];
    if (idx !== undefined) {
      const d = new Date(now);
      const year = d.getUTCFullYear();
      const from = Date.UTC(year, idx, 1);
      const to = Math.min(Date.UTC(year, idx + 1, 1), now);
      return { type: "range", from, to };
    }
  }

  // ─── Wochentag "am Montag" / "on Monday" ─────────────────────────────────
  const weekdayMatch =
    lower.match(/\b(am\s+([a-z]+))\b/) ||
    lower.match(/\b(on\s+([a-z]+))\b/);
  if (weekdayMatch) {
    const dayName = weekdayMatch[2];
    const targetDay = WEEKDAYS[dayName];
    if (targetDay !== undefined) {
      const from = previousWeekdayUTC(now, targetDay);
      return { type: "range", from, to: from + DAY_MS };
    }
  }

  // ─── Jahr allein "2025" ──────────────────────────────────────────────────
  const yearMatch = lower.match(/\b(\d{4})\b/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1], 10);
    if (year >= 1970 && year < 3000) {
      const from = Date.UTC(year, 0, 1);
      const to = Date.UTC(year + 1, 0, 1);
      return { type: "range", from, to };
    }
  }

  return null;
}

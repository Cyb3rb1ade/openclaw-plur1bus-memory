/**
 * lib/time-window.js — Timezone-bewusste Stunden- und Ruhezeiten-Helfer.
 *
 * Quiet hours und Time-of-Day-Direktiven liefen bisher auf der Server-
 * Lokalzeit. Diese Helfer erlauben eine IANA-Timezone (z.B. der User-
 * Zeitzone aus der Config) — mit Fail-open auf Lokalzeit, damit fehlende
 * oder kaputte Konfiguration das bisherige Verhalten NICHT ändert.
 */

/**
 * hourInTimeZone(nowMs, timeZone) -> integer 0-23
 *
 * Falsy timeZone → Server-Lokalzeit (`new Date(nowMs).getHours()`),
 * exakt das bisherige Verhalten. IANA-String → via Intl aufgelöst;
 * en-GB kann Mitternacht als "24" rendern, daher % 24. Ungültige
 * Timezone → Fail-open auf Lokalzeit.
 *
 * @param {number} nowMs   — Timestamp in ms
 * @param {string|null} [timeZone] — IANA-Timezone, z.B. "Europe/Berlin"
 * @returns {number} Stunde 0-23
 */
export function hourInTimeZone(nowMs, timeZone) {
  if (!timeZone) return new Date(nowMs).getHours();
  try {
    const rendered = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone })
      .format(new Date(nowMs));
    const h = Number.parseInt(rendered, 10);
    if (!Number.isInteger(h)) return new Date(nowMs).getHours();
    return h % 24; // en-GB rendert Mitternacht als "24"
  } catch (_) {
    return new Date(nowMs).getHours(); // ungültige Timezone → fail-open lokal
  }
}

/**
 * isQuietHour(hour, quietHours) -> boolean, wrap-aware.
 *
 * start > end (z.B. 22-8) überspannt Mitternacht; sonst Tagesfenster.
 * Null/ungültige quietHours oder nicht-ganzzahlige Grenzen → false
 * (Ruhezeiten greifen nur bei valider Konfiguration).
 *
 * @param {number} hour — Stunde 0-23
 * @param {{start:number,end:number}|null|false} quietHours
 * @returns {boolean}
 */
export function isQuietHour(hour, quietHours) {
  if (!quietHours || !Number.isInteger(quietHours.start) || !Number.isInteger(quietHours.end)) return false;
  const { start, end } = quietHours;
  return start > end
    ? (hour >= start || hour < end)   // wrap-around (über Nacht)
    : (hour >= start && hour < end);  // non-wrapping (tagsüber)
}

/**
 * lib/time-window.js — Timezone-bewusste Stunden- und Ruhezeiten-Helfer.
 *
 * Quiet hours und Time-of-Day-Direktiven liefen bisher auf der Server-
 * Lokalzeit. Diese Helfer erlauben eine IANA-Timezone (z.B. der User-
 * Zeitzone aus der Config). Fehlende/falsy Werte behalten die historische
 * Lokalzeit; explizit ungültige Werte werden vor semantischer Nutzung verworfen.
 */

// Hot path: hourInTimeZone runs once per message when a timezone is
// configured. Intl.DateTimeFormat construction is comparatively expensive —
// memoize one formatter per distinct timeZone string instead of building a
// new one on every call.
const formatterCache = new Map();

/**
 * Validate an explicit timezone before semantic time formatting.
 * @param {string|null|undefined} timeZone
 * @param {{path?: string}} [opts]
 * @returns {string|null|undefined}
 */
export function validateTimeZone(timeZone, opts = {}) {
  const path = opts.path || "timezone";
  if (timeZone == null || timeZone === "") return timeZone;
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    const error = new RangeError(`Invalid timezone at ${path}: expected a non-whitespace IANA timezone`);
    error.code = "INVALID_TIME_CONFIG";
    error.configPath = path;
    throw error;
  }
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone }).format(0);
  } catch (cause) {
    const error = new RangeError(`Invalid timezone at ${path}: ${timeZone}`, { cause });
    error.code = "INVALID_TIME_CONFIG";
    error.configPath = path;
    throw error;
  }
  return timeZone;
}

/**
 * Validate an explicit direct-hour window before semantic use.
 * @param {{start:number,end:number}} window
 * @param {{path?: string}} [opts]
 * @returns {{start:number,end:number}}
 */
export function validateHourWindow(window, opts = {}) {
  const path = opts.path || "quietHours";
  for (const key of ["start", "end"]) {
    const value = window && typeof window === "object" && !Array.isArray(window)
      ? window[key]
      : undefined;
    if (!Number.isInteger(value) || value < 0 || value > 23) {
      const configPath = `${path}.${key}`;
      const error = new RangeError(`Invalid direct hour at ${configPath}: expected an integer from 0 through 23`);
      error.code = "INVALID_TIME_CONFIG";
      error.configPath = configPath;
      throw error;
    }
  }
  return { start: window.start, end: window.end };
}

function formatterFor(timeZone) {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * hourInTimeZone(nowMs, timeZone) -> integer 0-23
 *
 * Falsy timeZone → Server-Lokalzeit (`new Date(nowMs).getHours()`),
 * exakt das bisherige Verhalten. IANA-String → via Intl aufgelöst (Formatter
 * pro Timezone gecacht — s.o.); en-GB kann Mitternacht als "24" rendern,
 * daher % 24. Explizit ungültige Timezones werfen einen pfadfähigen Fehler.
 *
 * @param {number} nowMs   — Timestamp in ms
 * @param {string|null} [timeZone] — IANA-Timezone, z.B. "Europe/Berlin"
 * @returns {number} Stunde 0-23
 */
export function hourInTimeZone(nowMs, timeZone) {
  if (!timeZone) return new Date(nowMs).getHours();
  validateTimeZone(timeZone, { path: "timeZone" });
  const rendered = formatterFor(timeZone).format(new Date(nowMs));
  const h = Number.parseInt(rendered, 10);
  if (!Number.isInteger(h)) return new Date(nowMs).getHours();
  return h % 24; // en-GB rendert Mitternacht als "24"
}

/**
 * isQuietHour(hour, quietHours) -> boolean, wrap-aware.
 *
 * start > end (z.B. 22-8) überspannt Mitternacht; sonst Tagesfenster.
 * Null/deaktivierte quietHours → false. Explizite ungültige Grenzen werfen.
 *
 * @param {number} hour — Stunde 0-23
 * @param {{start:number,end:number}|null|false} quietHours
 * @returns {boolean}
 */
export function isQuietHour(hour, quietHours) {
  if (!quietHours) return false;
  const { start, end } = validateHourWindow(quietHours, { path: "quietHours" });
  return start > end
    ? (hour >= start || hour < end)   // wrap-around (über Nacht)
    : (hour >= start && hour < end);  // non-wrapping (tagsüber)
}

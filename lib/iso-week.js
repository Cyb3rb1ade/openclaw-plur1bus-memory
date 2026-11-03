/**
 * lib/iso-week.js — ISO-8601-Wochenschlüssel (`YYYY-Www`).
 *
 * Eine Woche gehört zu dem Jahr, in dem ihr Donnerstag liegt. Der 31.12.2025
 * liegt deshalb in 2026-W01, der 03.01.2027 noch in 2026-W53. Der Schlüssel ist
 * immer zweistellig aufgefüllt (`2026-W05`), damit er zu `\d{4}-W\d{2}` passt
 * und lexikographisch wie chronologisch sortiert.
 */

/**
 * @param {number} year Kalenderjahr des Tages.
 * @param {number} month Monat 1-12.
 * @param {number} day Tag des Monats.
 * @returns {{isoYear: number, week: number, key: string}}
 */
export function isoWeekFromYmd(year, month, day) {
  const thursday = new Date(Date.UTC(year, month - 1, day));
  const weekday = thursday.getUTCDay() || 7; // Mo=1 .. So=7
  thursday.setUTCDate(thursday.getUTCDate() + 4 - weekday);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil((((thursday.getTime() - yearStart) / 86_400_000) + 1) / 7);
  return { isoYear, week, key: `${isoYear}-W${String(week).padStart(2, "0")}` };
}

/**
 * ISO-Wochenschlüssel für die lokalen Kalenderkomponenten eines Datums.
 * @param {Date} date
 * @returns {string} z. B. `2026-W05`
 */
export function isoWeekKey(date) {
  return isoWeekFromYmd(date.getFullYear(), date.getMonth() + 1, date.getDate()).key;
}

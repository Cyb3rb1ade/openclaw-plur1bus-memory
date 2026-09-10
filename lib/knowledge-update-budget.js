/**
 * Budget und Schutz fuer die KNOWLEDGE.md-Beförderung.
 *
 * Der LLM-Aufruf gibt den **ganzen** Textkoerper zurueck, nicht nur die
 * Ergaenzung. Ein fester Deckel von 3000 Token reichte, solange die Datei klein
 * war, und lief mit ihr aus dem Ruder: am 09.09.2026 brauchte allein der
 * Bestand 2752 Token (Bernd, 11 011 Bytes) bzw. 3121 (Bernhardine, 12 487) —
 * beide Laeufe schlugen fehl, waehrend derselbe Aufruf fuer eine 1841 Bytes
 * grosse Datei durchlief.
 */

/** Konservativ gerechnet: drei Zeichen je Token, damit das Budget nicht knapp wird. */
const CHARS_PER_TOKEN = 3;

/**
 * Passendes Ausgabebudget fuer einen gegebenen Bestand.
 *
 * @param {unknown} currentBody Bisheriger Textkoerper.
 * @param {{floor?: number, cap?: number, headroom?: number}} [options]
 * @returns {number}
 */
export function resolveKnowledgeUpdateMaxTokens(currentBody, options = {}) {
  const floor = Number.isFinite(options.floor) ? options.floor : 3000;
  const cap = Number.isFinite(options.cap) ? options.cap : 16000;
  const headroom = Number.isFinite(options.headroom) ? options.headroom : 1200;
  const chars = typeof currentBody === "string" ? currentBody.length : 0;
  const needed = Math.ceil(chars / CHARS_PER_TOKEN) + headroom;
  return Math.min(cap, Math.max(floor, needed));
}

/**
 * Ist die Antwort verdaechtig kurz gegenueber dem Bestand?
 *
 * Ohne diese Pruefung wuerde eine abgeschnittene Antwort ungeprueft
 * geschrieben — der Aufruf soll integrieren, nicht kuerzen, also darf das
 * Ergebnis den Bestand nicht drastisch unterschreiten. Ein leerer Bestand
 * (erste Anlage) ist davon ausgenommen.
 *
 * @param {unknown} currentBody
 * @param {unknown} updatedBody
 * @param {{minRatio?: number}} [options]
 * @returns {boolean}
 */
export function isTruncatedKnowledgeBody(currentBody, updatedBody, options = {}) {
  const minRatio = Number.isFinite(options.minRatio) ? options.minRatio : 0.6;
  const before = typeof currentBody === "string" ? currentBody.trim().length : 0;
  if (before === 0) return false;
  const after = typeof updatedBody === "string" ? updatedBody.trim().length : 0;
  return after < before * minRatio;
}

/**
 * Zeitgrenze passend zum Ausgabebudget.
 *
 * Der Standard von 30 s (`DEFAULT_LLM_TIMEOUT_MS`) reicht, solange die Datei
 * klein ist: faxpert brauchte am 09.09.2026 rund 460 Token Ausgabe und war in
 * Sekunden fertig. Fuer Bernd (2752) und Bernhardine (3121) lief derselbe
 * Aufruf in `TimeoutError` — und zwar seit dem 01.07.2026, wie der
 * Aenderungszeitpunkt ihrer KNOWLEDGE.md zeigt. Die Zeit muss also mit der
 * Menge wachsen, die erzeugt werden soll.
 *
 * @param {number} maxTokens Ausgabebudget des Aufrufs.
 * @param {{msPerToken?: number, floor?: number, cap?: number}} [options]
 * @returns {number}
 */
export function resolveKnowledgeUpdateTimeoutMs(maxTokens, options = {}) {
  // 25 ms je Token entspricht rund 40 Token pro Sekunde — bewusst konservativ,
  // damit ein langsamer Lauf nicht knapp scheitert.
  const msPerToken = Number.isFinite(options.msPerToken) ? options.msPerToken : 25;
  const floor = Number.isFinite(options.floor) ? options.floor : 30_000;
  const cap = Number.isFinite(options.cap) ? options.cap : 180_000;
  const tokens = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0;
  return Math.min(cap, Math.max(floor, Math.ceil(tokens * msPerToken)));
}

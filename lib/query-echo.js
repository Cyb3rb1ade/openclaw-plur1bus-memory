/**
 * lib/query-echo.js — erkennt Erinnerungen, die die aktuelle Anfrage nur
 * wiederholen (Selbst-Echo).
 *
 * Hintergrund (7.20.10, Mangel 1): Schickt der Nutzer dieselbe Nachricht ein
 * zweites Mal, findet der Auto-Recall ihre eigene Kopie vom ersten Mal mit
 * Ähnlichkeit ~1,0 und setzt sie an die Spitze des Blocks. Den aktuellen Turn
 * gibt es zur Recall-Zeit noch nicht als Zeile, und ein Ausschluss der ganzen
 * Sitzung träfe auch Inhalte von vor einer Kompaktierung. Das Kriterium ist
 * deshalb die Textgleichheit mit der Anfrage.
 *
 * Rein: neo-arch.js und die LanceDB-Pipeline importieren das Modul, es selbst
 * importiert nur den Talk-Mode-Präfix aus lib/recall-quality.js (ebenfalls
 * ohne Abhängigkeiten). Der Neo-Worker lädt es deshalb ohne die Pipeline.
 */

import { stripTalkModePrefix } from "./recall-quality.js";

const DEFAULT_MIN_CHARS = 20;
const DEFAULT_MIN_TOKENS = 5;
const DEFAULT_MIN_JACCARD = 0.9;
// Erinnerung steckt in der Anfrage: zählt nur, wenn sie den Großteil der
// Anfrage ausmacht. Ein kurzes Zitat in einer langen Nachricht ist kein Echo.
const MEMORY_IN_QUERY_MIN_RATIO = 0.6;
// Anfrage steckt in der Erinnerung: die Erinnerung darf nur wenig mehr sein.
const QUERY_IN_MEMORY_MIN_RATIO = 0.8;

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
};

// Umschlag der Sprachnachrichten-Transkription ("[Audio transcript …]: \"…\"").
const TRANSPORT_PREFIX_RE = /^\s*\[(?:audio transcript|voice transcript|transkript)[^\]]*\]:?\s*"?/iu;
// Sprecherpräfix am Anfang ("Mr. Cy: …", "Bernd: …").
const SPEAKER_PREFIX_RE = /^\s*\p{Lu}[\p{L}\p{N}_.\- ]{0,30}:\s+/u;

function decodeHtmlEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try { return String.fromCodePoint(code); } catch (_) { return match; }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/**
 * Normalisiert Text für den Echo-Vergleich: HTML-Entities dekodieren,
 * Talk-Mode-Präfix, Transkript-Umschlag und Sprecherpräfix vorne entfernen,
 * NFKC, Kleinschreibung, alles außer Buchstaben und Ziffern wird Leerzeichen.
 * Ohne den Talk-Mode-Präfix gälten zwei verschiedene kurze Sprachbefehle über
 * die vielen gemeinsamen Präfixwörter als Echo (Wort-Jaccard ≥ 0,9).
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeForEcho(text) {
  let s = stripTalkModePrefix(decodeHtmlEntities(String(text ?? "")));
  s = s.replace(TRANSPORT_PREFIX_RE, "").replace(SPEAKER_PREFIX_RE, "");
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokenSet(normalized) {
  const out = new Set();
  for (const token of normalized.split(" ")) if (token.length > 1) out.add(token);
  return out;
}

function jaccardOf(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function resolveOptions(opts = {}) {
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    minChars: Math.max(1, num(opts.minChars, DEFAULT_MIN_CHARS)),
    minTokens: Math.max(1, num(opts.minTokens, DEFAULT_MIN_TOKENS)),
    minJaccard: Math.min(1, Math.max(0, num(opts.minJaccard, DEFAULT_MIN_JACCARD))),
  };
}

/**
 * Baut einen Vergleicher für eine Anfrage. Die Anfrage wird einmal
 * normalisiert; der Vergleicher prüft danach beliebig viele Erinnerungen.
 * @param {string} query aktuelle Anfrage (Prompt des Nutzers)
 * @param {{minChars?: number, minTokens?: number, minJaccard?: number}} [opts]
 * @returns {(memoryText: string, matchOpts?: {chunkPart?: boolean}) => boolean}
 */
export function createQueryEchoMatcher(query, opts = {}) {
  const { minChars, minTokens, minJaccard } = resolveOptions(opts);
  const q = normalizeForEcho(query);
  if (q.length < minChars) return () => false;
  const qPadded = ` ${q} `;
  let qTokens = null;
  return (memoryText, matchOpts = {}) => {
    const m = normalizeForEcho(memoryText);
    if (m.length < minChars) return false;
    if (m === q) return true;
    // Enthaltensein nur an Wortgrenzen ("tee" steckt nicht in "teekanne").
    if (qPadded.includes(` ${m} `) && (matchOpts.chunkPart === true || m.length >= MEMORY_IN_QUERY_MIN_RATIO * q.length)) return true;
    if (` ${m} `.includes(qPadded) && q.length >= QUERY_IN_MEMORY_MIN_RATIO * m.length) return true;
    if (!qTokens) qTokens = tokenSet(q);
    if (qTokens.size < minTokens) return false;
    const mTokens = tokenSet(m);
    if (mTokens.size < minTokens) return false;
    return jaccardOf(qTokens, mTokens) >= minJaccard;
  };
}

/**
 * Liefert true, wenn eine Erinnerung die Anfrage nur wiederholt: gleicher
 * normalisierter Text, Enthaltensein in eine der beiden Richtungen (mit
 * Mindestanteil) oder Wort-Jaccard ≥ 0,9. Unter der Mindestlänge (20 Zeichen,
 * 5 Wörter) nie.
 * @param {string} memoryText Text der Erinnerung
 * @param {string} query aktuelle Anfrage
 * @param {{chunkPart?: boolean, minChars?: number, minTokens?: number, minJaccard?: number}} [opts]
 *   chunkPart: die Erinnerung ist ein Teilstück einer längeren Nachricht und
 *   zählt auch dann als Echo, wenn sie kürzer als 60 % der Anfrage ist.
 * @returns {boolean}
 */
export function isQueryEcho(memoryText, query, opts = {}) {
  return createQueryEchoMatcher(query, opts)(memoryText, { chunkPart: opts.chunkPart === true });
}

const MEMORY_SESSION_KEY_MAX_CHARS = 512;

/**
 * Normalisiert einen Sitzungsschlüssel für die Spalte `sessionKey` (LanceDB)
 * und `origin.sessionKey` (Neo): getrimmter String ohne Steuerzeichen,
 * höchstens 512 Zeichen; sonst "". Liegt hier, damit der Neo-Worker ihn ohne
 * lib/recall-pipeline.js nutzen kann; die Pipeline exportiert ihn weiter.
 * @param {unknown} value ctx.sessionKey des Hosts
 * @returns {string}
 */
export function normalizeMemorySessionKey(value) {
  if (typeof value !== "string") return "";
  const key = value.trim();
  if (!key || key.length > MEMORY_SESSION_KEY_MAX_CHARS) return "";
  if (/[\u0000-\u001f\u007f]/.test(key)) return "";
  return key;
}

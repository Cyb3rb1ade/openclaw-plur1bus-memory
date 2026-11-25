/**
 * lib/recall-keyword-fallback.js — keyword and recency search without a
 * query vector (7.21.1).
 *
 * When the query embedding of the automatic recall does not arrive in time
 * (cold start, provider outage, a hanging connection) the recall used to end
 * empty: the scheduler's budget ran out while the pipeline still waited for
 * the vector. This module gives the pipeline a second way in that needs no
 * embedding: rows whose text contains words of the prompt, topped up with the
 * newest rows. The result is marked as a fallback and never replaces a
 * working vector recall. It reads the table and writes nothing.
 *
 * LanceDB has no ORDER BY on a plain query, so "newest" is approximated by a
 * createdAt window (`recentDays`) read in full (without the vector column)
 * and sorted here.
 */

import { withTimeout } from "./with-timeout.js";
import { raceAbort } from "./abort.js";

/** Default number of keywords taken from the prompt. */
export const KEYWORD_FALLBACK_MAX_KEYWORDS = 6;
/** Shortest keyword (characters); shorter tokens only count when they contain a digit. */
export const KEYWORD_FALLBACK_MIN_KEYWORD_CHARS = 4;
/** Rows read by the keyword query at most. */
export const KEYWORD_FALLBACK_KEYWORD_LIMIT = 300;
/** Rows read by the recency query at most. */
export const KEYWORD_FALLBACK_RECENT_LIMIT = 600;
/** Window of the recency query in days. */
export const KEYWORD_FALLBACK_RECENT_DAYS = 7;

const DAY_MS = 86_400_000;

// Häufige Wörter ohne Suchwert (de/en). Nur Wörter ab vier Zeichen, kürzere
// fallen ohnehin weg.
const STOPWORDS = new Set([
  "aber", "alle", "allem", "allen", "aller", "alles", "also", "andere", "anderen", "auch", "auf", "bitte", "bist", "dabei", "damit", "dann", "darf", "darum", "dass", "deine", "deinem", "deinen", "deiner", "denn", "deren", "dessen", "dich", "diese", "diesem", "diesen", "dieser", "dieses", "doch", "dort", "durch", "eigentlich", "einem", "einen", "einer", "eines", "einfach", "etwas", "euch", "eure", "gerade", "gerne", "gibt", "habe", "haben", "hast", "hatte", "hatten", "heute", "hier", "ihnen", "ihre", "ihrem", "ihren", "ihrer", "immer", "jetzt", "kann", "kannst", "keine", "keinen", "können", "könnte", "machen", "macht", "mach", "mehr", "meine", "meinem", "meinen", "meiner", "mich", "mir", "muss", "musst", "nach", "nicht", "noch", "nur", "oder", "ohne", "schon", "sehr", "sein", "seine", "seinem", "seinen", "seiner", "selbst", "sich", "sind", "soll", "sollte", "sondern", "über", "unter", "uns", "unsere", "viel", "vielleicht", "vom", "von", "wann", "warum", "warst", "weil", "welche", "welchen", "welcher", "wenn", "werde", "werden", "wieder", "wird", "wirst", "woher", "wohin", "wollen", "wurde", "wurden", "zum", "zur", "zwar", "zwischen",
  "about", "after", "again", "also", "been", "before", "being", "could", "does", "doing", "from", "have", "having", "here", "into", "just", "like", "more", "most", "only", "other", "over", "please", "should", "some", "such", "than", "that", "their", "them", "then", "there", "these", "they", "this", "those", "very", "want", "what", "when", "where", "which", "while", "will", "with", "would", "your", "yours",
]);

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

/**
 * Pick the search words of a prompt: letters/digits only, lower case,
 * without stop words, longest first (long words carry more meaning), at most
 * `max`. A token is safe inside a SQL string because it only contains letters
 * and digits.
 *
 * @param {string} query Prompt text.
 * @param {{max?: number, minChars?: number}} [opts]
 * @returns {string[]} keywords
 */
export function extractFallbackKeywords(query, { max = KEYWORD_FALLBACK_MAX_KEYWORDS, minChars = KEYWORD_FALLBACK_MIN_KEYWORD_CHARS } = {}) {
  const tokens = String(query ?? "").normalize("NFC").toLowerCase().match(TOKEN_RE) || [];
  const seen = new Set();
  const out = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    const hasDigit = /\p{N}/u.test(token);
    if (token.length < minChars && !(hasDigit && token.length >= 2)) continue;
    if (STOPWORDS.has(token)) continue;
    if (token.length > 40) continue;
    out.push(token);
  }
  out.sort((a, b) => b.length - a.length);
  return out.slice(0, Math.max(0, max));
}

/**
 * SQL predicate for rows that contain at least one keyword (case-insensitive).
 *
 * @param {string[]} keywords Output of extractFallbackKeywords.
 * @returns {string|null} predicate, or null without keywords
 */
export function buildKeywordPredicate(keywords) {
  const safe = (keywords || []).filter((k) => /^[\p{L}\p{N}]+$/u.test(k));
  if (safe.length === 0) return null;
  return `(${safe.map((k) => `lower(text) LIKE '%${k}%'`).join(" OR ")})`;
}

/**
 * Score of a fallback row: share of keywords found (0.0–0.6) plus recency
 * (0.0–0.25, half-life 7 days), plus 0.05 when the row was found by keyword
 * at all. Kept well below typical vector/rerank scores so a later merge with
 * a vector recall cannot be dominated by fallback rows.
 *
 * @param {{text?: string, createdAt?: number|bigint}} row
 * @param {string[]} keywords
 * @param {number} now
 * @returns {{score: number, matched: number}}
 */
export function scoreFallbackRow(row, keywords, now) {
  const text = String(row?.text || "").toLowerCase();
  let matched = 0;
  for (const k of keywords || []) if (text.includes(k)) matched++;
  const share = keywords?.length ? matched / keywords.length : 0;
  const created = Number(row?.createdAt);
  const ageDays = Number.isFinite(created) && created > 0 ? Math.max(0, (now - created) / DAY_MS) : 365;
  const recency = 0.25 * Math.pow(0.5, ageDays / 7);
  return { score: Math.min(0.9, (matched > 0 ? 0.05 : 0) + 0.6 * share + recency), matched };
}

async function readColumns(dbTable) {
  if (typeof dbTable?.schema !== "function") return null;
  try {
    const schema = await dbTable.schema();
    const names = (schema?.fields || []).map((f) => f?.name).filter((n) => typeof n === "string" && n && n !== "vector");
    return names.length ? names : null;
  } catch {
    return null;
  }
}

async function runQuery(dbTable, predicate, columns, limit, signal, timeoutMs, label) {
  let q = dbTable.query().where(predicate);
  if (columns && typeof q.select === "function") q = q.select(columns);
  return withTimeout(raceAbort(q.limit(limit).toArray(), signal, "recall aborted"), timeoutMs, label);
}

/**
 * Search one table by keyword and recency, without a vector. Never throws on
 * a failing sub-query: what one query found is still returned (the failure is
 * reported in `errors`). An abort of `signal` is rethrown.
 *
 * @param {object} args
 * @param {object} args.dbTable LanceDB table (`query()`, optional `schema()`).
 * @param {string} args.query Prompt text.
 * @param {number} [args.now] Epoch ms.
 * @param {number} [args.timeoutMs] Budget per sub-query.
 * @param {AbortSignal|null} [args.signal]
 * @param {number} [args.recentDays]
 * @returns {Promise<{rows: Array<{row: object, score: number, matched: number, via: "keyword"|"recent"}>, keywords: string[], errors: string[]}>}
 *   rows sorted by score (best first), each row once
 */
export async function searchKeywordRecentFallback({ dbTable, query, now = Date.now(), timeoutMs = 2_000, signal = null, recentDays = KEYWORD_FALLBACK_RECENT_DAYS }) {
  const keywords = extractFallbackKeywords(query);
  const errors = [];
  if (!dbTable || typeof dbTable.query !== "function") return { rows: [], keywords, errors: ["no-table"] };
  const columns = await readColumns(dbTable);
  const keywordPredicate = buildKeywordPredicate(keywords);
  const since = Math.floor(now - Math.max(1, recentDays) * DAY_MS);
  const tasks = [
    keywordPredicate
      ? runQuery(dbTable, `status = 'active' AND ${keywordPredicate}`, columns, KEYWORD_FALLBACK_KEYWORD_LIMIT, signal, timeoutMs, "recall-fallback.keyword")
      : Promise.resolve([]),
    runQuery(dbTable, `status = 'active' AND createdAt >= ${since}`, columns, KEYWORD_FALLBACK_RECENT_LIMIT, signal, timeoutMs, "recall-fallback.recent"),
  ];
  const settled = await Promise.allSettled(tasks);
  if (signal?.aborted) throw signal.reason ?? new Error("recall aborted");
  const byId = new Map();
  settled.forEach((result, index) => {
    const via = index === 0 ? "keyword" : "recent";
    if (result.status === "rejected") {
      errors.push(`${via}: ${String(result.reason?.message || result.reason).slice(0, 120)}`);
      return;
    }
    for (const row of result.value || []) {
      if (!row?.id) continue;
      const id = String(row.id);
      if (byId.has(id)) continue;
      const { score, matched } = scoreFallbackRow(row, keywords, now);
      byId.set(id, { row, score, matched, via: matched > 0 ? "keyword" : via });
    }
  });
  const rows = [...byId.values()].sort((a, b) => b.score - a.score || Number(b.row.createdAt ?? 0) - Number(a.row.createdAt ?? 0));
  return { rows, keywords, errors };
}

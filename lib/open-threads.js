/**
 * lib/open-threads.js — Pure helpers for open-thread detection.
 * No I/O — the caller in index.js handles file reading.
 */

const OPEN_OUTCOMES = new Set(["ignored_or_topic_shifted", "asked_details"]);
const RESOLVED_OUTCOMES = new Set(["confirmed_or_continued", "continued_topic"]);

/**
 * Cooldown-Dateiname für "heute schon als offener Faden gezeigt".
 * Von index.js (Writer) und lib/afterthought.js (Reader) geteilt.
 */
export const OPEN_THREADS_SHOWN_FILE = ".open-threads-shown.json";

/**
 * normalizeTopic(s) -> normalisiertes Thema für Vergleich/Dedup.
 * Lowercase, alle Whitespace-Läufe (inkl. Zeilenumbrüche) zu einem Space
 * kollabiert, getrimmt, DANN auf 80 Zeichen geschnitten — in dieser
 * Reihenfolge, damit Writer und Reader beim selben Eingabestring immer
 * dasselbe Ergebnis liefern, unabhängig davon, ob die Quelle vorher schon
 * (anders) geschnitten wurde.
 */
export function normalizeTopic(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * collectOpenThreads(entries, opts) -> Array<{topic, ageDays, hint}>
 *
 * @param {object[]} entries  - Parsed JSONL lines with: outcome, topic, timestamp (ms or ISO string)
 * @param {object}   opts
 * @param {number}   [opts.maxAgeDays=4]
 * @param {number}   [opts.maxResults=2]
 * @param {number}   [opts.now=Date.now()]
 */
export function collectOpenThreads(entries, opts = {}) {
  const { maxAgeDays = 4, maxResults = 2, now = Date.now() } = opts;
  const cutoff = now - maxAgeDays * 86400000;

  // Build a set of topics that have a LATER resolved entry
  const resolvedTopics = new Map(); // topic -> latest resolved timestamp
  for (const entry of entries) {
    if (!entry || !entry.topic || !RESOLVED_OUTCOMES.has(entry.outcome)) continue;
    const ts = toMs(entry.timestamp);
    if (ts === null) continue;
    const prev = resolvedTopics.get(entry.topic) ?? 0;
    if (ts > prev) resolvedTopics.set(entry.topic, ts);
  }

  // Collect open entries
  const candidates = [];
  for (const entry of entries) {
    if (!entry || !entry.topic || !OPEN_OUTCOMES.has(entry.outcome)) continue;
    const ts = toMs(entry.timestamp);
    if (ts === null || ts < cutoff) continue;

    // Skip if there's a resolved entry that is LATER than this open entry
    const resolvedTs = resolvedTopics.get(entry.topic);
    if (resolvedTs !== undefined && resolvedTs > ts) continue;

    candidates.push({ topic: entry.topic, ts, hint: entry.outcome });
  }

  // Sort most recent first, dedupe by topic (keep latest per topic)
  const seen = new Map();
  for (const c of candidates) {
    const prev = seen.get(c.topic);
    if (!prev || c.ts > prev.ts) seen.set(c.topic, c);
  }

  const sorted = [...seen.values()].sort((a, b) => b.ts - a.ts).slice(0, maxResults);

  return sorted.map(({ topic, ts, hint }) => ({
    topic,
    ageDays: Math.floor((now - ts) / 86400000),
    hint,
  }));
}

/**
 * formatOpenThreadsContext(threads) -> string | null
 * Returns a German prose context block or null if threads is empty.
 * Max ~400 chars total.
 */
export function formatOpenThreadsContext(threads) {
  if (!threads || threads.length === 0) return null;

  const header = "Offene Fäden aus früheren Gesprächen (nur ansprechen, wenn es natürlich passt, maximal einen):";
  const lines = threads.map((t) => `- ${t.topic} (vor ${t.ageDays} Tag(en))`);
  let result = header + "\n" + lines.join("\n");

  if (result.length > 400) {
    result = result.slice(0, 397) + "…";
  }

  return result;
}

// --- Internal helpers ---

function toMs(timestamp) {
  if (timestamp === null || timestamp === undefined) return null;
  if (typeof timestamp === "number") return timestamp;
  if (typeof timestamp === "string") {
    const n = Date.parse(timestamp);
    return isNaN(n) ? null : n;
  }
  return null;
}

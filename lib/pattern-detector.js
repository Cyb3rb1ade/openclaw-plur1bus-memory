/**
 * lib/pattern-detector.js — Pattern-Erkennung im Turn-Journal.
 *
 * v2: Embedding-basiertes Clustering (Cosine-Similarity).
 * Fallback auf keyword-basierte Erkennung wenn keine embedFn verfügbar.
 */

import { clusterTurnsByEmbedding } from "./pattern-detector-embedding.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const STOPWORDS = new Set([
  "ich","du","er","sie","es","wir","ihr","sie","der","die","das","ein","eine","einer","eines",
  "einem","einen","den","dem","des","und","oder","aber","denn","weil","wenn","als","wie",
  "ist","sind","war","waren","wird","werden","wurde","wurden","habe","hast","hat","haben",
  "hatte","hatten","kann","kannst","können","könnt","könnte","könnten","muss","musst","müssen",
  "müsst","müsste","darf","darfst","dürfen","soll","sollst","sollen","sollte","sollten",
  "mag","magst","mögen","möchte","möchtest","möchten","möchtet","will","willst","wollen",
  "wollte","wollten","bin","bist","sein","seine","seiner","seinen","seinem","seines","im","in",
  "an","auf","aus","bei","mit","nach","von","zu","zum","zur","für","durch","gegen","ohne","um",
  "über","unter","vor","hinter","neben","zwischen","innerhalb","außerhalb","trotz","während",
  "wegen","bis","seit","gegenüber","this","that","the","a","an","and","or","but","because",
  "if","as","like","is","are","was","were","will","would","can","could","should","shall","may",
  "might","must","have","has","had","do","does","did","be","been","being","am","of","to","for",
  "with","at","by","from","up","about","into","through","during","before","after","above",
  "below","between","under","again","further","then","once","here","there","when","where",
  "why","how","all","each","few","more","most","other","some","such","no","nor","not","only",
  "own","same","so","than","too","very","just","now","also","heute","gestern","morgen","schon",
  "noch","schon","mal","wieder","bitte","danke","gern","gerne","ja","nein","vielleicht","wohl",
  "wo","was","wer","welche","welcher","welches","welchem","welchen","diese","dieser","dieses",
  "diesem","diesen","jene","jener","jenes","jenem","jenen","man","einer","kein","keine","keiner",
  "keines","keinem","keinen","mein","meine","meiner","meines","meinem","meinen","dein","deine",
  "deiner","deines","deinem","deinen","sein","ihr","ihre","ihrer","ihres","ihrem","ihren",
  "unser","unsere","unserer","unseres","unserem","unseren","euer","eure","eurer","eures",
  "eurem","euren","their","them","they","you","your","yours","our","ours","his","her","hers",
  "its","my","mine","me","him","his","he","she","it","we","us","i",
]);

function extractKeywords(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^\wäöüß\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return normalized;
}

function getTimestamp(turn) {
  if (typeof turn.createdAt === "number") return turn.createdAt;
  if (typeof turn.timestamp === "number") return turn.timestamp;
  // Parse strings, but fall through on an unparseable date instead of returning
  // NaN: NaN slips past the `ts < cutoff` lookback filter and poisons
  // recencyHours → scorePattern → the sort comparator.
  if (typeof turn.createdAt === "string") {
    const t = new Date(turn.createdAt).getTime();
    if (Number.isFinite(t)) return t;
  }
  if (typeof turn.timestamp === "string") {
    const t = new Date(turn.timestamp).getTime();
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

function getText(turn) {
  return String(turn.content || turn.prompt || turn.response || turn.text || "");
}

function hourOf(ts) {
  return new Date(ts).getUTCHours();
}

function weekdayOf(ts) {
  return new Date(ts).getUTCDay();
}

function diversityScore(timestamps) {
  if (timestamps.length < 2) return 0;
  const hours = new Set(timestamps.map(hourOf));
  const weekdays = new Set(timestamps.map(weekdayOf));
  const hourScore = Math.min(hours.size / 4, 1);
  const weekdayScore = Math.min(weekdays.size / 3, 1);
  return (hourScore + weekdayScore) / 2;
}

/**
 * Keyword-basierte Pattern-Erkennung (v1 Fallback).
 *
 * @param {Array} turnJournal
 * @param {Object} options
 * @param {number} options.now
 * @param {number} [options.lookbackDays=30]
 * @param {number} [options.minOccurrences=3]
 * @returns {Array<{keyword:string, occurrences:number, timestamps:number[], timeDiversity:number, recencyHours:number}>}
 */
function detectPatternsKeyword(turnJournal, options = {}) {
  const now = options.now || Date.now();
  const lookbackDays = options.lookbackDays ?? 30;
  const minOccurrences = options.minOccurrences ?? 3;
  const cutoff = now - lookbackDays * DAY_MS;

  const keywordMap = new Map();

  for (const turn of turnJournal) {
    const ts = getTimestamp(turn);
    if (ts < cutoff) continue;
    const text = getText(turn);
    const keywords = extractKeywords(text);
    const seen = new Set();
    for (const kw of keywords) {
      if (seen.has(kw)) continue;
      seen.add(kw);
      if (!keywordMap.has(kw)) {
        keywordMap.set(kw, []);
      }
      keywordMap.get(kw).push(ts);
    }
  }

  const patterns = [];
  for (const [keyword, timestamps] of keywordMap) {
    if (timestamps.length < minOccurrences) continue;
    const sorted = timestamps.slice().sort((a, b) => a - b);
    const mostRecent = sorted[sorted.length - 1];
    const recencyHours = (now - mostRecent) / HOUR_MS;
    const timeDiversity = diversityScore(sorted);
    patterns.push({
      keyword,
      occurrences: sorted.length,
      timestamps: sorted,
      timeDiversity,
      recencyHours,
    });
  }

  return patterns.sort((a, b) => scorePattern(b) - scorePattern(a));
}

/**
 * Findet wiederkehrende Patterns in Turn-Entries.
 *
 * v2: Wenn embedFn übergeben wird, nutzt Embedding-basiertes Clustering.
 * Sonst Fallback auf Keyword-basierte Erkennung.
 *
 * @param {Array} turnJournal
 * @param {Object} options
 * @param {number} options.now
 * @param {number} [options.lookbackDays=30]
 * @param {number} [options.minOccurrences=3]
 * @param {(text:string) => Promise<number[]>|number[]} [options.embedFn]
 * @param {number} [options.embeddingThreshold=0.82]
 * @returns {Promise<Array>|Array} — Patterns oder Cluster
 */
export async function detectPatterns(turnJournal, options = {}) {
  if (options.embedFn) {
    const clusters = await clusterTurnsByEmbedding(turnJournal, options.embedFn, {
      threshold: options.embeddingThreshold ?? 0.82,
      minClusterSize: options.minOccurrences ?? 3,
      lookbackDays: options.lookbackDays ?? 30,
      now: options.now,
    });
    // Mappe Cluster auf das alte Pattern-Format für Kompatibilität
    return clusters.map((c) => ({
      keyword: c.representative,
      occurrences: c.occurrences,
      timestamps: c.timestamps,
      timeDiversity: c.timeDiversity,
      recencyHours: c.recencyHours,
      score: c.score,
      clusterId: c.clusterId,
      turnIds: c.turnIds,
      centroid: c.centroid,
    }));
  }
  return detectPatternsKeyword(turnJournal, options);
}

/**
 * Berechnet einen Relevanz-Score für ein Pattern.
 *
 * Score = Häufigkeit × Aktualität × Diversität
 *
 * @param {Object} pattern
 * @returns {number} 0..1
 */
export function scorePattern(pattern) {
  const occurrences = pattern.occurrences || 0;
  const recencyHours = pattern.recencyHours ?? 0;
  const timeDiversity = pattern.timeDiversity ?? 0;

  // Häufigkeit: sublinear, maximiert bei ~10 Vorkommen
  const frequency = Math.min(Math.log1p(occurrences) / Math.log1p(10), 1);

  // Aktualität: exponentieller Abfall, Halbwertszeit 168h (1 Woche)
  const recency = Math.exp(-recencyHours / 168);

  // Diversität: direkt 0..1
  const diversity = Math.min(Math.max(timeDiversity, 0), 1);

  return Math.min(frequency * recency * diversity, 1);
}

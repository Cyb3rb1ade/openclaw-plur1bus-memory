/**
 * lib/query-refiner.js — Query-Verfeinerung für Recall-Pipeline.
 *
 * Einfache hardcoded Synonym-Expansion + Stopword-Removal.
 * Keine externen Dependencies.
 */

const SYNONYM_MAP = Object.freeze({
  docker: "Container",
  container: "Docker",
  kubernetes: "K8s",
  k8s: "Kubernetes",
  setup: "Installation",
  installation: "Setup",
  config: "Konfiguration",
  configuration: "Konfiguration",
  konfiguration: "Config",
  server: "Host",
  host: "Server",
  database: "DB",
  db: "Database",
  api: "Schnittstelle",
  schnittstelle: "API",
  error: "Fehler",
  fehler: "Error",
  bug: "Fehler",
  deploy: "Deployment",
  deployment: "Deploy",
  test: "Testing",
  testing: "Test",
});

const STOPWORDS = new Set([
  // German
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "eines", "einem", "einen",
  "und", "oder", "aber", "sondern", "doch", "jedoch", "denn", "weil", "obwohl", "wenn", "als",
  "ist", "sind", "war", "waren", "wird", "werden", "wurde", "wurden", "hat", "haben", "hatte",
  "hatten", "kann", "können", "konnte", "konnten", "soll", "sollen", "sollte", "sollten",
  "muss", "müssen", "musste", "mussten", "darf", "dürfen", "darfen", "will", "wollen", "wollte",
  "wollten", "möchte", "möchten", "ich", "du", "er", "sie", "es", "wir", "ihr", "sie", "Sie",
  "mir", "dir", "ihm", "ihr", "uns", "euch", "ihnen", "mich", "dich", "ihn", "sie", "es",
  "mein", "dein", "sein", "ihr", "unser", "euer", "ihr", "meine", "deine", "seine", "ihre",
  "unsere", "euere", "ihre", "von", "zu", "zum", "zur", "bei", "mit", "ohne", "durch", "für",
  "gegen", "um", "über", "unter", "vor", "nach", "in", "an", "auf", "aus", "hinter", "neben",
  "zwischen", "diese", "dieser", "dieses", "diesen", "diesem", "jene", "jener", "jenes", "jenen",
  "jenem", "welche", "welcher", "welches", "welchen", "welchem", "was", "wer", "wo", "wann",
  "wie", "warum", "wohin", "woher", "auch", "nur", "noch", "schon", "immer", "nie", "oft",
  "sehr", "ganz", "mehr", "weniger", "am", "im", "zum", "zur", "vom", "ins", "aufs", "nach",
  // English
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "when", "where", "why", "how",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did",
  "will", "would", "shall", "should", "may", "might", "can", "could", "must", "ought",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "her", "its", "our", "their", "mine", "yours", "hers", "ours", "theirs",
  "this", "that", "these", "those", "of", "to", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below", "between", "under",
  "again", "further", "then", "once", "here", "there", "all", "any", "both", "each", "few",
  "more", "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so",
  "than", "too", "very", "just", "now",
]);

/**
 * Entfernt Stopwörter aus einem Query-String.
 * Beibehaltung des Original-Casings.
 * @param {string} query
 * @returns {string}
 */
export function removeStopwords(query) {
  if (!query) return "";
  const raw = String(query).normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ");
  const words = raw.split(/\s+/).filter(Boolean);
  const filtered = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  return filtered.join(" ");
}

/**
 * Fügt einer Query Synonyme/verwandte Begriffe hinzu.
 * Maximal 3 Expansionen pro Query.
 * @param {string} query
 * @returns {string}
 */
export function expandQuery(query) {
  if (!query) return "";
  const raw = String(query).normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ");
  const words = raw.split(/\s+/).filter(Boolean);

  const expansions = [];
  for (const w of words) {
    const syn = SYNONYM_MAP[w.toLowerCase()];
    if (syn && !expansions.includes(syn)) {
      expansions.push(syn);
    }
    if (expansions.length >= 3) break;
  }

  if (expansions.length === 0) return query;
  return `${query} ${expansions.join(" ")}`;
}

/**
 * Prüft ob Query-Refinement nötig ist.
 * @param {Array|null|undefined} results
 * @param {number} minScore
 * @returns {boolean}
 */
export function shouldRefineQuery(results, minScore) {
  if (!results || results.length === 0) return true;
  const threshold = typeof minScore === "number" ? minScore : 0.15;
  return results.every((r) => (r.score ?? 0) < threshold);
}

/**
 * Extrahiert Kontext-Keywords aus dem Top-Result.
 * Beibehaltung des Original-Casings. Nutzt summary + text kombiniert.
 * @param {Object} topResult
 * @returns {string}
 */
function extractContextKeywords(topResult) {
  if (!topResult || !topResult.entry) return "";
  const summary = topResult.entry.summary || "";
  const text = topResult.entry.text || "";
  const combined = `${summary} ${text}`.trim();
  const raw = String(combined).normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ");
  const words = raw.split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w.toLowerCase()));

  // Deduplicate while preserving order, limit to 3
  const seen = new Set();
  const picked = [];
  for (const w of words) {
    if (!seen.has(w.toLowerCase())) {
      seen.add(w.toLowerCase());
      picked.push(w);
    }
    if (picked.length >= 3) break;
  }
  return picked.join(" ");
}

/**
 * Generiert eine verfeinerte Query.
 * @param {string} query
 * @param {Array} results
 * @returns {string}
 */
export function refineQuery(query, results) {
  if (!query) return "";
  const original = String(query).trim();
  if (!original) return "";

  let refined = removeStopwords(original);
  if (!refined) {
    refined = original;
  }

  refined = expandQuery(refined);

  // Wenn es ein Top-Result gibt, das nah dran aber nicht gut genug ist,
  // füge Kontext-Keywords hinzu.
  if (results && results.length > 0) {
    const top = results[0];
    if (top && top.score !== undefined && top.score >= 0.05) {
      const ctx = extractContextKeywords(top);
      if (ctx) {
        refined = `${refined} ${ctx}`;
      }
    }
  }

  return refined.trim();
}

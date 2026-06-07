/**
 * lib/text-utils.js — pure Text-Helpers (Tokenisierung, Similarity, Summary).
 *
 * Wird von Plugin (recall-pipeline + capture) und Doctor (dupes) gemeinsam
 * genutzt. Keine externe Dependency.
 */

/**
 * Tokenisiert Text zu einem Set unique words ≥4 Zeichen.
 * Lowercased, NFKD-normalisiert, alles außer Buchstaben/Zahlen → space.
 */
export function tokenize(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(w => w.length >= 2),
  );
}

/**
 * Jaccard-Similarity zwischen zwei Texten basierend auf tokenize().
 * @returns {number} in [0, 1]; 0 wenn ein Text leer.
 */
export function jaccardSimilarity(a, b) {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Cosine-Similarity zwischen zwei Vektoren gleicher Länge.
 * @returns {number} in [-1, 1]; 0 bei verschiedenen Längen oder Null-Vektor.
 */
export function cosineSimilarityVec(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Generiert eine Summary durch Wort-Truncation. Schneidet bevorzugt an
 * Satz-Grenzen (., !, ?) wenn die letzte Punkt nicht zu früh im Text liegt.
 * Kein LLM — pure deterministische Truncation.
 */
export function generateSummary(text, maxWords = 150) {
  const words = String(text).trim().split(/\s+/);
  if (words.length <= maxWords) return text;
  const truncated = words.slice(0, maxWords).join(' ');
  const lastPunct = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? ')
  );
  if (lastPunct > truncated.length * 0.6) return truncated.slice(0, lastPunct + 1);
  return truncated + '…';
}

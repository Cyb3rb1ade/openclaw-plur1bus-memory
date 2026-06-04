/**
 * lib/jobs/skill-miner/evidence-aggregator.js
 *
 * Extracts keywords from memory objects, clusters them by Jaccard keyword
 * overlap, and computes an evidence score per cluster.
 */

import { jaccardSimilarity } from "../../text-utils.js";

function extractKeywords(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\wäöüß\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4);
}

/**
 * Aggregate memories into evidence groups based on keyword overlap.
 *
 * @param {Array<{id, text, category, origin, trustLevel, retrievalCount, contradictory}>} memories
 * @returns {Array<{memories, keywords, score, topics}>}
 */
export function aggregateEvidence(memories) {
  if (!memories || memories.length === 0) return [];

  // 1. Build keyword sets for each memory
  const items = memories.map(m => ({
    memory: m,
    keywords: extractKeywords(m.text),
  })).filter(item => item.keywords.length > 0);

  // 2. Cluster by connected components where keyword Jaccard overlap >= 0.4
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(i) {
    if (parent[i] !== i) parent[i] = find(parent[i]);
    return parent[i];
  }

  function union(i, j) {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const setA = new Set(items[i].keywords);
      const setB = new Set(items[j].keywords);
      const intersection = items[i].keywords.filter(k => setB.has(k));
      const keywordUnion = [...new Set([...items[i].keywords, ...items[j].keywords])];
      const jaccard = intersection.length / keywordUnion.length;
      if (jaccard >= 0.4) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(items[i]);
  }

  // 3. Compute scores and build result
  const results = [];
  for (const groupItems of groups.values()) {
    const groupMemories = groupItems.map(g => g.memory);

    // Aggregate keywords by frequency
    const freq = new Map();
    for (const gi of groupItems) {
      for (const kw of gi.keywords) {
        freq.set(kw, (freq.get(kw) || 0) + 1);
      }
    }
    const sortedKeywords = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([kw]) => kw);

    let score = 0;
    for (const m of groupMemories) {
      score += 1; // +1 per memory
      if (m.origin === "user_confirmation" || ["validated", "curated"].includes(m.trustLevel)) {
        score += 2;
      }
      if (["workspace_rule", "user_preference"].includes(m.category)) {
        score += 1;
      }
      if ((m.retrievalCount || 0) >= 3) {
        score += 1;
      }
      if (m.contradictory === true) {
        score -= 1;
      }
    }

    if (score < 1) continue;

    results.push({
      memories: groupMemories,
      keywords: sortedKeywords,
      score,
      topics: sortedKeywords.slice(0, 5),
    });
  }

  return results;
}

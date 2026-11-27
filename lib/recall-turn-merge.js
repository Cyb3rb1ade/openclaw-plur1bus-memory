/**
 * lib/recall-turn-merge.js — one record per turn and role in the automatic
 * recall (7.21.1, recall.mergeTurnParts).
 *
 * Bernd, 24.11.2026: "Dieselbe Antwort ist in zwei Records gesplittet (gleiche
 * Uhrzeit, unterschiedlicher Text)". A turn with several assistant messages,
 * or a message the capture stored as several statements, came back as
 * several records of the same turn and took several of the 30 places. Nothing
 * is changed in the store: records with the same sourceTurnId and the same
 * speaker role are joined into the best-ranked one for this prompt only, the
 * others free their places.
 */

const ROLE_PREFIX_RE = /^\s*(User|Assistant):\s*/i;

function roleOf(entry) {
  const role = String(entry?.sourceMessageRole || "").toLowerCase();
  if (role) return role;
  return ROLE_PREFIX_RE.exec(String(entry?.text || ""))?.[1]?.toLowerCase() || "";
}

/**
 * Grouping key: sourceTurnId plus speaker role. Rows without a turn id, and
 * rows of a chunk group (Small-to-Big already handles those), are never
 * merged.
 *
 * @param {object} entry projected recall entry
 * @returns {string} key, or "" when the row is not mergeable
 */
export function turnPartKey(entry) {
  const turnId = String(entry?.sourceTurnId || "").trim();
  if (!turnId) return "";
  if (String(entry?.chunkGroupId || "").trim()) return "";
  if (entry?.memoryClass === "dream") return "";
  return `${turnId}\u0000${roleOf(entry)}`;
}

function normalizedText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Join the records of one turn and role. The best-ranked record keeps its
 * place, id and score; its text becomes the parts in stored order
 * (createdAt, then rank), without parts that another part already contains.
 *
 * @param {Array<{entry: object, score?: number}>} results ranked list
 * @param {{logger?: object}} [opts]
 * @returns {{results: Array, merged: number}} new list and number of records folded in
 */
export function mergeTurnParts(results, { logger } = {}) {
  if (!Array.isArray(results) || results.length < 2) return { results: results || [], merged: 0 };
  const groups = new Map();
  results.forEach((result, rank) => {
    const key = turnPartKey(result?.entry);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ result, rank });
  });
  const absorbed = new Set();
  const replacement = new Map();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const head = members[0];
    const parts = [...members].sort((a, b) => (Number(a.result.entry.createdAt) || 0) - (Number(b.result.entry.createdAt) || 0) || a.rank - b.rank);
    const texts = [];
    const summaries = [];
    for (const { result } of parts) {
      const text = String(result.entry.text || "");
      const norm = normalizedText(text);
      if (!norm) continue;
      if (texts.some((existing) => normalizedText(existing).includes(norm))) continue;
      for (let i = texts.length - 1; i >= 0; i--) {
        if (norm.includes(normalizedText(texts[i]))) { texts.splice(i, 1); summaries.splice(i, 1); }
      }
      texts.push(text);
      summaries.push(String(result.entry.summary || ""));
    }
    for (const member of members.slice(1)) absorbed.add(member.result);
    const mergedFromIds = members.map((member) => member.result.entry.id);
    replacement.set(head.result, {
      ...head.result,
      entry: {
        ...head.result.entry,
        text: texts.join("\n\n"),
        // Without a summary the renderer summarizes the joined text.
        summary: summaries.every(Boolean) ? summaries.join(" … ") : "",
        mergedTurnPartIds: mergedFromIds,
      },
    });
  }
  if (absorbed.size === 0) return { results, merged: 0 };
  const out = [];
  for (const result of results) {
    if (absorbed.has(result)) continue;
    out.push(replacement.get(result) ?? result);
  }
  try { logger?.info?.(`recall-pipeline: merged ${absorbed.size} record(s) into their turn (recall.mergeTurnParts)`); } catch (_) { /* best-effort */ }
  return { results: out, merged: absorbed.size };
}

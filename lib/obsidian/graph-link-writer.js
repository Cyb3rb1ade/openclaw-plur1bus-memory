/**
 * graph-link-writer: Wikilink injection for record notes
 *
 * Provides helpers for formatting and injecting [[wikilinks]] into
 * PLUR1BUS record notes, creating a knowledge graph within Obsidian.
 */

import { buildManagedBlock, replaceManagedBlock } from "./managed-blocks.js";
import { resolveReviewPath, atomicWriteText } from "./safe-paths.js";
import { buildRecordIndex } from "./record-index.js";

/**
 * Construct a vault-relative wikilink target from a record.
 * Falls back to plur1bus_id + type if path is missing.
 *
 * @param {Object} record - Record object with path, plur1bus_id, plur1bus_type
 * @param {string} reviewRoot - Review root (e.g. "plur1bus")
 * @returns {string} Vault-relative wikilink path (no .md extension)
 */
export function formatLinkTarget(record, reviewRoot) {
  const rel =
    record.path ||
    `records/${record.plur1bus_type || record.type || "unknown"}/${record.plur1bus_id || record.id || "unknown"}.md`;
  return `${reviewRoot}/${rel.replace(/\.md$/, "")}`;
}

/**
 * Format a display title for a wikilink label.
 * Prefers: title > summary (truncated to 60 chars) > plur1bus_id > "(unbekannt)"
 *
 * @param {Object} record - Record object
 * @returns {string} Display title
 */
export function formatDisplayTitle(record) {
  if (record.title) return record.title;
  if (record.summary) return String(record.summary).slice(0, 60);
  return record.plur1bus_id || record.id || "(unbekannt)";
}

/**
 * Build a markdown list item with a wikilink.
 * Format: "- [[target|displayTitle]] _(label)_"
 *
 * @param {Object} record - Record object
 * @param {string} reviewRoot - Review root
 * @param {string} displayTitle - Display title for the link
 * @param {string} label - Memory ID or identifier for the link
 * @returns {string} Markdown link line
 */
export function buildLinkLine(record, reviewRoot, displayTitle, label) {
  const target = formatLinkTarget(record, reviewRoot);
  return `- [[${target}|${displayTitle}]] _(${label})_`;
}

/**
 * Resolve graph configuration with defaults.
 * Merges user-provided graphLinks config over defaults.
 *
 * @param {Object} rawConfig - Bridge config object
 * @returns {Object} Resolved config with all properties set
 */
export function resolveGraphConfig(rawConfig) {
  const g = rawConfig.graphLinks || {};
  return {
    maxPerNote: g.maxPerNote ?? 5,
    includeSemantic: g.includeSemantic ?? false,
    semanticThreshold: g.semanticThreshold ?? 0.78,
    blockId: g.blockId ?? "graph-links",
    tiers: Array.isArray(g.tiers) ? g.tiers : ["explicit", "type", "semantic"],
  };
}

/**
 * Collect tier1 explicit reference links for a record.
 * Processes memoryIds and sourceRefs, deduplicating and respecting maxPerNote.
 *
 * @param {Object} record - Record with memoryIds and sourceRefs arrays
 * @param {Object} byId - Index mapping IDs to record objects
 * @param {string} reviewRoot - Review root (e.g. "plur1bus")
 * @param {number} maxPerNote - Maximum links to collect
 * @returns {Array<string>} Array of markdown link lines
 */
export function collectTier1Links(record, byId, reviewRoot, maxPerNote) {
  const links = [];
  const seen = new Set();
  const addLink = (id, label) => {
    if (links.length >= maxPerNote || seen.has(id)) return;
    const target = byId[id];
    if (!target) return;
    seen.add(id);
    links.push(buildLinkLine(target, reviewRoot, formatDisplayTitle(target), label));
  };
  for (const id of Array.isArray(record.memoryIds) ? record.memoryIds : []) addLink(id, "memoryId");
  for (const id of Array.isArray(record.sourceRefs) ? record.sourceRefs : []) addLink(id, "Quelle");
  return links;
}

/**
 * Collect tier2 type-based links for a record.
 * - memory_candidate: finds decision records whose memoryIds include this record's ID
 * - review_item: finds sibling review_items sharing the same reviewBundleId
 * - other types: returns []
 *
 * @param {Object} record - The current record being processed
 * @param {Object} byId - Index mapping plur1bus_id → record
 * @param {Object} byType - Index mapping plur1bus_type → array of records
 * @param {string} reviewRoot - Review root (e.g. "plur1bus")
 * @param {number} maxPerNote - Maximum links to return
 * @param {Set<string>} existingIds - Already-linked IDs to skip (from Tier 1)
 * @returns {Array<string>} Array of markdown link lines
 */
export function collectTier2Links(record, byId, byType, reviewRoot, maxPerNote, existingIds) {
  const links = [];
  const type = record.plur1bus_type;
  const selfId = record.plur1bus_id;

  if (type === "memory_candidate") {
    for (const dec of (byType.decision || [])) {
      if (links.length >= maxPerNote) break;
      const decId = dec.plur1bus_id;
      if (decId === selfId) continue;
      if (existingIds.has(decId)) continue;
      if (!Array.isArray(dec.memoryIds) || !dec.memoryIds.includes(selfId)) continue;
      links.push(buildLinkLine(dec, reviewRoot, formatDisplayTitle(dec), "Entscheidung"));
    }
  } else if (type === "review_item") {
    const bundleId = record.reviewBundleId;
    for (const sibling of (byType["review_item"] || [])) {
      if (links.length >= maxPerNote) break;
      const sibId = sibling.plur1bus_id;
      if (sibId === selfId) continue;
      if (existingIds.has(sibId)) continue;
      if (sibling.reviewBundleId !== bundleId) continue;
      links.push(buildLinkLine(sibling, reviewRoot, formatDisplayTitle(sibling), "Bundle"));
    }
  }

  return links;
}

/**
 * Write graph links to record note.
 * STUB — implemented in Task 5.
 *
 * @param {Object} rawConfig - Bridge config
 * @param {Array} records - Records to link
 * @param {Object} options - Options (blockId, category, etc.)
 * @returns {Promise<Object>} Result with updated/unchanged/skipped counts
 */
export async function writeGraphLinks(rawConfig, records, options = {}) {
  return {
    ok: true,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    conflicts: [],
    tiersUsed: [],
  };
}

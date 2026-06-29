/**
 * graph-link-writer: Wikilink injection for record notes
 *
 * Provides helpers for formatting and injecting [[wikilinks]] into
 * PLUR1BUS record notes, creating a knowledge graph within Obsidian.
 */

import { existsSync, readFileSync } from "node:fs";
import { buildManagedBlock, replaceManagedBlock } from "./managed-blocks.js";
import { resolveReviewPath, atomicWriteText } from "./safe-paths.js";
import { buildRecordIndex } from "./record-index.js";
import { safeWarn } from "../safe-logging.js";

const GENERATED_LINK_TARGET_TYPES = new Set([
  "duplicate_candidate",
  "impact_analysis",
  "provenance",
]);

function isGeneratedLinkTarget(record) {
  const type = record?.plur1bus_type || record?.type;
  return GENERATED_LINK_TARGET_TYPES.has(type);
}

function normalizeTier1Index(byIdOrIndex, byMemoryIdArg) {
  if (byIdOrIndex && ("byId" in byIdOrIndex || "byMemoryId" in byIdOrIndex)) {
    return {
      byId: byIdOrIndex.byId || {},
      byMemoryId: byIdOrIndex.byMemoryId || {},
    };
  }
  return { byId: byIdOrIndex || {}, byMemoryId: byMemoryIdArg || {} };
}

function resolveMemoryTarget(id, byId, byMemoryId) {
  const memoryTarget = byMemoryId[id];
  if (memoryTarget && !isGeneratedLinkTarget(memoryTarget)) return memoryTarget;
  const idTarget = byId[id];
  return idTarget && !isGeneratedLinkTarget(idTarget) ? idTarget : null;
}

function resolveSourceTarget(id, byId, byMemoryId) {
  const idTarget = byId[id];
  if (idTarget && !isGeneratedLinkTarget(idTarget)) return idTarget;
  return byMemoryId[id] || null;
}

function shouldWriteLegacyEmptyBlock(record, options, includeSemantic) {
  if (includeSemantic) return false;
  const path = String(record?.path || "");
  if (!path.startsWith("records/")) return false;
  const indexEntries = options?.linkIndex?.entries || {};
  const entry = (record?.memory_id ? indexEntries[record.memory_id] : null)
             ?? (record?.plur1bus_id ? indexEntries[record.plur1bus_id] : null);
  return Array.isArray(entry?.similar) && entry.similar.length > 0;
}

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
  if (record.title) return sanitizeWikilinkLabel(record.title);
  if (record.summary) return sanitizeWikilinkLabel(String(record.summary).slice(0, 60));
  return sanitizeWikilinkLabel(record.plur1bus_id || record.id || "(unbekannt)");
}

function sanitizeWikilinkLabel(value) {
  const sanitized = String(value ?? "")
    .replace(/<!--\s*plur1bus:managed:(?:start|end)[\s\S]*?-->/gi, " ")
    .replace(/\]\]/g, "] ]")
    .replace(/\|/g, "/")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || "(unbekannt)";
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
  return `- [[${target}|${sanitizeWikilinkLabel(displayTitle)}]] _(${label})_`;
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
 * @param {Object} byIdOrIndex - Index mapping IDs to records, or { byId, byMemoryId }
 * @param {string} reviewRoot - Review root (e.g. "plur1bus")
 * @param {number} maxPerNote - Maximum links to collect
 * @param {Object} [byMemoryIdArg] - Optional memory_id index for legacy callers
 * @returns {Array<string>} Array of markdown link lines
 */
export function collectTier1Links(record, byIdOrIndex, reviewRoot, maxPerNote, byMemoryIdArg = {}) {
  const { byId, byMemoryId } = normalizeTier1Index(byIdOrIndex, byMemoryIdArg);
  const links = [];
  const seen = new Set();
  const addLink = (id, label, resolver) => {
    if (links.length >= maxPerNote || seen.has(id)) return;
    const target = resolver(id, byId, byMemoryId);
    if (!target) return;
    seen.add(id);
    links.push(buildLinkLine(target, reviewRoot, formatDisplayTitle(target), label));
  };
  for (const id of Array.isArray(record.memoryIds) ? record.memoryIds : []) {
    addLink(id, "memoryId", resolveMemoryTarget);
  }
  for (const id of Array.isArray(record.source_memories) ? record.source_memories : []) {
    addLink(id, "source_memory", resolveMemoryTarget);
  }
  for (const id of Array.isArray(record.sourceRefs) ? record.sourceRefs : []) {
    addLink(id, "Quelle", resolveSourceTarget);
  }
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
      existingIds.add(decId);
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
      existingIds.add(sibId);
    }
  }

  return links;
}

/**
 * Write graph links to record note.
 * Injects a managed block with wikilinks into each record's note file.
 *
 * @param {Object} rawConfig - Bridge config
 * @param {Array} records - Records to link
 * @param {Object} options - Options (logger, pool, etc.)
 * @returns {Promise<Object>} Result with updated/unchanged/skipped counts
 */
export async function writeGraphLinks(rawConfig, records, options = {}) {
  const { logger } = options;
  const cfg = resolveGraphConfig(rawConfig);
  const { blockId, maxPerNote, tiers, includeSemantic } = cfg;
  const reviewRoot = rawConfig.reviewRoot || "plur1bus";

  const { byId, byType, byMemoryId } = buildRecordIndex(rawConfig, { records });

  let updated = 0, unchanged = 0, skipped = 0;
  const conflicts = [];
  const tiersUsedAll = new Set();

  for (const record of records) {
    try {
      if (!record.path) { skipped++; continue; }
      let targetPath;
      try {
        ({ targetPath } = resolveReviewPath(rawConfig, record.path));
      } catch (_) {
        skipped++;
        continue;
      }
      if (!existsSync(targetPath)) { skipped++; continue; }

      const links = [];
      const tiersUsed = new Set();

      // Tier 1: explicit references
      if (tiers.includes("explicit")) {
        const tier1 = collectTier1Links(record, { byId, byMemoryId }, reviewRoot, maxPerNote);
        links.push(...tier1);
        if (tier1.length > 0) tiersUsed.add("explicit");
      }

      // Build existingIds from the record's own memoryIds + sourceRefs
      const existingIds = new Set();
      for (const id of (Array.isArray(record.memoryIds) ? record.memoryIds : [])) existingIds.add(id);
      for (const id of (Array.isArray(record.source_memories) ? record.source_memories : [])) existingIds.add(id);
      for (const id of (Array.isArray(record.sourceRefs) ? record.sourceRefs : [])) existingIds.add(id);

      // Tier 2: type rules
      if (tiers.includes("type") && links.length < maxPerNote) {
        const tier2 = collectTier2Links(record, byId, byType, reviewRoot, maxPerNote - links.length, existingIds);
        links.push(...tier2);
        if (tier2.length > 0) tiersUsed.add("type");
      }

      // Tier 3: semantic (read from pre-built link index — no re-embedding)
      if (includeSemantic && tiers.includes("semantic") && links.length < maxPerNote) {
        const indexEntries = options.linkIndex?.entries || {};
        const entry = (record.memory_id ? indexEntries[record.memory_id] : null)
                   ?? (record.plur1bus_id ? indexEntries[record.plur1bus_id] : null);
        if (entry?.similar) {
          for (const similarId of entry.similar) {
            if (links.length >= maxPerNote) break;
            if (existingIds.has(similarId)) continue;
            const linked = byId[similarId] || byMemoryId[similarId];
            if (!linked) continue;
            links.push(buildLinkLine(linked, reviewRoot, formatDisplayTitle(linked), "ähnlich"));
            existingIds.add(similarId);
            tiersUsed.add("semantic");
          }
        }
      }

      for (const t of tiersUsed) tiersUsedAll.add(t);

      const body = "## 🔗 Verwandte Einträge\n\n" + (
        links.length > 0 ? links.join("\n") : "- _(keine Querverweise)_"
      );

      const existing = readFileSync(targetPath, "utf8");
      if (
        links.length === 0
        && !existing.includes(`id="${blockId}"`)
        && !shouldWriteLegacyEmptyBlock(record, options, includeSemantic)
      ) {
        unchanged++;
        continue;
      }
      const result = replaceManagedBlock(existing, {
        id: blockId,
        version: "4.2.18",
        body,
        attrs: { tiers: tiersUsed.size > 0 ? [...tiersUsed].join(",") : "none" },
      });

      if (result.conflict) {
        const id = record.plur1bus_id || record.id || record.path;
        conflicts.push(id);
        logger?.warn?.(`plur1bus-graph-links: conflict on ${id} — manual edit protected`);
        continue;
      }
      if (result.changed) {
        atomicWriteText(targetPath, result.content);
        updated++;
      } else {
        unchanged++;
      }
    } catch (err) {
      skipped++;
      safeWarn(logger, "plur1bus-graph-links.record", err, {
        id: record?.plur1bus_id || record?.id || "",
        path: record?.path || "",
      });
    }
  }

  return { ok: true, updated, unchanged, skipped, conflicts, tiersUsed: [...tiersUsedAll] };
}

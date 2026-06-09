import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { parseFrontmatter } from "./frontmatter.js";
import { RECORD_COLLECTIONS } from "./record-schema.js";
import { resolveReviewPath } from "./safe-paths.js";

export const DEEP_ANALYSIS_RECORD_COLLECTIONS = Object.freeze([
  "sources",
  "memory-candidates",
  "review-items",
  "decisions",
  "projects",
  "agents",
]);

export function readRecords(rawConfig, options = {}) {
  if (options.readExistingRecords === false) return [];
  const { reviewPath } = resolveReviewPath(rawConfig, ".");
  const root = join(reviewPath, "records");
  const records = [];
  if (!existsSync(root)) return records;
  const collections = options.collections || RECORD_COLLECTIONS;
  for (const collection of collections) {
    const dir = join(root, collection);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const file = join(dir, entry.name);
      const parsed = parseFrontmatter(readFileSync(file, "utf8"));
      records.push({
        ...parsed.frontmatter,
        path: relative(reviewPath, file).replace(/\\/g, "/"),
        body: parsed.body,
      });
    }
  }
  return records;
}

export function readMemoryNotes(rawConfig) {
  const { reviewPath } = resolveReviewPath(rawConfig, ".");
  const memoriesDir = join(reviewPath, "memories");
  if (!existsSync(memoriesDir)) return [];
  const records = [];
  for (const entry of readdirSync(memoriesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = join(memoriesDir, entry.name);
    const text = readFileSync(file, "utf8");
    const parsed = parseFrontmatter(text);
    const fm = parsed.frontmatter;
    if (fm.plur1bus_type !== "memory") continue;
    // Extract title from first # Heading in body
    const titleMatch = parsed.body.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : null;
    records.push({
      memory_id: fm.memory_id,
      plur1bus_type: fm.plur1bus_type,
      category: fm.category,
      importance: typeof fm.importance === "number"
        ? fm.importance
        : (fm.importance != null
            ? (isNaN(parseFloat(fm.importance)) ? 0 : parseFloat(fm.importance))
            : 0),
      scope: fm.scope,
      created_at: fm.created_at,
      content_hash: fm.content_hash,
      title,
      filePath: file,
      path: relative(reviewPath, file).replace(/\\/g, "/"),
    });
  }
  return records;
}

export function buildRecordIndex(rawConfig, options = {}) {
  const merged = new Map();
  for (const record of [...(options.records || []), ...readRecords(rawConfig, options)]) {
    const key = record.plur1bus_id || record.id || record.memory_id || record.path || JSON.stringify(record);
    merged.set(key, { ...(merged.get(key) || {}), ...record });
  }
  const records = [...merged.values()];
  const byType = {};
  const byId = {};
  const byMemoryId = {};
  for (const record of records) {
    const type = record.plur1bus_type || record.type || "unknown";
    if (!byType[type]) byType[type] = [];
    byType[type].push(record);
    if (record.plur1bus_id || record.id) byId[record.plur1bus_id || record.id] = record;
    if (record.memory_id) {
      if (byMemoryId[record.memory_id]) {
        console.warn(`[record-index] duplicate memory_id: ${record.memory_id}`);
      }
      byMemoryId[record.memory_id] = record;
    }
  }
  return { records, byType, byId, byMemoryId };
}

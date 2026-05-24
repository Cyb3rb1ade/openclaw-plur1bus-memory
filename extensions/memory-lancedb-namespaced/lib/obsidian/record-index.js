import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { parseFrontmatter } from "./frontmatter.js";
import { RECORD_COLLECTIONS } from "./record-schema.js";
import { resolveReviewPath } from "./safe-paths.js";

export function readRecords(rawConfig, options = {}) {
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

export function buildRecordIndex(rawConfig, options = {}) {
  const merged = new Map();
  for (const record of [...(options.records || []), ...readRecords(rawConfig, options)]) {
    const key = record.plur1bus_id || record.id || record.path || JSON.stringify(record);
    merged.set(key, { ...(merged.get(key) || {}), ...record });
  }
  const records = [...merged.values()];
  const byType = {};
  const byId = {};
  for (const record of records) {
    const type = record.plur1bus_type || record.type || "unknown";
    if (!byType[type]) byType[type] = [];
    byType[type].push(record);
    if (record.plur1bus_id || record.id) byId[record.plur1bus_id || record.id] = record;
  }
  return { records, byType, byId };
}

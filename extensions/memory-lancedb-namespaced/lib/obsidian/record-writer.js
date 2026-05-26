import { existsSync, readFileSync } from "node:fs";

import { formatFrontmatter, parseFrontmatter } from "./frontmatter.js";
import { buildManagedBlock, replaceManagedBlock } from "./managed-blocks.js";
import { normalizeRecord, recordFrontmatter, recordRelativePath } from "./record-schema.js";
import { atomicWriteText, resolveReviewPath } from "./safe-paths.js";

export function renderRecordBody(record = {}) {
  const title = record.title || record.statement || record.summary || record.id;
  const lines = [
    `# ${title}`,
    "",
    "> Generated PLUR1BUS dashboard record. This mirror is not authoritative memory.",
    "",
    "## Summary",
    "",
    record.summary || record.statement || record.text || "No summary provided.",
    "",
    "## Evidence",
    "",
    Array.isArray(record.evidence) && record.evidence.length ? record.evidence.map((item) => `- ${item}`).join("\n") : "- No evidence attached.",
    "",
    "## Proposal Status",
    "",
    `- Status: ${record.status || "pending"}`,
    `- Risk: ${record.risk || "low"}`,
    `- Scope: ${record.scope || "dashboard_only"}`,
    "",
  ];
  return lines.join("\n");
}

export function writeRecordNote(rawConfig, record, options = {}) {
  const normalized = normalizeRecord(record, options);
  const relPath = recordRelativePath(normalized);
  const { targetPath } = resolveReviewPath(rawConfig, relPath);
  const generated = formatFrontmatter(
    recordFrontmatter(normalized),
    buildManagedBlock({
      id: `record-${normalized.plur1bus_id}`,
      version: options.version || "4.2.13",
      body: options.body || renderRecordBody(normalized),
      attrs: { type: normalized.plur1bus_type },
    }),
  );
  if (existsSync(targetPath)) {
    const existing = readFileSync(targetPath, "utf8");
    const parsed = parseFrontmatter(existing);
    const replaced = replaceManagedBlock(parsed.body, {
      id: `record-${normalized.plur1bus_id}`,
      version: options.version || "4.2.13",
      body: options.body || renderRecordBody(normalized),
      attrs: { type: normalized.plur1bus_type },
    });
    if (replaced.conflict) return { ok: false, path: relPath, conflict: replaced.conflict };
    atomicWriteText(targetPath, formatFrontmatter({ ...parsed.frontmatter, ...recordFrontmatter(normalized) }, replaced.content));
    return { ok: true, path: relPath, changed: replaced.changed };
  }
  atomicWriteText(targetPath, generated);
  return { ok: true, path: relPath, changed: true };
}

export function writeRecords(rawConfig, records = [], options = {}) {
  return records.map((record) => writeRecordNote(rawConfig, record, options));
}

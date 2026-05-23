import { atomicWriteText, resolveReviewPath, safeSlug } from "./safe-paths.js";
import { buildRecordIndex } from "./record-index.js";
import { analyzeImpact } from "./impact-analysis.js";

export function buildMemoryExplanation(rawConfig, id, options = {}) {
  const index = buildRecordIndex(rawConfig, options);
  const record = index.byId[id] || (typeof options.findRecord === "function" ? options.findRecord(id) : null);
  const related = index.records.filter((item) => JSON.stringify(item).includes(id));
  const impact = options.deep ? analyzeImpact(rawConfig, id, { ...options, records: index.records }).impacts : [];
  const body = [
    `# Memory Explanation: ${id}`,
    "",
    "This page explains available provenance. Missing data is not invented.",
    "",
    "## Record",
    "",
    record ? JSON.stringify(record, null, 2) : "Record unavailable in current context.",
    "",
    "## Related Records",
    "",
    related.length ? related.map((item) => `- ${item.plur1bus_id || item.id}: ${item.path || ""}`).join("\n") : "- None found.",
    "",
    "## Impact Analysis",
    "",
    impact.length ? impact.map((item) => `- ${item.target}: ${item.summary}`).join("\n") : "- Not run or no impact records generated.",
    "",
    "## Safety",
    "",
    "- Explanatory only; no promotion, demotion, tombstone, prune, or sharing occurred.",
    "",
  ].join("\n");
  const rel = `memory-explanations/${safeSlug(id, "memory")}.md`;
  atomicWriteText(resolveReviewPath(rawConfig, rel).targetPath, body);
  return { ok: true, id, path: rel, found: Boolean(record), related: related.length };
}


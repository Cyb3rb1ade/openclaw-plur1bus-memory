import { buildRecordIndex } from "./record-index.js";
import { writeRecords } from "./record-writer.js";

function normalizedClaim(record) {
  return String(record.statement || record.summary || record.text || record.title || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function buildSemanticConflictGraph(rawConfig, options = {}) {
  const index = buildRecordIndex(rawConfig, options);
  const proposals = [];
  const records = index.records.filter((record) => normalizedClaim(record));
  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      const a = records[i];
      const b = records[j];
      const ca = normalizedClaim(a);
      const cb = normalizedClaim(b);
      if (!ca || !cb) continue;
      const sameTarget = (a.target && a.target === b.target) || (a.memoryIds || []).some((id) => (b.memoryIds || []).includes(id));
      const incompatibleStatus = new Set([a.status, b.status]).has("active") && new Set([a.status, b.status]).has("superseded");
      const likelyNegation = ca.includes(" not ") && ca.replace(" not ", " ") === cb || cb.includes(" not ") && cb.replace(" not ", " ") === ca;
      if (sameTarget && (incompatibleStatus || likelyNegation)) {
        proposals.push({
          type: "semantic_conflict",
          id: `sem-${a.plur1bus_id}-${b.plur1bus_id}`.slice(0, 100),
          status: "pending",
          risk: "high",
          target: a.target || b.target || "",
          summary: "Likely semantic conflict candidate.",
          sourceRefs: [a.path, b.path].filter(Boolean),
          confidence: likelyNegation ? 0.82 : 0.65,
        });
      }
    }
  }
  writeRecords(rawConfig, proposals, options);
  return { ok: true, proposals, count: proposals.length };
}


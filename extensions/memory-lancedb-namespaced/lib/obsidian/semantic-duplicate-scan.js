import { buildRecordIndex } from "./record-index.js";
import { writeRecords } from "./record-writer.js";

function tokenSet(text) {
  return new Set(String(text || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((part) => part.length > 2));
}

function jaccard(a, b) {
  const aa = tokenSet(a);
  const bb = tokenSet(b);
  if (!aa.size || !bb.size) return 0;
  const inter = [...aa].filter((token) => bb.has(token)).length;
  return inter / new Set([...aa, ...bb]).size;
}

export function scanSemanticDuplicates(rawConfig, options = {}) {
  const records = buildRecordIndex(rawConfig, options).records;
  const proposals = [];
  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      const a = records[i];
      const b = records[j];
      const score = jaccard(a.summary || a.body, b.summary || b.body);
      if (score >= (options.threshold || 0.75)) {
        proposals.push({ type: "duplicate_candidate", id: `dup-${a.plur1bus_id}-${b.plur1bus_id}`.slice(0, 100), status: "pending", risk: "medium", summary: "Likely duplicate record candidate.", sourceRefs: [a.path, b.path].filter(Boolean), confidence: Number(score.toFixed(2)) });
      }
    }
  }
  writeRecords(rawConfig, proposals, options);
  return { ok: true, proposals, count: proposals.length };
}


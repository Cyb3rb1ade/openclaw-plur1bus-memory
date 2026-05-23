import { buildRecordIndex } from "./record-index.js";
import { writeRecords } from "./record-writer.js";

export function analyzeImpact(rawConfig, target = "all", options = {}) {
  const records = buildRecordIndex(rawConfig, options).records;
  const selected = target === "all" ? records : records.filter((record) => JSON.stringify(record).includes(target));
  const impacts = selected.map((record) => ({
    type: "impact_analysis",
    id: `impact-${record.plur1bus_id || record.id}`,
    status: "proposal_only",
    risk: record.risk || "low",
    target: record.plur1bus_id || record.id,
    memoryIds: record.memoryIds || [],
    sourceRefs: [record.path, ...(record.sourceRefs || [])].filter(Boolean),
    summary: "Explanatory impact analysis only. Does not alter recall ranking or memory truth.",
    possibleImpact: [
      "May appear in Auto-Recall if stored in LanceDB and relevant.",
      "May relate to project dashboards or decisions.",
      "Review conflicts and duplicates before promotion.",
    ],
  }));
  writeRecords(rawConfig, impacts, options);
  return { ok: true, target, impacts, count: impacts.length };
}


import { buildRecordIndex } from "./record-index.js";
import { writeRecords } from "./record-writer.js";

export function buildProvenanceGraph(rawConfig, options = {}) {
  const records = buildRecordIndex(rawConfig, options).records;
  const provenance = records.map((record) => ({
    type: "provenance",
    id: `prov-${record.plur1bus_id || record.id}`,
    status: "current",
    risk: "low",
    scope: record.scope,
    trustLevel: record.trustLevel,
    origin: record.origin,
    storedBy: record.storedBy,
    agentId: record.agentId,
    memoryIds: record.memoryIds || [],
    sourceRefs: record.sourceRefs || [],
    reviewBundleId: record.reviewBundleId || "",
    summary: `Provenance mirror for ${record.plur1bus_id || record.id}`,
  }));
  writeRecords(rawConfig, provenance, options);
  return { ok: true, records: provenance, count: provenance.length };
}


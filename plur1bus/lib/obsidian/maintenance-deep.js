import { findArchiveCandidates } from "./archive-rotation.js";
import { findUnresolvedGeneratedLinks } from "./link-hygiene.js";
import { findMissingRecordProperties } from "./property-normalizer.js";
import { buildRecordIndex } from "./record-index.js";
import { writeRecords } from "./record-writer.js";

export function runMaintenanceDeep(rawConfig, options = {}) {
  const index = buildRecordIndex(rawConfig, options);
  const findings = [];
  const seen = new Map();
  for (const record of index.records) {
    const id = record.plur1bus_id || record.id;
    if (seen.has(id)) findings.push({ type: "conflict", id: `duplicate-record-${id}`, status: "pending", risk: "medium", target: id, reason: "Duplicate record ID.", sourceRefs: [seen.get(id), record.path].filter(Boolean) });
    seen.set(id, record.path);
    if (record.status === "pending" && record.createdAt && Date.now() - Date.parse(record.createdAt) > 7 * 86400000) {
      findings.push({ type: "stale_decision", id: `stale-pending-${id}`, status: "pending", risk: "medium", target: id, reason: "Pending approval is older than 7 days.", sourceRefs: [record.path].filter(Boolean) });
    }
  }
  findings.push(...findArchiveCandidates(rawConfig, options).map((item) => ({ ...item, type: "task", id: `archive-${item.path.replace(/[^\w.-]+/g, "-")}`, status: "pending", risk: "low", summary: `Archive generated file ${item.path}` })));
  findings.push(...findMissingRecordProperties(index.records));
  findings.push(...findUnresolvedGeneratedLinks(rawConfig, options));
  writeRecords(rawConfig, findings, options);
  return { ok: true, findings, count: findings.length };
}


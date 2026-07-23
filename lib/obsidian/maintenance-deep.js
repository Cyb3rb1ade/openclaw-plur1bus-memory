import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { findArchiveCandidates } from "./archive-rotation.js";
import { findUnresolvedGeneratedLinks } from "./link-hygiene.js";
import { REQUIRED_RECORD_FIELDS, findMissingRecordProperties } from "./property-normalizer.js";
import { buildRecordIndex } from "./record-index.js";
import { writeRecords } from "./record-writer.js";
import { resolveReviewPath } from "./safe-paths.js";
import { mutationAllowed } from "../obsidian-mutation-policy.js";

// Remove missing-<field>-<uuid>.md task files whose source record now has all required fields.
function cleanupResolvedFindings(rawConfig, index) {
  const { reviewPath } = resolveReviewPath(rawConfig, ".");
  const tasksDir = join(reviewPath, "records", "tasks");
  if (!existsSync(tasksDir)) return { removed: 0 };

  // Build set of IDs that still have at least one missing field.
  const stillMissing = new Set();
  for (const record of index.records) {
    const id = record.plur1bus_id || record.id;
    if (!id) continue;
    for (const field of REQUIRED_RECORD_FIELDS) {
      const val = record[field];
      if (val === undefined || val === null || val === "") {
        stillMissing.add(id);
        break;
      }
    }
  }

  let removed = 0;
  for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const m = entry.name.match(/^missing-[^-]+-(.+)\.md$/);
    if (!m) continue;
    const sourceId = m[1];
    if (!stillMissing.has(sourceId)) {
      try { unlinkSync(join(tasksDir, entry.name)); removed++; } catch { /* ignore */ }
    }
  }
  return { removed };
}

export function runMaintenanceDeep(rawConfig, options = {}) {
  if (!mutationAllowed(options.mutationPolicy, "vault_write")) {
    return { ok: true, findings: [], count: 0, cleanedUp: 0, applied: false, reason: "mutation_policy_denied" };
  }
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
  const cleanup = cleanupResolvedFindings(rawConfig, index);
  writeRecords(rawConfig, findings, options);
  return { ok: true, findings, count: findings.length, cleanedUp: cleanup.removed };
}

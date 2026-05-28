import { buildRecordIndex } from "./record-index.js";

export function collectStructuralConflicts(rawConfig, options = {}) {
  const index = buildRecordIndex(rawConfig, options);
  const conflicts = [];
  const byTarget = new Map();
  for (const record of index.records) {
    const target = record.target || record.memoryIds?.[0] || record.plur1bus_id;
    if (!target) continue;
    const list = byTarget.get(target) || [];
    list.push(record);
    byTarget.set(target, list);
  }
  for (const [target, records] of byTarget.entries()) {
    const statuses = new Set(records.map((record) => String(record.status || "")));
    if (statuses.has("active") && statuses.has("superseded")) {
      conflicts.push({ type: "conflict", id: `conflict-${target}`, target, status: "pending", risk: "medium", reason: "Target has both active and superseded records.", sourceRefs: records.map((r) => r.path).filter(Boolean) });
    }
    const scopes = new Set(records.map((record) => String(record.scope || "")));
    if (scopes.has("agent_private") && scopes.has("global_user")) {
      conflicts.push({ type: "conflict", id: `scope-${target}`, target, status: "pending", risk: "high", reason: "Target appears in private and global scope without explicit promotion evidence.", sourceRefs: records.map((r) => r.path).filter(Boolean) });
    }
  }
  for (const record of index.records) {
    if (record.status === "active" && record.staleAfter && Date.parse(record.staleAfter) < Date.now()) {
      conflicts.push({ type: "stale_decision", id: `stale-${record.plur1bus_id}`, target: record.plur1bus_id, status: "pending", risk: "medium", reason: "Record is active but staleAfter is in the past.", sourceRefs: [record.path].filter(Boolean) });
    }
    if (/assistant/i.test(record.trustLevel || record.origin || "") && /global_user|trusted/.test(`${record.scope} ${record.status}`)) {
      conflicts.push({ type: "conflict", id: `weak-evidence-${record.plur1bus_id}`, target: record.plur1bus_id, status: "pending", risk: "high", reason: "Assistant-originated assertion appears promoted too far.", sourceRefs: [record.path].filter(Boolean) });
    }
  }
  return conflicts;
}


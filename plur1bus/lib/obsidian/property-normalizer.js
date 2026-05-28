export const REQUIRED_RECORD_FIELDS = Object.freeze([
  "plur1bus_type",
  "plur1bus_id",
  "status",
  "risk",
  "scope",
  "trustLevel",
  "origin",
  "agentId",
  "createdAt",
  "updatedAt",
]);

export function findMissingRecordProperties(records = []) {
  const findings = [];
  for (const record of records) {
    for (const field of REQUIRED_RECORD_FIELDS) {
      if (record[field] === undefined || record[field] === null || record[field] === "") {
        findings.push({ type: "task", id: `missing-${field}-${record.plur1bus_id || record.id}`, target: record.path || record.plur1bus_id, status: "pending", risk: "low", reason: `Missing frontmatter field: ${field}` });
      }
    }
  }
  return findings;
}

import { buildRecordIndex } from "./record-index.js";

export function findUnresolvedGeneratedLinks(rawConfig, options = {}) {
  const index = buildRecordIndex(rawConfig, options);
  return index.records
    .filter((record) => /\[\[[^\]]+\]\]/.test(record.body || "") && /missing|unresolved/i.test(record.body || ""))
    .map((record) => ({ type: "link_hygiene", id: `link-${record.plur1bus_id}`, target: record.path, status: "pending", risk: "low", reason: "Generated note contains unresolved link marker." }));
}


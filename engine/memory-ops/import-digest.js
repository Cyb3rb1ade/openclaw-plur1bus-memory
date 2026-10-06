/**
 * engine/memory-ops/import-digest.js — per-group row digests recorded on
 * `memory.import` ledger lines (contract 1.13.0) and compared by
 * `memory.unimport` to decide "modified since import".
 *
 * Three groups, each sha256 over a canonical JSON projection, truncated to
 * 16 hex. Only hashes reach the ledger, never values. Machine-maintained
 * fields (retrieval, strength, replay, dynamics, enrichment status, emotion,
 * vector) are deliberately excluded: they change without anyone editing the
 * card and would make every recalled card look "modified".
 */

import { createHash } from "node:crypto";

export const IMPORT_DIGEST_GROUPS = Object.freeze({
  content: Object.freeze(["text", "summary"]),
  binding: Object.freeze(["scope", "ownerUserId", "workspaceId", "workspaceKey", "agentId"]),
  meta: Object.freeze([
    "category", "importance", "neverForget", "memoryClass",
    "validFrom", "validUntil", "epistemicStatus", "updatedAt",
  ]),
});

const BOOLEAN_FIELDS = new Set(["neverForget"]);
const NUMBER_FIELDS = new Set(["importance", "validFrom", "validUntil", "updatedAt"]);

function canonicalNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (Number.isInteger(n)) return n;
  // Float32 columns read back as e.g. 0.699999988; six decimals absorb that.
  return Math.round(n * 1e6) / 1e6;
}

function canonicalValue(field, value) {
  if (BOOLEAN_FIELDS.has(field)) return value === true || value === 1 || value === "true";
  if (NUMBER_FIELDS.has(field)) return canonicalNumber(value);
  if (value == null) return "";
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

function groupDigest(row, fields) {
  const projection = fields.map((field) => [field, canonicalValue(field, row?.[field])]);
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex").slice(0, 16);
}

/**
 * @param {object} row A stored memory row (as `getById` returns it).
 * @returns {{content: string, binding: string, meta: string}}
 */
export function importRowDigest(row) {
  return {
    content: groupDigest(row, IMPORT_DIGEST_GROUPS.content),
    binding: groupDigest(row, IMPORT_DIGEST_GROUPS.binding),
    meta: groupDigest(row, IMPORT_DIGEST_GROUPS.meta),
  };
}

/**
 * @param {unknown} value
 * @returns {value is {content: string, binding: string, meta: string}}
 */
export function isImportDigest(value) {
  return Boolean(value)
    && typeof value === "object"
    && ["content", "binding", "meta"].every((k) => typeof value[k] === "string" && /^[0-9a-f]{16}$/.test(value[k]));
}

import { sha256Hex } from "./managed-blocks.js";
import { safeSlug } from "./safe-paths.js";

export const RECORD_TYPES = Object.freeze({
  "memory_candidate": "memory-candidates",
  "review_item": "review-items",
  "conflict": "conflicts",
  "stale_decision": "stale-decisions",
  "task": "tasks",
  "decision": "decisions",
  "project": "projects",
  "agent": "agents",
  "source": "sources",
  "provenance": "provenance",
  "semantic_conflict": "semantic-conflicts",
  "duplicate_candidate": "duplicate-candidates",
  "impact_analysis": "impact-analysis",
});

export const RECORD_COLLECTIONS = Object.freeze([...new Set(Object.values(RECORD_TYPES))]);

export function normalizeRecordType(type) {
  const key = String(type || "").replace(/-/g, "_");
  if (RECORD_TYPES[key]) return key;
  const byCollection = Object.entries(RECORD_TYPES).find(([, collection]) => collection === type);
  if (byCollection) return byCollection[0];
  throw new Error(`Unsupported PLUR1BUS record type: ${type}`);
}

export function recordCollection(type) {
  return RECORD_TYPES[normalizeRecordType(type)];
}

export function normalizeRecord(record = {}, options = {}) {
  const now = options.now || new Date().toISOString();
  const type = normalizeRecordType(record.type || record.plur1bus_type || "source");
  const id = safeSlug(record.id || record.plur1bus_id || `${type}-${sha256Hex(JSON.stringify(record)).slice(0, 12)}`, type);
  const sourceRefs = Array.isArray(record.sourceRefs) ? record.sourceRefs : Array.isArray(record.source_refs) ? record.source_refs : [];
  const memoryIds = Array.isArray(record.memoryIds) ? record.memoryIds : Array.isArray(record.memory_ids) ? record.memory_ids : [];
  return {
    ...record,
    id,
    type,
    plur1bus_type: type,
    plur1bus_id: id,
    status: record.status || "pending",
    risk: record.risk || "low",
    scope: record.scope || record.targetScope || "dashboard_only",
    trustLevel: record.trustLevel || record.trust || record.origin?.trustLevel || "unknown",
    origin: typeof record.origin === "string" ? record.origin : record.origin?.kind || record.origin?.source || "generated",
    storedBy: record.storedBy || "",
    agentId: record.agentId || record.agent_id || "main",
    sourceRefs,
    memoryIds,
    reviewBundleId: record.reviewBundleId || record.review_bundle_id || "",
    createdAt: record.createdAt || record.created_at || now,
    updatedAt: record.updatedAt || record.updated_at || now,
    staleAfter: record.staleAfter || record.stale_after || "",
    preconditionHash: record.preconditionHash || record.hash || "",
    authoritative: false,
  };
}

export function recordFrontmatter(record = {}) {
  const normalized = normalizeRecord(record);
  return {
    plur1bus_type: normalized.plur1bus_type,
    plur1bus_id: normalized.plur1bus_id,
    status: normalized.status,
    risk: normalized.risk,
    scope: normalized.scope,
    trustLevel: normalized.trustLevel,
    origin: normalized.origin,
    storedBy: normalized.storedBy,
    agentId: normalized.agentId,
    sourceRefs: normalized.sourceRefs,
    memoryIds: normalized.memoryIds,
    reviewBundleId: normalized.reviewBundleId,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    staleAfter: normalized.staleAfter,
    preconditionHash: normalized.preconditionHash,
    authoritative: false,
  };
}

export function recordRelativePath(record = {}) {
  const normalized = normalizeRecord(record);
  return `records/${recordCollection(normalized.type)}/${normalized.id}.md`;
}


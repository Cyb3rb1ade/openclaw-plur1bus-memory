/**
 * lib/jobs/memory-compaction.js — LanceDB Memory Compaction.
 *
 * Reduziert Redundanz in der LanceDB-Tabelle durch:
 *   1. Duplikat-Erkennung (identischer Text)
 *   2. Ähnlichkeits-Clustering (cosine similarity >= threshold)
 *   3. Merge kompatibler Memories via LLM
 *   4. Konflikt-Markierung bei Widersprüchen
 *
 * Batch-Operation: Sammelt alle Änderungen, führt sie sequentiell aus.
 * Idempotent via SHA256-Digest der betroffenen IDs.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cosineSimilarityVec } from "../text-utils.js";
import { safeUuid, safeStatus } from "../sql-safety.js";
import { withTimeout, TimeoutError } from "../with-timeout.js";
import { safeWarnLlmFailure, withAbortableLlmTimeout } from "../llm-failure.js";
import { safeDebug } from "../safe-logging.js";
import { checkAccess, validateOwnershipTuple } from "../acl-middleware.js";
import { normalizeEpistemicStatus, combineEpistemicStatusForMerge } from "../epistemic-status.js";
import { hasDisjointValidityWindows, combineValidTimeForMerge } from "../valid-time.js";
import { assertCardWriteAllowed, splitAgentDbPath } from "../tombstone-write-guard.js";
import {
  LLM_RESULT_CACHE_PURPOSES,
  withLlmCallContext,
  withLlmResultCacheContext,
} from "../llm-result-cache.js";

const DEFAULT_OPTS = {
  similarityThreshold: 0.88,
  lookbackDays: 30,
  maxBatchSize: 50,
  dryRun: false,
  autoApply: true,
  llmMergeTimeoutMs: 30000,
};

const DEFAULT_COMPACTION_TIMEOUT_MS = 300_000; // 5 minutes

// Obergrenze des Kandidaten-Scans. Greift erst NACH dem where-Pushdown, begrenzt
// also nur die Menge, nicht mehr die Auswahl.
const DEFAULT_COMPACTION_SCAN_LIMIT = 5000;
const DEFAULT_COMPACTION_MAX_SCAN_ROWS = 50_000;
const EMPTY_WORKSPACE_ALIASES = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) });
const COMPACTION_OWNERSHIP_SCOPES = new Set(["agent-private", "workspace", "user"]);
const COMPACTION_SCAN_STATE_KEY = "memoryCompactionScan";
const inMemoryCompactionScanState = new WeakMap();

function boundedPositiveInteger(value, fallback, maximum = DEFAULT_COMPACTION_MAX_SCAN_ROWS) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.max(1, Math.floor(numeric)), maximum);
}

function compactionSortCompare(left, right) {
  const timeDelta = Number(right?.createdAt || 0) - Number(left?.createdAt || 0);
  return timeDelta || String(left?.id || "").localeCompare(String(right?.id || ""));
}

function normalizeCompactionScanCursor(value) {
  if (!value || typeof value !== "object") return null;
  const createdAt = Number(value.createdAt);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) return null;
  try {
    return { createdAt, id: safeUuid(value.id) };
  } catch {
    return null;
  }
}

function rowAfterCompactionCursor(row, cursor) {
  if (!cursor) return true;
  const createdAt = Number(row?.createdAt || 0);
  if (!Number.isFinite(createdAt)) return false;
  return createdAt < cursor.createdAt
    || (createdAt === cursor.createdAt && String(row?.id || "").localeCompare(cursor.id) > 0);
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function partitionCandidate(bindings) {
  const workspaceIdentity = bindings?.workspaceIdentity
    || bindings?.workspaceId
    || bindings?.workspaceKey
    || "";
  return {
    scope: bindings?.scope,
    agentId: bindings?.agentId || "",
    storedBy: bindings?.storedBy || bindings?.agentId || "",
    workspaceId: workspaceIdentity,
    workspaceKey: workspaceIdentity,
    ownerUserId: bindings?.ownerUserId || "",
  };
}

function ownershipTuple(memory, workspaceAliases = EMPTY_WORKSPACE_ALIASES) {
  const scope = memory?.scope || "agent-private";
  if (!COMPACTION_OWNERSHIP_SCOPES.has(scope)) return null;
  const candidate = memory?.workspaceIdentity && memory?.workspaceId === undefined && memory?.workspaceKey === undefined
    ? partitionCandidate(memory)
    : memory;
  const ownership = validateOwnershipTuple(candidate, workspaceAliases);
  if (!ownership.ok) return null;
  return Object.freeze({
    scope,
    agentId: ownership.bindings.agentId,
    workspaceIdentity: ownership.bindings.workspaceIdentity,
    ownerUserId: ownership.bindings.ownerUserId,
  });
}

function sameOwnershipTuple(left, right, workspaceAliases = EMPTY_WORKSPACE_ALIASES) {
  const a = ownershipTuple(left, workspaceAliases);
  const b = ownershipTuple(right, workspaceAliases);
  return Boolean(a && b
    && a.scope === b.scope
    && a.agentId === b.agentId
    && a.workspaceIdentity === b.workspaceIdentity
    && a.ownerUserId === b.ownerUserId);
}

/**
 * Build one authorized compaction partition from the canonical memory context.
 * @param {object} bindings Requested ownership bindings.
 * @param {object} requestContext Canonical authenticated memory context.
 * @returns {object} Normalized partition with a stable key.
 */
export function buildCompactionPartition(bindings, requestContext) {
  const candidate = partitionCandidate(bindings);
  if (!COMPACTION_OWNERSHIP_SCOPES.has(candidate.scope)) {
    throw new Error("invalid compaction ACL partition scope");
  }
  const workspaceAliases = requestContext?.workspaceAliases || EMPTY_WORKSPACE_ALIASES;
  const normalized = ownershipTuple(candidate, workspaceAliases);
  if (!normalized || !checkAccess(requestContext, candidate).allowed) {
    throw new Error("invalid compaction ACL partition binding");
  }
  const key = createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 20);
  return Object.freeze({ ...normalized, key });
}

function resolveCompactionScope(opts = {}) {
  const requestedPartition = opts.aclPartition || opts.ownershipPartition || opts.partition || null;
  const requestContext = opts.requestContext || null;
  if (requestedPartition) {
    try {
      const context = requestContext || (
        requestedPartition.scope === "agent-private" && requestedPartition.agentId
          ? { agentId: requestedPartition.agentId, workspaceAliases: EMPTY_WORKSPACE_ALIASES }
          : null
      );
      if (!context) return { partition: null, requestContext: null, strict: true, expectedAgentId: "" };
      return {
        partition: buildCompactionPartition(requestedPartition, context),
        requestContext: context,
        strict: true,
        expectedAgentId: context.agentId || requestedPartition.agentId || "",
      };
    } catch (error) {
      safeDebug(opts.logger, "memory-compaction.partition", error);
      return { partition: null, requestContext: null, strict: true, expectedAgentId: "" };
    }
  }

  if (requestContext?.agentId) {
    try {
      return {
        partition: buildCompactionPartition({ scope: "agent-private", agentId: requestContext.agentId }, requestContext),
        requestContext,
        strict: true,
        expectedAgentId: requestContext.agentId,
      };
    } catch (error) {
      safeDebug(opts.logger, "memory-compaction.request-context", error);
      return { partition: null, requestContext: null, strict: true, expectedAgentId: "" };
    }
  }

  if (opts.agentId) {
    try {
      const context = { agentId: opts.agentId, workspaceAliases: EMPTY_WORKSPACE_ALIASES };
      return {
        partition: buildCompactionPartition({ scope: "agent-private", agentId: opts.agentId }, context),
        requestContext: context,
        strict: false,
        expectedAgentId: opts.agentId,
      };
    } catch (error) {
      safeDebug(opts.logger, "memory-compaction.agent-context", error);
      return { partition: null, requestContext: null, strict: true, expectedAgentId: "" };
    }
  }

  // Legacy rows are allowed only when they are not explicitly protected. Any
  // user/workspace row requires an authorized partition and is denied here.
  return { partition: null, requestContext: null, strict: false, expectedAgentId: "" };
}

function compactionScanStateId(securityScope, agentId = "") {
  const bindings = securityScope?.partition || {
    scope: "agent-private",
    agentId: agentId || "",
    workspaceIdentity: "",
    ownerUserId: "",
  };
  return createHash("sha256").update(JSON.stringify({
    scope: bindings.scope || "agent-private",
    agentId: bindings.agentId || "",
    workspaceIdentity: bindings.workspaceIdentity || "",
    ownerUserId: bindings.ownerUserId || "",
  })).digest("hex").slice(0, 32);
}

function allowPersistentCompactionScanState(securityScope, opts = {}) {
  return opts.persistPrivateCompactionState === true
    || !securityScope?.partition
    || securityScope.partition.scope === "workspace";
}

function getInMemoryCompactionState(db) {
  if (!db || (typeof db !== "object" && typeof db !== "function")) return null;
  let state = inMemoryCompactionScanState.get(db);
  if (!state) {
    state = new Map();
    inMemoryCompactionScanState.set(db, state);
  }
  return state;
}

function normalizeCompactionScanFingerprint(value) {
  if (!value || typeof value !== "object") return null;
  const textHash = String(value.textHash || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(textHash)) return null;
  const createdAt = Number(value.createdAt);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) return null;
  try {
    return {
      id: safeUuid(value.id),
      textHash,
      createdAt,
      aclBindings: value.aclBindings && typeof value.aclBindings === "object"
        ? {
          scope: String(value.aclBindings.scope || ""),
          agentId: String(value.aclBindings.agentId || ""),
          workspaceIdentity: String(value.aclBindings.workspaceIdentity || ""),
          ownerUserId: String(value.aclBindings.ownerUserId || ""),
        }
        : null,
    };
  } catch {
    return null;
  }
}

function normalizeCompactionScanState(value) {
  if (!value || typeof value !== "object") return null;
  const exactCandidates = Array.isArray(value.exactCandidates)
    ? value.exactCandidates.map(normalizeCompactionScanFingerprint).filter(Boolean)
    : [];
  return {
    cursor: normalizeCompactionScanCursor(value.cursor),
    complete: value.complete === true,
    updatedAt: Number.isSafeInteger(Number(value.updatedAt)) ? Number(value.updatedAt) : 0,
    aclBindings: value.aclBindings && typeof value.aclBindings === "object"
      ? {
        scope: String(value.aclBindings.scope || ""),
        agentId: String(value.aclBindings.agentId || ""),
        workspaceIdentity: String(value.aclBindings.workspaceIdentity || ""),
        ownerUserId: String(value.aclBindings.ownerUserId || ""),
      }
      : null,
    exactCandidates,
  };
}

function readCompactionScanState(db, neoStore, stateId, persistent, logger) {
  if (persistent && typeof neoStore?.readRunState === "function") {
    try {
      const state = neoStore.readRunState() || {};
      return normalizeCompactionScanState(state?.[COMPACTION_SCAN_STATE_KEY]?.[stateId]);
    } catch (error) {
      safeDebug(logger, "memory-compaction.scan-state-read", error);
    }
  }
  return normalizeCompactionScanState(getInMemoryCompactionState(db)?.get(stateId));
}

async function writeCompactionScanState(db, neoStore, stateId, securityScope, cursor, exactCandidates, persistent, logger) {
  const normalizedCursor = normalizeCompactionScanCursor(cursor);
  const entry = {
    cursor: normalizedCursor,
    complete: !normalizedCursor,
    updatedAt: Date.now(),
    aclBindings: securityScope?.partition || null,
    exactCandidates: normalizedCursor
      ? (Array.isArray(exactCandidates) ? exactCandidates : []).map(normalizeCompactionScanFingerprint).filter(Boolean)
      : [],
  };
  if (persistent && typeof neoStore?.readRunState === "function" && typeof neoStore?.writeRunState === "function") {
    try {
      const state = neoStore.readRunState() || {};
      state[COMPACTION_SCAN_STATE_KEY] = state[COMPACTION_SCAN_STATE_KEY] || {};
      state[COMPACTION_SCAN_STATE_KEY][stateId] = entry;
      await neoStore.writeRunState(state);
      return;
    } catch (error) {
      safeDebug(logger, "memory-compaction.scan-state-write", error);
    }
  }
  getInMemoryCompactionState(db)?.set(stateId, entry);
}

function isLegacyCompactionRow(row, expectedAgentId = "") {
  const scope = row?.scope || "agent-private";
  if (scope === "user" || scope === "workspace") return false;
  if (row?.ownerUserId || row?.workspaceId || row?.workspaceKey) return false;
  const tuple = ownershipTuple(row, EMPTY_WORKSPACE_ALIASES);
  if (!tuple || tuple.scope !== "agent-private") return false;
  return !expectedAgentId || !tuple.agentId || tuple.agentId === expectedAgentId;
}

function canonicalValidityBound(value) {
  if (value === undefined || value === null || value === 0 || value === 0n) return 0;
  if (typeof value === "bigint") {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  }
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function sameValidityBound(left, right) {
  const a = canonicalValidityBound(left);
  const b = canonicalValidityBound(right);
  return a !== null && b !== null && a === b;
}

function contentHash(text) {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function rowSnapshot(row, workspaceAliases) {
  return {
    id: row.id,
    textHash: contentHash(row.text),
    status: row.status || "",
    epistemicStatus: normalizeEpistemicStatus(row.epistemicStatus),
    epistemicStatusActor: row.epistemicStatusActor || "",
    epistemicStatusReason: row.epistemicStatusReason || "",
    previousEpistemicStatus: row.previousEpistemicStatus || "",
    epistemicStatusUpdatedAt: row.epistemicStatusUpdatedAt ?? 0,
    validFrom: canonicalValidityBound(row.validFrom),
    validUntil: canonicalValidityBound(row.validUntil),
    aclBindings: ownershipTuple(row, workspaceAliases),
  };
}

function computeCompactionDigest(actions) {
  const canonical = actions
    .map(a => `${a.type}:${a.id}${a.targetId ? ":" + a.targetId : ""}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function isIdenticalText(a, b) {
  return normalizedExactText(a?.text) === normalizedExactText(b?.text);
}

function normalizedExactText(text) {
  return String(text || "").trim().toLowerCase();
}

function exactTextClusterKey(memory, workspaceAliases) {
  const ownership = ownershipTuple(memory, workspaceAliases);
  if (!ownership) return null;
  return `${JSON.stringify(ownership)}:${contentHash(normalizedExactText(memory?.text))}`;
}

function isCompatibleText(a, b) {
  const ta = String(a.text || "").trim().toLowerCase();
  const tb = String(b.text || "").trim().toLowerCase();
  if (ta === tb) return true;
  // Wenn einer den anderen komplett enthält → kompatibel
  if (ta.includes(tb) || tb.includes(ta)) return true;
  return false;
}

function hasEquivalentEpistemicEvidence(a, b) {
  const fields = [
    "epistemicStatus",
    "epistemicStatusActor",
    "epistemicStatusReason",
    "previousEpistemicStatus",
    "epistemicStatusUpdatedAt",
  ];
  return fields.every((field) => String(a?.[field] ?? "") === String(b?.[field] ?? ""));
}

/**
 * Ask the LLM for one deterministic agent-scoped compaction merge decision.
 * @param {string} existingText
 * @param {string} newText
 * @param {object} llmCfg
 * @param {Function} callLlm
 * @param {number} timeoutMs
 * @param {string} agentId
 * @param {object} logger
 * @returns {Promise<object|null>}
 */
async function callMergeCheck(existingText, newText, llmCfg, callLlm, timeoutMs, agentId, logger) {
  const A = String(existingText || "").slice(0, 2000);
  const B = String(newText || "").slice(0, 2000);
  const prompt = `Two memory fragments — should they be merged into one?\n\nFragment A: ${A}\nFragment B: ${B}\n\nRespond with JSON only: {"merge": boolean, "reason": "brief explanation", "mergedText": "merged version (only if merge=true)"}\nRules:\n- merge=true only if both fragments describe the same subject/fact from different angles\n- mergedText must contain ALL information from both fragments\n- mergedText must be longer than the shorter of the two fragments`;
  const callContext = llmCfg?.callContext || {};

  try {
    const result = await withAbortableLlmTimeout(
      (signal) => callLlm(
        [{ role: "user", content: prompt }],
        withLlmCallContext(
          withLlmResultCacheContext(
            { ...llmCfg, jsonMode: true, maxTokens: 300, temperature: 0 },
            agentId,
            LLM_RESULT_CACHE_PURPOSES.MERGE_DECISION,
          ),
          callContext.agentId || (typeof callContext.runtimeLlm?.complete === "function" ? undefined : agentId),
          LLM_RESULT_CACHE_PURPOSES.MERGE_DECISION,
          { runtimeLlm: callContext.runtimeLlm, signal },
        ),
      ),
      {
        timeoutMs,
        signal: callContext.signal,
        label: "memory compaction merge check",
      },
    );
    if (!result) return null;
    const parsed = JSON.parse(result);
    if (typeof parsed?.merge !== "boolean" || typeof parsed?.reason !== "string") return null;
    if (parsed.merge && typeof parsed.mergedText !== "string") return null;
    return parsed;
  } catch (err) {
    safeWarnLlmFailure(logger, "memory-compaction.llm-merge", err);
    return null;
  }
}

// ─── Load Candidates ───────────────────────────────────────────────────────

function sqlLiteral(value) {
  return `'${String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

async function readSchemaFields(table, logger) {
  try {
    const schema = await table.schema();
    return Array.isArray(schema?.fields) ? schema.fields.map((field) => field.name).filter(Boolean) : [];
  } catch (error) {
    safeDebug(logger, "memory-compaction.schema", error);
    return [];
  }
}

async function buildCompactionWhere(table, cutoffMs, partition, logger, scanCursor = null) {
  const fields = await readSchemaFields(table, logger);
  const has = (name) => fields.includes(name);
  const clauses = [];
  if (has("createdAt")) clauses.push(`createdAt >= ${Math.floor(cutoffMs)}`);
  if (has("status")) clauses.push("(status = 'active' OR status IS NULL OR status = '')");
  if (partition && has("scope")) clauses.push(`scope = ${sqlLiteral(partition.scope)}`);
  if (partition && partition.agentId) {
    const agentPredicates = [];
    if (has("agentId")) agentPredicates.push(`agentId = ${sqlLiteral(partition.agentId)}`);
    if (has("storedBy")) agentPredicates.push(`storedBy = ${sqlLiteral(partition.agentId)}`);
    if (agentPredicates.length > 0) clauses.push(`(${agentPredicates.join(" OR ")})`);
  }
  if (partition?.scope === "workspace" && partition.workspaceIdentity) {
    const workspacePredicates = [];
    if (has("workspaceId")) workspacePredicates.push(`workspaceId = ${sqlLiteral(partition.workspaceIdentity)}`);
    if (has("workspaceKey")) workspacePredicates.push(`workspaceKey = ${sqlLiteral(partition.workspaceIdentity)}`);
    if (workspacePredicates.length > 0) clauses.push(`(${workspacePredicates.join(" OR ")})`);
  }
  if (partition?.scope === "user" && partition.ownerUserId && has("ownerUserId")) {
    clauses.push(`ownerUserId = ${sqlLiteral(partition.ownerUserId)}`);
  }
  if (scanCursor && has("createdAt") && has("id")) {
    clauses.push(`(createdAt < ${scanCursor.createdAt} OR (createdAt = ${scanCursor.createdAt} AND id > ${sqlLiteral(scanCursor.id)}))`);
  }
  return clauses.length > 0 ? clauses.join(" AND ") : "true";
}

async function readPagedRows(table, whereClause, { pageSize, maxRows, logger, rowFilter = null }) {
  const rows = [];
  const seenIds = new Set();
  let offset = 0;
  let useWhere = true;
  let exhausted = false;
  let lastScannedRow = null;

  while (rows.length < maxRows) {
    const requested = Math.min(pageSize, maxRows - rows.length);
    let query;
    let pageLimit = requested;
    try {
      query = table.query();
      if (useWhere && typeof query.where === "function") {
        query = query.where(whereClause);
      } else if (useWhere) {
        useWhere = false;
      }
      if (offset > 0) {
        if (typeof query.offset !== "function") break;
        query = query.offset(offset);
      } else if (typeof query.offset !== "function") {
        // A table implementation without offset gets one bounded, larger
        // read so it cannot silently return only the first page forever.
        const canReadUnbounded = !Number.isFinite(maxRows) && typeof query.toArray === "function";
        pageLimit = canReadUnbounded ? Number.POSITIVE_INFINITY : (Number.isFinite(maxRows) ? maxRows : pageSize);
      }
      if (typeof query.limit === "function" && Number.isFinite(pageLimit)) query = query.limit(pageLimit);
      let page = await query.toArray();
      if (!Array.isArray(page) || page.length === 0) {
        exhausted = true;
        break;
      }
      if (page.length > pageLimit) page = page.slice(0, pageLimit);
      let newRawRows = 0;
      for (const row of page) {
        const id = row?.id;
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        newRawRows += 1;
        lastScannedRow = row;
        if (rowFilter && !rowFilter(row)) continue;
        rows.push(row);
        if (rows.length >= maxRows) break;
      }
      offset += page.length;
      if (newRawRows === 0) break;
      if (rows.length >= maxRows) break;
      if (page.length < pageLimit) {
        exhausted = true;
        break;
      }
    } catch (error) {
      if (useWhere) {
        safeDebug(logger, "memory-compaction.where-fallback", error);
        useWhere = false;
        rows.length = 0;
        seenIds.clear();
        offset = 0;
        exhausted = false;
        lastScannedRow = null;
        continue;
      }
      safeDebug(logger, "memory-compaction.page", error, { offset });
      throw error;
    }
  }
  return { rows, exhausted, lastScannedRow };
}

function compactionRowAllowed(row, cutoffMs, loadScope, workspaceAliases, scanCursor = null) {
  if (!rowAfterCompactionCursor(row, scanCursor)) return false;
  if ((row?.createdAt || 0) < cutoffMs) return false;
  if (row?.status && row.status !== "active") return false;
  if (normalizeEpistemicStatus(row?.epistemicStatus) === "invalidated") return false;
  if (row?.memoryClass === "core" || row?.neverForget === true || row?.neverForget === 1) return false;
  if (loadScope.partition) {
    if (loadScope.requestContext && checkAccess(loadScope.requestContext, row).allowed
      && sameOwnershipTuple(row, loadScope.partition, workspaceAliases)) return true;
    return !loadScope.strict && isLegacyCompactionRow(row, loadScope.expectedAgentId);
  }
  return !loadScope.strict && isLegacyCompactionRow(row, loadScope.expectedAgentId);
}

function projectCompactionCandidates(rows, cutoffMs, loadScope, workspaceAliases, scanCursor = null) {
  return rows
    .filter((row) => compactionRowAllowed(row, cutoffMs, loadScope, workspaceAliases, scanCursor))
    .filter((row) => row.id !== "__schema__")
    .filter((row) => (!row.status || row.status === "active"))
    .filter((row) => normalizeEpistemicStatus(row.epistemicStatus) !== "invalidated")
    .filter((row) => row.memoryClass !== "core" && row.neverForget !== true && row.neverForget !== 1)
    .filter((row) => (row.createdAt || 0) >= cutoffMs)
    .sort(compactionSortCompare)
    .map((row) => ({
      id: row.id,
      text: row.text || "",
      summary: row.summary || "",
      vector: row.vector,
      createdAt: row.createdAt || 0,
      importance: row.importance ?? 0.5,
      category: row.category || "other",
      origin: row.origin || "dm",
      status: row.status || "",
      scope: row.scope || "agent-private",
      agentId: row.agentId || "",
      storedBy: row.storedBy || "",
      workspaceId: row.workspaceId || "",
      workspaceKey: row.workspaceKey || "",
      ownerUserId: row.ownerUserId || "",
      confirmed: row.confirmed === true || row.confirmed === 1,
      epistemicStatus: row.epistemicStatus || "",
      epistemicStatusActor: row.epistemicStatusActor || "",
      epistemicStatusReason: row.epistemicStatusReason || "",
      epistemicStatusUpdatedAt: row.epistemicStatusUpdatedAt ?? 0,
      previousEpistemicStatus: row.previousEpistemicStatus || "",
      validFrom: row.validFrom ?? 0,
      validUntil: row.validUntil ?? 0,
      aclBindings: ownershipTuple(row, workspaceAliases),
    }));
}

async function loadCompactionOverlapCandidates(table, scanState, lookbackDays, loadScope, workspaceAliases) {
  if (!scanState?.cursor || !Array.isArray(scanState.exactCandidates) || scanState.exactCandidates.length === 0) return [];
  if (loadScope.partition && !sameAclBindings(scanState.aclBindings, loadScope.partition)) return [];
  const references = scanState.exactCandidates.filter((reference) => (
    reference.aclBindings
    && (!loadScope.partition || sameAclBindings(reference.aclBindings, loadScope.partition))
  ));
  if (references.length === 0) return [];
  const safeIds = references.map((reference) => safeUuid(reference.id));
  let query = table.query();
  const whereClause = safeIds.map((id) => `id = '${id}'`).join(" OR ");
  if (typeof query.where === "function") query = query.where(whereClause);
  if (typeof query.limit === "function") query = query.limit(safeIds.length);
  const rows = await query.toArray();
  if (!Array.isArray(rows)) throw new Error("compaction overlap query returned a non-array");
  const cutoffMs = Date.now() - lookbackDays * 86400000;
  return projectCompactionCandidates(rows, cutoffMs, loadScope, workspaceAliases);
}

function mergeCompactionCandidates(overlapCandidates, candidates) {
  const byId = new Map();
  for (const candidate of [...overlapCandidates, ...candidates]) {
    if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
  }
  return [...byId.values()].sort(compactionSortCompare);
}

function buildCompactionExactFingerprintState(scanState, candidates, securityScope, workspaceAliases) {
  const references = new Map();
  const add = (reference) => {
    const normalized = normalizeCompactionScanFingerprint(reference);
    if (!normalized || !normalized.aclBindings) return;
    if (securityScope?.partition && !sameAclBindings(normalized.aclBindings, securityScope.partition)) return;
    const current = references.get(normalized.textHash);
    if (!current || normalized.createdAt > current.createdAt
      || (normalized.createdAt === current.createdAt && normalized.id.localeCompare(current.id) < 0)) {
      references.set(normalized.textHash, normalized);
    }
  };
  for (const reference of scanState?.exactCandidates || []) add(reference);
  for (const candidate of candidates) {
    const ownership = ownershipTuple(candidate, workspaceAliases);
    if (!ownership) continue;
    add({
      id: candidate.id,
      textHash: contentHash(normalizedExactText(candidate.text)),
      createdAt: candidate.createdAt,
      aclBindings: ownership,
    });
  }
  return [...references.values()];
}

/**
 * Load active, trusted-enough compaction candidates for one exact ACL partition.
 * @param {object} table LanceDB table.
 * @param {number} lookbackDays Candidate lookback window.
 * @param {{scanLimit?: number, maxScanRows?: number, unboundedScan?: boolean, scanCursor?: object, requestContext?: object, aclPartition?: object, agentId?: string, logger?: object}} [opts]
 * @returns {Promise<Array<object>>} Projected candidates retaining ownership and valid-time fields.
 */
export async function loadCompactionCandidates(table, lookbackDays, opts = {}) {
  const cutoffMs = Date.now() - lookbackDays * 86400000;
  const pageSize = boundedPositiveInteger(opts.scanLimit, DEFAULT_COMPACTION_SCAN_LIMIT);
  const maxRows = opts.unboundedScan === true
    ? Number.POSITIVE_INFINITY
    : boundedPositiveInteger(opts.maxScanRows, DEFAULT_COMPACTION_MAX_SCAN_ROWS);
  const loadScope = resolveCompactionScope(opts);
  const workspaceAliases = loadScope.requestContext?.workspaceAliases || EMPTY_WORKSPACE_ALIASES;
  const scanCursor = normalizeCompactionScanCursor(opts.scanCursor);
  const whereClause = await buildCompactionWhere(table, cutoffMs, loadScope.partition, opts.logger, scanCursor);
  const scanResult = await readPagedRows(table, whereClause, {
    pageSize,
    maxRows,
    logger: opts.logger,
    rowFilter: (row) => compactionRowAllowed(row, cutoffMs, loadScope, workspaceAliases, scanCursor),
  });
  const rows = scanResult.rows;

  const candidates = projectCompactionCandidates(rows, cutoffMs, loadScope, workspaceAliases, scanCursor);
  Object.defineProperty(candidates, "scanMeta", {
    enumerable: false,
    value: {
      exhausted: scanResult.exhausted,
      lastScannedCursor: normalizeCompactionScanCursor(scanResult.lastScannedRow),
    },
  });
  return candidates;
}

// ─── Similarity Graph ──────────────────────────────────────────────────────

function buildSimilarityPairs(memories, threshold, workspaceAliases = EMPTY_WORKSPACE_ALIASES) {
  const pairs = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i];
      const b = memories[j];
      if (!a.vector || !b.vector) continue;
      if (!sameOwnershipTuple(a, b, workspaceAliases)) continue;
      const sim = cosineSimilarityVec(a.vector, b.vector);
      if (sim >= threshold) {
        pairs.push({ a, b, similarity: sim });
      }
    }
  }
  return pairs.sort((p1, p2) => p2.similarity - p1.similarity);
}

// ─── Union-Find für Connected Components ───────────────────────────────────

class UnionFind {
  constructor(items) {
    this.parent = new Map();
    for (const item of items) this.parent.set(item.id, item.id);
  }
  find(id) {
    if (this.parent.get(id) !== id) {
      this.parent.set(id, this.find(this.parent.get(id)));
    }
    return this.parent.get(id);
  }
  union(idA, idB) {
    const rootA = this.find(idA);
    const rootB = this.find(idB);
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }
}

function clusterBySimilarity(pairs, memories, workspaceAliases = EMPTY_WORKSPACE_ALIASES) {
  const uf = new UnionFind(memories);
  for (const pair of pairs) {
    if (sameOwnershipTuple(pair.a, pair.b, workspaceAliases)) uf.union(pair.a.id, pair.b.id);
  }
  const groups = new Map();
  for (const mem of memories) {
    const root = uf.find(mem.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(mem);
  }
  // Nur Gruppen mit >= 2 Mitgliedern sind interessant
  return [...groups.values()]
    .filter(g => g.length >= 2)
    .filter((group) => group.every((memory) => sameOwnershipTuple(group[0], memory, workspaceAliases)));
}

// ─── Action Generation ─────────────────────────────────────────────────────

/**
 * Generate compaction actions for a similarity cluster.
 * @param {Array<object>} cluster
 * @param {object} opts
 * @param {string} opts.agentId
 * @returns {Promise<Array<object>>}
 */
async function generateCompactionActions(cluster, opts) {
  const { llmCfg, callLlm, llmMergeTimeoutMs, logger, agentId } = opts;
  const workspaceAliases = opts.workspaceAliases || EMPTY_WORKSPACE_ALIASES;
  const aclBindings = ownershipTuple(cluster[0], workspaceAliases);
  if (!aclBindings || cluster.some((memory) => !sameOwnershipTuple(cluster[0], memory, workspaceAliases))) return [];
  const secureAction = (action, rows) => ({
    ...action,
    aclBindings,
    expectedRows: rows.map((row) => rowSnapshot(row, workspaceAliases)),
  });
  const actions = [];

  // Sortiere nach createdAt desc → neueste zuerst
  const sorted = [...cluster].sort(compactionSortCompare);
  const keep = sorted[0];

  // Prüfe auf identische Duplikate
  const duplicates = sorted.slice(1).filter(
    (memory) => (
      isIdenticalText(memory, keep)
      && !hasDisjointValidityWindows(memory, keep)
      && hasEquivalentEpistemicEvidence(memory, keep)
    ),
  );
  for (const dup of duplicates) {
    actions.push(secureAction(
      { type: "delete", id: dup.id, targetId: keep.id, reason: "identical_duplicate", similarity: 1.0 },
      [dup, keep],
    ));
  }

  // Verbleibende: kompatibel oder widersprüchlich
  const remaining = sorted.slice(1).filter(m => !duplicates.includes(m));
  for (const mem of remaining) {
    // Phase 2 — Bi-Temporal Memory (plan §8b). Two textually-compatible rows
    // with known, disjoint validity windows are NOT the same claim merely
    // reworded — they are two historical facts (e.g. "Firma A" then "Firma
    // B") that happen to share overlapping vocabulary. Attempting an LLM
    // merge on them would collapse distinct historical states into one row.
    // Route to the existing mark_redundant action instead (logged-only,
    // never auto-applied — see isLowRiskAutoApplyAction below), not a new
    // action kind.
    if (isCompatibleText(mem, keep) && !hasDisjointValidityWindows(mem, keep)) {
      // Versuche Merge via LLM
      if (llmCfg && callLlm) {
        const mergeResult = await callMergeCheck(
          keep.text,
          mem.text,
          llmCfg,
          callLlm,
          llmMergeTimeoutMs,
          agentId,
          logger,
        );
        if (mergeResult?.merge === true && mergeResult.mergedText && mergeResult.mergedText.length > Math.min(keep.text.length, mem.text.length)) {
          actions.push(secureAction({
            type: "merge",
            id: keep.id,
            targetId: mem.id,
            mergedText: mergeResult.mergedText,
            reason: `llm_merge: ${mergeResult.reason || ""}`,
            similarity: cosineSimilarityVec(keep.vector, mem.vector),
          }, [keep, mem]));
          continue;
        }
      }
      // Kein Merge möglich → behalte beide, aber markiere als potenziell redundant
      actions.push(secureAction(
        { type: "mark_redundant", id: mem.id, targetId: keep.id, reason: "compatible_but_not_merged" },
        [mem, keep],
      ));
    } else if (isCompatibleText(mem, keep)) {
      actions.push(secureAction(
        { type: "mark_redundant", id: mem.id, targetId: keep.id, reason: "compatible_text_disjoint_validity_window" },
        [mem, keep],
      ));
      continue;
    } else {
      // Widersprüchlich → Konflikt
      actions.push(secureAction(
        { type: "mark_conflict", id: mem.id, targetId: keep.id, reason: "contradictory_content" },
        [mem, keep],
      ));
    }
  }

  return actions;
}

// ─── Action Execution ──────────────────────────────────────────────────────

function appendAlias(workspaceDir, alias) {
  if (!workspaceDir) return;
  const dir = join(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "memory-aliases.jsonl");
  appendFileSync(path, JSON.stringify(alias) + "\n", "utf8");
}

async function tryArchive(table, id, logger) {
  try {
    const safe = safeUuid(id);
    await table.update({
      where: `id = '${safe}'`,
      values: { status: safeStatus("archived") },
    });
    logger?.info?.(`memory-compaction: archived ${id}`);
    return true;
  } catch (err) {
    logger?.warn?.(`memory-compaction: archive failed for ${id}: ${err.message}`);
    return false;
  }
}

function resolveCompactionOutputDir(opts, securityScope) {
  const sink = opts.proposalSink;
  const explicitDir = typeof sink === "string"
    ? sink
    : sink?.outputDir || opts.outputDir || opts.proposalOutputDir || null;
  const explicitBindings = typeof sink === "object" && sink
    ? sink.aclBindings
    : opts.outputAclBindings;
  if (securityScope?.partition && securityScope.partition.scope !== "workspace") {
    return explicitDir && explicitBindings && sameAclBindings(explicitBindings, securityScope.partition)
      ? explicitDir
      : null;
  }
  return explicitDir || opts.workspaceDir || null;
}

function persistProposals(workspaceDir, actions, logger) {
  if (!workspaceDir) {
    logger?.warn?.("memory-compaction: proposal persistence skipped — owner-bound sink missing");
    return 0;
  }
  try {
    const dir = join(workspaceDir, ".adaptive-learning");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, "merge-proposals.jsonl");
    const partitions = [...new Map(
      actions
        .filter((action) => action?.aclBindings)
        .map((action) => [JSON.stringify(action.aclBindings), action.aclBindings]),
    ).values()];
    const entry = {
      proposedAt: Date.now(),
      actions,
      aclBindings: partitions.length === 1 ? partitions[0] : null,
      aclPartitions: partitions,
      status: "pending",
    };
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
    logger?.info?.(`memory-compaction: persisted ${actions.length} proposals for approval`);
    return actions.length;
  } catch (err) {
    logger?.warn?.(`memory-compaction: failed to persist proposals: ${err.message}`);
    return 0;
  }
}

function isLowRiskAutoApplyAction(action) {
  return action?.type === "delete" && action.reason === "identical_duplicate";
}

async function rereadActionRows(table, ids, logger) {
  const uniqueIds = [...new Set(ids)];
  let safeIds;
  try {
    safeIds = uniqueIds.map((id) => safeUuid(id));
  } catch (error) {
    safeDebug(logger, "memory-compaction.revalidate.invalid-id", error);
    return null;
  }
  try {
    let query = table.query();
    const whereClause = safeIds.map((id) => `id = '${id}'`).join(" OR ");
    if (typeof query.where === "function") query = query.where(whereClause);
    if (typeof query.limit === "function") query = query.limit(safeIds.length);
    const rows = await query.toArray();
    if (!Array.isArray(rows)) return null;
    const byId = new Map(rows.filter((row) => safeIds.includes(row?.id)).map((row) => [row.id, row]));
    return safeIds.map((id) => byId.get(id) || null);
  } catch (error) {
    safeDebug(logger, "memory-compaction.revalidate.read", error);
    return null;
  }
}

function sameAclBindings(left, right) {
  return Boolean(left && right
    && left.scope === right.scope
    && left.agentId === right.agentId
    && left.workspaceIdentity === right.workspaceIdentity
    && left.ownerUserId === right.ownerUserId);
}

function matchesActionSnapshot(row, snapshot, workspaceAliases) {
  if (!row || !snapshot || row.id !== snapshot.id) return false;
  if (contentHash(row.text) !== snapshot.textHash) return false;
  if ((row.status || "") !== snapshot.status) return false;
  if (normalizeEpistemicStatus(row.epistemicStatus) !== snapshot.epistemicStatus) return false;
  if (String(row.epistemicStatusActor || "") !== String(snapshot.epistemicStatusActor || "")) return false;
  if (String(row.epistemicStatusReason || "") !== String(snapshot.epistemicStatusReason || "")) return false;
  if (String(row.previousEpistemicStatus || "") !== String(snapshot.previousEpistemicStatus || "")) return false;
  if (String(row.epistemicStatusUpdatedAt ?? 0) !== String(snapshot.epistemicStatusUpdatedAt ?? 0)) return false;
  if (!sameValidityBound(row.validFrom, snapshot.validFrom) || !sameValidityBound(row.validUntil, snapshot.validUntil)) return false;
  return sameAclBindings(ownershipTuple(row, workspaceAliases), snapshot.aclBindings);
}

async function revalidateAutoArchiveAction(table, action, candidates, securityScope, logger) {
  const memoryMap = new Map(candidates.map((memory) => [memory.id, memory]));
  const source = memoryMap.get(action.id);
  const target = memoryMap.get(action.targetId);
  const workspaceAliases = securityScope?.requestContext?.workspaceAliases || EMPTY_WORKSPACE_ALIASES;
  const expectedRows = Array.isArray(action.expectedRows) && action.expectedRows.length === 2
    ? action.expectedRows
    : [source, target].filter(Boolean).map((row) => rowSnapshot(row, workspaceAliases));
  if (!source || !target || expectedRows.length !== 2) return false;

  const currentRows = await rereadActionRows(table, [action.id, action.targetId], logger);
  if (!currentRows || currentRows.length !== 2 || currentRows.some((row) => !row)) return false;
  if (!currentRows.every((row, index) => matchesActionSnapshot(row, expectedRows[index], workspaceAliases))) return false;

  for (const row of currentRows) {
    if (row.status && row.status !== "active") return false;
    if (normalizeEpistemicStatus(row.epistemicStatus) === "invalidated") return false;
    if (row.memoryClass === "core" || row.neverForget === true || row.neverForget === 1) return false;
    if (securityScope?.partition) {
      if (!securityScope.requestContext || !checkAccess(securityScope.requestContext, row).allowed) return false;
      if (!sameOwnershipTuple(row, securityScope.partition, workspaceAliases)) return false;
    } else if (!isLegacyCompactionRow(row, securityScope?.expectedAgentId || "")) {
      return false;
    }
  }
  if (!sameOwnershipTuple(currentRows[0], currentRows[1], workspaceAliases)) return false;
  if (hasDisjointValidityWindows(currentRows[0], currentRows[1])) return false;
  if (action.aclBindings && !sameAclBindings(ownershipTuple(currentRows[0], workspaceAliases), action.aclBindings)) return false;
  return true;
}

async function executeActions(table, actions, candidates, dryRun, autoApply, logger, outputDir, embeddings, securityScope, tombstoneCtx = {}) {
  if (dryRun) {
    logger?.info?.(`memory-compaction: dry-run, ${actions.length} actions would execute`);
    return { executed: 0, dryRun: true, planned: actions.length, proposalsPersisted: 0, actions };
  }

  if (!autoApply) {
    const proposalsPersisted = persistProposals(outputDir, actions, logger);
    return {
      executed: 0,
      autoApply: false,
      planned: actions.length,
      proposals: actions.length,
      proposalsPersisted,
      errors: proposalsPersisted === actions.length ? 0 : 1,
      actions,
    };
  }

  const lowRiskActions = actions.filter(isLowRiskAutoApplyAction);
  const proposalActions = actions.filter((action) => !isLowRiskAutoApplyAction(action));
  let proposalsPersisted = 0;
  const errors = [];
  if (proposalActions.length > 0) {
    proposalsPersisted = persistProposals(outputDir, proposalActions, logger);
    if (proposalsPersisted !== proposalActions.length) {
      errors.push({ actions: proposalActions, error: "proposal_persistence_failed" });
    }
  }

  let executed = 0;
  let deleted = 0;
  let merged = 0;
  const memoryMap = new Map(candidates.map(m => [m.id, m]));

  for (const action of lowRiskActions) {
    try {
      switch (action.type) {
        case "delete": {
          // Re-read and validate both rows immediately before the first
          // archive. This closes the TOCTOU gap between proposal generation
          // and mutation, including ACL, ownership, trust, and valid-time.
          if (!await revalidateAutoArchiveAction(table, action, candidates, securityScope, logger)) {
            errors.push({ action, error: "auto_archive_revalidation_failed" });
            break;
          }
          const archived = await tryArchive(table, action.id, logger);
          if (!archived) {
            errors.push({ action, error: "archive_failed" });
            break;
          }
          appendAlias(outputDir, {
            oldId: action.id,
            canonicalId: action.targetId,
            reason: "duplicate",
            createdAt: Date.now(),
            aclBindings: action.aclBindings || null,
          });
          executed++;
          deleted++;
          logger?.info?.(`memory-compaction: aliased duplicate ${action.id} → ${action.targetId}`);
          break;
        }
        case "merge": {
          const target = memoryMap.get(action.id);
          if (!target) {
            errors.push({ action, error: "target not found in candidates" });
            break;
          }
          const mergeGuard = assertCardWriteAllowed({
            baseDbPath: tombstoneCtx.baseDbPath,
            agentId: tombstoneCtx.agentId || target.agentId || target.storedBy,
            text: action.mergedText,
            scope: target.scope || action.aclBindings?.scope || "agent-private",
            workspaceIdentity: target.workspaceId || target.workspaceKey || action.aclBindings?.workspaceIdentity || "",
            ownerUserId: target.ownerUserId || action.aclBindings?.ownerUserId || "",
          });
          if (!mergeGuard.allowed) {
            logger?.warn?.(`memory-compaction: merge blocked by tombstone; sources kept ${action.id} + ${action.targetId}`);
            errors.push({ action, error: "tombstone_blocked" });
            break;
          }
          // Blocker 1 / plan §7b: the previous code only ever loaded `target`
          // (action.id, the "keep" side) and spread it wholesale into the
          // merged row — the "other" side (action.targetId, the row being
          // merged away) was never consulted for epistemicStatus at all, so
          // a disputed/untrusted memory merged INTO a trusted one would
          // silently inherit "trusted". Load both sides explicitly.
          const other = memoryMap.get(action.targetId);
          const mergedId = randomUUID();
          // Archive both originals
          appendAlias(outputDir, {
            oldId: action.id,
            canonicalId: mergedId,
            reason: "merged",
            createdAt: Date.now(),
            aclBindings: action.aclBindings || null,
          });
          appendAlias(outputDir, {
            oldId: action.targetId,
            canonicalId: mergedId,
            reason: "merged",
            createdAt: Date.now(),
            aclBindings: action.aclBindings || null,
          });
          const archivedTarget = await tryArchive(table, action.id, logger);
          const archivedOther = archivedTarget && await tryArchive(table, action.targetId, logger);
          if (!archivedTarget || !archivedOther) {
            errors.push({ action, error: "merge_archive_failed" });
            break;
          }
          // Add merged with FRESH embedding for the new text
          try {
            let mergedVector = target.vector;
            if (embeddings && typeof embeddings.embed === "function") {
              try {
                mergedVector = await embeddings.embed(action.mergedText);
              } catch (embedErr) {
                logger?.warn?.(`memory-compaction: re-embed failed, using old vector: ${embedErr.message}`);
              }
            }
            const merged = {
              ...target,
              id: mergedId,
              text: action.mergedText,
              summary: action.mergedText.split("\n")[0].slice(0, 200),
              vector: mergedVector,
              createdAt: Date.now(),
              mergedFrom: JSON.stringify([action.id, action.targetId]),
              // See combineEpistemicStatusForMerge() (plan §7b): the merge
              // result takes the MORE CONSERVATIVE of the two source
              // statuses, not just `target`'s. `other` may be undefined if
              // it fell out of `candidates` between action-generation and
              // execution; normalizeEpistemicStatus(undefined) resolves
              // fail-closed to "untrusted", which is the correct
              // conservative default for that edge case too.
              epistemicStatus: combineEpistemicStatusForMerge(target.epistemicStatus, other?.epistemicStatus),
              epistemicStatusActor: "system:merge",
              epistemicStatusReason: `compaction merge of ${action.id} + ${action.targetId}`,
              epistemicStatusUpdatedAt: Date.now(),
              previousEpistemicStatus: normalizeEpistemicStatus(target.epistemicStatus),
              // Phase 2 — Bi-Temporal Memory (plan §8b), mirrors the
              // epistemicStatus treatment above. Defensive: this "merge"
              // branch is currently unreachable at auto-apply time
              // (isLowRiskAutoApplyAction only accepts type==="delete"), so
              // this is defense-in-depth for if that gate is ever loosened,
              // not something exercised by the live auto-apply path today.
              ...combineValidTimeForMerge(target, other),
            };
            if (merged.vector && !Array.isArray(merged.vector)) {
              merged.vector = Array.from(merged.vector);
            }
            await table.add([merged]);
          } catch (addErr) {
            logger?.warn?.(`memory-compaction: merged add failed, aliases preserved: ${addErr.message}`);
            errors.push({ action, error: "merge_add_failed" });
            break;
          }
          executed++;
          merged++;
          logger?.info?.(`memory-compaction: aliased merge ${action.id} + ${action.targetId} → ${mergedId}`);
          break;
        }
        case "mark_redundant":
        case "mark_conflict": {
          logger?.info?.(`memory-compaction: ${action.type} ${action.id} (vs ${action.targetId})`);
          break;
        }
      }
    } catch (err) {
      errors.push({ action, error: err.message });
      logger?.warn?.(`memory-compaction: action failed: ${action.type} ${action.id}: ${err.message}`);
    }
  }

  return {
    executed,
    deleted,
    merged,
    errors: errors.length,
    errorDetails: errors.slice(0, 5),
    autoApply: true,
    autoApplyRisk: "low-only",
    proposals: proposalActions.length,
    proposalsPersisted,
    planned: actions.length,
  };
}

// ─── Hauptfunktion ─────────────────────────────────────────────────────────

/**
 * Compact one agent's memory table and optionally use deterministic LLM merge decisions.
 * @param {object} db
 * @param {object} [opts]
 * @param {string} [opts.agentId]
 * @param {object} [opts.requestContext] Canonical authenticated memory context.
 * @param {object} [opts.aclPartition] One authorized exact ownership partition.
 * @returns {Promise<object>}
 */
export async function runMemoryCompaction(db, opts = {}) {
  const mergedOpts = { ...DEFAULT_OPTS, ...opts };
  const {
    timeoutMs = DEFAULT_COMPACTION_TIMEOUT_MS,
    logger = { info: () => {}, warn: () => {} },
  } = mergedOpts;

  try {
    return await withTimeout(
      runMemoryCompactionBody(db, mergedOpts),
      timeoutMs,
      "memory-compaction",
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      logger.warn?.(`memory-compaction: timed out after ${timeoutMs}ms`);
      return {
        compacted: 0,
        merged: 0,
        deleted: 0,
        planned: 0,
        plannedDeleted: 0,
        plannedMerged: 0,
        proposalsPersisted: 0,
        executed: 0,
        note: "timeout",
        timeoutMs,
        durationMs: timeoutMs,
      };
    }
    throw err;
  }
}

async function runMemoryCompactionBody(db, mergedOpts) {
  const {
    similarityThreshold,
    lookbackDays,
    maxBatchSize: requestedBatchSize,
    dryRun,
    autoApply,
    llmCfg,
    callLlm,
    llmMergeTimeoutMs,
    agentId,
    logger = { info: () => {}, warn: () => {} },
    neoStore,
    embeddings,
  } = mergedOpts;

  // Lokale Provider (CPU/GPU) sind langsamer — Batch-Größe automatisch reduzieren
  const isLocalProvider = embeddings?.id === "local-transformers";
  const requestedBatchNumber = Number(requestedBatchSize ?? DEFAULT_OPTS.maxBatchSize);
  const normalizedBatchSize = Number.isFinite(requestedBatchNumber) && requestedBatchNumber > 0
    ? Math.max(1, Math.floor(requestedBatchNumber))
    : DEFAULT_OPTS.maxBatchSize;
  const maxBatchSize = isLocalProvider
    ? Math.min(normalizedBatchSize, 10)
    : normalizedBatchSize;

  const startTime = Date.now();

  if (!db || !db.table) {
    return {
      compacted: 0,
      merged: 0,
      deleted: 0,
      planned: 0,
      plannedDeleted: 0,
      plannedMerged: 0,
      proposalsPersisted: 0,
      executed: 0,
      note: "db.table missing",
      durationMs: 0,
    };
  }

  const securityScope = resolveCompactionScope({ ...mergedOpts, logger });
  if ((mergedOpts.requestContext || mergedOpts.aclPartition || mergedOpts.ownershipPartition || mergedOpts.partition)
    && !securityScope.partition) {
    return {
      compacted: 0,
      merged: 0,
      deleted: 0,
      planned: 0,
      plannedDeleted: 0,
      plannedMerged: 0,
      proposalsPersisted: 0,
      executed: 0,
      note: "acl_partition_missing",
      durationMs: Date.now() - startTime,
    };
  }
  const compactionRunKey = `compaction:${db.dbPath || "unknown"}${securityScope.partition ? `:${securityScope.partition.key}` : ""}`;
  const scanStateId = compactionScanStateId(securityScope, agentId);
  const persistScanState = allowPersistentCompactionScanState(securityScope, mergedOpts);
  const scanState = readCompactionScanState(db, neoStore, scanStateId, persistScanState, logger);
  const scanCursor = scanState?.cursor || null;

  // Idempotenz-Prüfung
  const statePath = neoStore?.paths?.runs;
  let previousDigest = "";
  if (statePath && neoStore.readRunState) {
    const state = neoStore.readRunState();
    previousDigest = securityScope.partition ? "" : (state.compaction?.lastDigest || "");
  }

  const loadedCandidates = await loadCompactionCandidates(db.table, lookbackDays, {
    ...mergedOpts,
    requestContext: mergedOpts.requestContext,
    aclPartition: mergedOpts.aclPartition || mergedOpts.ownershipPartition || mergedOpts.partition,
    agentId,
    scanCursor,
    unboundedScan: securityScope.partition
      && securityScope.partition.scope !== "workspace"
      && !persistScanState,
    logger,
  });
  const scanMeta = loadedCandidates.scanMeta || {};
  const persistedOverlapCandidates = await loadCompactionOverlapCandidates(
    db.table,
    scanState,
    lookbackDays,
    securityScope,
    securityScope.requestContext?.workspaceAliases || EMPTY_WORKSPACE_ALIASES,
  );
  const currentExactHashes = new Set(
    loadedCandidates.map((candidate) => contentHash(normalizedExactText(candidate.text))),
  );
  const overlapCandidates = persistedOverlapCandidates.filter((candidate) => (
    currentExactHashes.has(contentHash(normalizedExactText(candidate.text)))
  ));
  const candidates = mergeCompactionCandidates(overlapCandidates, loadedCandidates);
  const nextScanCursor = scanMeta.exhausted
    ? null
    : (scanMeta.lastScannedCursor || normalizeCompactionScanCursor(loadedCandidates[loadedCandidates.length - 1]));
  const nextExactFingerprintState = buildCompactionExactFingerprintState(
    scanState,
    loadedCandidates,
    securityScope,
    securityScope.requestContext?.workspaceAliases || EMPTY_WORKSPACE_ALIASES,
  );
  const advanceScan = async (successful = true) => {
    if (!dryRun && autoApply && successful) {
      await writeCompactionScanState(
        db,
        neoStore,
        scanStateId,
        securityScope,
        nextScanCursor,
        nextExactFingerprintState,
        persistScanState,
        logger,
      );
    }
  };

  if (candidates.length < 2) {
    await advanceScan();
    return {
      compacted: 0,
      merged: 0,
      deleted: 0,
      planned: 0,
      plannedDeleted: 0,
      plannedMerged: 0,
      proposalsPersisted: 0,
      executed: 0,
      candidates: candidates.length,
      note: "too_few_candidates",
      durationMs: Date.now() - startTime,
    };
  }

  logger.info?.(`memory-compaction: ${candidates.length} candidates loaded`);

  // Keep exact-text clusters across every bounded batch. The former per-batch
  // clustering split an otherwise identical pair exactly at maxBatchSize and
  // permanently missed it.
  const workspaceAliases = securityScope.requestContext?.workspaceAliases || EMPTY_WORKSPACE_ALIASES;
  const exactClusters = new Map();
  for (let offset = 0; offset < candidates.length; offset += maxBatchSize) {
    const batch = candidates.slice(offset, offset + maxBatchSize);
    for (const memory of batch) {
      const key = exactTextClusterKey(memory, workspaceAliases);
      if (!key) continue;
      if (!exactClusters.has(key)) exactClusters.set(key, []);
      exactClusters.get(key).push(memory);
    }
  }
  const exactClusterGroups = [...exactClusters.values()].filter((group) => group.length >= 2);
  const exactClusterMembers = new Set(exactClusterGroups.flat());
  const allActions = [];
  const actionKeys = new Set();
  const appendActions = (actions) => {
    for (const action of actions) {
      const key = `${action.type}:${action.id}:${action.targetId || ""}`;
      if (actionKeys.has(key)) continue;
      actionKeys.add(key);
      allActions.push(action);
    }
  };
  let clusterCount = 0;

  for (const cluster of exactClusterGroups) {
    clusterCount++;
    appendActions(await generateCompactionActions(cluster, {
      llmCfg,
      callLlm,
      llmMergeTimeoutMs,
      logger,
      agentId,
      workspaceAliases,
    }));
  }

  for (let offset = 0; offset < candidates.length; offset += maxBatchSize) {
    const batch = candidates
      .slice(offset, offset + maxBatchSize)
      .filter((memory) => !exactClusterMembers.has(memory));
    if (batch.length < 2) continue;
    const pairs = buildSimilarityPairs(batch, similarityThreshold, workspaceAliases);
    const clusters = clusterBySimilarity(pairs, batch, workspaceAliases);
    clusterCount += clusters.length;
    for (const cluster of clusters) {
      const actions = await generateCompactionActions(cluster, {
        llmCfg,
        callLlm,
        llmMergeTimeoutMs,
        logger,
        agentId,
        workspaceAliases,
      });
      appendActions(actions);
    }
  }

  if (clusterCount === 0) {
    await advanceScan();
    return {
      compacted: 0,
      merged: 0,
      deleted: 0,
      planned: 0,
      plannedDeleted: 0,
      plannedMerged: 0,
      proposalsPersisted: 0,
      executed: 0,
      candidates: candidates.length,
      note: "no_clusters",
      durationMs: Date.now() - startTime,
    };
  }

  logger.info?.(`memory-compaction: ${clusterCount} clusters found`);

  const digest = computeCompactionDigest(allActions);
  if (digest === previousDigest) {
    await advanceScan();
    return {
      compacted: 0,
      merged: 0,
      deleted: 0,
      planned: 0,
      plannedDeleted: allActions.filter((action) => action.type === "delete").length,
      plannedMerged: allActions.filter((action) => action.type === "merge").length,
      proposalsPersisted: 0,
      executed: 0,
      note: "already_compacted",
      durationMs: Date.now() - startTime,
    };
  }

  const outputDir = resolveCompactionOutputDir(mergedOpts, securityScope);

  const result = await executeActions(
    db.table,
    allActions,
    candidates,
    dryRun,
    autoApply,
    logger,
    outputDir,
    embeddings,
    securityScope,
    {
      baseDbPath: mergedOpts.baseDbPath || (db.dbPath ? splitAgentDbPath(db.dbPath).baseDbPath : ""),
      agentId: mergedOpts.agentId || (db.dbPath ? splitAgentDbPath(db.dbPath).agentId : ""),
    },
  );

  const plannedDeleted = allActions.filter(a => a.type === "delete").length;
  const plannedMerged = allActions.filter(a => a.type === "merge").length;
  const deleted = result.deleted || 0;
  const merged = result.merged || 0;
  const successfulRun = (result.errors || 0) === 0;

  // State speichern nur wenn autoApply aktiv (oder dryRun) — bei Pending-Proposals
  // soll der gleiche Digest beim nächsten Lauf erneut generiert werden.
  if (neoStore?.markRunCompleted && !dryRun && autoApply && successfulRun) {
    neoStore.markRunCompleted(compactionRunKey, {
      digest,
      deleted,
      merged,
      plannedDeleted,
      plannedMerged,
      clusters: clusterCount,
      aclBindings: securityScope.partition || null,
      durationMs: Date.now() - startTime,
    });
  }

  await advanceScan(successfulRun);

  logger.info?.(`memory-compaction: ${deleted} deleted, ${merged} merged, ${result.errors || 0} errors`);

  return {
    compacted: allActions.length,
    deleted,
    merged,
    plannedDeleted,
    plannedMerged,
    planned: allActions.length,
    clusters: clusterCount,
    candidates: candidates.length,
    dryRun,
    autoApply,
    autoApplyRisk: result.autoApplyRisk,
    executed: result.executed || 0,
    proposals: result.proposals || 0,
    proposalsPersisted: result.proposalsPersisted || 0,
    durationMs: Date.now() - startTime,
    errors: result.errors || 0,
  };
}

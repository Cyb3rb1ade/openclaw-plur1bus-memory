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

function boundedPositiveInteger(value, fallback, maximum = DEFAULT_COMPACTION_MAX_SCAN_ROWS) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.max(1, Math.floor(numeric)), maximum);
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
  return String(a.text || "").trim().toLowerCase() === String(b.text || "").trim().toLowerCase();
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

async function buildCompactionWhere(table, cutoffMs, partition, logger) {
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
  return clauses.length > 0 ? clauses.join(" AND ") : "true";
}

async function readPagedRows(table, whereClause, { pageSize, maxRows, logger }) {
  const rows = [];
  const seenIds = new Set();
  let offset = 0;
  let useWhere = true;

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
        pageLimit = maxRows;
      }
      if (typeof query.limit === "function") query = query.limit(pageLimit);
      let page = await query.toArray();
      if (!Array.isArray(page) || page.length === 0) break;
      if (page.length > pageLimit) page = page.slice(0, pageLimit);
      const rowsBeforePage = rows.length;
      for (const row of page) {
        const id = row?.id;
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        rows.push(row);
        if (rows.length >= maxRows) break;
      }
      offset += page.length;
      if (rows.length === rowsBeforePage) break;
      if (page.length < pageLimit) break;
    } catch (error) {
      if (useWhere) {
        safeDebug(logger, "memory-compaction.where-fallback", error);
        useWhere = false;
        rows.length = 0;
        seenIds.clear();
        offset = 0;
        continue;
      }
      safeDebug(logger, "memory-compaction.page", error, { offset });
      break;
    }
  }
  return rows;
}

/**
 * Load active, trusted-enough compaction candidates for one exact ACL partition.
 * @param {object} table LanceDB table.
 * @param {number} lookbackDays Candidate lookback window.
 * @param {{scanLimit?: number, maxScanRows?: number, requestContext?: object, aclPartition?: object, agentId?: string, logger?: object}} [opts]
 * @returns {Promise<Array<object>>} Projected candidates retaining ownership and valid-time fields.
 */
export async function loadCompactionCandidates(table, lookbackDays, opts = {}) {
  const cutoffMs = Date.now() - lookbackDays * 86400000;
  const pageSize = boundedPositiveInteger(opts.scanLimit, DEFAULT_COMPACTION_SCAN_LIMIT);
  const maxRows = boundedPositiveInteger(opts.maxScanRows, DEFAULT_COMPACTION_MAX_SCAN_ROWS);
  const loadScope = resolveCompactionScope(opts);
  const workspaceAliases = loadScope.requestContext?.workspaceAliases || EMPTY_WORKSPACE_ALIASES;
  const whereClause = await buildCompactionWhere(table, cutoffMs, loadScope.partition, opts.logger);
  const rows = await readPagedRows(table, whereClause, {
    pageSize,
    maxRows,
    logger: opts.logger,
  });

  return rows
    .filter(r => r.id !== '__schema__')
    .filter(r => (!r.status || r.status === 'active'))
    // An invalidated memory must never be auto-compacted (merged/aliased into
    // another memory, or used as a merge target) — that would let a retracted
    // fact re-enter the live memory graph under a different id (see plan §7a,
    // Blocker 1).
    .filter(r => normalizeEpistemicStatus(r.epistemicStatus) !== "invalidated")
    .filter(r => r.memoryClass !== "core" && r.neverForget !== true && r.neverForget !== 1)
    .filter(r => (r.createdAt || 0) >= cutoffMs)
    .filter((row) => {
      if (loadScope.partition) {
        if (loadScope.requestContext && checkAccess(loadScope.requestContext, row).allowed
          && sameOwnershipTuple(row, loadScope.partition, workspaceAliases)) return true;
        return !loadScope.strict && isLegacyCompactionRow(row, loadScope.expectedAgentId);
      }
      return !loadScope.strict && isLegacyCompactionRow(row, loadScope.expectedAgentId);
    })
    .sort((a, b) => {
      const timeDelta = Number(b.createdAt || 0) - Number(a.createdAt || 0);
      return timeDelta || String(a.id).localeCompare(String(b.id));
    })
    .map(r => ({
      id: r.id,
      text: r.text || "",
      summary: r.summary || "",
      vector: r.vector,
      createdAt: r.createdAt || 0,
      importance: r.importance ?? 0.5,
      category: r.category || "other",
      origin: r.origin || "dm",
      status: r.status || "",
      scope: r.scope || "agent-private",
      agentId: r.agentId || "",
      storedBy: r.storedBy || "",
      workspaceId: r.workspaceId || "",
      workspaceKey: r.workspaceKey || "",
      ownerUserId: r.ownerUserId || "",
      confirmed: r.confirmed === true || r.confirmed === 1,
      epistemicStatus: r.epistemicStatus || "",
      epistemicStatusActor: r.epistemicStatusActor || "",
      epistemicStatusReason: r.epistemicStatusReason || "",
      epistemicStatusUpdatedAt: r.epistemicStatusUpdatedAt ?? 0,
      previousEpistemicStatus: r.previousEpistemicStatus || "",
      // Phase 2 — Bi-Temporal Memory (plan §8b). Pass-through only; the
      // exclusion/disjoint-window checks happen downstream in
      // generateCompactionActions/executeActions.
      validFrom: r.validFrom ?? 0,
      validUntil: r.validUntil ?? 0,
      aclBindings: ownershipTuple(r, workspaceAliases),
    }));
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
  const sorted = [...cluster].sort((a, b) => b.createdAt - a.createdAt);
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

function persistProposals(workspaceDir, actions, logger) {
  if (!workspaceDir) return;
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
  try {
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
    logger?.info?.(`memory-compaction: persisted ${actions.length} proposals for approval`);
  } catch (err) {
    logger?.warn?.(`memory-compaction: failed to persist proposals: ${err.message}`);
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

async function executeActions(table, actions, candidates, dryRun, autoApply, logger, workspaceDir, embeddings, securityScope) {
  if (dryRun) {
    logger?.info?.(`memory-compaction: dry-run, ${actions.length} actions would execute`);
    return { executed: 0, dryRun: true, actions };
  }

  if (!autoApply) {
    persistProposals(workspaceDir, actions, logger);
    return { executed: 0, autoApply: false, proposals: actions.length, actions };
  }

  const lowRiskActions = actions.filter(isLowRiskAutoApplyAction);
  const proposalActions = actions.filter((action) => !isLowRiskAutoApplyAction(action));
  if (proposalActions.length > 0) {
    persistProposals(workspaceDir, proposalActions, logger);
  }

  let executed = 0;
  const errors = [];
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
          appendAlias(workspaceDir, {
            oldId: action.id,
            canonicalId: action.targetId,
            reason: "duplicate",
            createdAt: Date.now(),
            aclBindings: action.aclBindings || null,
          });
          executed++;
          logger?.info?.(`memory-compaction: aliased duplicate ${action.id} → ${action.targetId}`);
          break;
        }
        case "merge": {
          const target = memoryMap.get(action.id);
          if (!target) {
            errors.push({ action, error: "target not found in candidates" });
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
          appendAlias(workspaceDir, {
            oldId: action.id,
            canonicalId: mergedId,
            reason: "merged",
            createdAt: Date.now(),
            aclBindings: action.aclBindings || null,
          });
          appendAlias(workspaceDir, {
            oldId: action.targetId,
            canonicalId: mergedId,
            reason: "merged",
            createdAt: Date.now(),
            aclBindings: action.aclBindings || null,
          });
          await tryArchive(table, action.id, logger);
          await tryArchive(table, action.targetId, logger);
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
          }
          executed += 2;
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
    errors: errors.length,
    errorDetails: errors.slice(0, 5),
    autoApply: true,
    autoApplyRisk: "low-only",
    proposals: proposalActions.length,
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
      return { compacted: 0, merged: 0, deleted: 0, note: "timeout", timeoutMs, durationMs: timeoutMs };
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
    workspaceDir,
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
    return { compacted: 0, merged: 0, deleted: 0, note: "db.table missing", durationMs: 0 };
  }

  const securityScope = resolveCompactionScope({ ...mergedOpts, logger });
  if ((mergedOpts.requestContext || mergedOpts.aclPartition || mergedOpts.ownershipPartition || mergedOpts.partition)
    && !securityScope.partition) {
    return { compacted: 0, merged: 0, deleted: 0, note: "acl_partition_missing", durationMs: Date.now() - startTime };
  }
  const compactionRunKey = `compaction:${db.dbPath || "unknown"}${securityScope.partition ? `:${securityScope.partition.key}` : ""}`;

  // Idempotenz-Prüfung
  const statePath = neoStore?.paths?.runs;
  let previousDigest = "";
  if (statePath && neoStore.readRunState) {
    const state = neoStore.readRunState();
    previousDigest = securityScope.partition ? "" : (state.compaction?.lastDigest || "");
  }

  const candidates = await loadCompactionCandidates(db.table, lookbackDays, {
    ...mergedOpts,
    requestContext: mergedOpts.requestContext,
    aclPartition: mergedOpts.aclPartition || mergedOpts.ownershipPartition || mergedOpts.partition,
    agentId,
    logger,
  });
  if (candidates.length < 2) {
    return { compacted: 0, merged: 0, deleted: 0, candidates: candidates.length, note: "too_few_candidates", durationMs: Date.now() - startTime };
  }

  logger.info?.(`memory-compaction: ${candidates.length} candidates loaded`);

  // Paginate deterministically through every bounded page. The former
  // candidates.slice(0, maxBatchSize) permanently starved duplicates after
  // the first page when that page had no cluster.
  const workspaceAliases = securityScope.requestContext?.workspaceAliases || EMPTY_WORKSPACE_ALIASES;
  const allActions = [];
  let clusterCount = 0;
  for (let offset = 0; offset < candidates.length; offset += maxBatchSize) {
    const batch = candidates.slice(offset, offset + maxBatchSize);
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
      allActions.push(...actions);
    }
  }

  if (clusterCount === 0) {
    return { compacted: 0, merged: 0, deleted: 0, candidates: candidates.length, note: "no_clusters", durationMs: Date.now() - startTime };
  }

  logger.info?.(`memory-compaction: ${clusterCount} clusters found`);

  const digest = computeCompactionDigest(allActions);
  if (digest === previousDigest) {
    return { compacted: 0, merged: 0, deleted: 0, note: "already_compacted", durationMs: Date.now() - startTime };
  }

  const result = await executeActions(
    db.table,
    allActions,
    candidates,
    dryRun,
    autoApply,
    logger,
    workspaceDir,
    embeddings,
    securityScope,
  );

  const deleted = allActions.filter(a => a.type === "delete").length;
  const merged = allActions.filter(a => a.type === "merge").length;

  // State speichern nur wenn autoApply aktiv (oder dryRun) — bei Pending-Proposals
  // soll der gleiche Digest beim nächsten Lauf erneut generiert werden.
  if (neoStore?.markRunCompleted && !dryRun && autoApply) {
    neoStore.markRunCompleted(compactionRunKey, {
      digest,
      deleted,
      merged,
      clusters: clusterCount,
      aclBindings: securityScope.partition || null,
      durationMs: Date.now() - startTime,
    });
  }

  logger.info?.(`memory-compaction: ${deleted} deleted, ${merged} merged, ${result.errors || 0} errors`);

  return {
    compacted: allActions.length,
    deleted,
    merged,
    clusters: clusterCount,
    candidates: candidates.length,
    dryRun,
    autoApply,
    autoApplyRisk: result.autoApplyRisk,
    executed: result.executed || 0,
    proposals: result.proposals || 0,
    durationMs: Date.now() - startTime,
    errors: result.errors || 0,
  };
}

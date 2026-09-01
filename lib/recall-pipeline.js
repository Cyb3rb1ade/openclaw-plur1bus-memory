/**
 * lib/recall-pipeline.js — komplette Recall-Pipeline als orchestrator.
 *
 * Wird von Plugin (Auto-Recall in before_agent_start, manuelles
 * memory_recall) und vom Doctor (eval pipeline mode) genutzt. Alle
 * Recall-Komponenten an EINER Stelle:
 *
 *   Query → Embedding → LanceDB Vektorsuche → Importance-Boost
 *         → provider-aware Rerank (optional) → Inter-Result-Dedup
 *         → kombiniert mit Canonical-First (KNOWLEDGE.md)
 *         → Top-N Result-Pakete
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  captureThenableSettlement,
  safeDebug,
  safeWarn,
  settleSafeWarning,
  trySafeWarn,
} from "./safe-logging.js";
import { distanceToScore } from "./score.js";
import {
  createRecallDecisionTrace,
  addTraceCandidate,
  addTraceDecision,
  addTraceGuard,
  addTraceStoreDecision,
  summarizeTrace,
  textPreview,
} from "./recall-decision-trace.js";
import { jaccardSimilarity, cosineSimilarityVec, generateSummary } from "./text-utils.js";
import { deserializeEmotionalValence } from "./emotion.js";
import { readGraph, traverseGraph, mergeAssociativeResults, createGraphMetrics } from "./memory-graph.js";
import { buildGraphIndex, queryGraphIndex } from "./graph-index.js";
import { applyRecallBudget } from "./recall-budget.js";
import { safeUuidList, sqlString } from "./sql-safety.js";
import { recordGraphRecallMetrics } from "./metrics.js";
import { parseTemporal } from "./temporal-parser.js";
import { applyTemporalFilter, temporalRangeFromAnchor } from "./temporal-filter.js";
import { checkAccess } from "./acl-middleware.js";
import { shouldRefineQuery, refineQuery } from "./query-refiner.js";
import { TimeoutError, withTimeout } from "./with-timeout.js";
import { normalizeEpistemicStatus, epistemicScoreBoost } from "./epistemic-status.js";
import { hasDisjointValidityWindows, isEntryValidAt } from "./valid-time.js";

// ─── Timeouts ──────────────────────────────────────────────────────────────

const LANCEDB_READ_TIMEOUT_MS = 10_000;
const QUERY_RELEVANCE_TIMEOUT_MS = 5_000;
const DEFAULT_MERGED_TRACE_DECISIONS = 200;
const GRAPH_ACL_MAX_INSPECTED_EDGES = 400;
const GRAPH_ACL_MAX_ENDPOINT_IDS = 200;
const GET_BY_IDS_IN_CHUNK_SIZE = 100;
const GET_BY_IDS_FALLBACK_BATCH_SIZE = 10;
const EMPTY_WORKSPACE_ALIASES = Object.freeze({
  paths: Object.freeze([]),
  aliases: Object.freeze([]),
});

function freezeRecallAclContext(ctx = null) {
  const workspaceIdentity = ctx?.workspaceIdentity ?? ctx?.workspaceId ?? null;
  return Object.freeze({
    agentId: ctx?.agentId ?? null,
    workspaceId: workspaceIdentity,
    workspaceIdentity,
    userPrincipal: ctx?.userPrincipal ?? null,
    workspaceAliases: ctx?.workspaceAliases ?? EMPTY_WORKSPACE_ALIASES,
  });
}

const DENY_ALL_RECALL_ACL_CONTEXT = freezeRecallAclContext();

/**
 * Project one persisted row into the recall entry shape without dropping ownership aliases.
 * @param {Object} row Persisted memory row.
 * @returns {Object} Recall entry used by all pipeline paths.
 */
export function projectRecallEntry(row) {
  return {
    id: row.id,
    text: row.text || "",
    summary: row.summary || "",
    scope: row.scope || "agent-private",
    storedBy: row.storedBy || "",
    agentId: row.agentId || "",
    workspaceKey: row.workspaceKey || "",
    workspaceId: row.workspaceId || "",
    ownerUserId: row.ownerUserId || "",
    sourceMemoryId: row.sourceMemoryId || "",
    sourceAgentId: row.sourceAgentId || "",
    shareIdempotencyKey: row.shareIdempotencyKey || "",
    shareProvenance: row.shareProvenance || "{}",
    status: row.status ?? null,
    origin: row.origin || "dm",
    category: row.category,
    importance: row.importance ?? 0.5,
    createdAt: row.createdAt,
    sourceUrl: row.sourceUrl || "",
    evidenceQuote: row.evidenceQuote || "",
    emotionalValence: row.emotionalValence ?? "",
    emotionalIntensity: row.emotionalIntensity ?? 0,
    emotionalDominant: row.emotionalDominant || "neutral",
    retrievalCount: row.retrievalCount ?? 0,
    lastRetrievedAt: row.lastRetrievedAt ?? 0,
    memoryStrength: row.memoryStrength ?? 1,
    halfLifeDays: row.halfLifeDays ?? 30,
    lastStrengthenedAt: row.lastStrengthenedAt ?? 0,
    lastDynamicsAt: row.lastDynamicsAt ?? 0,
    memoryClass: row.memoryClass || "standard",
    neverForget: row.neverForget ?? 0,
    coreMemoryScore: row.coreMemoryScore ?? 0,
    coreMemoryReason: row.coreMemoryReason || "",
    versionNumber: row.versionNumber ?? 1,
    previousVersion: row.previousVersion || "",
    supersededBy: row.supersededBy || "",
    updateSource: row.updateSource || "",
    updateEvidence: row.updateEvidence || "",
    reconsolidationConfidence: row.reconsolidationConfidence ?? 0,
    versionCreatedAt: row.versionCreatedAt ?? 0,
    updatedAt: row.updatedAt ?? 0,
    expiresAt: row.expiresAt,
    memoryKind: row.memoryKind ?? "memory",
    type: row.type || "",
    confirmed: row.confirmed ?? 0,
    confirmationStatus: row.confirmationStatus || "",
    reminderStatus: row.reminderStatus || "",
    reminderKey: row.reminderKey || "",
    remindAt: row.remindAt ?? 0,
    reminderTimezone: row.reminderTimezone || "",
    reminderRecurrence: row.reminderRecurrence || "",
    epistemicStatus: row.epistemicStatus || "",
    validFrom: row.validFrom ?? 0,
    validUntil: row.validUntil ?? 0,
  };
}

/**
 * Returns whether a projected memory is active, has a strictly live expiry,
 * and — when `validAt` is supplied — falls within its bi-temporal validity
 * window. `validAt` defaults to `null`: absent validAt means zero temporal
 * filtering, so every pre-Phase-2 2-arg call site is byte-for-byte
 * unaffected (see lib/valid-time.js's isEntryValidAt and plan §5a).
 *
 * @param {object} entry projected memory entry
 * @param {number} [now=Date.now()] System-Time instant used for TTL checks
 * @param {number|bigint|null} [validAt=null] optional Valid-Time instant
 * @returns {boolean} whether the entry passes status, trust, TTL, and Valid-Time gates
 */
export function isRecallEntryLive(entry, now = Date.now(), validAt = null) {
  if (entry?.status != null && entry.status !== "active") return false;
  // Hard exclusion, mirrors the status check above — an invalidated memory
  // must never surface via recall regardless of how live its status/expiry
  // otherwise look (see plan §6a).
  if (normalizeEpistemicStatus(entry?.epistemicStatus) === "invalidated") return false;
  const expiry = entry?.expiresAt;
  const liveExpiry = expiry == null
    || expiry === 0
    || (typeof expiry === "number" && Number.isFinite(expiry) && expiry > now);
  if (!liveExpiry) return false;
  if (!isEntryValidAt(entry, validAt)) return false;
  return true;
}

function validTimeVectorPredicate(validAt) {
  if (validAt == null) return null;
  const numericValidAt = Number(validAt);
  if (!Number.isSafeInteger(numericValidAt) || numericValidAt < 0) return null;
  return `(validFrom = 0 OR validFrom <= ${numericValidAt}) AND (validUntil = 0 OR validUntil > ${numericValidAt})`;
}

function isMissingValidTimeColumnError(error) {
  const message = String(error?.message ?? error ?? "");
  return /\bno\s+field\s+named\s+["']?(?:validFrom|validUntil)["']?(?:[.\s]|$)/i.test(message)
    || /\bcolumn\s+["']?(?:validFrom|validUntil)["']?\s+not\s+found\b/i.test(message)
    || /\bunknown\s+column\s+["']?(?:validFrom|validUntil)["']?(?:[.\s]|$)/i.test(message)
    || /\bno\s+such\s+field\s*:\s*["']?(?:validFrom|validUntil)["']?(?:[.\s]|$)/i.test(message);
}

async function runVectorSearchWithValidTimeFallback({
  dbTable,
  vector,
  validAt,
  fetchLimit,
  logger,
  timeoutLabel,
}) {
  const initialQuery = dbTable.vectorSearch(vector);
  const predicate = validTimeVectorPredicate(validAt);
  const canPushPredicate = predicate != null && typeof initialQuery?.where === "function";
  try {
    const query = canPushPredicate ? initialQuery.where(predicate) : initialQuery;
    return await withTimeout(
      query.limit(fetchLimit).toArray(),
      LANCEDB_READ_TIMEOUT_MS,
      timeoutLabel,
    );
  } catch (error) {
    if (!canPushPredicate || !isMissingValidTimeColumnError(error)) throw error;
    safeWarn(logger, `${timeoutLabel}.legacy-valid-time-fallback`, error);
    return withTimeout(
      dbTable.vectorSearch(vector).limit(fetchLimit).toArray(),
      LANCEDB_READ_TIMEOUT_MS,
      `${timeoutLabel}.legacy-fallback`,
    );
  }
}

/** Stable provenance key shared by a private source and its workspace/user copies. */
export function canonicalMemoryOriginKey(entry) {
  if (!entry || typeof entry !== "object") return "";
  const sourceAgentId = String(entry.sourceAgentId || "").trim();
  const sourceMemoryId = String(entry.sourceMemoryId || "").trim();
  if (sourceAgentId && sourceMemoryId) return `${sourceAgentId}:${sourceMemoryId}`;
  const owner = String(entry.agentId || entry.storedBy || "").trim();
  const id = String(entry.id || "").trim();
  return owner && id ? `${owner}:${id}` : "";
}

function filterRecallCandidatesByLifecycle(candidates, now, trace, validAt = null) {
  return candidates.filter((candidate) => {
    const live = isRecallEntryLive(candidate.entry, now, validAt);
    if (!live && trace) {
      addTraceDecision(trace, {
        memoryId: candidate.entry?.id || "",
        action: "rejection",
        stage: "lifecycle",
        reason: "inactive or non-live expiry",
      });
    }
    return live;
  });
}

function filterRecallCandidatesByAcl(candidates, context, trace, logger, stage) {
  const aclCtx = context ?? DENY_ALL_RECALL_ACL_CONTEXT;
  const filtered = candidates.filter((r) => {
    const acl = checkAccess(aclCtx, r.entry);
    if (!acl.allowed) {
      const memoryId = r.entry?.id || "";
      logger?.info?.(`recall-pipeline: ACL denied for memory ${memoryId}: ${acl.reason}`);
      if (trace) {
        addTraceGuard(trace, { name: "acl", passed: false, reason: acl.reason, memoryId });
        addTraceDecision(trace, {
          memoryId,
          action: "rejection",
          stage,
          reason: acl.reason,
        });
      }
    }
    return acl.allowed;
  });
  if (filtered.length !== candidates.length) {
    logger?.info?.(`recall-pipeline: ACL filter removed ${candidates.length - filtered.length} memories at ${stage}`);
  }
  return filtered;
}

// ─── Associative Recall Opt-in (K1-02) ─────────────────────────────────────

/**
 * Assoziativer Recall ist nur aktiv, wenn sowohl der Continuity-Engine-
 * Hauptschalter als auch der assoziative Recall explizit enabled sind.
 */
export function computeUseAssociative(continuityEnabled, assocCfg = {}) {
  return continuityEnabled === true && assocCfg.enabled !== false;
}

/**
 * Emit one retrieval-ledger entry without letting callback or logger failures alter recall.
 * @param {{retrievalLogger?: Function|null, logger?: object|null, entry: object}} options Ledger callback and entry.
 * @returns {{ok: true, emitted: boolean, pending?: boolean, settlement?: Promise<object>}|{ok: false, error: unknown, loggingError: unknown|null, pending?: boolean, settlement?: Promise<object>}} Emission outcome.
 */
export function emitRetrievalLedger({ retrievalLogger = null, logger = null, entry } = {}) {
  if (typeof retrievalLogger !== "function") return { ok: true, emitted: false };
  try {
    const delivery = retrievalLogger(entry);
    const callbackSettlement = captureThenableSettlement(delivery);
    if (callbackSettlement) {
      const settlement = settleRetrievalLedgerCallback(callbackSettlement, logger);
      return { ok: true, emitted: true, pending: true, settlement };
    }
    return { ok: true, emitted: true };
  } catch (error) {
    const warning = warnRetrievalLoggerFailure(logger);
    if (warning.pending) {
      const settlement = settleRetrievalLedgerFailure(error, warning);
      return {
        ok: false,
        error,
        loggingError: null,
        pending: true,
        settlement,
      };
    }
    return {
      ok: false,
      error,
      loggingError: warning.ok ? null : warning.error,
    };
  }
}

async function settleRetrievalLedgerCallback(callbackSettlement, logger) {
  try {
    const callbackOutcome = await callbackSettlement;
    if (callbackOutcome.ok) return { ok: true, emitted: true };
    const warning = warnRetrievalLoggerFailure(logger);
    return await settleRetrievalLedgerFailure(callbackOutcome.error, warning);
  } catch (internalError) {
    return { ok: false, error: internalError, loggingError: null };
  }
}

function warnRetrievalLoggerFailure(logger) {
  return trySafeWarn(
    logger,
    "recall-pipeline.retrievalLogger",
    new Error("retrieval callback failed"),
  );
}

async function settleRetrievalLedgerFailure(error, warning) {
  try {
    const warningOutcome = await settleSafeWarning(warning);
    return {
      ok: false,
      error,
      loggingError: warningOutcome.ok ? null : warningOutcome.error,
    };
  } catch (internalError) {
    return { ok: false, error, loggingError: internalError };
  }
}

// ─── Importance-Boost ──────────────────────────────────────────────────────

/**
 * Re-sortiert Results nach `score * (1 + importance * boost)`.
 * Bei boost=0 (oder leerer results) → unverändert.
 */
export function applyImportanceBoost(results, boost) {
  if (!boost || boost <= 0) return results;
  const boosted = results.map(r => ({
    ...r,
    score: r.score + ((r.entry.importance ?? 0.5) - 0.5) * boost,
  }));
  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}

// ─── Inter-Result-Dedup ────────────────────────────────────────────────────

/**
 * Behält nur die ersten Results bis maxOut, suppimiert nahe Duplikate via
 * Jaccard auf summary/text. Erste in Liste = beste, wird behalten.
 *
 * @param {Array<{entry: Object, score?: number, source?: string}>} results Ranked recall results.
 * @param {number} maxOut Maximum number of results to retain.
 * @param {number} [jaccardThreshold=0.78] Similarity threshold for overlapping validity windows.
 * @returns {Array<{entry: Object, score?: number, source?: string}>} Deduplicated ranked results.
 */
export function dedupResults(results, maxOut, jaccardThreshold = 0.78) {
  if (maxOut <= 0) return [];
  const out = [];
  for (const r of results) {
    let isDup = false;
    const text = r.entry.summary || r.entry.text || "";
    for (const kept of out) {
      const keptText = kept.entry.summary || kept.entry.text || "";
      if (
        jaccardSimilarity(text, keptText) >= jaccardThreshold
        && !hasDisjointValidityWindows(r.entry, kept.entry)
      ) {
        isDup = true;
        break;
      }
    }
    if (!isDup) out.push(r);
    if (out.length >= maxOut) break;
  }
  return out;
}

/**
 * Merges completed same-agent namespace recalls into one globally capped result.
 *
 * @param {Array<{namespace?: string|null, canonical?: Array, memories?: Array, trace?: Object}>} namespaceResults
 * @param {{maxOut?: number, canonicalMaxItems?: number, dedupEnabled?: boolean, dedupJaccard?: number, trace?: Object}} [options={}]
 * @returns {{queryVector: Array|undefined, canonical: Array, memories: Array, trace: Object|undefined}}
 */
export function mergeNamespaceRecallResults(namespaceResults, options = {}) {
  const results = Array.isArray(namespaceResults) ? namespaceResults : [];
  const maxOut = normalizeRecallLimit(options.maxOut);
  const canonicalMaxItems = Math.min(maxOut, normalizeRecallLimit(options.canonicalMaxItems, maxOut));
  const dedupEnabled = options.dedupEnabled !== false;
  const dedupJaccard = Number.isFinite(options.dedupJaccard) ? options.dedupJaccard : 0.78;
  const trace = options.trace === undefined || options.trace === null ? undefined : options.trace;
  const decisionBuffer = trace ? createNamespaceDecisionBuffer(trace) : null;
  const queryVector = cloneNamespaceQueryVector(results);
  if (trace !== undefined && (typeof trace !== "object" || Array.isArray(trace))) {
    throw new TypeError("mergeNamespaceRecallResults trace must be an object");
  }

  if (trace) {
    replayNamespaceTraces(trace, results, decisionBuffer);
  }

  const canonicalCandidates = [];
  const memoryCandidates = [];
  let ordinal = 0;
  for (const result of results) {
    const namespace = normalizeRecallNamespace(result?.namespace);
    const sourceKind = normalizeSourceKind(result?.sourceKind, namespace);
    const canonical = Array.isArray(result?.canonical) ? result.canonical : [];
    for (const item of canonical) {
      if (!item || typeof item !== "object") continue;
      canonicalCandidates.push({
        item: cloneCanonicalForNamespace(item, namespace),
        namespace,
        ordinal: ordinal++,
      });
    }
    const memories = Array.isArray(result?.memories) ? result.memories : [];
    for (const item of memories) {
      if (!item || typeof item !== "object" || !item.entry || typeof item.entry !== "object") continue;
      memoryCandidates.push({
        item: cloneMemoryForNamespace(item, namespace),
        namespace,
        sourceKind,
        ordinal: ordinal++,
      });
    }
  }

  canonicalCandidates.sort(compareRecallCandidate);
  const canonical = [];
  const canonicalKeys = new Set();
  for (const candidate of canonicalCandidates) {
    const key = canonicalContentKey(candidate.item);
    if (canonicalKeys.has(key)) {
      recordNamespaceDedup(trace, decisionBuffer, canonicalTraceId(candidate.item), candidate.namespace, "namespace-canonical-dedup", "duplicate canonical content");
      continue;
    }
    canonicalKeys.add(key);
    if (canonical.length >= canonicalMaxItems) {
      recordNamespaceDedup(trace, decisionBuffer, canonicalTraceId(candidate.item), candidate.namespace, "namespace-canonical-cap", "beyond global canonical cap");
      continue;
    }
    canonical.push(candidate.item);
  }

  const originWinners = new Map();
  const originUnique = [];
  for (const candidate of memoryCandidates) {
    const key = canonicalMemoryOriginKey(candidate.item.entry);
    if (!key) {
      originUnique.push(candidate);
      continue;
    }
    const winners = originWinners.get(key);
    if (!winners) {
      originWinners.set(key, [candidate]);
      continue;
    }
    const overlapping = winners.filter((existing) => (
      !hasDisjointValidityWindows(existing.item.entry, candidate.item.entry)
    ));
    if (overlapping.length === 0) {
      winners.push(candidate);
      continue;
    }
    const candidatePriority = sourcePriority(candidate.sourceKind);
    const replacesEveryOverlap = overlapping.every((existing) => {
      const existingPriority = sourcePriority(existing.sourceKind);
      return candidatePriority < existingPriority
        || (candidatePriority === existingPriority && compareRecallCandidate(candidate, existing) < 0);
    });
    if (!replacesEveryOverlap) {
      recordNamespaceDedup(
        trace,
        decisionBuffer,
        candidate.item.entry.id,
        candidate.namespace,
        "namespace-origin-dedup",
        `duplicate canonical origin ${key}`,
      );
      continue;
    }
    const overlappingSet = new Set(overlapping);
    originWinners.set(key, [
      ...winners.filter((existing) => !overlappingSet.has(existing)),
      candidate,
    ]);
    for (const rejected of overlapping) {
      recordNamespaceDedup(
        trace,
        decisionBuffer,
        rejected.item.entry.id,
        rejected.namespace,
        "namespace-origin-dedup",
        `duplicate canonical origin ${key}`,
      );
    }
  }
  originUnique.push(...Array.from(originWinners.values()).flat());
  originUnique.sort(compareRecallCandidate);
  const byId = new Map();
  const uniqueMemories = [];
  for (const candidate of originUnique) {
    const id = candidate.item.entry.id;
    if (typeof id !== "string" || id.length === 0) {
      uniqueMemories.push(candidate);
      continue;
    }
    if (byId.has(id)) {
      recordNamespaceDedup(trace, decisionBuffer, id, candidate.namespace, "namespace-id-dedup", "duplicate memory ID with a lower global score");
      continue;
    }
    byId.set(id, candidate);
    uniqueMemories.push(candidate);
  }

  const memorySlots = Math.max(0, maxOut - canonical.length);
  const flat = uniqueMemories.map(({ item }) => item);
  const selected = dedupEnabled
    ? dedupResults(flat, memorySlots, dedupJaccard)
    : flat.slice(0, memorySlots);
  const selectedSet = new Set(selected);
  for (const candidate of uniqueMemories) {
    if (!selectedSet.has(candidate.item)) {
      recordNamespaceDedup(trace, decisionBuffer, candidate.item.entry.id, candidate.namespace, "namespace-result-dedup", "duplicate or beyond global result cap");
    }
  }

  if (trace) {
    replayBufferedNamespaceDecisions(trace, decisionBuffer);
    summarizeTrace(trace);
  }
  return { queryVector, canonical, memories: selected, trace };
}

function normalizeSourceKind(sourceKind, namespace) {
  if (sourceKind === "private" || sourceKind === "workspace" || sourceKind === "user") return sourceKind;
  if (namespace === "shared-workspace") return "workspace";
  if (namespace === "shared-user") return "user";
  return "private";
}

function sourcePriority(sourceKind) {
  return sourceKind === "private" ? 0 : sourceKind === "workspace" ? 1 : 2;
}

function cloneNamespaceQueryVector(results) {
  for (const result of results) {
    if (Array.isArray(result?.queryVector)) return result.queryVector.slice();
    if (ArrayBuffer.isView(result?.queryVector)) return Array.from(result.queryVector);
  }
  return undefined;
}

function normalizeRecallLimit(value, fallback = 0) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeRecallNamespace(namespace) {
  if (typeof namespace !== "string") return null;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(namespace) ? namespace : null;
}

function compareRecallCandidate(left, right) {
  const scoreDifference = normalizedRecallScore(right.item.score) - normalizedRecallScore(left.item.score);
  return scoreDifference || left.ordinal - right.ordinal;
}

function normalizedRecallScore(score) {
  return Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY;
}

function cloneMemoryForNamespace(memory, namespace) {
  return {
    ...memory,
    entry: { ...memory.entry },
    namespace,
  };
}

function cloneCanonicalForNamespace(canonical, namespace) {
  return { ...canonical, namespace };
}

function canonicalContentKey(canonical) {
  const heading = normalizeCanonicalText(canonical.heading);
  const text = normalizeCanonicalText(canonical.text);
  return `${heading}\u0000${text}`;
}

function normalizeCanonicalText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function canonicalTraceId(canonical) {
  return `canonical:${textPreview(canonical.heading || canonical.text, 40)}`;
}

function recordNamespaceDedup(trace, decisionBuffer, memoryId, namespace, stage, reason) {
  if (!trace) return;
  bufferNamespaceDecision(decisionBuffer, "global", namespace, {
    memoryId: String(memoryId ?? ""),
    action: "deduped",
    stage,
    reason,
    namespace: namespace ?? undefined,
  });
}

function replayNamespaceTraces(masterTrace, namespaceResults, decisionBuffer) {
  const traceSources = [];
  for (const result of namespaceResults) {
    const childTrace = result?.trace;
    if (!childTrace || typeof childTrace !== "object" || childTrace === masterTrace) continue;
    traceSources.push({
      childTrace,
      namespace: normalizeRecallNamespace(result?.namespace),
    });
  }

  replayNamespaceTraceEntries(traceSources, "candidates", (candidate, namespace) => {
    addTraceCandidate(masterTrace, {
      id: candidate.id,
      summary: candidate.preview,
      source: candidate.source,
      score: candidate.score,
      vectorScore: candidate.vectorScore,
      importanceBoost: candidate.importanceBoost,
      emotionalBoost: candidate.emotionalBoost,
      strengthBoost: candidate.strengthBoost,
      graphBoost: candidate.graphBoost,
      graphDepth: candidate.graphDepth,
      category: candidate.category,
      status: candidate.status,
      scoreBreakdown: candidate.scoreBreakdown,
      temporal: candidate.temporal,
      namespace: namespace ?? undefined,
    });
  });
  replayNamespaceTraceEntries(traceSources, "decisions", (decision, namespace) => {
    bufferNamespaceDecision(decisionBuffer, "child", namespace, {
      memoryId: decision.memoryId,
      action: decision.action,
      stage: decision.stage,
      reason: decision.reason,
      finalScore: decision.finalScore,
      scoreBreakdown: decision.scoreBreakdown,
      temporal: decision.temporal,
      namespace: namespace ?? undefined,
    });
  });
  replayNamespaceTraceEntries(traceSources, "guards", (guard, namespace) => {
    addTraceGuard(masterTrace, {
      name: guard.name,
      passed: guard.passed,
      reason: guard.reason,
      memoryId: guard.memoryId,
      namespace: namespace ?? undefined,
    });
  });
  replayNamespaceTraceEntries(traceSources, "storeDecisions", (decision, namespace) => {
    addTraceStoreDecision(masterTrace, {
      memoryId: decision.memoryId,
      action: decision.action,
      reason: decision.reason,
      namespace: namespace ?? undefined,
    });
  });
}

function createNamespaceDecisionBuffer(trace) {
  const configuredLimit = trace.config?.maxDecisions;
  return {
    maxEntries: Number.isFinite(configuredLimit)
      ? Math.max(1, Math.floor(configuredLimit))
      : DEFAULT_MERGED_TRACE_DECISIONS,
    buckets: [],
  };
}

function bufferNamespaceDecision(buffer, phase, namespace, decision) {
  if (!buffer) return;
  const normalizedNamespace = normalizeRecallNamespace(namespace);
  let bucket = buffer.buckets.find(
    (candidate) => candidate.phase === phase && candidate.namespace === normalizedNamespace,
  );
  if (!bucket) {
    bucket = { phase, namespace: normalizedNamespace, entries: [] };
    buffer.buckets.push(bucket);
  }
  bucket.entries.push(decision);
  if (bucket.entries.length > buffer.maxEntries) {
    bucket.entries = bucket.entries.slice(-buffer.maxEntries);
  }
}

function replayBufferedNamespaceDecisions(masterTrace, buffer) {
  if (!buffer) return;
  const selected = fairTraceSuffix(buffer.buckets, buffer.maxEntries);
  for (const { entry } of selected) addTraceDecision(masterTrace, entry);
}

function replayNamespaceTraceEntries(traceSources, field, replayEntry) {
  const sources = traceSources.map(({ childTrace, namespace }) => ({
    entries: Array.isArray(childTrace[field]) ? childTrace[field] : [],
    namespace,
  }));
  forEachFairTraceEntry(sources, ({ entry, namespace }) => replayEntry(entry, namespace));
}

function fairTraceSuffix(sources, maxEntries) {
  const suffix = [];
  forEachFairTraceEntry(sources, (item) => {
    suffix.push(item);
    if (suffix.length > maxEntries) suffix.shift();
  });
  return suffix;
}

function forEachFairTraceEntry(sources, visit) {
  const maxLength = sources.reduce(
    (largest, source) => Math.max(largest, source.entries.length),
    0,
  );

  // Align each child at its newest edge. The trace helpers retain a capped
  // suffix, so saturated children receive slots round-robin without losing
  // the newest per-namespace entries or changing their internal order.
  for (let distanceFromEnd = maxLength; distanceFromEnd > 0; distanceFromEnd--) {
    for (const source of sources) {
      const index = source.entries.length - distanceFromEnd;
      if (index >= 0) visit({ entry: source.entries[index], namespace: source.namespace });
    }
  }
}

// ─── Canonical-First (KNOWLEDGE.md) ────────────────────────────────────────

const KNOWLEDGE_CACHE_FILE = "knowledge-cache.json";

/**
 * Splittet KNOWLEDGE.md-Content in Sections per H1/H2/H3-Header.
 * Frontmatter wird gestrippt. Sections <30 Zeichen werden ignoriert.
 */
export function parseKnowledgeMd(content) {
  let body = content;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---\n", 4);
    if (end > 0) body = body.slice(end + 5);
  }
  const lines = body.split("\n");
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.+)$/);
    if (m) {
      if (current && current.text.trim().length > 30) sections.push(current);
      current = { heading: m[2].trim(), text: line + "\n" };
    } else if (current) {
      current.text += line + "\n";
    }
  }
  if (current && current.text.trim().length > 30) sections.push(current);
  return sections;
}

function readKnowledgeCache(workspaceDir, logger) {
  try {
    const p = join(workspaceDir, ".adaptive-learning", KNOWLEDGE_CACHE_FILE);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  } catch (err) { safeWarn(logger, "readKnowledgeCache", err); }
  return null;
}

function writeKnowledgeCache(workspaceDir, cache, logger) {
  try {
    const dir = join(workspaceDir, ".adaptive-learning");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const p = join(dir, KNOWLEDGE_CACHE_FILE);
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(cache), "utf8");
    renameSync(tmp, p);
  } catch (err) { safeWarn(logger, "writeKnowledgeCache", err); }
}

/**
 * Lädt KNOWLEDGE.md, parst Sections, embedded sie. Mtime-basierter Cache —
 * nur neu embedden wenn KNOWLEDGE.md sich geändert hat.
 * @param {string} workspaceDir Workspace root containing memory/KNOWLEDGE.md.
 * @param {Object} embeddings Embedding provider.
 * @param {Object} [logger] Bounded diagnostic logger.
 * @param {Object} [embeddingContext] Immutable request context for cache scoping.
 * @returns {Promise<Array>} Embedded canonical chunks.
 */
export async function getKnowledgeChunks(workspaceDir, embeddings, logger, embeddingContext) {
  if (!workspaceDir) return [];
  const knowledgePath = join(workspaceDir, "memory", "KNOWLEDGE.md");
  if (!existsSync(knowledgePath)) return [];
  const stat = statSync(knowledgePath);
  const mtime = stat.mtimeMs;

  const cache = readKnowledgeCache(workspaceDir, logger);
  if (cache && cache.mtime === mtime && Array.isArray(cache.chunks) && cache.chunks.length > 0) {
    return cache.chunks;
  }

  const content = readFileSync(knowledgePath, "utf8");
  const sections = parseKnowledgeMd(content);
  if (sections.length === 0) return [];

  const chunks = [];
  for (const sec of sections) {
    try {
      const vec = await embeddings.embed(sec.text.slice(0, 4000), embeddingContext);
      chunks.push({ heading: sec.heading, text: sec.text, vector: vec });
    } catch (e) {
      logger?.warn?.(`recall-pipeline: knowledge embed failed for "${sec.heading}": ${String(e)}`);
    }
  }
  writeKnowledgeCache(workspaceDir, { mtime, chunks }, logger);
  return chunks;
}

/**
 * Mtime von KNOWLEDGE.md in Epoch-Millisekunden.
 *
 * Canonical-Sections sind keine DB-Zeilen und haben kein eigenes `createdAt`.
 * Als Alter dient deshalb der Änderungszeitpunkt der Datei. Bewusst ein eigener
 * `statSync` statt eines Felds im Chunk-Cache: der Cache persistiert Chunks, ein
 * zusätzliches Feld dort erzwänge eine Formatmigration für bestehende Caches.
 *
 * @param {string} workspaceDir Workspace root containing memory/KNOWLEDGE.md.
 * @returns {number} Epoch ms, oder 0 wenn die Datei fehlt/nicht lesbar ist.
 */
export function knowledgeMtimeMs(workspaceDir) {
  if (!workspaceDir) return 0;
  try {
    const knowledgePath = join(workspaceDir, "memory", "KNOWLEDGE.md");
    if (!existsSync(knowledgePath)) return 0;
    return statSync(knowledgePath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Cosine-Match einer Query gegen alle KNOWLEDGE.md-Sections. Top-N mit
 * Score ≥ minScore.
 * @param {string} workspaceDir Workspace root containing canonical knowledge.
 * @param {Array<number>} queryVector Query embedding.
 * @param {Object} embeddings Embedding provider.
 * @param {number} minScore Minimum cosine score.
 * @param {number} topN Maximum canonical results.
 * @param {Object} [logger] Bounded diagnostic logger.
 * @param {Object} [embeddingContext] Immutable request context for cache scoping.
 * @returns {Promise<Array>} Ranked canonical matches.
 */
export async function searchCanonical(
  workspaceDir,
  queryVector,
  embeddings,
  minScore,
  topN,
  logger,
  embeddingContext,
) {
  const chunks = await getKnowledgeChunks(workspaceDir, embeddings, logger, embeddingContext);
  if (chunks.length === 0) return [];
  const mtimeMs = knowledgeMtimeMs(workspaceDir);
  const scored = chunks.map(c => ({
    heading: c.heading,
    text: c.text,
    score: cosineSimilarityVec(queryVector, c.vector),
    mtimeMs,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.filter(s => s.score >= minScore).slice(0, topN);
}

// ─── Komplette Pipeline ────────────────────────────────────────────────────

/**
 * Vollständige Recall-Pipeline. Ein einziger Funktionsaufruf für Plugin
 * Auto-Recall, manuelles memory_recall, und Doctor-Eval-Pipeline-Mode.
 *
 * @param {Object} opts
 * @param {string} opts.query — User-Query
 * @param {Object} opts.dbTable — LanceDB-Tabelle (.vectorSearch().limit().toArray() API)
 * @param {Object} opts.embeddings — { dim, embed(text) → Promise<vector> }
 * @param {string} opts.workspaceDir — für KNOWLEDGE.md-Lookup
 * @param {number} opts.topN — wie viele final injiziert werden (default 5)
 * @param {number} opts.recallMinScore — Schwelle für vector results (default 0.15)
 * @param {number} opts.importanceBoost — Boost-Faktor (default 0.3, 0 = aus)
 * @param {boolean} opts.dedupEnabled — Inter-Result-Dedup (default true)
 * @param {number} opts.dedupJaccard — Dedup-Schwelle (default 0.78)
 * @param {boolean} opts.canonicalEnabled — KNOWLEDGE.md-Lookup (default true)
 * @param {number} opts.canonicalMinScore — Schwelle für canonical (default 0.30)
 * @param {number} opts.canonicalMaxItems — max canonical items (default 2)
 * @param {Object} opts.reranker — optional Reranker mit .rerank(query, docs, topN)
 * @param {number} opts.rerankCandidates — wie viele Vektor-Kandidaten an Reranker (default 20)
 * @param {number} opts.candidateTopK — initial ANN candidate limit, bounded to the request hard limit (default 40)
 * @param {number} opts.rerankerTimeoutMs — Timeout für Reranker-Aufruf (default 5000)
 * @param {boolean} opts.rerankerFallbackOnError — bei Reranker-Fehler/Timeout auf unrerankte Top-N fallbacken (default true)
 * @param {number} opts.summaryMaxWords — für generateSummary fallback (default 150)
 * @param {Object} opts.logger — { warn(msg), info(msg) }
 * @param {Object} opts.emotionalState — optional EmotionalState-Instanz für stimmungsabhängigen Recall
 * @param {string} opts.workspaceKey — Workspace-Key für Retrieval-Ledger
 * @param {string} opts.agentId — Agent-ID für Retrieval-Ledger
 * @param {string|null} opts.userPrincipal — canonical authenticated user principal for ACL.
 * @param {Function} opts.retrievalLogger — Callback(entry) für Retrieval-Ledger-Einträge
 * @returns {{queryVector: number[], canonical: Array, memories: Array}}
 */
// ─── Graph-Result Hydration ────────────────────────────────────────────────

/**
 * Lädt graph-only Treffer aus LanceDB nach und filtert inactive/superseded.
 * Verwirft Treffer ohne text/summary.
 *
 * Neu (K1-01): Graph-only Kandidaten werden nach dem Hydrate gegen den
 * Query-Vektor revalidiert. Bei zu schwacher Relevanz werden sie verworfen.
 * Der Threshold ist über graphConfig.graphHydrationRelevanceThreshold konfigurierbar.
 *
 * @param {Object} dbTable LanceDB table adapter.
 * @param {Array} results Recall candidates to hydrate.
 * @param {Object} logger Logger used for bounded diagnostics.
 * @param {{queryVector?: Array, embeddings?: Object, graphConfig?: Object, decisionTrace?: Object, strictReadErrors?: boolean, aclCtx?: Object|null, embeddingContext?: Object, now?: number, validAt?: number|bigint|null}} [opts]
 * @param {number} [opts.now=Date.now()] System-time instant used for lifecycle expiry checks.
 * @param {number|bigint|null} [opts.validAt=null] Optional valid-time instant used for historical filtering.
 * @returns {Promise<Array>} Hydrated active recall candidates.
 */
export async function hydrateGraphResults(dbTable, results, logger, opts = {}) {
  const {
    queryVector,
    embeddings,
    graphConfig = {},
    decisionTrace,
    strictReadErrors = false,
    aclCtx = null,
    embeddingContext,
    now = Date.now(),
    // Phase 2 — Bi-Temporal Memory. Default null: absent validAt means zero
    // temporal filtering (see plan §5b/§5's site-4/5 threading).
    validAt = null,
  } = opts;
  const requestAclCtx = freezeRecallAclContext(aclCtx);
  const relevanceThreshold = graphConfig.graphHydrationRelevanceThreshold ?? 0.25;
  const shouldRevalidate = queryVector && queryVector.length > 0 && embeddings;

  const graphOnly = results.filter(r => r.source === "graph" && (!r.entry?.text && !r.entry?.summary));
  if (graphOnly.length === 0) {
    const active = filterRecallCandidatesByLifecycle(results, now, decisionTrace, validAt);
    return filterRecallCandidatesByAcl(active, requestAclCtx, decisionTrace, logger, "graph-hydration-acl");
  }

  const ids = graphOnly.map(r => r.entry?.id).filter(Boolean);
  const hydratedMap = await getByIds(dbTable, ids, { strictReadErrors, logger });

  let hydrationMisses = 0;
  const out = [];
  for (const r of results) {
    const isGraphOnly = r.source === "graph" && (!r.entry?.text && !r.entry?.summary);
    if (isGraphOnly) {
      const row = hydratedMap.get(r.entry?.id);
      if (!row) {
        hydrationMisses++;
        if (decisionTrace) {
          addTraceDecision(decisionTrace, {
            memoryId: r.entry?.id,
            action: "rejection",
            stage: "graph-hydration",
            reason: "hydration miss",
          });
        }
        continue;
      }
      const entry = projectRecallEntry(row);
      if (!isRecallEntryLive(entry, now, validAt)) {
        if (decisionTrace) {
          addTraceDecision(decisionTrace, {
            memoryId: row.id,
            action: "rejection",
            stage: "graph-hydration",
            reason: "inactive or non-live expiry",
          });
        }
        continue;
      }

      if (filterRecallCandidatesByAcl(
        [{ ...r, entry }],
        requestAclCtx,
        decisionTrace,
        logger,
        "graph-hydration-acl",
      ).length === 0) {
        continue;
      }

      if (shouldRevalidate) {
        try {
          const relevance = await computeQueryRelevance(
            row,
            queryVector,
            embeddings,
            embeddingContext,
          );
          if (relevance < relevanceThreshold) {
            logger?.info?.(`recall-pipeline: graph hydration relevance ${relevance.toFixed(3)} < ${relevanceThreshold} for ${row.id}, dropping`);
            if (decisionTrace) {
              addTraceDecision(decisionTrace, {
                memoryId: row.id,
                action: "rejection",
                stage: "graph-hydration",
                reason: `relevance ${relevance.toFixed(3)} below threshold ${relevanceThreshold}`,
              });
            }
            continue;
          }
        } catch (e) {
          logger?.warn?.(`recall-pipeline: graph hydration relevance check failed for ${row.id}: ${String(e)}`);
        }
      }

      out.push({
        ...r,
        entry,
      });
    } else {
      if (isRecallEntryLive(r.entry, now, validAt)) {
        const allowed = filterRecallCandidatesByAcl(
          [r],
          requestAclCtx,
          decisionTrace,
          logger,
          "graph-hydration-acl",
        );
        if (allowed.length > 0) out.push(r);
      }
    }
  }

  if (hydrationMisses > 0) {
    trySafeWarn(
      logger,
      "recall-pipeline.graph-hydration",
      `missed ${hydrationMisses} of ${graphOnly.length} IDs`,
      { hydrationMisses, requestedIds: graphOnly.length },
    );
  }
  return out;
}

/**
 * Berechnet die Cosine-Ähnlichkeit zwischen einem hydrated Row und dem Query-Vektor.
 * Verwendet row.vector wenn vorhanden, sonst embeddet text/summary.
 */
async function computeQueryRelevance(row, queryVector, embeddings, embeddingContext) {
  let candidateVector = row.vector;
  if (!candidateVector || candidateVector.length !== queryVector.length) {
    const text = row.text || row.summary || "";
    try {
      candidateVector = await withTimeout(
        typeof embeddings.embed === "function"
          ? embeddings.embed(text, embeddingContext)
          : embeddings.embedQuery(text, embeddingContext),
        QUERY_RELEVANCE_TIMEOUT_MS,
        "recall-pipeline.computeQueryRelevance",
      );
    } catch (e) {
      if (e?.code === "ETIMEOUT") {
        return 0;
      }
      throw e;
    }
  }
  return cosineSimilarityVec(queryVector, candidateVector);
}

/**
 * Robuster Batch-Lookup mehrerer IDs aus LanceDB.
 * Verwendet begrenzte IN-Chunks; Einzel-Lookups sind nur ein
 * Kompatibilitäts-Fallback für nicht unterstützte IN-Syntax/Legacy-IDs.
 */
async function getByIds(dbTable, ids, { strictReadErrors = false, logger } = {}) {
  const cleanIds = [...new Set(ids)]
    .map(String)
    .filter(id => /^[a-zA-Z0-9-]+$/.test(id));
  if (cleanIds.length === 0) return new Map();

  const map = new Map();
  const readDeadline = Date.now() + LANCEDB_READ_TIMEOUT_MS;
  const uuidIds = [];
  const legacyFallbackIds = [];
  for (const id of cleanIds) {
    if (safeUuidList([id], 1)) uuidIds.push(id);
    else legacyFallbackIds.push(id);
  }
  const fallbackChunks = [];
  let inReadTimedOut = false;

  for (let index = 0; index < uuidIds.length; index += GET_BY_IDS_IN_CHUNK_SIZE) {
    const chunk = uuidIds.slice(index, index + GET_BY_IDS_IN_CHUNK_SIZE);
    const requestedIds = new Set(chunk);
    const inClause = safeUuidList(chunk, GET_BY_IDS_IN_CHUNK_SIZE);
    const remainingMs = readDeadline - Date.now();
    if (remainingMs <= 0) {
      const timeout = new TimeoutError(
        "recall-pipeline.getByIds.in",
        LANCEDB_READ_TIMEOUT_MS,
        Promise.resolve(),
      );
      if (strictReadErrors) throw timeout;
      trySafeWarn(logger, "recall-pipeline.getByIds.in", timeout, { chunkSize: chunk.length });
      inReadTimedOut = true;
      break;
    }
    try {
      const rows = await withTimeout(
        dbTable.query()
          .where(`id IN (${inClause})`)
          .limit(chunk.length)
          .toArray(),
        remainingMs,
        "recall-pipeline.getByIds.in",
      );
      for (const row of rows) {
        if (row.id && requestedIds.has(row.id)) map.set(row.id, row);
      }
    } catch (e) {
      if (e?.code === "ETIMEOUT") {
        if (strictReadErrors) throw e;
        trySafeWarn(logger, "recall-pipeline.getByIds.in", e, { chunkSize: chunk.length });
        inReadTimedOut = true;
        break;
      }
      if (isUnsupportedInQueryError(e)) {
        safeDebug(logger, "recall-pipeline.getByIds.in-unsupported", e, { chunkSize: chunk.length });
        fallbackChunks.push(chunk);
        continue;
      }
      if (strictReadErrors) throw e;
      trySafeWarn(logger, "recall-pipeline.getByIds.in", e, { chunkSize: chunk.length });
    }
  }

  if (inReadTimedOut) return map;

  if (legacyFallbackIds.length > 0) {
    safeDebug(
      logger,
      "recall-pipeline.getByIds.legacy-id-fallback",
      "IN lookup unavailable for non-UUID memory IDs",
      { lookupCount: legacyFallbackIds.length },
    );
    for (let index = 0; index < legacyFallbackIds.length; index += GET_BY_IDS_IN_CHUNK_SIZE) {
      fallbackChunks.push(legacyFallbackIds.slice(index, index + GET_BY_IDS_IN_CHUNK_SIZE));
    }
  }

  const fallbackIds = fallbackChunks.flat();
  if (fallbackIds.length > 0) {
    await readIdsIndividually(dbTable, fallbackIds, map, {
      strictReadErrors,
      logger,
      deadline: readDeadline,
    });
  }
  return map;
}

function isUnsupportedInQueryError(error) {
  return error?.code === "ERR_UNSUPPORTED_IN_QUERY";
}

async function readIdsIndividually(dbTable, ids, map, { strictReadErrors, logger, deadline }) {
  const failures = [];
  for (let index = 0; index < ids.length; index += GET_BY_IDS_FALLBACK_BATCH_SIZE) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      failures.push(new TimeoutError(
        "recall-pipeline.getByIds.fallback",
        LANCEDB_READ_TIMEOUT_MS,
        Promise.resolve(),
      ));
      break;
    }
    const batch = ids.slice(index, index + GET_BY_IDS_FALLBACK_BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map(async (id) => {
      const rows = await withTimeout(
        dbTable.query()
          .where(`id = ${sqlString(id)}`)
          .limit(1)
          .toArray(),
        remainingMs,
        "recall-pipeline.getByIds.fallback",
      );
      if (rows[0]?.id === id) map.set(id, rows[0]);
    }));
    const batchFailures = settled
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    failures.push(...batchFailures);
    if (batchFailures.some((error) => error?.code === "ETIMEOUT")) {
      break;
    }
  }
  if (failures.length === 0) return;
  if (strictReadErrors) throw combineStrictReadFailures(failures);
  trySafeWarn(logger, "recall-pipeline.getByIds.fallback", failures[0], {
    failedLookups: failures.length,
    requestedLookups: ids.length,
  });
}

function combineStrictReadFailures(failures) {
  const timeoutFailures = failures.filter((error) => (
    error?.code === "ETIMEOUT"
    && error.settlement
    && typeof error.settlement.then === "function"
  ));
  if (timeoutFailures.length === 0) return failures[0];
  const primary = timeoutFailures[0];
  const settlements = [...new Set(timeoutFailures.map((error) => error.settlement))];
  if (settlements.length > 1) {
    primary.settlement = settleAllStrictReads(settlements);
  }
  return primary;
}

async function settleAllStrictReads(settlements) {
  const outcomes = await Promise.allSettled(settlements);
  const failed = outcomes.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return outcomes.map((result) => result.value);
}

function selectReachableGraphEdges(graphEdges, seedIds, graphConfig) {
  const inspectedEdges = graphEdges.slice(0, GRAPH_ACL_MAX_INSPECTED_EDGES);
  const configuredDepth = Number.isFinite(graphConfig?.maxDepth)
    ? Math.max(0, Math.floor(graphConfig.maxDepth))
    : 2;
  const maxDepth = Math.min(configuredDepth, GRAPH_ACL_MAX_ENDPOINT_IDS);
  const reachableIds = new Set(seedIds.slice(0, GRAPH_ACL_MAX_ENDPOINT_IDS));
  const adjacency = new Map();
  for (const edge of inspectedEdges) {
    if (!edge?.source || !edge?.target) continue;
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source).push(edge.target);
    if (!edge.directed) {
      if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
      adjacency.get(edge.target).push(edge.source);
    }
  }
  let frontier = [...reachableIds];
  let endpointCapReached = seedIds.length > GRAPH_ACL_MAX_ENDPOINT_IDS;

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier = [];
    for (const currentId of frontier) {
      for (const nextId of adjacency.get(currentId) || []) {
        if (reachableIds.has(nextId)) continue;
        if (reachableIds.size >= GRAPH_ACL_MAX_ENDPOINT_IDS) {
          endpointCapReached = true;
          continue;
        }
        reachableIds.add(nextId);
        nextFrontier.push(nextId);
      }
    }
    frontier = nextFrontier;
  }

  const edges = inspectedEdges.filter((edge) => (
    edge?.source
    && edge?.target
    && reachableIds.has(edge.source)
    && reachableIds.has(edge.target)
  ));
  const inspectionCapReached = graphEdges.length > inspectedEdges.length;
  return {
    edges,
    endpointIds: [...reachableIds],
    capReached: inspectionCapReached || endpointCapReached,
    capReason: `inspected ${inspectedEdges.length}/${graphEdges.length} edges and selected ${reachableIds.size}/${GRAPH_ACL_MAX_ENDPOINT_IDS} endpoint IDs`,
  };
}

function traceGraphEndpointCap(decisionTrace, selected) {
  if (!decisionTrace || !selected.capReached) return;
  addTraceGuard(decisionTrace, {
    name: "graph_acl_endpoint_cap",
    passed: false,
    reason: selected.capReason,
  });
}

async function authorizeGraphEdges({
  dbTable,
  graphEdges,
  seedResults,
  graphConfig,
  aclCtx,
  decisionTrace,
  logger,
  strictReadErrors,
  now,
  // Phase 2 — Bi-Temporal Memory. Default null: absent validAt means zero
  // temporal filtering (see plan §5b/§5's site-4 threading).
  validAt = null,
}) {
  const seedCount = Number.isFinite(graphConfig?.seedCount)
    ? Math.max(0, Math.floor(graphConfig.seedCount))
    : 5;
  const seedIds = seedResults
    .slice(0, seedCount)
    .map((result) => result.entry?.id)
    .filter(Boolean);
  const selected = selectReachableGraphEdges(graphEdges, seedIds, graphConfig);
  if (selected.edges.length === 0) {
    traceGraphEndpointCap(decisionTrace, selected);
    return selected.edges;
  }

  const rowsById = await getByIds(dbTable, selected.endpointIds, { strictReadErrors, logger });
  const allowedIds = new Set();
  for (const endpointId of selected.endpointIds) {
    const row = rowsById.get(endpointId);
    if (!row) {
      logger?.info?.(`recall-pipeline: graph endpoint ${endpointId} denied: missing row`);
      if (decisionTrace) {
        addTraceDecision(decisionTrace, {
          memoryId: endpointId,
          action: "rejection",
          stage: "graph-endpoint-acl",
          reason: "missing endpoint row",
        });
      }
      continue;
    }
    const entry = projectRecallEntry(row);
    if (!isRecallEntryLive(entry, now, validAt)) {
      const reason = entry.status != null && entry.status !== "active"
        ? `inactive status: ${entry.status}`
        : "non-live expiry";
      if (decisionTrace) {
        addTraceDecision(decisionTrace, {
          memoryId: endpointId,
          action: "rejection",
          stage: "graph-endpoint-acl",
          reason,
        });
      }
      continue;
    }
    const allowed = filterRecallCandidatesByAcl(
      [{ entry }],
      aclCtx,
      decisionTrace,
      logger,
      "graph-endpoint-acl",
    );
    if (allowed.length > 0) allowedIds.add(endpointId);
  }

  const authorizedEdges = selected.edges.filter((edge) => (
    allowedIds.has(edge.source) && allowedIds.has(edge.target)
  ));
  traceGraphEndpointCap(decisionTrace, selected);
  return authorizedEdges;
}

/**
 * Runs the primary single-table recall pipeline.
 *
 * @param {Object} options Recall pipeline dependencies and limits.
 * @param {boolean} [options.strictReadErrors=false] Propagate read timeouts for coordinated multi-table recall.
 * @param {number|bigint|null} [options.validAt=null] Optional valid-time instant used for historical filtering.
 * @returns {Promise<{queryVector: Array, canonical: Array, memories: Array, trace: Object|undefined}>}
 */
export async function runRecallPipeline({
  query,
  dbTable,
  embeddings,
  workspaceDir = null,
  topN = 12,
  budget = topN,
  recallMinScore = 0.15,
  importanceBoost = 0.3,
  dedupEnabled = true,
  dedupJaccard = 0.78,
  canonicalEnabled = true,
  canonicalMinScore = 0.30,
  canonicalMaxItems = 5,
  reranker = null,
  rerankCandidates = 20,
  candidateTopK = 40,
  rerankerTimeoutMs = 5000,
  rerankerFallbackOnError = true,
  summaryMaxWords = 150,
  logger = console,
  querySummarizer = null,
  emotionalState = null,
  graphEdges = [],
  associativeEnabled = true,
  graphConfig = {},
  workspaceKey = null,
  agentId = null,
  workspaceId = null,
  userPrincipal = null,
  memoryCtx = null,
  retrievalLogger = null,
  queryRefinerEnabled = false,
  strictReadErrors = false,
  decisionTrace = null,
  phaseTimer = null,
  softBudgetFallback = true,
  deferFinalCap = false,
  candidateHardLimit = 100,
  now = Date.now(),
  // Phase 2 — Bi-Temporal Memory. Default null, NOT now: absent validAt
  // means zero temporal filtering (byte-identical to pre-Phase-2 output),
  // not "filter at the current instant" (see plan §5b).
  validAt = null,
}) {
  const requestAgentId = memoryCtx?.agentId ?? agentId;
  const requestWorkspaceIdentity = memoryCtx?.workspaceIdentity ?? memoryCtx?.workspaceId ?? workspaceId;
  const requestUserPrincipal = memoryCtx?.userPrincipal ?? userPrincipal;
  const embeddingContext = Object.freeze({ agentId: requestAgentId });
  const aclCtx = freezeRecallAclContext({
    agentId: requestAgentId,
    workspaceId: requestWorkspaceIdentity,
    workspaceIdentity: requestWorkspaceIdentity,
    userPrincipal: requestUserPrincipal,
    workspaceAliases: memoryCtx?.workspaceAliases ?? EMPTY_WORKSPACE_ALIASES,
  });
  const hardCandidateLimit = Math.min(100, Math.max(1, normalizeRecallLimit(candidateHardLimit, 100)));
  const normalizedCandidateTopK = Math.min(
    hardCandidateLimit,
    Math.max(1, normalizeRecallLimit(candidateTopK, 40)),
  );
  phaseTimer?.start("embedding");
  // 1. Embedding — shorten long queries before calling the embedding API.
  // text-embedding-3-large has an 8191-token limit (German ≈ 4 chars/token → ~32 KB).
  // When the query exceeds that, summarize via LLM instead of hard-truncating so the
  // semantic meaning of long pasted documents / conversation threads is preserved.
  const EMBED_CHAR_LIMIT = 20000;
  let queryForEmbed = query;
  if (query.length > EMBED_CHAR_LIMIT) {
    if (typeof querySummarizer === "function") {
      try {
        queryForEmbed = await querySummarizer(query);
        logger?.info?.(`recall-pipeline: summarized long query ${query.length} → ${queryForEmbed.length} chars`);
      } catch (e) {
        logger?.warn?.(`recall-pipeline: querySummarizer failed, falling back to truncation: ${String(e)}`);
        queryForEmbed = query.slice(-EMBED_CHAR_LIMIT);
      }
    } else {
      queryForEmbed = query.slice(-EMBED_CHAR_LIMIT);
    }
  }
  const vector = typeof embeddings.embedQuery === "function"
    ? await embeddings.embedQuery(queryForEmbed, embeddingContext)
    : await embeddings.embed(queryForEmbed, embeddingContext);
  phaseTimer?.end("embedding");

  // Trace setup — kept cheap and entirely optional.
  let trace;
  if (decisionTrace === true) {
    trace = createRecallDecisionTrace({
      query,
      config: {
        recallMinScore,
        topN,
        budget,
        importanceBoost,
      },
    });
  } else if (decisionTrace && typeof decisionTrace === "object") {
    trace = decisionTrace;
  }

  // Canonical results are filled later; declare early so soft-budget fallback can
  // reference them safely even if it triggers before the canonical phase runs.
  let canonicalHits = [];

  // P8 — soft-budget fallback helper. Returns whatever is safe so far.
  function softBudgetPartial(currentList) {
    const remainingSlots = deferFinalCap
      ? hardCandidateLimit
      : Math.max(0, topN - canonicalHits.length);
    let partial = Array.isArray(currentList) ? currentList : [];
    partial = deferFinalCap
      ? partial.slice(0, remainingSlots)
      : dedupEnabled
        ? dedupResults(partial, remainingSlots, dedupJaccard)
        : partial.slice(0, remainingSlots);
    partial = filterRecallCandidatesByAcl(partial, aclCtx, trace, logger, "soft-budget-acl");
    if (trace) {
      addTraceGuard(trace, {
        name: "soft-budget",
        passed: false,
        reason: "soft_budget_fallback",
        phaseSummary: phaseTimer?.summary(),
      });
    }
    if (retrievalLogger && typeof retrievalLogger === "function") {
      emitRetrievalLedger({
        retrievalLogger,
        logger,
        entry: {
          agentId,
          workspaceKey,
          query,
          resultsCount: partial.length,
          selectedIds: partial.map((r) => r.entry.id),
        },
      });
    }
    if (trace) summarizeTrace(trace);
    return { queryVector: vector, canonical: canonicalHits, memories: partial, trace };
  }

  function maybeSoftBudgetFallback(currentList) {
    if (!softBudgetFallback || !phaseTimer) return null;
    if (!phaseTimer.isSoftBudgetExceeded()) return null;
    return softBudgetPartial(currentList);
  }

  // 2. LanceDB Vektorsuche
  phaseTimer?.start("vector_search");
  const fetchLimit = validAt == null
    ? Math.min(
        hardCandidateLimit,
        Math.max(topN, normalizedCandidateTopK, reranker ? normalizeRecallLimit(rerankCandidates, 0) : 0),
      )
    : hardCandidateLimit;
  let rows = [];
  try {
    rows = await runVectorSearchWithValidTimeFallback({
      dbTable,
      vector,
      validAt,
      fetchLimit,
      logger,
      timeoutLabel: "recall-pipeline.vectorSearch",
    });
  } catch (e) {
    if (e?.code === "ETIMEOUT") {
      if (strictReadErrors) throw e;
      logger?.warn?.(`recall-pipeline: vectorSearch timed out, treating as empty: ${e.message}`);
    } else {
      throw e;
    }
  }
  let results = rows.map(r => ({
    entry: projectRecallEntry(r),
    score: distanceToScore(r._distance),
    source: "vector",
  })).filter(r => r.score >= recallMinScore);
  results = filterRecallCandidatesByLifecycle(results, now, trace, validAt);
  results = filterRecallCandidatesByAcl(results, aclCtx, trace, logger, "initial-acl");
  phaseTimer?.end("vector_search");
  const vectorSearchFallback = maybeSoftBudgetFallback(results);
  if (vectorSearchFallback) return vectorSearchFallback;

  if (trace) {
    for (const r of results) {
      addTraceCandidate(trace, {
        id: r.entry.id,
        source: "vector",
        score: r.score,
        vectorScore: r.score,
        summary: r.entry.summary || r.entry.text,
        category: r.entry.category,
        status: r.entry.status,
      });
    }
  }

  // 2.3 Query-Verfeinerung — wenn erste Suche zu schlecht/keine Treffer, zweite Suche mit erweiterter Query
  phaseTimer?.start("query_refinement");
  if (queryRefinerEnabled && shouldRefineQuery(results, recallMinScore)) {
    const refinedQueryText = refineQuery(query, results);
    logger?.info?.(`recall-pipeline: query refinement triggered "${query}" → "${refinedQueryText}"`);
    try {
      const refinedEmbed = typeof embeddings.embedQuery === "function"
        ? await embeddings.embedQuery(refinedQueryText, embeddingContext)
        : await embeddings.embed(refinedQueryText, embeddingContext);
      let refinedRows = [];
      try {
        refinedRows = await runVectorSearchWithValidTimeFallback({
          dbTable,
          vector: refinedEmbed,
          validAt,
          fetchLimit,
          logger,
          timeoutLabel: "recall-pipeline.vectorSearch.refined",
        });
      } catch (e) {
        if (e?.code === "ETIMEOUT") {
          if (strictReadErrors) throw e;
          logger?.warn?.(`recall-pipeline: refined vectorSearch timed out, treating as empty: ${e.message}`);
        } else {
          throw e;
        }
      }
      const refinedResults = refinedRows.map(r => ({
        entry: projectRecallEntry(r),
        score: distanceToScore(r._distance),
        source: "vector",
      })).filter(r => r.score >= recallMinScore);
      const liveRefinedResults = filterRecallCandidatesByLifecycle(refinedResults, now, trace, validAt);
      const authorizedRefinedResults = filterRecallCandidatesByAcl(
        liveRefinedResults,
        aclCtx,
        trace,
        logger,
        "refined-acl",
      );

      // Kombiniere beide Result-Sets, dedupliziert nach ID (besserer Score gewinnt)
      const combinedMap = new Map();
      for (const r of results) {
        combinedMap.set(r.entry.id, r);
      }
      for (const r of authorizedRefinedResults) {
        const existing = combinedMap.get(r.entry.id);
        if (!existing || r.score > existing.score) {
          combinedMap.set(r.entry.id, r);
        }
      }
      results = Array.from(combinedMap.values()).sort((a, b) => b.score - a.score);
      logger?.info?.(`recall-pipeline: refinement combined ${results.length} unique results (original ${results.length - authorizedRefinedResults.length + (authorizedRefinedResults.length > 0 ? 0 : 0)} + refined)`);
      if (trace) {
        addTraceGuard(trace, {
          name: "query-refinement",
          passed: true,
          reason: `refinement triggered; merged ${results.length} unique results`,
        });
      }
    } catch (e) {
      if (strictReadErrors && e?.code === "ETIMEOUT") throw e;
      logger?.warn?.(`recall-pipeline: query refinement failed, keeping original results: ${String(e)}`);
    }
  }
  phaseTimer?.end("query_refinement");
  const refinementFallback = maybeSoftBudgetFallback(results);
  if (refinementFallback) return refinementFallback;

  // 2.5 Temporal Reasoning — wenn der Query einen Zeit-Anchor enthält, vor dem
  // Boost/Rerank filtern, damit weniger Kandidaten die teuren Schritte durchlaufen.
  phaseTimer?.start("temporal");
  // An explicit validAt is the authoritative Valid-Time selector. The legacy
  // query parser filters on System-Time createdAt and would otherwise apply a
  // second, contradictory year filter to historically valid rows.
  const temporal = validAt == null ? parseTemporal(query) : null;
  if (temporal && results.length > 0) {
    if (temporal.type === "anchor") {
      try {
        const resolved = await temporalRangeFromAnchor(
          temporal.referenceQuery,
          dbTable,
          embeddings,
          { strictReadErrors, embeddingContext, logger },
        );
        if (resolved) {
          const beforeIds = new Set(results.map(r => r.entry.id));
          const before = results.length;
          results = applyTemporalFilter(results, resolved);
          logger?.info?.(`recall-pipeline: temporal anchor "${temporal.referenceQuery}" resolved to range (${before} → ${results.length})`);
          if (trace && results.length < before) {
            const afterIds = new Set(results.map(r => r.entry.id));
            for (const id of beforeIds) {
              if (!afterIds.has(id)) {
                addTraceDecision(trace, {
                  memoryId: id,
                  action: "rejection",
                  stage: "temporal-filter",
                  reason: "outside resolved temporal range",
                });
              }
            }
          }
        }
      } catch (e) {
        if (strictReadErrors) throw e;
        logger?.warn?.(`recall-pipeline: temporal anchor resolution failed: ${String(e)}`);
      }
    } else {
      const beforeIds = new Set(results.map(r => r.entry.id));
      const before = results.length;
      results = applyTemporalFilter(results, temporal);
      if (before !== results.length) {
        logger?.info?.(`recall-pipeline: temporal filter applied (${before} → ${results.length})`);
      }
      if (trace && results.length < before) {
        const afterIds = new Set(results.map(r => r.entry.id));
        for (const id of beforeIds) {
          if (!afterIds.has(id)) {
            addTraceDecision(trace, {
              memoryId: id,
              action: "rejection",
              stage: "temporal-filter",
              reason: "outside temporal range",
            });
          }
        }
      }
    }
  }
  phaseTimer?.end("temporal");
  const temporalFallback = maybeSoftBudgetFallback(results);
  if (temporalFallback) return temporalFallback;

  // 3. Canonical-First parallel zur Vektorsuche aufrufen wäre möglich, aber
  // beide brauchen das vector-embedding zuerst. Sequentiell ist OK.
  phaseTimer?.start("canonical");
  canonicalHits = [];
  if (canonicalEnabled && workspaceDir) {
    try {
      canonicalHits = await searchCanonical(
        workspaceDir,
        vector,
        embeddings,
        canonicalMinScore,
        canonicalMaxItems,
        logger,
        embeddingContext,
      );
    } catch (e) {
      logger?.warn?.(`recall-pipeline: canonical search failed: ${String(e)}`);
    }
  }
  if (trace) {
    for (const hit of canonicalHits) {
      addTraceCandidate(trace, {
        id: `canonical:${textPreview(hit.heading, 40)}`,
        source: "canonical",
        score: hit.score,
        summary: hit.heading,
      });
      addTraceDecision(trace, {
        memoryId: `canonical:${textPreview(hit.heading, 40)}`,
        action: "inclusion",
        stage: "canonical",
        reason: "canonical KNOWLEDGE.md hit",
        finalScore: hit.score,
      });
    }
  }
  phaseTimer?.end("canonical");
  const canonicalFallback = maybeSoftBudgetFallback(results);
  if (canonicalFallback) return canonicalFallback;

  // 4. Single-Pass-Scoring: Importance-, Emotional- und Strength-Boost sind
  // alle multiplikativ — in EINEM map + EINEM sort kombinieren statt drei
  // separate map+sort-Durchläufe (das Endergebnis ist identisch, da nur der
  // finale Sort die Reihenfolge bestimmt).
  phaseTimer?.start("scoring");
  let boosted = results;
  if (results.length > 0) {
    const applyImportance = importanceBoost && importanceBoost > 0;
    boosted = results.map((r) => {
      let score = r.score;

      // 4a. Importance boost — additive, never lets low-relevance memories overtake
      if (applyImportance) {
        score += ((r.entry.importance ?? 0.5) - 0.5) * importanceBoost;
      }

      // 4b. Emotional boost — clamped to +/-10% so it acts as a tie-breaker
      if (emotionalState) {
        const rawValence = r.entry.emotionalValence;
        const valence = typeof rawValence === "string"
          ? deserializeEmotionalValence(rawValence)
          : (rawValence || {});
        // deserializeEmotionalValence liefert nur die 7 Dimensionen — die
        // gespeicherte Intensität separat anhängen, damit der Intensitäts-Term
        // in computeRecallBoost greift.
        if (valence && typeof valence === "object" && valence.emotionalIntensity === undefined) {
          valence.emotionalIntensity = r.entry.emotionalIntensity ?? 0;
        }
        const factor = emotionalState.computeRecallBoost(valence, r.entry.importance);
        score *= Math.min(Math.max(factor, 0.9), 1.1);
      }

      // 4c. Memory strength boost — additive minor nudge
      score += (r.entry.memoryStrength ?? 1.0) - 1.0;

      // 4d. Epistemic-status boost — additive, small (+/-0.4 max at the
      // extremes). Uses epistemicScoreBoost(), NOT normalizeEpistemicStatus(),
      // because scoring must treat legacy/absent as neutral (0), never as
      // "untrusted" — that fail-closed resolution is reserved for the
      // exclusion/legality checks (isRecallEntryLive above, transition
      // matrix), not for scoring existing legacy rows (see plan §4e).
      score += epistemicScoreBoost(r.entry.epistemicStatus);

      return { ...r, score };
    });
    boosted.sort((a, b) => b.score - a.score);
    if (trace) {
      const boostParts = [];
      if (applyImportance) boostParts.push("importance");
      if (emotionalState) boostParts.push("emotion");
      boostParts.push("strength");
      boostParts.push("epistemic");
      addTraceGuard(trace, {
        name: "score-recompute",
        passed: true,
        reason: `${boostParts.join("/")} re-scoring applied`,
      });
      for (const r of boosted) {
        addTraceDecision(trace, {
          memoryId: r.entry.id,
          action: "inclusion",
          stage: "score-recompute",
          reason: "re-scored",
          finalScore: r.score,
        });
      }
    }
  }

    // 4.5 Statusfilter — Vector-Results bereits gefiltert, hier nur expliziter Check
  // (sicherstellen, dass keine superseded/tombstoned durchgerutscht sind)
  boosted = filterRecallCandidatesByLifecycle(boosted, now, trace, validAt);
  phaseTimer?.end("scoring");
  const scoringFallback = maybeSoftBudgetFallback(boosted);
  if (scoringFallback) return scoringFallback;

  // 4.6 Assoziativer Spread (Memory-Graph)
  phaseTimer?.start("graph");
  let graphMetricsData = null;
  if (associativeEnabled && graphEdges.length > 0 && boosted.length > 0) {
    const graphStart = Date.now();
    let authorizedGraphEdges = null;
    try {
      authorizedGraphEdges = await authorizeGraphEdges({
        dbTable,
        graphEdges,
        seedResults: boosted,
        graphConfig,
        aclCtx,
        decisionTrace: trace,
        logger,
        strictReadErrors,
        now,
        validAt,
      });
    } catch (e) {
      if (strictReadErrors) {
        phaseTimer?.end("graph");
        throw e;
      }
      logger?.warn?.(`recall-pipeline: graph endpoint authorization failed: ${String(e)}`);
    }
    if (authorizedGraphEdges) {
      try {
        const indexEnabled = graphConfig?.graphIndex?.enabled !== false;
        const graphInput = indexEnabled
          ? queryGraphIndex(buildGraphIndex(authorizedGraphEdges))
          : authorizedGraphEdges;
        const { adjacency } = readGraph(graphInput);
        const associative = traverseGraph(boosted, adjacency, graphConfig, trace);
        const metrics = createGraphMetrics();
        metrics.computeDegreeStats(adjacency);
        metrics.traversalVisitedNodes = associative.length;
        metrics.associativeResultsAdded = associative.length;
        metrics.recallLatencyMs = Date.now() - graphStart;
        boosted = mergeAssociativeResults(
          boosted,
          associative,
          deferFinalCap ? hardCandidateLimit : Math.max(topN * 3, 20),
          trace,
        );
        logger?.info?.(`recall-pipeline: associative spread added ${associative.length} memories in ${metrics.recallLatencyMs}ms`);
        graphMetricsData = metrics;
      } catch (e) {
        logger?.warn?.(`recall-pipeline: associative spread failed: ${String(e)}`);
      }
    }
  }
  phaseTimer?.end("graph");
  const graphFallback = maybeSoftBudgetFallback(boosted);
  if (graphFallback) return graphFallback;

  // Persist graph recall metrics
  if (graphMetricsData && workspaceDir) {
    try {
      await recordGraphRecallMetrics(workspaceDir, {
        edgesTotal: graphEdges.length,
        recallLatencyMs: graphMetricsData.recallLatencyMs,
        associativeResultsAdded: graphMetricsData.associativeResultsAdded,
        traversalVisitedNodes: graphMetricsData.traversalVisitedNodes,
      });
    } catch (err) { safeWarn(logger, "recordGraphRecallMetrics", err); }
  }

  // 4.7 Graph-only Hydration — graph-basierte Treffer aus LanceDB nachladen
  // und gegen den Query-Vektor revalidieren (K1-01).
  phaseTimer?.start("graph_hydration");
  boosted = await hydrateGraphResults(dbTable, boosted, logger, {
    queryVector: vector,
    embeddings,
    graphConfig,
    decisionTrace: trace,
    strictReadErrors,
    aclCtx,
    embeddingContext,
    now,
    validAt,
  });
  phaseTimer?.end("graph_hydration");
  const hydrationFallback = maybeSoftBudgetFallback(boosted);
  if (hydrationFallback) return hydrationFallback;

  // 4.8 Recall budget — enforce tier caps before final dedup/rerank.
  // Canonical items are kept separate; episodic/associative share the remaining slots.
  phaseTimer?.start("budget");
  if (!deferFinalCap && budget > 0 && boosted.length > 0) {
    const beforeBudget = boosted.map(r => r.entry.id);
    // Canonical items are kept separate from vector/graph results and prepended
    // by callers (e.g. index.js). Mixing them here would break the uniform
    // { entry, score, source } shape expected by dedup, ACL, and downstream formatters.
    const budgetResult = applyRecallBudget(boosted, { canonical: [], budget });
    boosted = budgetResult.selected;
    if (trace) {
      const selectedIds = new Set(boosted.map(r => r.entry.id));
      for (const id of beforeBudget) {
        if (!selectedIds.has(id)) {
          addTraceDecision(trace, {
            memoryId: id,
            action: "rejection",
            stage: "recall-budget",
            reason: "budget cap",
          });
        }
      }
    }
  }
  phaseTimer?.end("budget");
  const budgetFallback = maybeSoftBudgetFallback(boosted);
  if (budgetFallback) return budgetFallback;

  // 5. Provider-aware Rerank (optional) — mit Timeout und Fallback-Kontrolle
  phaseTimer?.start("rerank");
  let ordered = boosted;
  if (reranker && boosted.length > 1) {
    let rerankFallback = false;
    try {
      const docs = boosted.map(r => r.entry.summary || generateSummary(r.entry.text || "", summaryMaxWords));
      const rerankLimit = deferFinalCap
        ? hardCandidateLimit
        : Math.max(topN, dedupEnabled ? topN * 2 : topN);
      const rerankPromise = reranker.rerank(query, docs, rerankLimit);
      let reranked;
      if (rerankerTimeoutMs > 0) {
        reranked = await Promise.race([
          rerankPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("reranker timeout")), rerankerTimeoutMs)),
        ]);
      } else {
        reranked = await rerankPromise;
      }
      const validRanked = Array.isArray(reranked)
        ? reranked.filter(r => Number.isInteger(r?.index) && r.index >= 0 && r.index < boosted.length)
        : [];
      if (validRanked.length === 0) {
        rerankFallback = true;
        ordered = boosted.slice(0, deferFinalCap ? hardCandidateLimit : topN);
      } else {
        ordered = validRanked.map(r => boosted[r.index]);
      }
    } catch (e) {
      rerankFallback = true;
      if (rerankerFallbackOnError) {
        logger?.warn?.(`recall-pipeline: rerank failed/timeout, falling back to unreranked: ${String(e)}`);
        ordered = boosted.slice(0, deferFinalCap ? hardCandidateLimit : topN);
      } else {
        throw e;
      }
    }
    if (rerankFallback && trace) {
      addTraceGuard(trace, {
        name: "rerank",
        passed: false,
        reason: "reranker returned no valid indices or threw; falling back to unreranked topN",
      });
    }
  }
  phaseTimer?.end("rerank");
  const rerankFallbackSoft = maybeSoftBudgetFallback(ordered);
  if (rerankFallbackSoft) return rerankFallbackSoft;

  // 6. Inter-Result-Dedup (Slot-Aufteilung: canonical priorisiert)
  phaseTimer?.start("dedup");
  const remainingSlots = deferFinalCap
    ? hardCandidateLimit
    : Math.max(0, topN - canonicalHits.length);
  const beforeDedup = ordered.map(r => r.entry.id);
  ordered = deferFinalCap
    ? ordered.slice(0, remainingSlots)
    : dedupEnabled
      ? dedupResults(ordered, remainingSlots, dedupJaccard)
      : ordered.slice(0, remainingSlots);
  if (trace) {
    const afterDedupIds = new Set(ordered.map(r => r.entry.id));
    for (const id of beforeDedup) {
      if (!afterDedupIds.has(id)) {
        addTraceDecision(trace, {
          memoryId: id,
          action: "deduped",
          stage: "jaccard-dedup",
          reason: "duplicate or beyond slot limit",
        });
      }
    }
  }
  phaseTimer?.end("dedup");
  const dedupFallback = maybeSoftBudgetFallback(ordered);
  if (dedupFallback) return dedupFallback;

  // 6.5 ACL-Filter — nur erlaubte Memories an den Agent zurückgeben
  phaseTimer?.start("acl");
  ordered = filterRecallCandidatesByAcl(ordered, aclCtx, trace, logger, "acl");
  phaseTimer?.end("acl");
  const aclFallback = maybeSoftBudgetFallback(ordered);
  if (aclFallback) return aclFallback;

  // 7. Retrieval-Ledger — nach finaler Selektion loggen
  phaseTimer?.start("finalize");
  if (retrievalLogger && typeof retrievalLogger === 'function') {
    emitRetrievalLedger({
      retrievalLogger,
      logger,
      entry: {
        agentId,
        workspaceKey,
        query,
        resultsCount: ordered.length,
        selectedIds: ordered.map(r => r.entry.id),
      },
    });
  }

  if (trace) {
    summarizeTrace(trace);
  }
  phaseTimer?.end("finalize");
  return { queryVector: vector, canonical: canonicalHits, memories: ordered, trace };
}

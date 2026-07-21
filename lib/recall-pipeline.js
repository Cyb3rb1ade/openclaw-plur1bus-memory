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

import { safeWarn } from "./safe-logging.js";
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
import { applyRecallBudget } from "./recall-budget.js";
import { safeUuidList, sqlString } from "./sql-safety.js";
import { recordGraphRecallMetrics } from "./metrics.js";
import { parseTemporal } from "./temporal-parser.js";
import { applyTemporalFilter, temporalRangeFromAnchor } from "./temporal-filter.js";
import { checkAccess } from "./acl-middleware.js";
import { shouldRefineQuery, refineQuery } from "./query-refiner.js";
import { withTimeout } from "./with-timeout.js";

// ─── Timeouts ──────────────────────────────────────────────────────────────

const LANCEDB_READ_TIMEOUT_MS = 10_000;
const QUERY_RELEVANCE_TIMEOUT_MS = 5_000;

// ─── Associative Recall Opt-in (K1-02) ─────────────────────────────────────

/**
 * Assoziativer Recall ist nur aktiv, wenn sowohl der Continuity-Engine-
 * Hauptschalter als auch der assoziative Recall explizit enabled sind.
 */
export function computeUseAssociative(continuityEnabled, assocCfg = {}) {
  return continuityEnabled === true && assocCfg.enabled === true;
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
 */
export function dedupResults(results, maxOut, jaccardThreshold = 0.78) {
  if (maxOut <= 0) return [];
  const out = [];
  for (const r of results) {
    let isDup = false;
    const text = r.entry.summary || r.entry.text || "";
    for (const kept of out) {
      const keptText = kept.entry.summary || kept.entry.text || "";
      if (jaccardSimilarity(text, keptText) >= jaccardThreshold) {
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
  const queryVector = cloneNamespaceQueryVector(results);
  if (trace !== undefined && (typeof trace !== "object" || Array.isArray(trace))) {
    throw new TypeError("mergeNamespaceRecallResults trace must be an object");
  }

  if (trace) {
    for (const result of results) {
      replayNamespaceTrace(trace, result?.trace, normalizeRecallNamespace(result?.namespace));
    }
  }

  const canonicalCandidates = [];
  const memoryCandidates = [];
  let ordinal = 0;
  for (const result of results) {
    const namespace = normalizeRecallNamespace(result?.namespace);
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
      recordNamespaceDedup(trace, canonicalTraceId(candidate.item), candidate.namespace, "namespace-canonical-dedup", "duplicate canonical content");
      continue;
    }
    canonicalKeys.add(key);
    if (canonical.length >= canonicalMaxItems) {
      recordNamespaceDedup(trace, canonicalTraceId(candidate.item), candidate.namespace, "namespace-canonical-cap", "beyond global canonical cap");
      continue;
    }
    canonical.push(candidate.item);
  }

  memoryCandidates.sort(compareRecallCandidate);
  const byId = new Map();
  const uniqueMemories = [];
  for (const candidate of memoryCandidates) {
    const id = candidate.item.entry.id;
    if (typeof id !== "string" || id.length === 0) {
      uniqueMemories.push(candidate);
      continue;
    }
    if (byId.has(id)) {
      recordNamespaceDedup(trace, id, candidate.namespace, "namespace-id-dedup", "duplicate memory ID with a lower global score");
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
      recordNamespaceDedup(trace, candidate.item.entry.id, candidate.namespace, "namespace-result-dedup", "duplicate or beyond global result cap");
    }
  }

  if (trace) summarizeTrace(trace);
  return { queryVector, canonical, memories: selected, trace };
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

function recordNamespaceDedup(trace, memoryId, namespace, stage, reason) {
  if (!trace) return;
  addTraceDecision(trace, {
    memoryId: String(memoryId ?? ""),
    action: "deduped",
    stage,
    reason,
    namespace: namespace ?? undefined,
  });
}

function replayNamespaceTrace(masterTrace, childTrace, namespace) {
  if (!childTrace || typeof childTrace !== "object" || childTrace === masterTrace) return;
  for (const candidate of childTrace.candidates || []) {
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
  }
  for (const decision of childTrace.decisions || []) {
    addTraceDecision(masterTrace, {
      memoryId: decision.memoryId,
      action: decision.action,
      stage: decision.stage,
      reason: decision.reason,
      finalScore: decision.finalScore,
      scoreBreakdown: decision.scoreBreakdown,
      temporal: decision.temporal,
      namespace: namespace ?? undefined,
    });
  }
  for (const guard of childTrace.guards || []) {
    addTraceGuard(masterTrace, {
      name: guard.name,
      passed: guard.passed,
      reason: guard.reason,
      memoryId: guard.memoryId,
      namespace: namespace ?? undefined,
    });
  }
  for (const decision of childTrace.storeDecisions || []) {
    addTraceStoreDecision(masterTrace, {
      memoryId: decision.memoryId,
      action: decision.action,
      reason: decision.reason,
      namespace: namespace ?? undefined,
    });
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
 */
export async function getKnowledgeChunks(workspaceDir, embeddings, logger) {
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
      const vec = await embeddings.embed(sec.text.slice(0, 4000));
      chunks.push({ heading: sec.heading, text: sec.text, vector: vec });
    } catch (e) {
      logger?.warn?.(`recall-pipeline: knowledge embed failed for "${sec.heading}": ${String(e)}`);
    }
  }
  writeKnowledgeCache(workspaceDir, { mtime, chunks }, logger);
  return chunks;
}

/**
 * Cosine-Match einer Query gegen alle KNOWLEDGE.md-Sections. Top-N mit
 * Score ≥ minScore.
 */
export async function searchCanonical(workspaceDir, queryVector, embeddings, minScore, topN, logger) {
  const chunks = await getKnowledgeChunks(workspaceDir, embeddings, logger);
  if (chunks.length === 0) return [];
  const scored = chunks.map(c => ({
    heading: c.heading,
    text: c.text,
    score: cosineSimilarityVec(queryVector, c.vector),
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
 * @param {number} opts.rerankerTimeoutMs — Timeout für Reranker-Aufruf (default 5000)
 * @param {boolean} opts.rerankerFallbackOnError — bei Reranker-Fehler/Timeout auf unrerankte Top-N fallbacken (default true)
 * @param {number} opts.summaryMaxWords — für generateSummary fallback (default 150)
 * @param {Object} opts.logger — { warn(msg), info(msg) }
 * @param {Object} opts.emotionalState — optional EmotionalState-Instanz für stimmungsabhängigen Recall
 * @param {string} opts.workspaceKey — Workspace-Key für Retrieval-Ledger
 * @param {string} opts.agentId — Agent-ID für Retrieval-Ledger
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
 */
export async function hydrateGraphResults(dbTable, results, logger, opts = {}) {
  const { queryVector, embeddings, graphConfig = {}, decisionTrace } = opts;
  const relevanceThreshold = graphConfig.graphHydrationRelevanceThreshold ?? 0.25;
  const shouldRevalidate = queryVector && queryVector.length > 0 && embeddings;

  const graphOnly = results.filter(r => r.source === "graph" && (!r.entry?.text && !r.entry?.summary));
  if (graphOnly.length === 0) return results.filter(r => !r.entry?.status || r.entry.status === "active");

  const ids = graphOnly.map(r => r.entry?.id).filter(Boolean);
  const hydratedMap = await getByIds(dbTable, ids);

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
      const status = row.status || "active";
      if (status !== "active" && status !== "") {
        if (decisionTrace) {
          addTraceDecision(decisionTrace, {
            memoryId: row.id,
            action: "rejection",
            stage: "graph-hydration",
            reason: `inactive status: ${status}`,
          });
        }
        continue;
      }

      if (shouldRevalidate) {
        try {
          const relevance = await computeQueryRelevance(row, queryVector, embeddings);
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
        entry: {
          id: row.id,
          text: row.text || "",
          summary: row.summary || "",
          origin: row.origin || "dm",
          category: row.category,
          importance: row.importance ?? 0.5,
          createdAt: row.createdAt,
          sourceUrl: row.sourceUrl || "",
          evidenceQuote: row.evidenceQuote || "",
          scope: row.scope || "agent-private",
          agentId: row.agentId || "",
          workspaceId: row.workspaceId || "",
          emotionalValence: row.emotionalValence ?? "",
          emotionalIntensity: row.emotionalIntensity ?? 0,
          emotionalDominant: row.emotionalDominant || "neutral",
          retrievalCount: row.retrievalCount ?? 0,
          lastRetrievedAt: row.lastRetrievedAt ?? 0,
          memoryStrength: row.memoryStrength ?? 1.0,
          halfLifeDays: row.halfLifeDays ?? 30,
          lastStrengthenedAt: row.lastStrengthenedAt ?? 0,
          lastDynamicsAt: row.lastDynamicsAt ?? 0,
          memoryClass: row.memoryClass || "standard",
          neverForget: row.neverForget ?? 0,
          coreMemoryScore: row.coreMemoryScore ?? 0.0,
          coreMemoryReason: row.coreMemoryReason || "",
          versionNumber: row.versionNumber ?? 1,
          previousVersion: row.previousVersion || "",
          supersededBy: row.supersededBy || "",
          updateSource: row.updateSource || "",
          updateEvidence: row.updateEvidence || "",
          reconsolidationConfidence: row.reconsolidationConfidence ?? 0.0,
          status: row.status || "active",
          versionCreatedAt: row.versionCreatedAt ?? 0,
          updatedAt: row.updatedAt ?? 0,
        },
      });
    } else {
      if (!r.entry?.status || r.entry.status === "active") {
        out.push(r);
      }
    }
  }

  if (hydrationMisses > 0) {
    logger?.warn?.(`recall-pipeline: graph hydration missed ${hydrationMisses} of ${graphOnly.length} IDs`);
  }
  return out;
}

/**
 * Berechnet die Cosine-Ähnlichkeit zwischen einem hydrated Row und dem Query-Vektor.
 * Verwendet row.vector wenn vorhanden, sonst embeddet text/summary.
 */
async function computeQueryRelevance(row, queryVector, embeddings) {
  let candidateVector = row.vector;
  if (!candidateVector || candidateVector.length !== queryVector.length) {
    const text = row.text || row.summary || "";
    const embedFn = typeof embeddings.embed === "function" ? embeddings.embed : embeddings.embedQuery;
    try {
      candidateVector = await withTimeout(
        embedFn(text),
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
 * Versucht IN-Query, fallback auf batched single lookups.
 */
async function getByIds(dbTable, ids) {
  const cleanIds = [...new Set(ids)]
    .map(String)
    .filter(id => /^[a-zA-Z0-9-]+$/.test(id));
  if (cleanIds.length === 0) return new Map();

  const map = new Map();

  const inClause = safeUuidList(cleanIds);
  if (inClause) {
    try {
      const rows = await withTimeout(
        dbTable.query()
          .where(`id IN (${inClause})`)
          .limit(cleanIds.length)
          .toArray(),
        LANCEDB_READ_TIMEOUT_MS,
        "recall-pipeline.getByIds.in",
      );
      for (const row of rows) {
        if (row.id) map.set(row.id, row);
      }
      if (map.size === cleanIds.length) return map;
    } catch (e) {
      if (e?.code === "ETIMEOUT") {
        safeWarn(undefined, "getByIds IN timeout", e);
      }
      // IN query not supported or timed out, fall through
    }
  }

  const BATCH = 10;
  for (let i = 0; i < cleanIds.length; i += BATCH) {
    const batch = cleanIds.slice(i, i + BATCH);
    await Promise.all(batch.map(async (id) => {
      try {
        const rows = await withTimeout(
          dbTable.query()
            .where(`id = ${sqlString(id)}`)
            .limit(1)
            .toArray(),
          LANCEDB_READ_TIMEOUT_MS,
          "recall-pipeline.getByIds.batch",
        );
        if (rows[0]?.id) map.set(rows[0].id, rows[0]);
      } catch (e) {
        if (e?.code === "ETIMEOUT") {
          safeWarn(undefined, `getByIds batch timeout for ${id}`, e);
        }
        // ignore other errors
      }
    }));
  }
  return map;
}

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
  retrievalLogger = null,
  queryRefinerEnabled = false,
  decisionTrace = null,
  phaseTimer = null,
  softBudgetFallback = true,
}) {
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
    ? await embeddings.embedQuery(queryForEmbed)
    : await embeddings.embed(queryForEmbed);
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
    const remainingSlots = Math.max(0, topN - canonicalHits.length);
    let partial = Array.isArray(currentList) ? currentList : [];
    partial = dedupEnabled
      ? dedupResults(partial, remainingSlots, dedupJaccard)
      : partial.slice(0, remainingSlots);
    if (agentId) {
      partial = partial.filter((r) => {
        const acl = checkAccess({ agentId, workspaceId }, r.entry);
        if (!acl.allowed) {
          logger?.info?.(`recall-pipeline: ACL denied for memory ${r.entry.id}: ${acl.reason}`);
          if (trace) {
            addTraceGuard(trace, { name: "acl", passed: false, reason: acl.reason, memoryId: r.entry.id });
            addTraceDecision(trace, { memoryId: r.entry.id, action: "rejection", stage: "acl", reason: acl.reason });
          }
        }
        return acl.allowed;
      });
    }
    if (trace) {
      addTraceGuard(trace, {
        name: "soft-budget",
        passed: false,
        reason: "soft_budget_fallback",
        phaseSummary: phaseTimer?.summary(),
      });
    }
    if (retrievalLogger && typeof retrievalLogger === "function") {
      try {
        retrievalLogger({
          agentId,
          workspaceKey,
          query,
          resultsCount: partial.length,
          selectedIds: partial.map((r) => r.entry.id),
        });
      } catch (_) { /* retrieval logger must not break recall */ }
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
  const fetchLimit = Math.min(100, reranker ? Math.max(rerankCandidates, topN * 3) : topN);
  let rows = [];
  try {
    rows = await withTimeout(
      dbTable.vectorSearch(vector).limit(fetchLimit).toArray(),
      LANCEDB_READ_TIMEOUT_MS,
      "recall-pipeline.vectorSearch",
    );
  } catch (e) {
    if (e?.code === "ETIMEOUT") {
      logger?.warn?.(`recall-pipeline: vectorSearch timed out, treating as empty: ${e.message}`);
    } else {
      throw e;
    }
  }
  let results = rows.map(r => ({
    entry: {
      id: r.id,
      text: r.text,
      summary: r.summary || "",
      origin: r.origin || "dm",
      category: r.category,
      importance: r.importance ?? 0.5,
      createdAt: r.createdAt,
      sourceUrl: r.sourceUrl || "",
      evidenceQuote: r.evidenceQuote || "",
      scope: r.scope || "agent-private",
      storedBy: r.storedBy || "",
      workspaceKey: r.workspaceKey || "",
      agentId: r.agentId || r.storedBy || "",
      workspaceId: r.workspaceId || r.workspaceKey || "",
      emotionalValence: r.emotionalValence ?? "",
      emotionalIntensity: r.emotionalIntensity ?? 0,
      emotionalDominant: r.emotionalDominant || "neutral",
      retrievalCount: r.retrievalCount ?? 0,
      lastRetrievedAt: r.lastRetrievedAt ?? 0,
      memoryStrength: r.memoryStrength ?? 1.0,
      halfLifeDays: r.halfLifeDays ?? 30,
      lastStrengthenedAt: r.lastStrengthenedAt ?? 0,
      lastDynamicsAt: r.lastDynamicsAt ?? 0,
      memoryClass: r.memoryClass || "standard",
      neverForget: r.neverForget ?? 0,
      coreMemoryScore: r.coreMemoryScore ?? 0.0,
      coreMemoryReason: r.coreMemoryReason || "",
      versionNumber: r.versionNumber ?? 1,
      previousVersion: r.previousVersion || "",
      supersededBy: r.supersededBy || "",
      updateSource: r.updateSource || "",
      updateEvidence: r.updateEvidence || "",
      reconsolidationConfidence: r.reconsolidationConfidence ?? 0.0,
      status: r.status || "active",
      versionCreatedAt: r.versionCreatedAt ?? 0,
      updatedAt: r.updatedAt ?? 0,
    },
    score: distanceToScore(r._distance),
    source: "vector",
  })).filter(r => r.score >= recallMinScore && (!r.entry.status || r.entry.status === "active"));
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
        ? await embeddings.embedQuery(refinedQueryText)
        : await embeddings.embed(refinedQueryText);
      let refinedRows = [];
      try {
        refinedRows = await withTimeout(
          dbTable.vectorSearch(refinedEmbed).limit(fetchLimit).toArray(),
          LANCEDB_READ_TIMEOUT_MS,
          "recall-pipeline.vectorSearch.refined",
        );
      } catch (e) {
        if (e?.code === "ETIMEOUT") {
          logger?.warn?.(`recall-pipeline: refined vectorSearch timed out, treating as empty: ${e.message}`);
        } else {
          throw e;
        }
      }
      const refinedResults = refinedRows.map(r => ({
        entry: {
          id: r.id,
          text: r.text,
          summary: r.summary || "",
          origin: r.origin || "dm",
          category: r.category,
          importance: r.importance ?? 0.5,
          createdAt: r.createdAt,
        sourceUrl: r.sourceUrl || "",
        evidenceQuote: r.evidenceQuote || "",
        scope: r.scope || "agent-private",
        storedBy: r.storedBy || "",
        workspaceKey: r.workspaceKey || "",
        agentId: r.agentId || r.storedBy || "",
        workspaceId: r.workspaceId || r.workspaceKey || "",
          emotionalValence: r.emotionalValence ?? "",
          emotionalIntensity: r.emotionalIntensity ?? 0,
          emotionalDominant: r.emotionalDominant || "neutral",
          retrievalCount: r.retrievalCount ?? 0,
          lastRetrievedAt: r.lastRetrievedAt ?? 0,
          memoryStrength: r.memoryStrength ?? 1.0,
          halfLifeDays: r.halfLifeDays ?? 30,
          lastStrengthenedAt: r.lastStrengthenedAt ?? 0,
          lastDynamicsAt: r.lastDynamicsAt ?? 0,
          memoryClass: r.memoryClass || "standard",
          neverForget: r.neverForget ?? 0,
          coreMemoryScore: r.coreMemoryScore ?? 0.0,
          coreMemoryReason: r.coreMemoryReason || "",
          versionNumber: r.versionNumber ?? 1,
          previousVersion: r.previousVersion || "",
          supersededBy: r.supersededBy || "",
          updateSource: r.updateSource || "",
          updateEvidence: r.updateEvidence || "",
          reconsolidationConfidence: r.reconsolidationConfidence ?? 0.0,
          status: r.status || "active",
          versionCreatedAt: r.versionCreatedAt ?? 0,
          updatedAt: r.updatedAt ?? 0,
        },
        score: distanceToScore(r._distance),
        source: "vector",
      })).filter(r => r.score >= recallMinScore && (!r.entry.status || r.entry.status === "active"));

      // Kombiniere beide Result-Sets, dedupliziert nach ID (besserer Score gewinnt)
      const combinedMap = new Map();
      for (const r of results) {
        combinedMap.set(r.entry.id, r);
      }
      for (const r of refinedResults) {
        const existing = combinedMap.get(r.entry.id);
        if (!existing || r.score > existing.score) {
          combinedMap.set(r.entry.id, r);
        }
      }
      results = Array.from(combinedMap.values()).sort((a, b) => b.score - a.score);
      logger?.info?.(`recall-pipeline: refinement combined ${results.length} unique results (original ${results.length - refinedResults.length + (refinedResults.length > 0 ? 0 : 0)} + refined)`);
      if (trace) {
        addTraceGuard(trace, {
          name: "query-refinement",
          passed: true,
          reason: `refinement triggered; merged ${results.length} unique results`,
        });
      }
    } catch (e) {
      logger?.warn?.(`recall-pipeline: query refinement failed, keeping original results: ${String(e)}`);
    }
  }
  phaseTimer?.end("query_refinement");
  const refinementFallback = maybeSoftBudgetFallback(results);
  if (refinementFallback) return refinementFallback;

  // 2.5 Temporal Reasoning — wenn der Query einen Zeit-Anchor enthält, vor dem
  // Boost/Rerank filtern, damit weniger Kandidaten die teuren Schritte durchlaufen.
  phaseTimer?.start("temporal");
  const temporal = parseTemporal(query);
  if (temporal && results.length > 0) {
    if (temporal.type === "anchor") {
      try {
        const resolved = await temporalRangeFromAnchor(temporal.referenceQuery, dbTable, embeddings);
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
      canonicalHits = await searchCanonical(workspaceDir, vector, embeddings, canonicalMinScore, canonicalMaxItems, logger);
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

      return { ...r, score };
    });
    boosted.sort((a, b) => b.score - a.score);
    if (trace) {
      const boostParts = [];
      if (applyImportance) boostParts.push("importance");
      if (emotionalState) boostParts.push("emotion");
      boostParts.push("strength");
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
  boosted = boosted.filter(r => !r.entry.status || r.entry.status === "active");
  phaseTimer?.end("scoring");
  const scoringFallback = maybeSoftBudgetFallback(boosted);
  if (scoringFallback) return scoringFallback;

  // 4.6 Assoziativer Spread (Memory-Graph)
  phaseTimer?.start("graph");
  let graphMetricsData = null;
  if (associativeEnabled && graphEdges.length > 0 && boosted.length > 0) {
    try {
      const graphStart = Date.now();
      const { adjacency } = readGraph(graphEdges);
      const associative = traverseGraph(boosted, adjacency, graphConfig, trace);
      const metrics = createGraphMetrics();
      metrics.computeDegreeStats(adjacency);
      metrics.traversalVisitedNodes = associative.length;
      metrics.associativeResultsAdded = associative.length;
      metrics.recallLatencyMs = Date.now() - graphStart;
      boosted = mergeAssociativeResults(boosted, associative, Math.max(topN * 3, 20), trace);
      logger?.info?.(`recall-pipeline: associative spread added ${associative.length} memories in ${metrics.recallLatencyMs}ms`);
      graphMetricsData = metrics;
    } catch (e) {
      logger?.warn?.(`recall-pipeline: associative spread failed: ${String(e)}`);
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
  });
  phaseTimer?.end("graph_hydration");
  const hydrationFallback = maybeSoftBudgetFallback(boosted);
  if (hydrationFallback) return hydrationFallback;

  // 4.8 Recall budget — enforce tier caps before final dedup/rerank.
  // Canonical items are kept separate; episodic/associative share the remaining slots.
  phaseTimer?.start("budget");
  if (budget > 0 && boosted.length > 0) {
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
      const rerankPromise = reranker.rerank(query, docs, Math.max(topN, dedupEnabled ? topN * 2 : topN));
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
        ordered = boosted.slice(0, topN);
      } else {
        ordered = validRanked.map(r => boosted[r.index]);
      }
    } catch (e) {
      rerankFallback = true;
      if (rerankerFallbackOnError) {
        logger?.warn?.(`recall-pipeline: rerank failed/timeout, falling back to unreranked: ${String(e)}`);
        ordered = boosted.slice(0, topN);
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
  const remainingSlots = Math.max(0, topN - canonicalHits.length);
  const beforeDedup = ordered.map(r => r.entry.id);
  ordered = dedupEnabled
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
  if (agentId) {
    const beforeAcl = ordered.map(r => r.entry.id);
    ordered = ordered.filter(r => {
      const acl = checkAccess({ agentId, workspaceId }, r.entry);
      if (!acl.allowed) {
        logger?.info?.(`recall-pipeline: ACL denied for memory ${r.entry.id}: ${acl.reason}`);
        if (trace) {
          addTraceGuard(trace, {
            name: "acl",
            passed: false,
            reason: acl.reason,
            memoryId: r.entry.id,
          });
          addTraceDecision(trace, {
            memoryId: r.entry.id,
            action: "rejection",
            stage: "acl",
            reason: acl.reason,
          });
        }
      }
      return acl.allowed;
    });
    if (beforeAcl.length !== ordered.length) {
      logger?.info?.(`recall-pipeline: ACL filter removed ${beforeAcl.length - ordered.length} memories`);
    }
  }
  phaseTimer?.end("acl");
  const aclFallback = maybeSoftBudgetFallback(ordered);
  if (aclFallback) return aclFallback;

  // 7. Retrieval-Ledger — nach finaler Selektion loggen
  phaseTimer?.start("finalize");
  if (retrievalLogger && typeof retrievalLogger === 'function') {
    try {
      retrievalLogger({
        agentId,
        workspaceKey,
        query,
        resultsCount: ordered.length,
        selectedIds: ordered.map(r => r.entry.id),
      });
    } catch (e) {
      logger?.warn?.(`recall-pipeline: retrievalLogger failed: ${String(e)}`);
    }
  }

  if (trace) {
    summarizeTrace(trace);
  }
  phaseTimer?.end("finalize");
  return { queryVector: vector, canonical: canonicalHits, memories: ordered, trace };
}

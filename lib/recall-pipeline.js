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
  const { queryVector, embeddings, graphConfig = {} } = opts;
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
        continue;
      }
      const status = row.status || "active";
      if (status !== "active" && status !== "") {
        continue;
      }

      if (shouldRevalidate) {
        try {
          const relevance = await computeQueryRelevance(row, queryVector, embeddings);
          if (relevance < relevanceThreshold) {
            logger?.info?.(`recall-pipeline: graph hydration relevance ${relevance.toFixed(3)} < ${relevanceThreshold} for ${row.id}, dropping`);
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
    candidateVector = await embedFn(text);
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
      const rows = await dbTable.query()
        .where(`id IN (${inClause})`)
        .limit(cleanIds.length)
        .toArray();
      for (const row of rows) {
        if (row.id) map.set(row.id, row);
      }
      if (map.size === cleanIds.length) return map;
    } catch (e) {
      // IN query not supported, fall through
    }
  }

  const BATCH = 10;
  for (let i = 0; i < cleanIds.length; i += BATCH) {
    const batch = cleanIds.slice(i, i + BATCH);
    await Promise.all(batch.map(async (id) => {
      try {
        const rows = await dbTable.query()
          .where(`id = ${sqlString(id)}`)
          .limit(1)
          .toArray();
        if (rows[0]?.id) map.set(rows[0].id, rows[0]);
      } catch (e) {
        // ignore
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
}) {
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

  // 2. LanceDB Vektorsuche
  const fetchLimit = reranker ? Math.max(rerankCandidates, topN * 3) : topN;
  const rows = await dbTable.vectorSearch(vector).limit(fetchLimit).toArray();
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
      agentId: r.agentId || "",
      workspaceId: r.workspaceId || "",
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
  })).filter(r => r.score >= recallMinScore && (!r.entry.status || r.entry.status === "active"));

  // 2.3 Query-Verfeinerung — wenn erste Suche zu schlecht/keine Treffer, zweite Suche mit erweiterter Query
  if (queryRefinerEnabled && shouldRefineQuery(results, recallMinScore)) {
    const refinedQueryText = refineQuery(query, results);
    logger?.info?.(`recall-pipeline: query refinement triggered "${query}" → "${refinedQueryText}"`);
    try {
      const refinedEmbed = typeof embeddings.embedQuery === "function"
        ? await embeddings.embedQuery(refinedQueryText)
        : await embeddings.embed(refinedQueryText);
      const refinedRows = await dbTable.vectorSearch(refinedEmbed).limit(fetchLimit).toArray();
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
          agentId: r.agentId || "",
          workspaceId: r.workspaceId || "",
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
    } catch (e) {
      logger?.warn?.(`recall-pipeline: query refinement failed, keeping original results: ${String(e)}`);
    }
  }

  // 2.5 Temporal Reasoning — wenn der Query einen Zeit-Anchor enthält, vor dem
  // Boost/Rerank filtern, damit weniger Kandidaten die teuren Schritte durchlaufen.
  const temporal = parseTemporal(query);
  if (temporal && results.length > 0) {
    if (temporal.type === "anchor") {
      try {
        const resolved = await temporalRangeFromAnchor(temporal.referenceQuery, dbTable, embeddings);
        if (resolved) {
          const before = results.length;
          results = applyTemporalFilter(results, resolved);
          logger?.info?.(`recall-pipeline: temporal anchor "${temporal.referenceQuery}" resolved to range (${before} → ${results.length})`);
        }
      } catch (e) {
        logger?.warn?.(`recall-pipeline: temporal anchor resolution failed: ${String(e)}`);
      }
    } else {
      const before = results.length;
      results = applyTemporalFilter(results, temporal);
      if (before !== results.length) {
        logger?.info?.(`recall-pipeline: temporal filter applied (${before} → ${results.length})`);
      }
    }
  }

  // 3. Canonical-First parallel zur Vektorsuche aufrufen wäre möglich, aber
  // beide brauchen das vector-embedding zuerst. Sequentiell ist OK.
  let canonicalHits = [];
  if (canonicalEnabled && workspaceDir) {
    try {
      canonicalHits = await searchCanonical(workspaceDir, vector, embeddings, canonicalMinScore, canonicalMaxItems, logger);
    } catch (e) {
      logger?.warn?.(`recall-pipeline: canonical search failed: ${String(e)}`);
    }
  }

  // 4. Single-Pass-Scoring: Importance-, Emotional- und Strength-Boost sind
  // alle multiplikativ — in EINEM map + EINEM sort kombinieren statt drei
  // separate map+sort-Durchläufe (das Endergebnis ist identisch, da nur der
  // finale Sort die Reihenfolge bestimmt).
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
  }

    // 4.5 Statusfilter — Vector-Results bereits gefiltert, hier nur expliziter Check
  // (sicherstellen, dass keine superseded/tombstoned durchgerutscht sind)
  boosted = boosted.filter(r => !r.entry.status || r.entry.status === "active");

  // 4.6 Assoziativer Spread (Memory-Graph)
  let graphMetricsData = null;
  if (associativeEnabled && graphEdges.length > 0 && boosted.length > 0) {
    try {
      const graphStart = Date.now();
      const { adjacency } = readGraph(graphEdges);
      const associative = traverseGraph(boosted, adjacency, graphConfig);
      const metrics = createGraphMetrics();
      metrics.computeDegreeStats(adjacency);
      metrics.traversalVisitedNodes = associative.length;
      metrics.associativeResultsAdded = associative.length;
      metrics.recallLatencyMs = Date.now() - graphStart;
      boosted = mergeAssociativeResults(boosted, associative, Math.max(topN * 3, 20));
      logger?.info?.(`recall-pipeline: associative spread added ${associative.length} memories in ${metrics.recallLatencyMs}ms`);
      graphMetricsData = metrics;
    } catch (e) {
      logger?.warn?.(`recall-pipeline: associative spread failed: ${String(e)}`);
    }
  }

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
  boosted = await hydrateGraphResults(dbTable, boosted, logger, {
    queryVector: vector,
    embeddings,
    graphConfig,
  });

  // 4.8 Recall budget — enforce tier caps before final dedup/rerank.
  // Canonical items are kept separate; episodic/associative share the remaining slots.
  if (budget > 0 && boosted.length > 0) {
    const budgetResult = applyRecallBudget(boosted, { canonical: canonicalHits, budget });
    boosted = budgetResult.selected;
  }

  // 5. Provider-aware Rerank (optional) — mit Timeout und Fallback-Kontrolle
  let ordered = boosted;
  if (reranker && boosted.length > 1) {
    try {
      const docs = boosted.map(r => r.entry.summary || generateSummary(r.entry.text, summaryMaxWords));
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
      ordered = reranked.map(r => boosted[r.index]);
    } catch (e) {
      if (rerankerFallbackOnError) {
        logger?.warn?.(`recall-pipeline: rerank failed/timeout, falling back to unreranked: ${String(e)}`);
        ordered = boosted.slice(0, topN);
      } else {
        throw e;
      }
    }
  }

  // 6. Inter-Result-Dedup (Slot-Aufteilung: canonical priorisiert)
  const remainingSlots = Math.max(0, topN - canonicalHits.length);
  ordered = dedupEnabled
    ? dedupResults(ordered, remainingSlots, dedupJaccard)
    : ordered.slice(0, remainingSlots);

  // 6.5 ACL-Filter — nur erlaubte Memories an den Agent zurückgeben
  if (agentId) {
    const beforeAcl = ordered.length;
    ordered = ordered.filter(r => {
      const acl = checkAccess({ agentId, workspaceId }, r.entry);
      if (!acl.allowed) {
        logger?.info?.(`recall-pipeline: ACL denied for memory ${r.entry.id}: ${acl.reason}`);
      }
      return acl.allowed;
    });
    if (beforeAcl !== ordered.length) {
      logger?.info?.(`recall-pipeline: ACL filter removed ${beforeAcl - ordered.length} memories`);
    }
  }

  // 7. Retrieval-Ledger — nach finaler Selektion loggen
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

  return { queryVector: vector, canonical: canonicalHits, memories: ordered };
}

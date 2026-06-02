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

import { distanceToScore } from "./score.js";
import { jaccardSimilarity, cosineSimilarityVec, generateSummary } from "./text-utils.js";
import { deserializeEmotionalValence } from "./emotion.js";
import { readGraph, traverseGraph, mergeAssociativeResults, createGraphMetrics } from "./memory-graph.js";

// ─── Importance-Boost ──────────────────────────────────────────────────────

/**
 * Re-sortiert Results nach `score * (1 + importance * boost)`.
 * Bei boost=0 (oder leerer results) → unverändert.
 */
export function applyImportanceBoost(results, boost) {
  if (!boost || boost <= 0) return results;
  const boosted = results.map(r => ({
    ...r,
    score: r.score * (1 + (r.entry.importance ?? 0.5) * boost),
  }));
  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}

// ─── Inter-Result-Dedup ────────────────────────────────────────────────────

/**
 * Behält nur die ersten Results bis maxOut, suppimiert nahe Duplikate via
 * Jaccard auf summary/text. Erste in Liste = beste, wird behalten.
 */
export function dedupResults(results, maxOut, jaccardThreshold = 0.6) {
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

function readKnowledgeCache(workspaceDir) {
  try {
    const p = join(workspaceDir, ".adaptive-learning", KNOWLEDGE_CACHE_FILE);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  } catch (_) {}
  return null;
}

function writeKnowledgeCache(workspaceDir, cache) {
  try {
    const dir = join(workspaceDir, ".adaptive-learning");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const p = join(dir, KNOWLEDGE_CACHE_FILE);
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(cache), "utf8");
    renameSync(tmp, p);
  } catch (_) {}
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

  const cache = readKnowledgeCache(workspaceDir);
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
  writeKnowledgeCache(workspaceDir, { mtime, chunks });
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
 * @param {number} opts.dedupJaccard — Dedup-Schwelle (default 0.6)
 * @param {boolean} opts.canonicalEnabled — KNOWLEDGE.md-Lookup (default true)
 * @param {number} opts.canonicalMinScore — Schwelle für canonical (default 0.30)
 * @param {number} opts.canonicalMaxItems — max canonical items (default 2)
 * @param {Object} opts.reranker — optional Reranker mit .rerank(query, docs, topN)
 * @param {number} opts.rerankCandidates — wie viele Vektor-Kandidaten an Reranker (default 20)
 * @param {number} opts.summaryMaxWords — für generateSummary fallback (default 150)
 * @param {Object} opts.logger — { warn(msg), info(msg) }
 * @param {Object} opts.emotionalState — optional EmotionalState-Instanz für stimmungsabhängigen Recall
 * @param {string} opts.workspaceKey — Workspace-Key für Retrieval-Ledger
 * @param {string} opts.agentId — Agent-ID für Retrieval-Ledger
 * @param {Function} opts.retrievalLogger — Callback(entry) für Retrieval-Ledger-Einträge
 * @returns {{queryVector: number[], canonical: Array, memories: Array}}
 */
export async function runRecallPipeline({
  query,
  dbTable,
  embeddings,
  workspaceDir = null,
  topN = 5,
  recallMinScore = 0.15,
  importanceBoost = 0.3,
  dedupEnabled = true,
  dedupJaccard = 0.6,
  canonicalEnabled = true,
  canonicalMinScore = 0.30,
  canonicalMaxItems = 2,
  reranker = null,
  rerankCandidates = 20,
  summaryMaxWords = 150,
  logger = console,
  querySummarizer = null,
  emotionalState = null,
  graphEdges = [],
  associativeEnabled = true,
  graphConfig = {},
  workspaceKey = null,
  agentId = null,
  retrievalLogger = null,
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
  const results = rows.map(r => ({
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
  })).filter(r => r.score >= recallMinScore);

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

  // 4. Importance-Boost auf vector results
  let boosted = applyImportanceBoost(results, importanceBoost);

  // 4.5 Emotional Boost (stimmungsabhängiger Recall)
  if (emotionalState && boosted.length > 0) {
    boosted = boosted.map((r) => {
      const rawValence = r.entry.emotionalValence;
      const valence = typeof rawValence === "string"
        ? deserializeEmotionalValence(rawValence)
        : rawValence;
      const boost = emotionalState.computeRecallBoost(valence, r.entry.importance);
      return { ...r, score: r.score * boost };
    });
    boosted.sort((a, b) => b.score - a.score);
  }

  // 4.55 Memory Strength Boost — softened factor (0.65 + 0.35 * strength)
  if (boosted.length > 0) {
    boosted = boosted.map((r) => ({
      ...r,
      score: r.score * (0.65 + 0.35 * (r.entry.memoryStrength ?? 1.0)),
    }));
    boosted.sort((a, b) => b.score - a.score);
  }

  // 4.6 Assoziativer Spread (Memory-Graph)
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
    } catch (e) {
      logger?.warn?.(`recall-pipeline: associative spread failed: ${String(e)}`);
    }
  }

  // 5. Provider-aware Rerank (optional)
  let ordered = boosted;
  if (reranker && boosted.length > 1) {
    try {
      const docs = boosted.map(r => r.entry.summary || generateSummary(r.entry.text, summaryMaxWords));
      const reranked = await reranker.rerank(query, docs, Math.max(topN, dedupEnabled ? topN * 2 : topN));
      ordered = reranked.map(r => boosted[r.index]);
    } catch (e) {
      logger?.warn?.(`recall-pipeline: rerank failed, falling back: ${String(e)}`);
      ordered = boosted.slice(0, topN);
    }
  }

  // 6. Inter-Result-Dedup (Slot-Aufteilung: canonical priorisiert)
  const remainingSlots = Math.max(0, topN - canonicalHits.length);
  ordered = dedupEnabled
    ? dedupResults(ordered, remainingSlots, dedupJaccard)
    : ordered.slice(0, remainingSlots);

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

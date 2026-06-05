/**
 * lib/memory-graph.js — Graph-Engine für assoziative Memory-Verknüpfung.
 *
 * Hybrid-Ansatz: Neo-Store JSONL für Persistenz + LanceDB für
 * semantische Candidate-Generierung. Beam-Search-Traversierung mit
 * adaptiver Tiefe, Zyklen-Schutz und Debug-Metrics.
 */

import { distanceToScore } from "./score.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Edge-Schema & Kanonische IDs ───────────────────────────────────────────

export function canonicalEdgeKey(source, target, type, directed = false) {
  if (directed) return `${source}:${target}:${type}`;
  const [a, b] = [source, target].sort();
  return `${a}:${b}:${type}`;
}

export function createEdge(source, target, type, strength, directed = false) {
  const now = new Date().toISOString();
  const [sortedSource, sortedTarget] = directed
    ? [source, target]
    : [source, target].sort();
  return {
    source: sortedSource,
    target: sortedTarget,
    type,
    strength: clamp01(strength),
    directed,
    createdAt: now,
    updatedAt: now,
    lastReinforcedAt: now,
    observations: 1,
    algorithmVersion: "1.0",
  };
}

// ─── Strength-Berechnung ───────────────────────────────────────────────────

export function semanticStrength(similarity) {
  return clamp((similarity - 0.78) / (0.95 - 0.78), 0, 1) * 0.9;
}

export function temporalStrength(deltaMinutes) {
  return Math.exp(-deltaMinutes / 15) * 0.7;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ─── Graph-Lesen & Deduplizierung ──────────────────────────────────────────

export function readGraph(edgeRecords) {
  const byKey = new Map();
  for (const edge of edgeRecords) {
    if (!edge || !edge.source || !edge.target) continue;
    const key = canonicalEdgeKey(edge.source, edge.target, edge.type, edge.directed);
    const existing = byKey.get(key);
    if (!existing || edge.strength > existing.strength) {
      byKey.set(key, {
        ...edge,
        observations: (existing?.observations || 0) + (edge.observations || 1),
        updatedAt: new Date().toISOString(),
      });
    } else {
      existing.observations += (edge.observations || 1);
      existing.updatedAt = new Date().toISOString();
    }
  }

  const edges = Array.from(byKey.values());
  const adjacency = new Map();

  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
    adjacency.get(edge.source).push(edge);
    if (!edge.directed) {
      adjacency.get(edge.target).push({ ...edge, source: edge.target, target: edge.source });
    }
  }

  return { edges, adjacency };
}

// ─── Beam-Search Traversierung ─────────────────────────────────────────────

export const DEFAULT_TRAVERSAL_CONFIG = {
  seedCount: 5,
  maxDepth: 3,
  maxNeighborsPerNode: 8,
  minCumulativeRelevance: 0.2,
  maxVisitedNodes: 150,
  maxAssociatedResults: 40,
};

export function traverseGraph(seedMemories, adjacency, config = {}) {
  const cfg = { ...DEFAULT_TRAVERSAL_CONFIG, ...config };
  const visited = new Set();
  const results = new Map();
  const queue = [];

  // Seed initialisieren
  for (let i = 0; i < Math.min(seedMemories.length, cfg.seedCount); i++) {
    const seed = seedMemories[i];
    const seedId = seed.entry?.id || seed.id;
    if (!seedId) continue;
    queue.push({
      memoryId: seedId,
      score: seed.score || 0.5,
      cumulativeRelevance: 1.0,
      depth: 0,
      path: [seedId],
    });
  }

  // Priority Queue (einfache Sortierung nach score DESC)
  while (
    queue.length > 0 &&
    visited.size < cfg.maxVisitedNodes &&
    results.size < cfg.maxAssociatedResults
  ) {
    queue.sort((a, b) => b.score - a.score);
    const current = queue.shift();
    if (visited.has(current.memoryId)) continue;
    visited.add(current.memoryId);

    if (current.depth > 0) {
      const depthPenalty = 1 / (1 + current.depth * 0.25);
      const pathStrength = current.cumulativeRelevance;
      const associatedScore = (current.score || 0.5) * pathStrength * depthPenalty;
      results.set(current.memoryId, {
        memoryId: current.memoryId,
        associatedScore,
        depth: current.depth,
        path: current.path,
      });
    }

    if (current.depth >= cfg.maxDepth) continue;
    const neighbors = adjacency.get(current.memoryId) || [];
    const sorted = neighbors.sort((a, b) => (b.strength || 0) - (a.strength || 0));
    const selected = sorted.slice(0, cfg.maxNeighborsPerNode);

    for (const edge of selected) {
      const nextId = edge.target;
      if (visited.has(nextId)) continue;
      const nextCumulative = current.cumulativeRelevance * (edge.strength || 0.1);
      if (nextCumulative < cfg.minCumulativeRelevance) continue;
      queue.push({
        memoryId: nextId,
        score: current.score,
        cumulativeRelevance: nextCumulative,
        depth: current.depth + 1,
        path: [...current.path, nextId],
      });
    }
  }

  return Array.from(results.values());
}

// ─── Score-Merging für Recall ──────────────────────────────────────────────

export function mergeAssociativeResults(originalResults, associativeResults, maxTotal = 15) {
  const byId = new Map();
  for (const r of originalResults) {
    byId.set(r.entry?.id || r.id, { ...r, source: "vector" });
  }
  for (const assoc of associativeResults) {
    const id = assoc.memoryId;
    const existing = byId.get(id);
    if (existing) {
      const assocScore = assoc.associatedScore;
      existing.score = Math.max(existing.score, 0.6 * existing.score + 0.4 * assocScore);
      existing.source = "both";
    } else {
      byId.set(id, {
        entry: { id: assoc.memoryId },
        score: assoc.associatedScore * 0.85,
        source: "graph",
        depth: assoc.depth,
      });
    }
  }
  const merged = Array.from(byId.values());
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, maxTotal);
}

// ─── Graph-Signal Extraktion ───────────────────────────────────────────────

const STOPWORDS_DE = new Set([
  "der", "die", "das", "den", "dem", "ein", "eine", "einer", "einem", "einen",
  "ich", "du", "er", "sie", "es", "wir", "ihr", "sie", "mich", "dich", "ihn",
  "und", "oder", "aber", "denn", "weil", "wenn", "dass", "mit", "für", "von",
  "zu", "auf", "in", "an", "bei", "nach", "aus", "über", "unter", "vor",
  "hinter", "neben", "zwischen", "durch", "gegen", "ohne", "um", "bis",
  "ist", "sind", "war", "waren", "wird", "werden", "wurde", "wurden",
  "habe", "hat", "hatten", "hatte", "kann", "können", "konnte", "konnten",
  "muss", "müssen", "musste", "mussten", "will", "wollen", "wollte",
  "soll", "sollen", "sollte", "sollten", "darf", "dürfen", "durfte",
  "mag", "mögen", "mochte", "this", "that", "the", "a", "an", "is", "are",
  "was", "were", "be", "been", "being", "have", "has", "had", "do", "does",
  "did", "will", "would", "could", "should", "may", "might", "must",
  "can", "shall", "am", "it", "he", "she", "we", "they", "you", "me",
  "him", "her", "us", "them", "my", "your", "his", "her", "its", "our",
  "their", "and", "or", "but", "if", "then", "else", "when", "where",
  "why", "how", "what", "who", "which", "whose", "whom",
]);

const STOPWORDS_EN = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "can", "shall", "it", "he", "she",
  "we", "they", "you", "me", "him", "her", "us", "them",
]);

/**
 * Extrahiert Graph-Signale (topics, entities, people, projects) aus Text.
 * Minimal ohne LLM — regex-basiert, schnell, deterministisch.
 */
export function extractGraphSignals(text, opts = {}) {
  const { category, sourceUrl, role } = opts;
  const lower = String(text || "").toLowerCase();
  const words = text.split(/\s+/);

  // Topics: Capitalized sequences (potential nouns/names)
  const topicMatches = text.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\b/g) || [];
  const topics = [...new Set(
    topicMatches
      .map(t => t.toLowerCase())
      .filter(t => t.length > 2 && !STOPWORDS_DE.has(t) && !STOPWORDS_EN.has(t))
  )].slice(0, 10);

  // Entities: same as topics but keep original case for proper names
  const entities = [...new Set(
    topicMatches
      .filter(t => t.length > 2 && !STOPWORDS_DE.has(t.toLowerCase()) && !STOPWORDS_EN.has(t.toLowerCase()))
  )].slice(0, 8);

  // People: Names with 2+ capitalized words (first + last name pattern)
  const peopleMatches = text.match(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g) || [];
  const people = [...new Set(peopleMatches)].slice(0, 5);

  // Projects: Pattern "Projekt X", "Project Y", "Task Z", etc.
  const projectMatches = text.match(/\b(?:Projekt|Project|Task|Aufgabe|Issue|Ticket)\s+[A-Z]?[a-zA-Z0-9_-]+\b/gi) || [];
  const projects = [...new Set(projectMatches.map(p => p.toLowerCase()))].slice(0, 5);

  return {
    topics,
    entities,
    people,
    projects,
  };
}

// ─── Concurrency helper (no external dependency) ───────────────────────────

async function runWithConcurrency(tasks, maxConcurrent = 3) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: maxConcurrent }, worker));
  return results;
}

// ─── Edge-Generierung für Session ──────────────────────────────────────────

export async function buildEdgesForSession(newMemories, existingMemories, dbTable, logger) {
  const edges = [];

  // P2.1: Bounded concurrency for semantic vector searches
  const semanticTasks = [];
  for (const mem of newMemories) {
    const memId = mem.id;
    const memVector = mem.vector;
    if (memVector && dbTable) {
      semanticTasks.push(async () => {
        try {
          const results = await dbTable.vectorSearch(memVector).limit(20).toArray();
          const batchEdges = [];
          for (const row of results) {
            const similarity = distanceToScore(row._distance);
            if (similarity >= 0.78 && row.id !== memId) {
              batchEdges.push(createEdge(memId, row.id, "semantic", semanticStrength(similarity), false));
            }
          }
          return batchEdges;
        } catch (err) {
          if (logger) {
            const { safeWarn } = await import("./safe-logging.js");
            safeWarn(logger, "buildEdgesForSession.vectorSearch", err, { memId });
          }
          return [];
        }
      });
    }
  }
  const semanticEdgeBatches = await runWithConcurrency(semanticTasks, 3);
  for (const batch of semanticEdgeBatches) edges.push(...batch);

  // P2.2: Index-based entity/emotional edges
  // Build indices once for O(1) lookup
  const topicIndex = new Map(); // topic -> [memories]
  const emotionIndex = new Map(); // emotionalDominant -> [memories]
  for (const other of existingMemories || []) {
    const topics = other.topics || other.entities || [];
    for (const t of topics) {
      if (!topicIndex.has(t)) topicIndex.set(t, []);
      topicIndex.get(t).push(other);
    }
    if (other.emotionalDominant) {
      if (!emotionIndex.has(other.emotionalDominant)) emotionIndex.set(other.emotionalDominant, []);
      emotionIndex.get(other.emotionalDominant).push(other);
    }
  }

  for (const mem of newMemories) {
    const memId = mem.id;
    const memTime = new Date(mem.createdAt).getTime();

    // Temporal: connect to last 5–10 memories in same session
    const sameSession = (existingMemories || [])
      .filter(m => m.sessionId === mem.sessionId && m.id !== memId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 10);
    for (const other of sameSession) {
      const deltaMinutes = Math.abs(memTime - new Date(other.createdAt).getTime()) / 60000;
      if (deltaMinutes < 30) {
        edges.push(createEdge(other.id, memId, "temporal", temporalStrength(deltaMinutes), true));
      }
    }

    // Entity: shared topics/entities via index (O(K) instead of O(M))
    const memTopics = new Set(mem.topics || mem.entities || []);
    const candidateSet = new Map(); // otherId -> { other, overlapCount }
    for (const t of memTopics) {
      for (const other of topicIndex.get(t) || []) {
        if (other.id === memId) continue;
        candidateSet.set(other.id, { other, overlap: (candidateSet.get(other.id)?.overlap || 0) + 1 });
      }
    }
    for (const { other, overlap } of candidateSet.values()) {
      const otherTopics = new Set(other.topics || other.entities || []);
      const union = new Set([...memTopics, ...otherTopics]).size;
      if (union > 0 && overlap / union > 0.3) {
        edges.push(createEdge(memId, other.id, "entity", (overlap / union) * 0.8, false));
      }
    }

    // Emotional: same dominant emotion via index (O(K) instead of O(M))
    if (mem.emotionalDominant) {
      for (const other of emotionIndex.get(mem.emotionalDominant) || []) {
        if (other.id === memId) continue;
        const intensityMatch = 1 - Math.abs((mem.emotionalIntensity || 0.5) - (other.emotionalIntensity || 0.5));
        edges.push(createEdge(memId, other.id, "emotional", intensityMatch * 0.6, false));
      }
    }
  }

  return edges;
}

// ─── Episode-Anchor Edges ──────────────────────────────────────────────────

export function buildEpisodeAnchorEdges(episodes, memoryIdsInEpisode) {
  const edges = [];
  for (const episode of episodes) {
    const anchorId = `episode-${episode.id}`;
    for (const memId of memoryIdsInEpisode) {
      edges.push(createEdge(memId, anchorId, "episode", (episode.vividness || 0.5) * 0.85, false));
    }
  }
  return edges;
}

// ─── Pruning & Compaction ──────────────────────────────────────────────────

export function shouldPrune(edge) {
  const ageDays = (Date.now() - new Date(edge.createdAt).getTime()) / (1000 * 60 * 60 * 24);
  const lastReinforcedDays = edge.lastReinforcedAt
    ? (Date.now() - new Date(edge.lastReinforcedAt).getTime()) / (1000 * 60 * 60 * 24)
    : ageDays;
  return (
    edge.strength < 0.2 &&
    (edge.observations || 1) <= 1 &&
    edge.type !== "episode" &&
    ageDays > 60 &&
    lastReinforcedDays > 60
  );
}

export function compactGraph(edgeRecords) {
  const { edges } = readGraph(edgeRecords);
  const kept = edges.filter(e => !shouldPrune(e));
  return kept;
}

// ─── Debug Metrics ─────────────────────────────────────────────────────────

export function createGraphMetrics() {
  return {
    edgesCreatedPerSession: 0,
    edgesByType: { semantic: 0, temporal: 0, entity: 0, emotional: 0, episode: 0 },
    avgDegree: 0,
    maxDegree: 0,
    prunedEdges: 0,
    traversalVisitedNodes: 0,
    associativeResultsAdded: 0,
    recallLatencyMs: 0,
    topEdgeTypesUsedInRecall: [],
    record(type, count = 1) {
      this.edgesCreatedPerSession += count;
      if (this.edgesByType[type] !== undefined) this.edgesByType[type] += count;
    },
    computeDegreeStats(adjacency) {
      const degrees = Array.from(adjacency.values()).map(edges => edges.length);
      if (degrees.length === 0) return { avg: 0, max: 0 };
      this.avgDegree = degrees.reduce((a, b) => a + b, 0) / degrees.length;
      this.maxDegree = Math.max(...degrees);
      return { avg: this.avgDegree, max: this.maxDegree };
    },
  };
}

// ─── Vault-Ausgabe (Obsidian) ──────────────────────────────────────────────

export function writeGraphConstellationReport(graphEdges, workspaceDir) {
  const { edges, adjacency } = readGraph(graphEdges);
  if (edges.length === 0) return null;

  const topEdges = edges
    .filter(e => e.type !== "episode")
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 50);

  const mermaidLines = ["graph TD"];
  const nodeIds = new Set();
  for (const edge of topEdges) {
    const safeSource = edge.source.replace(/[^a-zA-Z0-9]/g, "_");
    const safeTarget = edge.target.replace(/[^a-zA-Z0-9]/g, "_");
    nodeIds.add(safeSource);
    nodeIds.add(safeTarget);
    const lineStyle = edge.strength > 0.7 ? "==>" : edge.strength > 0.4 ? "-->" : "-.->";
    mermaidLines.push(`  ${safeSource}${lineStyle}|${edge.strength.toFixed(2)}|${safeTarget}`);
  }

  const stats = {
    totalEdges: edges.length,
    byType: Object.fromEntries(
      ["semantic", "temporal", "entity", "emotional", "episode"].map(t => [
        t,
        edges.filter(e => e.type === t).length,
      ])
    ),
    avgStrength: edges.reduce((a, e) => a + e.strength, 0) / edges.length,
    topHubs: Array.from(adjacency.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 10)
      .map(([id, edges]) => ({ id, degree: edges.length })),
  };

  const content = [
    "---",
    `date: ${new Date().toISOString().split("T")[0]}`,
    `total_edges: ${stats.totalEdges}`,
    `avg_strength: ${stats.avgStrength.toFixed(3)}`,
    "---",
    "",
    "# Memory Constellation",
    "",
    "## Top Connections",
    "",
    "```mermaid",
    ...mermaidLines,
    "```",
    "",
    "## Statistics",
    "",
    "| Type | Count |",
    "|------|-------|",
    ...Object.entries(stats.byType).map(([t, c]) => `| ${t} | ${c} |`),
    "",
    "## Top Hub Memories",
    "",
    ...stats.topHubs.map(h => `- ${h.id}: degree ${h.degree}`),
  ].join("\n");

  const now = new Date();
  const monthDir = join(
    workspaceDir,
    "memory",
    "graph",
    now.getFullYear().toString(),
    String(now.getMonth() + 1).padStart(2, "0")
  );
  mkdirSync(monthDir, { recursive: true });
  const path = join(monthDir, `constellation-${now.toISOString().split("T")[0]}.md`);
  writeFileSync(path, content, "utf8");
  return path;
}

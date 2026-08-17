/**
 * lib/memory-graph.js — Graph-Engine für assoziative Memory-Verknüpfung.
 *
 * Hybrid-Ansatz: Neo-Store JSONL für Persistenz + LanceDB für
 * semantische Candidate-Generierung. Beam-Search-Traversierung mit
 * adaptiver Tiefe, Zyklen-Schutz und Debug-Metrics.
 */

import { distanceToScore } from "./score.js";
import { withTimeout } from "./with-timeout.js";
import { addTraceCandidate, addTraceDecision, addTraceGuard } from "./recall-decision-trace.js";
import { checkAccess, validateOwnershipTuple } from "./acl-middleware.js";
import { normalizeEpistemicStatus } from "./epistemic-status.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Edge-Schema & Kanonische IDs ───────────────────────────────────────────

export function canonicalEdgeKey(source, target, type, directed = false) {
  if (directed) return `${source}:${target}:${type}`;
  const [a, b] = [source, target].sort();
  return `${a}:${b}:${type}`;
}

const GRAPH_OWNERSHIP_SCHEMA_VERSION = 1;
const GRAPH_SCOPES = new Set(["agent-private", "workspace", "user"]);
const INACTIVE_GRAPH_STATUSES = new Set(["superseded", "archived", "deleted", "tombstoned"]);
const EMPTY_WORKSPACE_ALIASES = Object.freeze({
  paths: Object.freeze([]),
  aliases: Object.freeze([]),
});

function hasCanonicalGraphRequestContext(requestContext) {
  return Boolean(
    requestContext
    && typeof requestContext === "object"
    && typeof requestContext.agentId === "string"
    && requestContext.agentId.trim()
    && requestContext.workspaceAliases
    && Array.isArray(requestContext.workspaceAliases.paths)
    && Array.isArray(requestContext.workspaceAliases.aliases),
  );
}

function canonicalTupleForBindings(scope, bindings) {
  return Object.freeze({
    schemaVersion: GRAPH_OWNERSHIP_SCHEMA_VERSION,
    scope,
    agentId: bindings.agentId || "",
    workspaceIdentity: bindings.workspaceIdentity || "",
    ownerUserId: bindings.ownerUserId || "",
  });
}

/**
 * Resolve the exact canonical ownership tuple persisted with a graph endpoint.
 *
 * @param {Object} memory Persisted memory row or recall entry.
 * @param {Object} [workspaceAliases] Trusted workspace alias snapshot.
 * @returns {Object|null} Canonical graph ownership tuple, or null when invalid.
 */
export function canonicalGraphOwnership(memory, workspaceAliases = EMPTY_WORKSPACE_ALIASES) {
  if (!memory || typeof memory !== "object") return null;
  const scope = memory.scope || "agent-private";
  if (!GRAPH_SCOPES.has(scope)) return null;

  const ownership = validateOwnershipTuple(memory, workspaceAliases);
  if (!ownership.ok) return null;
  const { bindings } = ownership;
  if (scope === "agent-private" && !bindings.agentId) return null;
  if (scope === "workspace" && !bindings.workspaceIdentity) return null;
  if (scope === "user" && !bindings.ownerUserId) return null;
  return canonicalTupleForBindings(scope, bindings);
}

function memoryFromGraphOwnership(id, ownership) {
  return {
    id,
    scope: ownership.scope,
    agentId: ownership.agentId,
    storedBy: ownership.agentId,
    workspaceId: ownership.workspaceIdentity,
    workspaceKey: ownership.workspaceIdentity,
    ownerUserId: ownership.ownerUserId,
  };
}

function normalizeSerializedGraphOwnership(ownership) {
  if (!ownership || typeof ownership !== "object") return null;
  if (ownership.schemaVersion !== GRAPH_OWNERSHIP_SCHEMA_VERSION) return null;
  const normalized = canonicalGraphOwnership(
    memoryFromGraphOwnership("graph-endpoint", ownership),
    EMPTY_WORKSPACE_ALIASES,
  );
  if (!normalized) return null;
  if (
    normalized.scope !== ownership.scope
    || normalized.agentId !== (ownership.agentId || "")
    || normalized.workspaceIdentity !== (ownership.workspaceIdentity || "")
    || normalized.ownerUserId !== (ownership.ownerUserId || "")
  ) return null;
  return normalized;
}

function sameGraphOwnership(left, right) {
  return Boolean(
    left
    && right
    && left.schemaVersion === right.schemaVersion
    && left.scope === right.scope
    && left.agentId === right.agentId
    && left.workspaceIdentity === right.workspaceIdentity
    && left.ownerUserId === right.ownerUserId,
  );
}

/**
 * Returns whether an edge contains a complete, schema-valid ownership tuple for
 * both endpoints. Legacy ID-only edges are deliberately not trusted.
 *
 * @param {Object} edge Persisted or newly-created graph edge.
 * @returns {boolean} Whether both endpoint bindings are trustworthy.
 */
export function isBoundGraphEdge(edge) {
  if (!edge || typeof edge !== "object" || edge.needsRebuild === true) return false;
  if (edge.source == null || edge.target == null || String(edge.source).trim() === "" || String(edge.target).trim() === "") return false;
  if (edge.ownershipStatus !== "bound") return false;
  const source = normalizeSerializedGraphOwnership(edge.sourceOwnership);
  const target = normalizeSerializedGraphOwnership(edge.targetOwnership);
  if (!source || !target || !edge.ownership || typeof edge.ownership !== "object") return false;
  if (!sameGraphOwnership(source, normalizeSerializedGraphOwnership(edge.ownership.source))) return false;
  if (!sameGraphOwnership(target, normalizeSerializedGraphOwnership(edge.ownership.target))) return false;
  return true;
}

/**
 * Filter graph edges to the canonical requester's authorized endpoint scope.
 * This performs no hydration; CRR must reauthorize the actual hydrated rows.
 *
 * @param {Array} graphEdges Candidate graph edges.
 * @param {Object|null} requestContext Canonical memory request context.
 * @returns {Array} Edges whose serialized endpoints are authorized.
 */
export function filterGraphEdgesForRequest(graphEdges, requestContext) {
  if (!hasCanonicalGraphRequestContext(requestContext) || !Array.isArray(graphEdges)) return [];
  const allowed = [];
  for (const edge of graphEdges) {
    if (!isBoundGraphEdge(edge)) continue;
    const sourceOwnership = normalizeSerializedGraphOwnership(edge.sourceOwnership);
    const targetOwnership = normalizeSerializedGraphOwnership(edge.targetOwnership);
    if (!sourceOwnership || !targetOwnership) continue;
    const sourceAccess = checkAccess(
      requestContext,
      memoryFromGraphOwnership(edge.source, sourceOwnership),
    );
    const targetAccess = checkAccess(
      requestContext,
      memoryFromGraphOwnership(edge.target, targetOwnership),
    );
    if (sourceAccess.allowed && targetAccess.allowed) {
      allowed.push({
        ...edge,
        sourceOwnership,
        targetOwnership,
        ownership: { source: sourceOwnership, target: targetOwnership },
        ownershipStatus: "bound",
        needsRebuild: false,
      });
    }
  }
  return allowed;
}

/**
 * Returns whether a graph candidate is live at the supplied system-time instant.
 *
 * @param {Object} memory Persisted memory row or recall entry.
 * @param {number} [now=Date.now()] System-time instant.
 * @returns {boolean} Whether lifecycle gates permit graph use.
 */
export function isGraphMemoryLive(memory, now = Date.now()) {
  if (!memory || typeof memory !== "object") return false;
  const status = memory.status ?? memory.plur1bus_status;
  if (status != null && INACTIVE_GRAPH_STATUSES.has(String(status))) return false;
  if (status != null && status !== "active") return false;
  if (normalizeEpistemicStatus(memory.epistemicStatus) === "invalidated") return false;

  const expiry = memory.expiresAt;
  if (expiry == null || expiry === 0 || expiry === 0n) return true;
  if (typeof expiry === "bigint") {
    return Number.isSafeInteger(now) && expiry > BigInt(now);
  }
  return typeof expiry === "number" && Number.isFinite(expiry) && expiry > now;
}

function prepareGraphEndpoint(memory, requestContext, now) {
  if (!isGraphMemoryLive(memory, now)) return null;
  const aliases = requestContext?.workspaceAliases || EMPTY_WORKSPACE_ALIASES;
  const ownership = canonicalGraphOwnership(memory, aliases);
  if (hasCanonicalGraphRequestContext(requestContext)) {
    if (!ownership || !checkAccess(requestContext, memory).allowed) return null;
    return { memory, ownership, trusted: true };
  }
  // Preserve the old function signature for callers that have not yet supplied
  // the canonical context, but make the resulting edge explicit rebuild work.
  // Protected rows are never accepted without a request context.
  if (ownership) return null;
  return { memory, ownership: null, trusted: false, needsRebuild: true };
}

function createPreparedEdge(source, target, type, strength, directed, requestContext) {
  if (!source || !target) return null;
  if (source.trusted && target.trusted) {
    return createEdge(source.memory.id, target.memory.id, type, strength, directed, {
      sourceOwnership: source.ownership,
      targetOwnership: target.ownership,
    });
  }
  if (!hasCanonicalGraphRequestContext(requestContext) && source.needsRebuild && target.needsRebuild) {
    return createEdge(source.memory.id, target.memory.id, type, strength, directed);
  }
  return null;
}

/**
 * Create a graph edge, preserving canonical ownership with its endpoint.
 *
 * @param {string} source Source endpoint ID.
 * @param {string} target Target endpoint ID.
 * @param {string} type Edge type.
 * @param {number} strength Raw edge strength.
 * @param {boolean} [directed=false] Whether endpoint order is meaningful.
 * @param {{sourceOwnership?: Object, targetOwnership?: Object}} [options] Canonical endpoint tuples.
 * @returns {Object} Graph edge, marked for rebuild when ownership is incomplete.
 */
export function createEdge(source, target, type, strength, directed = false, options = {}) {
  const now = new Date().toISOString();
  const edgeOptions = options && typeof options === "object" ? options : {};
  const endpoints = [
    { id: source, ownership: normalizeSerializedGraphOwnership(edgeOptions.sourceOwnership) },
    { id: target, ownership: normalizeSerializedGraphOwnership(edgeOptions.targetOwnership) },
  ];
  const orderedEndpoints = directed
    ? endpoints
    : endpoints.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const [sourceEndpoint, targetEndpoint] = orderedEndpoints;
  const bound = Boolean(sourceEndpoint.ownership && targetEndpoint.ownership);
  return {
    source: sourceEndpoint.id,
    target: targetEndpoint.id,
    type,
    strength: clamp01(strength),
    directed,
    sourceOwnership: bound ? sourceEndpoint.ownership : null,
    targetOwnership: bound ? targetEndpoint.ownership : null,
    ownership: bound
      ? { source: sourceEndpoint.ownership, target: targetEndpoint.ownership }
      : null,
    ownershipStatus: bound ? "bound" : "unbound",
    needsRebuild: !bound,
    visibility: bound && sourceEndpoint.ownership
      ? {
        scope: sourceEndpoint.ownership.scope || "agent_private",
        agentId: sourceEndpoint.ownership.agentId || "",
        workspaceIdentity: sourceEndpoint.ownership.workspaceIdentity || sourceEndpoint.ownership.workspaceId || "",
        ownerUserId: sourceEndpoint.ownership.ownerUserId || "",
      }
      : null,
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

const LANCEDB_READ_TIMEOUT_MS = 10_000;

const GRAPH_NO_ANCHOR_SCALE = 0.7;

// ─── Graph-Lesen & Deduplizierung ──────────────────────────────────────────

/**
 * Read and deduplicate graph edges, marking legacy records for rebuild.
 *
 * @param {Array} edgeRecords Persisted graph records.
 * @param {{requireBoundOwnership?: boolean}} [options] Strict ownership mode.
 * @returns {{edges: Array, adjacency: Map}} Deduplicated graph and adjacency.
 */
export function readGraph(edgeRecords, { requireBoundOwnership = false } = {}) {
  const byKey = new Map();
  for (const edge of Array.isArray(edgeRecords) ? edgeRecords : []) {
    if (!edge || !edge.source || !edge.target) continue;
    const bound = isBoundGraphEdge(edge);
    if (requireBoundOwnership && !bound) continue;
    const readableEdge = bound
      ? edge
      : {
        ...edge,
        sourceOwnership: null,
        targetOwnership: null,
        ownership: null,
        ownershipStatus: "unbound",
        needsRebuild: true,
      };
    const ownershipKey = bound
      ? [
        readableEdge.sourceOwnership.scope,
        readableEdge.sourceOwnership.agentId,
        readableEdge.sourceOwnership.workspaceIdentity,
        readableEdge.sourceOwnership.ownerUserId,
        readableEdge.targetOwnership.scope,
        readableEdge.targetOwnership.agentId,
        readableEdge.targetOwnership.workspaceIdentity,
        readableEdge.targetOwnership.ownerUserId,
      ].join("|")
      : "unbound";
    const key = `${canonicalEdgeKey(readableEdge.source, readableEdge.target, readableEdge.type, readableEdge.directed)}:${ownershipKey}`;
    const existing = byKey.get(key);
    if (!existing || readableEdge.strength > existing.strength) {
      byKey.set(key, {
        ...readableEdge,
        observations: (existing?.observations || 0) + (readableEdge.observations || 1),
        updatedAt: new Date().toISOString(),
      });
    } else {
      existing.observations += (readableEdge.observations || 1);
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
      adjacency.get(edge.target).push({
        ...edge,
        source: edge.target,
        target: edge.source,
        sourceOwnership: edge.targetOwnership,
        targetOwnership: edge.sourceOwnership,
        ownership: edge.ownership
          ? { source: edge.ownership.target, target: edge.ownership.source }
          : edge.ownership,
      });
    }
  }

  return { edges, adjacency };
}

/**
 * Read and deduplicate only ownership-bound graph edges.
 *
 * @param {Array} edgeRecords Persisted graph records.
 * @returns {{edges: Array, adjacency: Map}} Bound graph and adjacency.
 */
export function readBoundGraph(edgeRecords) {
  return readGraph(edgeRecords, { requireBoundOwnership: true });
}

// ─── Beam-Search Traversierung ─────────────────────────────────────────────

export const DEFAULT_TRAVERSAL_CONFIG = {
  seedCount: 5,
  maxDepth: 2,
  maxNeighborsPerNode: 8,
  minCumulativeRelevance: 0.2,
  depthRelevanceScale: 0.5,
  maxVisitedNodes: 150,
  maxAssociatedResults: 40,
};

export function traverseGraph(seedMemories, adjacency, config = {}, decisionTrace = null) {
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
      const depthPenalty = 1 / (1 + current.depth * 0.5);
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
      const depthScaledThreshold = cfg.minCumulativeRelevance * (1 + (current.depth + 1) * (cfg.depthRelevanceScale ?? 0));
      if (nextCumulative < depthScaledThreshold) continue;
      queue.push({
        memoryId: nextId,
        score: current.score,
        cumulativeRelevance: nextCumulative,
        depth: current.depth + 1,
        path: [...current.path, nextId],
      });
    }
  }

  if (decisionTrace) {
    addTraceGuard(decisionTrace, {
      name: "graph-traversal",
      passed: true,
      reason: `visited ${visited.size} nodes, returned ${results.size} associative results`,
    });
  }

  return Array.from(results.values());
}

// ─── Score-Merging für Recall ──────────────────────────────────────────────

/**
 * Merge vector results with associative/graph results.
 *
 * Invariants:
 * - H1-01: graph-only hits are capped below the best vector score, or scaled
 *   down by GRAPH_NO_ANCHOR_SCALE if no vector results exist.
 * - H1-02: memories present in both sets keep their vector score; only the
 *   source label changes to "both".
 *
 * @param {Array} originalResults — vector search results
 * @param {Array} associativeResults — graph traversal results
 * @param {number} [maxTotal=15] — maximum combined results to return
 * @returns {Array<{entry, score, source, depth?}>}
 */
export function mergeAssociativeResults(originalResults, associativeResults, maxTotal = 15, decisionTrace = null) {
  const byId = new Map();
  const maxVectorScore = originalResults.reduce(
    (max, r) => Math.max(max, r.score || 0),
    0,
  );

  for (const r of originalResults) {
    byId.set(r.entry?.id || r.id, { ...r, source: "vector" });
  }

  for (const assoc of associativeResults) {
    const id = assoc.memoryId;
    const existing = byId.get(id);
    if (existing) {
      // H1-02: graph overlap must not artificially inflate vector score.
      // The item is already recalled directly; keep its vector score.
      existing.source = "both";
      if (decisionTrace) {
        addTraceDecision(decisionTrace, {
          memoryId: id,
          action: "merged",
          stage: "associative-merge",
          reason: "graph overlap",
          finalScore: existing.score,
          scoreBreakdown: {
            vectorScore: existing.score,
            graphScore: assoc.associatedScore,
          },
        });
      }
    } else {
      // H1-01: graph-only hits compete in a separate lane.
      // Cap them below the best vector hit, or scale them down if there is no anchor.
      const rawGraphScore = assoc.associatedScore;
      const cappedGraphScore = maxVectorScore > 0
        ? Math.min(rawGraphScore, maxVectorScore * 0.85)
        : rawGraphScore * GRAPH_NO_ANCHOR_SCALE;
      byId.set(id, {
        entry: { id: assoc.memoryId },
        score: cappedGraphScore,
        source: "graph",
        depth: assoc.depth,
      });
      if (decisionTrace) {
        addTraceCandidate(decisionTrace, {
          id,
          source: "graph",
          score: cappedGraphScore,
          vectorScore: rawGraphScore,
          graphDepth: assoc.depth,
          summary: `graph-only via ${assoc.path?.[0] ?? "unknown"}`,
        });
        addTraceDecision(decisionTrace, {
          memoryId: id,
          action: "inclusion",
          stage: "associative-merge",
          reason: "weak-association",
          finalScore: cappedGraphScore,
          scoreBreakdown: {
            rawGraphScore,
            cappedGraphScore,
            maxVectorScore,
          },
        });
      }
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

function topicOverlap(aTopics = [], bTopics = []) {
  const a = new Set(aTopics.map(String).map(t => t.toLowerCase()));
  const b = new Set(bTopics.map(String).map(t => t.toLowerCase()));
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap++;
  return overlap;
}

/**
 * Build graph edges only from live, ACL-authorized endpoint rows.
 *
 * @param {Array} newMemories Newly captured memory rows.
 * @param {Array} existingMemories Candidate existing memory rows.
 * @param {Object|null} dbTable LanceDB table adapter.
 * @param {Object|null} logger Bounded diagnostic logger.
 * @param {{requestContext?: Object|null, now?: number}} [options] Canonical request context and system time.
 * @returns {Promise<Array>} Bound graph edges or explicit rebuild markers.
 */
export async function buildEdgesForSession(newMemories, existingMemories, dbTable, logger, options = {}) {
  const edges = [];
  const requestContext = options?.requestContext || null;
  const now = options?.now ?? Date.now();
  const newRows = Array.isArray(newMemories) ? newMemories : [];
  const existingRows = Array.isArray(existingMemories) ? existingMemories : [];
  const preparedNew = new Map();
  const preparedExisting = [];
  const preparedExistingById = new Map();
  const existingRowsById = new Map();

  for (const memory of newRows) {
    const prepared = prepareGraphEndpoint(memory, requestContext, now);
    if (prepared && memory?.id != null) preparedNew.set(String(memory.id), prepared);
  }
  for (const memory of existingRows) {
    if (memory?.id != null && !existingRowsById.has(String(memory.id))) {
      existingRowsById.set(String(memory.id), memory);
    }
    const prepared = prepareGraphEndpoint(memory, requestContext, now);
    if (!prepared || memory?.id == null) continue;
    preparedExisting.push(prepared);
    if (!preparedExistingById.has(String(memory.id))) {
      preparedExistingById.set(String(memory.id), prepared);
    }
  }

  // P2.1: Bounded concurrency for semantic vector searches
  const semanticTasks = [];
  for (const mem of newRows) {
    const memId = mem.id;
    const memVector = mem.vector;
    const source = preparedNew.get(String(memId));
    if (source && memVector && dbTable) {
      semanticTasks.push(async () => {
        try {
          const results = await withTimeout(
            dbTable.vectorSearch(memVector).limit(20).toArray(),
            LANCEDB_READ_TIMEOUT_MS,
            "memory-graph.vectorSearch",
          );
          const batchEdges = [];
          for (const row of results) {
            if (!row || row.id == null || String(row.id) === String(memId)) continue;
            const similarity = distanceToScore(row._distance);
            if (similarity < 0.78) continue;
            // Some vector adapters project only id/_distance. Reuse the
            // already-loaded full row when available so ownership is never
            // reconstructed from an ID-only ANN hit.
            const candidate = preparedExistingById.get(String(row.id))
              || prepareGraphEndpoint(existingRowsById.get(String(row.id)) || row, requestContext, now);
            const edge = createPreparedEdge(source, candidate, "semantic", semanticStrength(similarity), false, requestContext);
            if (edge) batchEdges.push(edge);
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
  for (const prepared of preparedExisting) {
    const other = prepared.memory;
    const topics = other.topics || other.entities || [];
    for (const t of topics) {
      if (!topicIndex.has(t)) topicIndex.set(t, []);
      topicIndex.get(t).push(prepared);
    }
    if (other.emotionalDominant) {
      if (!emotionIndex.has(other.emotionalDominant)) emotionIndex.set(other.emotionalDominant, []);
      emotionIndex.get(other.emotionalDominant).push(prepared);
    }
  }

  for (const mem of newRows) {
    const memId = mem.id;
    const source = preparedNew.get(String(memId));
    if (!source) continue;
    const memTime = new Date(mem.createdAt).getTime();

    // Temporal: connect to last 5–10 memories in same session
    const sameSession = preparedExisting
      .filter(({ memory: other }) => other.sessionId === mem.sessionId && other.id !== memId)
      .sort(({ memory: a }, { memory: b }) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 10);
    for (const other of sameSession) {
      const otherMemory = other.memory;
      const deltaMinutes = Math.abs(memTime - new Date(otherMemory.createdAt).getTime()) / 60000;
      if (deltaMinutes < 30) {
        const edge = createPreparedEdge(other, source, "temporal", temporalStrength(deltaMinutes), true, requestContext);
        if (edge) edges.push(edge);
      }
    }

    // Entity: shared topics/entities via index (O(K) instead of O(M))
    const memTopics = new Set(mem.topics || mem.entities || []);
    const candidateSet = new Map(); // otherId -> { other, overlapCount }
    for (const t of memTopics) {
      for (const other of topicIndex.get(t) || []) {
        if (other.memory.id === memId) continue;
        const id = String(other.memory.id);
        candidateSet.set(id, { other, overlap: (candidateSet.get(id)?.overlap || 0) + 1 });
      }
    }
    for (const { other, overlap } of candidateSet.values()) {
      if (overlap < 2) continue;
      const otherTopics = new Set(other.memory.topics || other.memory.entities || []);
      const union = new Set([...memTopics, ...otherTopics]).size;
      const jaccard = union > 0 ? overlap / union : 0;
      if (jaccard < 0.5) continue;
      const edge = createPreparedEdge(source, other, "entity", Math.min(jaccard * 0.8, 0.7), false, requestContext);
      if (edge) edges.push(edge);
    }

    // Emotional: same dominant emotion only if there is also content overlap
    if (mem.emotionalDominant) {
      for (const other of emotionIndex.get(mem.emotionalDominant) || []) {
        if (other.memory.id === memId) continue;
        const sharedTokens = topicOverlap(
          mem.topics || mem.entities || [],
          other.memory.topics || other.memory.entities || [],
        );
        if (sharedTokens === 0) continue;
        const intensityMatch = 1 - Math.abs((mem.emotionalIntensity || 0.5) - (other.memory.emotionalIntensity || 0.5));
        const edge = createPreparedEdge(source, other, "emotional", intensityMatch * 0.4, false, requestContext);
        if (edge) edges.push(edge);
      }
    }
  }

  return edges;
}

// ─── Episode-Anchor Edges ──────────────────────────────────────────────────

function endpointId(endpoint) {
  if (typeof endpoint === "string" || typeof endpoint === "number") return String(endpoint);
  if (!endpoint || typeof endpoint !== "object") return "";
  return String(endpoint.id ?? endpoint.memoryId ?? endpoint.memory_id ?? "");
}

function endpointOverrideById(overrides, id) {
  if (!overrides || !id) return null;
  if (overrides instanceof Map) return overrides.get(id) ?? null;
  if (Array.isArray(overrides)) {
    return overrides.find((candidate) => endpointId(candidate) === id) ?? null;
  }
  if (typeof overrides === "object") return overrides[id] ?? null;
  return null;
}

function resolveGraphEndpoint(endpoint, ownershipOverride, workspaceAliases) {
  const id = endpointId(endpoint);
  if (!id) return null;

  const overrideId = endpointId(ownershipOverride);
  if (overrideId && overrideId !== id) return null;

  const candidates = [
    ownershipOverride?.ownership,
    ownershipOverride,
    endpoint?.ownership,
    endpoint,
  ];
  for (const candidate of candidates) {
    const serialized = normalizeSerializedGraphOwnership(candidate);
    if (serialized) return { id, ownership: serialized };
    const canonical = canonicalGraphOwnership(candidate, workspaceAliases);
    if (canonical) return { id, ownership: canonical };
  }
  return null;
}

/**
 * Build episode-anchor edges only when both endpoint ownership bindings are canonical.
 * Legacy ID-only inputs intentionally produce no edge and are never persisted as
 * hydration graph records.
 *
 * @param {Array<Object>} episodes Episode endpoint records.
 * @param {Array<string|Object>} memoryIdsInEpisode Memory IDs or endpoint records.
 * @param {{workspaceAliases?: Object, memoryEndpoints?: Map|Object|Array}} [options] Endpoint ownership overrides.
 * @returns {Array} Ownership-bound episode edges.
 */
export function buildEpisodeAnchorEdges(episodes, memoryIdsInEpisode, options = {}) {
  const edges = [];
  const opts = options && typeof options === "object" ? options : {};
  const workspaceAliases = opts.workspaceAliases
    ?? opts.requestContext?.workspaceAliases
    ?? EMPTY_WORKSPACE_ALIASES;
  const memoryOverrides = opts.memoryEndpoints
    ?? opts.memoryEndpointsById
    ?? opts.memoryById
    ?? opts.memoryOwnershipById
    ?? null;

  for (const episode of Array.isArray(episodes) ? episodes : []) {
    const episodeEndpoint = resolveGraphEndpoint(
      episode,
      endpointOverrideById(opts.episodeEndpoints ?? opts.episodeEndpointsById ?? opts.episodeById, endpointId(episode)),
      workspaceAliases,
    );
    const episodeId = endpointId(episode);
    if (!episodeEndpoint || !episodeId) continue;
    const anchorId = `episode-${episodeId}`;
    const strength = (episode.vividness || 0.5) * 0.85;
    for (const memory of Array.isArray(memoryIdsInEpisode) ? memoryIdsInEpisode : []) {
      const memoryId = endpointId(memory);
      const memoryEndpoint = resolveGraphEndpoint(
        memory,
        endpointOverrideById(memoryOverrides, memoryId),
        workspaceAliases,
      );
      if (!memoryEndpoint) continue;
      const edge = createEdge(memoryEndpoint.id, anchorId, "episode", strength, false, {
        sourceOwnership: memoryEndpoint.ownership,
        targetOwnership: episodeEndpoint.ownership,
      });
      if (isBoundGraphEdge(edge)) edges.push(edge);
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
  const { edges } = readGraph(edgeRecords, { requireBoundOwnership: true });
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
  const { edges, adjacency } = readGraph(graphEdges, { requireBoundOwnership: true });
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

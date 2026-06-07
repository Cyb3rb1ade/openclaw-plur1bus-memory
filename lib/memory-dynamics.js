// Phase 7 - Memory Dynamics: pure helpers for strength decay, reinforcement,
// flashbulb encoding, and privacy-preserving retrieval ledger entries.

import { createHash, randomUUID } from "node:crypto";

export const CORE_MEMORY_THRESHOLD = 0.95;
export const CORE_MEMORY_HALF_LIFE_DAYS = 36500;

/**
 * Computes decayed memory strength using an exponential forgetting curve:
 * S = S0 * (1/2)^(elapsed / halfLife).
 */
export function computeDecayedStrength(row = {}, now = Date.now()) {
  if (isCoreMemory(row)) return 1.0;

  const s0 = clamp(row.memoryStrength ?? 1.0, 0.01, 1.0);
  const halfLifeMs = Math.max(1, Number(row.halfLifeDays ?? 30)) * 86400000;
  const lastDynamics = firstValidTimestamp(
    row.lastDynamicsAt,
    row.lastStrengthenedAt,
    row.createdAt,
  );
  const elapsed = Number(now) - lastDynamics;

  if (!Number.isFinite(elapsed) || elapsed <= 0) return s0;

  const decayed = s0 * Math.pow(0.5, elapsed / halfLifeMs);
  return clamp(decayed, 0.01, 1.0);
}

/**
 * Applies retrieval reinforcement after first decaying the current strength.
 */
export function applyRetrievalReinforcement(row = {}, now = Date.now()) {
  if (isCoreMemory(row)) {
    return {
      retrievalCount: (Number(row.retrievalCount) || 0) + 1,
      lastRetrievedAt: now,
      memoryStrength: 1.0,
      lastStrengthenedAt: now,
      lastDynamicsAt: now,
    };
  }

  const decayed = computeDecayedStrength(row, now);
  const count = (Number(row.retrievalCount) || 0) + 1;
  const boost = 0.10 / Math.sqrt(count);
  const strength = clamp(decayed + boost, 0.01, 1.0);

  return {
    retrievalCount: count,
    lastRetrievedAt: now,
    memoryStrength: strength,
    lastStrengthenedAt: now,
    lastDynamicsAt: now,
  };
}

/**
 * Applies daily decay without strengthening.
 */
export function applyDailyDecay(row = {}, now = Date.now()) {
  return {
    memoryStrength: computeDecayedStrength(row, now),
    lastDynamicsAt: now,
  };
}

/**
 * Computes a flashbulb score from emotional and semantic features.
 */
export function computeFlashbulbScore(row = {}) {
  const emotionalIntensity = Number(row.emotionalIntensity ?? 0);
  const importance = Number(row.importance ?? 0.5);
  const novelty = Number(row.novelty ?? 0);
  const userCorrection = Number(row.userCorrection ?? 0);

  return clamp(
    emotionalIntensity * 0.35 +
      importance * 0.35 +
      novelty * 0.15 +
      userCorrection * 0.15,
    0,
    1,
  );
}

/**
 * Applies flashbulb encoding when the score crosses the threshold.
 */
export function applyFlashbulbEncoding(row = {}, now = Date.now(), threshold = 0.70) {
  const score = computeFlashbulbScore(row);
  if (score < threshold) return null;

  return {
    memoryStrength: 0.95,
    halfLifeDays: 90,
    lastStrengthenedAt: now,
    lastDynamicsAt: now,
  };
}

/**
 * Core memories are intentionally rare: they require both emotional depth and
 * high importance, then must still clear the flashbulb-style aggregate score.
 */
export function computeCoreMemoryScore(row = {}) {
  if (isCoreMemory(row)) return 1.0;

  const emotionalIntensity = Number(row.emotionalIntensity ?? 0);
  const importance = Number(row.importance ?? 0.5);
  if (emotionalIntensity < CORE_MEMORY_THRESHOLD || importance < CORE_MEMORY_THRESHOLD) {
    return 0;
  }

  const novelty = Number(row.novelty ?? 0);
  const userCorrection = Number(row.userCorrection ?? 0);
  const correctionLift = userCorrection >= CORE_MEMORY_THRESHOLD && novelty >= CORE_MEMORY_THRESHOLD ? 0.05 : 0;

  return clamp(
    emotionalIntensity * 0.45 +
      importance * 0.45 +
      novelty * 0.10 +
      correctionLift,
    0,
    1,
  );
}

export function applyCoreMemoryEncoding(row = {}, now = Date.now(), threshold = CORE_MEMORY_THRESHOLD) {
  const score = computeCoreMemoryScore(row);
  if (score < threshold) return null;

  return {
    memoryClass: "core",
    neverForget: 1,
    coreMemoryScore: score,
    coreMemoryReason: row.coreMemoryReason || "deep_flashbulb_threshold",
    memoryStrength: 1.0,
    halfLifeDays: CORE_MEMORY_HALF_LIFE_DAYS,
    expiresAt: 0,
    lastStrengthenedAt: now,
    lastDynamicsAt: now,
  };
}

export function isCoreMemory(row = {}) {
  return row.memoryClass === "core" || row.neverForget === true || row.neverForget === 1;
}

/**
 * Default half-life mapping by memory category.
 * Groups: transient (60d), episodic (180d), longContext/project (365d).
 * Core memories bypass this entirely (see CORE_MEMORY_HALF_LIFE_DAYS).
 */
const DEFAULT_HALF_LIFE_MAP = {
  transient: 60,   // fact, general
  episodic: 180,   // other (catch-all)
  longContext: 365,// person, work
  project: 365,    // project, decision
};

const CATEGORY_TO_GROUP = {
  fact: "transient",
  general: "transient",
  other: "episodic",
  person: "longContext",
  work: "longContext",
  project: "project",
  decision: "project",
};

/**
 * Resolve halfLifeDays from category and memoryClass.
 * @param {string} category — memory category
 * @param {string|null} memoryClass — optional memoryClass (core bypasses mapping)
 * @param {object} overrides — optional config overrides per group
 * @returns {number} halfLifeDays
 */
export function resolveHalfLifeDays(category, memoryClass = null, overrides = {}) {
  if (memoryClass === "core" || isCoreMemory({ memoryClass })) {
    return CORE_MEMORY_HALF_LIFE_DAYS;
  }
  const group = CATEGORY_TO_GROUP[String(category || "").toLowerCase()] || "episodic";
  return overrides[group] ?? DEFAULT_HALF_LIFE_MAP[group];
}

/**
 * Applies dynamics and versioning defaults before storing an entry.
 */
export function applyDynamicsDefaults(entry = {}, now = Date.now(), halfLifeOverrides = {}) {
  const isNew = !entry.lastDynamicsAt;
  const out = { ...entry };

  if (isNew) {
    const core = applyCoreMemoryEncoding(out, now);
    const flashbulb = core ? null : applyFlashbulbEncoding(out, now);
    if (core) {
      Object.assign(out, core);
    } else if (flashbulb) {
      Object.assign(out, flashbulb);
      out.memoryClass = entry.memoryClass || "flashbulb";
      out.neverForget = entry.neverForget ? 1 : 0;
      out.coreMemoryScore = entry.coreMemoryScore ?? computeCoreMemoryScore(out);
      out.coreMemoryReason = entry.coreMemoryReason || "";
    } else {
      out.memoryStrength = entry.memoryStrength ?? 1.0;
      out.halfLifeDays = entry.halfLifeDays ?? resolveHalfLifeDays(entry.category, entry.memoryClass, halfLifeOverrides);
      out.lastDynamicsAt = now;
      out.memoryClass = entry.memoryClass || "standard";
      out.neverForget = entry.neverForget ? 1 : 0;
      out.coreMemoryScore = entry.coreMemoryScore ?? computeCoreMemoryScore(out);
      out.coreMemoryReason = entry.coreMemoryReason || "";
    }
    out.retrievalCount = entry.retrievalCount ?? 0;
    out.lastRetrievedAt = entry.lastRetrievedAt ?? 0;
    out.lastStrengthenedAt = out.lastStrengthenedAt ?? entry.lastStrengthenedAt ?? 0;
    out.versionNumber = entry.versionNumber ?? 1;
    out.previousVersion = entry.previousVersion || "";
    out.supersededBy = entry.supersededBy || "";
    out.updateSource = entry.updateSource || "";
    out.updateEvidence = entry.updateEvidence || "";
    out.reconsolidationConfidence = entry.reconsolidationConfidence ?? 0.0;
    out.status = entry.status || "active";
    out.versionCreatedAt = entry.versionCreatedAt || now;
    out.updatedAt = entry.updatedAt || now;
  } else {
    Object.assign(out, applyDailyDecay(out, now));
  }

  return out;
}

/**
 * Creates a retrieval ledger entry without persisting the raw query text.
 */
export function createRetrievalLedgerEntry({
  agentId,
  workspaceKey,
  query,
  queryHash,
  resultsCount,
  selectedIds,
  timestamp = Date.now(),
} = {}) {
  const hash = queryHash || (query ? createHash("sha256").update(String(query)).digest("hex") : null);

  return {
    id: randomUUID(),
    agentId: agentId || null,
    workspaceKey: workspaceKey || null,
    queryHash: hash,
    resultsCount: resultsCount ?? 0,
    selectedIds: Array.isArray(selectedIds) ? selectedIds : [],
    timestamp,
  };
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function firstValidTimestamp(...candidates) {
  for (const t of candidates) {
    const n = Number(t);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

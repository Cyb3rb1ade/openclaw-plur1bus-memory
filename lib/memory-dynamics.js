// Phase 7 - Memory Dynamics: pure helpers for strength decay, reinforcement,
// flashbulb encoding, and privacy-preserving retrieval ledger entries.

import { createHash, randomUUID } from "node:crypto";

export const CORE_MEMORY_THRESHOLD = 0.95;
export const CORE_MEMORY_HALF_LIFE_DAYS = 36500;

/**
 * `importance = 1.0` ist dem Agenten vorbehalten: er markiert damit im Gespräch
 * eine Erinnerung, die er subjektiv nicht vergessen will. Der automatische
 * Scorer erreicht den Wert nicht — `computeMemoryImportance` startet ohne
 * expliziten Wert bei 0.5, hebt über Floors auf höchstens 0.7 und deckelt
 * Triviales auf 0.45/0.2. 1.0 entsteht also ausschließlich durch eine bewusste
 * Setzung und wird deshalb ohne weitere Bedingung als Core anerkannt.
 *
 * Insbesondere ohne das emotionale Tor: `emotionalIntensity` stammt aus der
 * automatischen Tonanalyse des Textes und ist für den Agenten gar nicht
 * setzbar. Eine ruhig formulierte Sicherheitsnotiz — genau der Fall, für den
 * die Markierung gedacht ist — hat emotionale Intensität 0.
 */
export const MANUAL_CORE_IMPORTANCE = 1.0;

export function isManualCoreMarker(row = {}) {
  return Number(row.importance) >= MANUAL_CORE_IMPORTANCE;
}

/**
 * Computes decayed memory strength using an exponential forgetting curve:
 * S = S0 * (1/2)^(elapsed / halfLife).
 */
export function computeDecayedStrength(row = {}, now = Date.now()) {
  if (isCoreMemory(row)) return 1.0;

  const s0 = clamp(row.memoryStrength ?? 1.0, 0.01, 1.0);
  const rawHalfLifeDays = Number(row.halfLifeDays ?? 30);
  const halfLifeDays = Number.isFinite(rawHalfLifeDays) ? Math.max(1, rawHalfLifeDays) : 30;
  const halfLifeMs = halfLifeDays * 86400000;
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
  const boost = 0.15 / (1 + Math.log1p(count));
  const strength = clamp(decayed + boost, 0.01, 0.99);

  return {
    retrievalCount: count,
    lastRetrievedAt: now,
    memoryStrength: strength,
    lastStrengthenedAt: now,
    lastDynamicsAt: now,
  };
}

/**
 * Computes whether a memory is a candidate for promotion to a higher class.
 * @param {object} row — memory row
 * @param {number} sessionCount — how many distinct sessions it has been retrieved in
 * @returns {{ isCandidate: boolean, score: number, reasons: string[] }}
 */
export function computePromotionCandidate(row = {}, sessionCount = 1) {
  const reasons = [];
  const retrievalCount = Number(row.retrievalCount) || 0;
  const importance = Number(row.importance ?? 0.5);
  const category = String(row.category || "").toLowerCase();
  const memoryClass = String(row.memoryClass || "").toLowerCase();

  if (memoryClass === "core") {
    reasons.push("memoryClass is core — already highest class");
    return { isCandidate: false, score: 0, reasons };
  }

  if (retrievalCount < 3) {
    reasons.push(`retrievalCount ${retrievalCount} < 3`);
  }
  if (importance < 0.7) {
    reasons.push(`importance ${importance} < 0.7`);
  }
  if (sessionCount < 2) {
    reasons.push(`sessionCount ${sessionCount} < 2`);
  }
  if (category === "fact" || category === "general") {
    reasons.push(`category '${category}' is transient — not eligible`);
  }

  const isCandidate =
    retrievalCount >= 3 &&
    importance >= 0.7 &&
    sessionCount >= 2 &&
    category !== "fact" &&
    category !== "general";

  const score = isCandidate
    ? importance * 0.4 + (retrievalCount / 10) * 0.3 + (sessionCount / 5) * 0.3
    : 0;

  if (isCandidate) {
    reasons.push("meets all promotion criteria");
  }

  return { isCandidate, score, reasons };
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

  // `novelty` und `userCorrection` trugen früher 15 % + 15 %, sind aber keine
  // Spalten der Tabelle und werden von keiner Stelle geschrieben (über die
  // gesamte Historie nie). Der Score konnte damit höchstens 0.70 erreichen —
  // exakt die Schwelle — und feuerte nur im singulären Punkt 1.0/1.0. Die
  // Gewichte sind deshalb auf die tatsächlich vorhandenen Merkmale normiert.
  return clamp(emotionalIntensity * 0.5 + importance * 0.5, 0, 1);
}

/**
 * Skaliert eine Basis-Halbwertszeit mit der emotionalen Intensität:
 * je intensiver die Erinnerung, desto langsamer das Vergessen.
 * halfLife' = halfLife × (1 + intensity × factor)
 */
export function modulateHalfLifeDays(baseDays, emotionalIntensity, factor = 1.0) {
  const base = Number(baseDays);
  if (!Number.isFinite(base) || base <= 0) return baseDays;
  const intensity = clamp(emotionalIntensity ?? 0, 0, 1);
  const f = Number.isFinite(Number(factor)) ? Math.max(0, Number(factor)) : 1.0;
  return Math.round(base * (1 + intensity * f));
}

/**
 * Applies flashbulb encoding when the score crosses the threshold.
 */
export function applyFlashbulbEncoding(row = {}, now = Date.now(), threshold = 0.70, baseHalfLifeDays = 0) {
  const score = computeFlashbulbScore(row);
  if (score < threshold) return null;

  return {
    memoryStrength: 0.95,
    // Flashbulb darf die Halbwertszeit nur verlängern, nie verkürzen —
    // sonst würden z.B. Projekt-Memories (600d) auf 90d gestutzt.
    halfLifeDays: Math.max(Number(baseHalfLifeDays) || 0, 90),
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
  if (isManualCoreMarker(row)) return 1.0;

  const emotionalIntensity = Number(row.emotionalIntensity ?? 0);
  const importance = Number(row.importance ?? 0.5);
  if (emotionalIntensity < CORE_MEMORY_THRESHOLD || importance < CORE_MEMORY_THRESHOLD) {
    return 0;
  }

  // Siehe computeFlashbulbScore: `novelty` trug 10 %, existiert aber nicht.
  // Der Score kam dadurch nie über 0.90 und blieb dauerhaft unter der Schwelle
  // von 0.95 — Core war rechnerisch unerreichbar. Gewichte normiert.
  return clamp(emotionalIntensity * 0.5 + importance * 0.5, 0, 1);
}

export function applyCoreMemoryEncoding(row = {}, now = Date.now(), threshold = CORE_MEMORY_THRESHOLD) {
  const score = computeCoreMemoryScore(row);
  if (score < threshold) return null;

  return {
    memoryClass: "core",
    neverForget: 1,
    coreMemoryScore: score,
    coreMemoryReason: row.coreMemoryReason
      || (isManualCoreMarker(row) ? "manual_importance_marker" : "deep_flashbulb_threshold"),
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
  longContext: 600,// person, work
  project: 600,    // project, decision
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
  // Träume verblassen schnell, wie beim Menschen — intensive Träume
  // überleben länger über den normalen Strength-Mechanismus.
  if (memoryClass === "dream") {
    return overrides.dream ?? 30;
  }
  const group = CATEGORY_TO_GROUP[String(category || "").toLowerCase()] || "episodic";
  return overrides[group] ?? DEFAULT_HALF_LIFE_MAP[group];
}

/**
 * Applies dynamics and versioning defaults before storing an entry.
 */
export function applyDynamicsDefaults(entry = {}, now = Date.now(), halfLifeOverrides = {}, opts = {}) {
  const isNew = !entry.lastDynamicsAt;
  const out = { ...entry };

  if (isNew) {
    const baseHalfLifeDays = entry.halfLifeDays ?? modulateHalfLifeDays(
      resolveHalfLifeDays(entry.category, entry.memoryClass, halfLifeOverrides),
      entry.emotionalIntensity,
      opts.intensityHalfLifeFactor ?? 1.0,
    );
    const core = applyCoreMemoryEncoding(out, now);
    const flashbulb = core ? null : applyFlashbulbEncoding(out, now, 0.70, baseHalfLifeDays);
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
      out.halfLifeDays = baseHalfLifeDays;
      out.lastDynamicsAt = now;
      out.memoryClass = entry.memoryClass || "standard";
      out.neverForget = entry.neverForget ? 1 : 0;
      out.coreMemoryScore = entry.coreMemoryScore ?? computeCoreMemoryScore(out);
      out.coreMemoryReason = entry.coreMemoryReason || "";
    }
    out.retrievalCount = entry.retrievalCount ?? 0;
    out.lastRetrievedAt = entry.lastRetrievedAt ?? 0;
    out.replayCount = entry.replayCount ?? 0;
    out.lastReplayed = entry.lastReplayed ?? 0;
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
    out.replayCount = entry.replayCount ?? 0;
    out.lastReplayed = entry.lastReplayed ?? 0;
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

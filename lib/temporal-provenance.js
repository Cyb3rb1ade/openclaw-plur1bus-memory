/**
 * lib/temporal-provenance.js — P5 Temporal Provenance + Operational Action Guard.
 *
 * Pure deterministic helpers that compute memory age/freshness, detect
 * operational/system-state memories, classify operational risk, and decide
 * whether live verification is required before acting on a recalled memory.
 *
 * No DB/network dependencies. `opts.now` allows fixed-time injection for tests.
 */

const DEFAULT_FRESH_MS = 15 * 60 * 1000;
const DEFAULT_RECENT_MS = 2 * 60 * 60 * 1000;

const OPERATIONAL_KEYWORDS = [
  "cron", "crontab", "cronjob",
  "systemctl", "service", "timer",
  "deploy", "deployment",
  "gateway",
  "protect script", "update script", "deploy script",
  "lockfile", "lock file", "duplicate job", "duplikat",
  "database migration", "db migration",
  "journalctl",
  "production", "live",
];

const DESTRUCTIVE_KEYWORDS = [
  "disable", "disable", "stop", "delete", "remove", "move", "drop",
  "reset hard", "reset --hard", "rm -", "chmod", "chown",
];

const HIGH_RISK_KEYWORDS = [
  "edit", "change", "alter", "modify", "rewrite", "update",
  "crontab", "cron", "deploy script", "protect script", "update script",
];

const MEDIUM_RISK_KEYWORDS = [
  "restart", "reload", "status", "check", "verify", "list-timers",
  "list-units", "systemctl",
];

const LOW_RISK_KEYWORDS = [
  "journalctl", "log", "logged", "warning", "error",
];

/**
 * Parses a timestamp value into epoch milliseconds.
 * Accepts ISO strings, numbers, or Date objects.
 * Returns undefined for missing/invalid values.
 *
 * @param {string|number|Date|null|undefined} value
 * @returns {number|undefined}
 */
export function parseMemoryTimestamp(value) {
  if (value === null || value === undefined || value === "") return undefined;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Formats an age in milliseconds as a compact human-readable label.
 *
 * @param {number|undefined} ageMs
 * @returns {string}
 */
export function formatAgeForPrompt(ageMs) {
  if (ageMs === undefined || ageMs === null || !Number.isFinite(ageMs)) return "unknown";
  const minutes = Math.round(ageMs / (60 * 1000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(ageMs / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(ageMs / (24 * 60 * 60 * 1000));
  return `${days}d ago`;
}

/**
 * Classifies memory freshness based on age.
 *
 * @param {number|undefined} ageMs
 * @param {{freshMs?: number, recentMs?: number}} [opts={}]
 * @returns {"fresh"|"recent"|"stale"|"unknown"}
 */
export function classifyMemoryFreshness(ageMs, opts = {}) {
  if (ageMs === undefined || ageMs === null || !Number.isFinite(ageMs)) return "unknown";
  const freshMs = opts.freshMs ?? DEFAULT_FRESH_MS;
  const recentMs = opts.recentMs ?? DEFAULT_RECENT_MS;
  if (ageMs <= freshMs) return "fresh";
  if (ageMs <= recentMs) return "recent";
  return "stale";
}

/**
 * Computes the effective age of a memory using the most recent available
 * timestamp (lastRetrievedAt > updatedAt > createdAt).
 *
 * @param {Object} memory
 * @param {{now?: number}} [opts={}]
 * @returns {{ageMs?: number, ageLabel: string, timestamp?: number, timestampField?: string}}
 */
export function computeMemoryAge(memory, opts = {}) {
  const now = opts.now ?? Date.now();
  const candidates = [
    { field: "lastRetrievedAt", value: parseMemoryTimestamp(memory?.lastRetrievedAt) },
    { field: "updatedAt", value: parseMemoryTimestamp(memory?.updatedAt) },
    { field: "createdAt", value: parseMemoryTimestamp(memory?.createdAt) },
  ];
  const best = candidates.find(c => c.value !== undefined);
  if (!best) {
    return { ageMs: undefined, ageLabel: "unknown" };
  }
  const ageMs = Math.max(0, now - best.value);
  return {
    ageMs,
    ageLabel: formatAgeForPrompt(ageMs),
    timestamp: best.value,
    timestampField: best.field,
  };
}

/**
 * Detects whether a memory describes operational/system state.
 *
 * @param {string} text
 * @param {{summary?: string, category?: string}} [metadata={}]
 * @returns {{isOperational: boolean, reasons: string[]}}
 */
export function detectOperationalMemory(text, metadata = {}) {
  const source = String(text || metadata.summary || "").toLowerCase();
  const reasons = [];
  for (const keyword of OPERATIONAL_KEYWORDS) {
    if (source.includes(keyword.toLowerCase())) {
      reasons.push(`operational keyword: ${keyword}`);
    }
  }
  return {
    isOperational: reasons.length > 0,
    reasons,
  };
}

/**
 * Classifies the operational risk level of a memory.
 *
 * @param {string} text
 * @param {{summary?: string, category?: string}} [metadata={}]
 * @returns {{isOperational: boolean, operationalRisk: "none"|"low"|"medium"|"high"|"destructive", reasons: string[]}}
 */
export function classifyOperationalRisk(text, metadata = {}) {
  const operational = detectOperationalMemory(text, metadata);
  if (!operational.isOperational) {
    return { isOperational: false, operationalRisk: "none", reasons: [] };
  }

  const source = String(text || metadata.summary || "").toLowerCase();
  const reasons = [...operational.reasons];

  for (const keyword of DESTRUCTIVE_KEYWORDS) {
    if (source.includes(keyword.toLowerCase())) {
      reasons.push(`destructive keyword: ${keyword}`);
      return { isOperational: true, operationalRisk: "destructive", reasons };
    }
  }

  for (const keyword of HIGH_RISK_KEYWORDS) {
    if (source.includes(keyword.toLowerCase())) {
      reasons.push(`high-risk keyword: ${keyword}`);
      return { isOperational: true, operationalRisk: "high", reasons };
    }
  }

  for (const keyword of MEDIUM_RISK_KEYWORDS) {
    if (source.includes(keyword.toLowerCase())) {
      reasons.push(`medium-risk keyword: ${keyword}`);
      return { isOperational: true, operationalRisk: "medium", reasons };
    }
  }

  for (const keyword of LOW_RISK_KEYWORDS) {
    if (source.includes(keyword.toLowerCase())) {
      reasons.push(`low-risk keyword: ${keyword}`);
      return { isOperational: true, operationalRisk: "low", reasons };
    }
  }

  return { isOperational: true, operationalRisk: "medium", reasons };
}

/**
 * Decides whether a memory requires live verification before action.
 *
 * @param {Object} provenance
 * @returns {boolean}
 */
export function shouldRequireLiveVerification(provenance) {
  if (!provenance || !provenance.isOperational) return false;
  return provenance.freshness === "stale" || provenance.freshness === "unknown";
}

/**
 * Enriches a RecallDecisionTrace with temporal provenance metadata and adds
 * guard records for stale/unknown-age operational memories.
 *
 * @param {Object} trace
 * @param {Array} memories
 * @param {{now?: number}} [opts={}]
 */
export function enrichTraceWithTemporalProvenance(trace, memories, opts = {}) {
  if (!trace || typeof trace !== "object") return;
  const memoryById = new Map();
  for (const m of (memories || [])) {
    if (m?.id) memoryById.set(String(m.id), m);
  }

  for (const candidate of trace.candidates || []) {
    const memory = memoryById.get(String(candidate.id));
    if (!memory) continue;
    const provenance = buildTemporalProvenance(memory, opts);
    candidate.temporal = provenance;
  }

  for (const decision of trace.decisions || []) {
    const memory = memoryById.get(String(decision.memoryId));
    if (!memory) continue;
    const provenance = buildTemporalProvenance(memory, opts);
    decision.temporal = provenance;
    if (provenance.requiresLiveVerification) {
      trace.guards.push({
        name: "operational-live-verification-required",
        passed: false,
        stage: decision.stage || "context-render",
        memoryId: decision.memoryId,
        reason: `stale operational memory (${provenance.operationalRisk}); live verification required before action`,
        recordedAt: new Date().toISOString(),
      });
      trace.summary.guardFail = (trace.summary.guardFail || 0) + 1;
    }
  }
}

/**
 * Builds the complete temporal provenance object for a memory.
 *
 * @param {Object} memory
 * @param {{now?: number, freshMs?: number, recentMs?: number}} [opts={}]
 * @returns {Object}
 */
export function buildTemporalProvenance(memory, opts = {}) {
  const now = opts.now ?? Date.now();
  const createdMs = parseMemoryTimestamp(memory?.createdAt);
  const updatedMs = parseMemoryTimestamp(memory?.updatedAt);
  const retrievedMs = parseMemoryTimestamp(memory?.lastRetrievedAt);
  const age = computeMemoryAge(memory, { now });
  const freshness = classifyMemoryFreshness(age.ageMs, opts);
  const risk = classifyOperationalRisk(memory?.text || memory?.display, { summary: memory?.summary, category: memory?.category });

  const reasons = [...risk.reasons];
  if (freshness === "stale") {
    reasons.push(`stale operational memory older than ${formatThreshold(opts.recentMs ?? DEFAULT_RECENT_MS)}`);
  } else if (freshness === "unknown") {
    reasons.push("operational memory with unknown age");
  }

  const provenance = {
    createdAt: createdMs !== undefined ? new Date(createdMs).toISOString() : null,
    updatedAt: updatedMs !== undefined ? new Date(updatedMs).toISOString() : null,
    lastRetrievedAt: retrievedMs !== undefined ? new Date(retrievedMs).toISOString() : null,
    ageMs: age.ageMs,
    ageLabel: age.ageLabel,
    freshness,
    isOperational: risk.isOperational,
    operationalRisk: risk.operationalRisk,
    requiresLiveVerification: false,
    reasons,
  };

  provenance.requiresLiveVerification = shouldRequireLiveVerification(provenance);
  return provenance;
}

function formatThreshold(ms) {
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / (60 * 1000))}m`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.round(ms / (60 * 60 * 1000))}h`;
  return `${Math.round(ms / (24 * 60 * 60 * 1000))}d`;
}

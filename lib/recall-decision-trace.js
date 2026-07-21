/**
 * lib/recall-decision-trace.js — Recall Decision Trace helpers.
 *
 * Pure functions for building a structured, audit-friendly trace of why a
 * memory was (or was not) recalled. Traces are intentionally separate from
 * ranking/scoring: they observe the pipeline without altering it.
 *
 * Sensitive prompt text is never stored verbatim; only truncated text previews
 * are kept. Trace metadata attached to a memory object is stored on a
 * non-enumerable Symbol key so it cannot leak into JSON or downstream prompts.
 */

/**
 * Symbol key used to attach trace metadata to a memory object.
 * Non-enumerable → JSON.stringify and prompt rendering ignore it.
 */
const MEMORY_TRACE_SYMBOL = Symbol("plur1bus.recallDecisionTrace");

/**
 * Allowed decision actions recorded by the recall pipeline.
 */
const DECISION_ACTIONS = new Set([
  "inclusion",
  "rejection",
  "downrank",
  "superseded",
  "deduped",
  "merged",
]);

/**
 * Default maximum length for text previews inside a trace.
 */
const DEFAULT_MAX_TEXT_PREVIEW_CHARS = 160;

/**
 * Default cap for how many candidate entries a trace keeps.
 */
const DEFAULT_MAX_CANDIDATES = 50;

/**
 * Default caps for decisions, guards, and store decisions.
 */
const DEFAULT_MAX_DECISIONS = 200;
const DEFAULT_MAX_GUARDS = 200;
const DEFAULT_MAX_STORE_DECISIONS = 100;

/**
 * Creates a sanitized, deterministic text preview.
 *
 * - Collapses whitespace.
 * - Strips control characters.
 * - Truncates to `maxChars` and appends "…" when shortened.
 * - Never returns the full text when it exceeds the limit.
 *
 * @param {string} text
 * @param {number} [maxChars=160]
 * @returns {string}
 */
export function textPreview(text, maxChars = DEFAULT_MAX_TEXT_PREVIEW_CHARS) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_TEXT_PREVIEW_CHARS;
  let str = String(text ?? "");
  // Strip control characters except tab/newline, then collapse whitespace.
  str = str.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  if (str.length <= limit) return str;
  // Cut at a word boundary when possible.
  let cut = limit;
  while (cut > 0 && str[cut] !== " " && str[cut - 1] !== " ") {
    cut--;
  }
  if (cut <= 0) cut = limit;
  return str.slice(0, cut).trimEnd() + "…";
}

/**
 * Creates a new RecallDecisionTrace object.
 *
 * @param {Object} [opts={}]
 * @param {string} [opts.query]
 * @param {string} [opts.queryHash]
 * @param {number} [opts.maxCandidates=50]
 * @param {number} [opts.maxTextPreviewChars=160]
 * @param {Object} [opts.config={}] — snapshot of recall config relevant to this trace
 * @returns {Object}
 */
export function createRecallDecisionTrace(opts = {}) {
  const maxTextPreviewChars = Number.isFinite(opts.maxTextPreviewChars)
    ? Math.max(1, Math.floor(opts.maxTextPreviewChars))
    : DEFAULT_MAX_TEXT_PREVIEW_CHARS;
  const maxCandidates = Number.isFinite(opts.maxCandidates)
    ? Math.max(1, Math.floor(opts.maxCandidates))
    : DEFAULT_MAX_CANDIDATES;
  const maxDecisions = Number.isFinite(opts.maxDecisions)
    ? Math.max(1, Math.floor(opts.maxDecisions))
    : DEFAULT_MAX_DECISIONS;
  const maxGuards = Number.isFinite(opts.maxGuards)
    ? Math.max(1, Math.floor(opts.maxGuards))
    : DEFAULT_MAX_GUARDS;
  const maxStoreDecisions = Number.isFinite(opts.maxStoreDecisions)
    ? Math.max(1, Math.floor(opts.maxStoreDecisions))
    : DEFAULT_MAX_STORE_DECISIONS;

  return {
    traceId: generateTraceId(),
    createdAt: new Date().toISOString(),
    query: opts.query
      ? {
          text: textPreview(opts.query, maxTextPreviewChars),
          hash: opts.queryHash || undefined,
        }
      : { text: "", hash: opts.queryHash || undefined },
    config: {
      maxCandidates,
      maxTextPreviewChars,
      maxDecisions,
      maxGuards,
      maxStoreDecisions,
      ...(opts.config || {}),
    },
    candidates: [],
    decisions: [],
    guards: [],
    storeDecisions: [],
    summary: {
      totalCandidates: 0,
      included: 0,
      rejected: 0,
      downranked: 0,
      superseded: 0,
      deduped: 0,
      merged: 0,
      guardPass: 0,
      guardFail: 0,
      storeAccepted: 0,
      storeRejected: 0,
    },
  };
}

/**
 * Adds a candidate memory to the trace, normalizing fields and storing only
 * text previews. Returns the normalized candidate.
 *
 * @param {Object} trace
 * @param {Object} candidate
 * @param {string} candidate.id
 * @param {string} [candidate.text]
 * @param {string} [candidate.summary]
 * @param {string} [candidate.source]
 * @param {number} [candidate.score]
 * @param {number} [candidate.vectorScore]
 * @param {number} [candidate.importanceBoost]
 * @param {number} [candidate.emotionalBoost]
 * @param {number} [candidate.strengthBoost]
 * @param {number} [candidate.graphBoost]
 * @param {number} [candidate.graphDepth]
 * @param {string} [candidate.category]
 * @param {string} [candidate.status]
 * @param {Object} [candidate.scoreBreakdown]
 * @param {Object} [candidate.temporal]
 * @param {string} [candidate.namespace] — validated storage namespace provenance
 * @returns {Object}
 */
export function addTraceCandidate(trace, candidate) {
  if (!trace || typeof trace !== "object") {
    throw new TypeError("addTraceCandidate requires a trace object");
  }
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError("addTraceCandidate requires a candidate object");
  }

  const maxTextPreviewChars = trace.config?.maxTextPreviewChars ?? DEFAULT_MAX_TEXT_PREVIEW_CHARS;
  const maxCandidates = trace.config?.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  const namespace = sanitizeNamespace(candidate.namespace);
  const normalized = {
    id: String(candidate.id ?? ""),
    source: String(candidate.source ?? ""),
    category: String(candidate.category ?? ""),
    status: String(candidate.status ?? "active"),
    preview: textPreview(candidate.summary || candidate.text, maxTextPreviewChars),
    score: normalizeNumber(candidate.score),
    vectorScore: normalizeNumber(candidate.vectorScore),
    importanceBoost: normalizeNumber(candidate.importanceBoost),
    emotionalBoost: normalizeNumber(candidate.emotionalBoost),
    strengthBoost: normalizeNumber(candidate.strengthBoost),
    graphBoost: normalizeNumber(candidate.graphBoost),
    graphDepth: Number.isFinite(candidate.graphDepth) ? Math.max(0, Math.floor(candidate.graphDepth)) : undefined,
    scoreBreakdown: candidate.scoreBreakdown && typeof candidate.scoreBreakdown === "object"
      ? sanitizeScoreBreakdown(candidate.scoreBreakdown)
      : undefined,
    temporal: candidate.temporal && typeof candidate.temporal === "object"
      ? sanitizeTemporal(candidate.temporal)
      : undefined,
    ...(namespace !== undefined ? { namespace } : {}),
    addedAt: new Date().toISOString(),
  };

  trace.candidates.push(normalized);
  if (trace.candidates.length > maxCandidates) {
    trace.candidates = trace.candidates.slice(-maxCandidates);
  }
  trace.summary.totalCandidates = trace.candidates.length;
  return normalized;
}

/**
 * Records a recall-time decision for a candidate memory.
 *
 * @param {Object} trace
 * @param {Object} decision
 * @param {string} decision.memoryId
 * @param {string} decision.action — inclusion|rejection|downrank|superseded|deduped|merged
 * @param {string} [decision.stage]
 * @param {string} [decision.reason]
 * @param {number} [decision.finalScore]
 * @param {Object} [decision.scoreBreakdown]
 * @param {Object} [decision.temporal]
 * @param {string} [decision.namespace] — validated storage namespace provenance
 * @returns {Object}
 */
export function addTraceDecision(trace, decision) {
  if (!trace || typeof trace !== "object") {
    throw new TypeError("addTraceDecision requires a trace object");
  }
  if (!decision || typeof decision !== "object") {
    throw new TypeError("addTraceDecision requires a decision object");
  }
  const action = String(decision.action ?? "");
  if (!DECISION_ACTIONS.has(action)) {
    throw new TypeError(`Unknown decision action: ${action}`);
  }

  const namespace = sanitizeNamespace(decision.namespace);
  const normalized = {
    memoryId: String(decision.memoryId ?? ""),
    action,
    stage: String(decision.stage ?? ""),
    reason: textPreview(decision.reason, trace.config?.maxTextPreviewChars ?? DEFAULT_MAX_TEXT_PREVIEW_CHARS),
    finalScore: normalizeNumber(decision.finalScore),
    scoreBreakdown: decision.scoreBreakdown && typeof decision.scoreBreakdown === "object"
      ? sanitizeScoreBreakdown(decision.scoreBreakdown)
      : undefined,
    temporal: decision.temporal && typeof decision.temporal === "object"
      ? sanitizeTemporal(decision.temporal)
      : undefined,
    ...(namespace !== undefined ? { namespace } : {}),
    recordedAt: new Date().toISOString(),
  };

  trace.decisions.push(normalized);
  updateDecisionSummary(trace.summary, action);

  const maxDecisions = trace.config?.maxDecisions ?? DEFAULT_MAX_DECISIONS;
  if (trace.decisions.length > maxDecisions) {
    trace.decisions = trace.decisions.slice(-maxDecisions);
    summarizeTrace(trace);
  }

  return normalized;
}

/**
 * Records a guard outcome (e.g. safety, ACL, threshold gate).
 *
 * @param {Object} trace
 * @param {Object} guard
 * @param {string} guard.name
 * @param {boolean} guard.passed
 * @param {string} [guard.reason]
 * @param {string} [guard.memoryId]
 * @param {string} [guard.namespace] — validated storage namespace provenance
 * @returns {Object}
 */
export function addTraceGuard(trace, guard) {
  if (!trace || typeof trace !== "object") {
    throw new TypeError("addTraceGuard requires a trace object");
  }
  if (!guard || typeof guard !== "object") {
    throw new TypeError("addTraceGuard requires a guard object");
  }

  const namespace = sanitizeNamespace(guard.namespace);
  const normalized = {
    name: String(guard.name ?? ""),
    passed: Boolean(guard.passed),
    reason: textPreview(guard.reason, trace.config?.maxTextPreviewChars ?? DEFAULT_MAX_TEXT_PREVIEW_CHARS),
    memoryId: guard.memoryId !== undefined ? String(guard.memoryId) : undefined,
    ...(namespace !== undefined ? { namespace } : {}),
    recordedAt: new Date().toISOString(),
  };

  trace.guards.push(normalized);
  if (normalized.passed) {
    trace.summary.guardPass++;
  } else {
    trace.summary.guardFail++;
  }

  const maxGuards = trace.config?.maxGuards ?? DEFAULT_MAX_GUARDS;
  if (trace.guards.length > maxGuards) {
    trace.guards = trace.guards.slice(-maxGuards);
    summarizeTrace(trace);
  }

  return normalized;
}

/**
 * Records a store-time decision (e.g. stored, merged, deduped, superseded).
 *
 * @param {Object} trace
 * @param {Object} decision
 * @param {string} decision.memoryId
 * @param {string} decision.action
 * @param {string} [decision.reason]
 * @param {string} [decision.namespace] — validated storage namespace provenance
 * @returns {Object}
 */
export function addTraceStoreDecision(trace, decision) {
  if (!trace || typeof trace !== "object") {
    throw new TypeError("addTraceStoreDecision requires a trace object");
  }
  if (!decision || typeof decision !== "object") {
    throw new TypeError("addTraceStoreDecision requires a decision object");
  }

  const namespace = sanitizeNamespace(decision.namespace);
  const normalized = {
    memoryId: String(decision.memoryId ?? ""),
    action: String(decision.action ?? ""),
    reason: textPreview(decision.reason, trace.config?.maxTextPreviewChars ?? DEFAULT_MAX_TEXT_PREVIEW_CHARS),
    ...(namespace !== undefined ? { namespace } : {}),
    recordedAt: new Date().toISOString(),
  };

  trace.storeDecisions.push(normalized);
  if (normalized.action === "accepted" || normalized.action === "stored") {
    trace.summary.storeAccepted++;
  } else {
    trace.summary.storeRejected++;
  }

  const maxStoreDecisions = trace.config?.maxStoreDecisions ?? DEFAULT_MAX_STORE_DECISIONS;
  if (trace.storeDecisions.length > maxStoreDecisions) {
    trace.storeDecisions = trace.storeDecisions.slice(-maxStoreDecisions);
    summarizeTrace(trace);
  }

  return normalized;
}

/**
 * Computes summary counts from the trace contents.
 *
 * @param {Object} trace
 * @returns {Object}
 */
export function summarizeTrace(trace) {
  if (!trace || typeof trace !== "object") {
    throw new TypeError("summarizeTrace requires a trace object");
  }

  const summary = {
    totalCandidates: trace.candidates?.length ?? 0,
    included: 0,
    rejected: 0,
    downranked: 0,
    superseded: 0,
    deduped: 0,
    merged: 0,
    guardPass: 0,
    guardFail: 0,
    storeAccepted: 0,
    storeRejected: 0,
  };

  for (const d of trace.decisions || []) {
    updateDecisionSummary(summary, d.action);
  }
  for (const g of trace.guards || []) {
    if (g.passed) summary.guardPass++;
    else summary.guardFail++;
  }
  for (const s of trace.storeDecisions || []) {
    if (s.action === "accepted" || s.action === "stored") summary.storeAccepted++;
    else summary.storeRejected++;
  }

  trace.summary = summary;
  return summary;
}

/**
 * Serializes a trace to a JSON string safe for debug output.
 *
 * Full text is never emitted; previews are truncated to
 * `opts.maxTextPreviewChars` (default 160 or the trace's configured value).
 *
 * @param {Object} trace
 * @param {Object} [opts={}]
 * @param {number} [opts.maxTextPreviewChars]
 * @param {number} [opts.indent=2]
 * @returns {string}
 */
export function serializeTraceForDebug(trace, opts = {}) {
  if (!trace || typeof trace !== "object") {
    throw new TypeError("serializeTraceForDebug requires a trace object");
  }
  const maxTextPreviewChars = Number.isFinite(opts.maxTextPreviewChars)
    ? Math.max(1, Math.floor(opts.maxTextPreviewChars))
    : (trace.config?.maxTextPreviewChars ?? DEFAULT_MAX_TEXT_PREVIEW_CHARS);
  const indent = opts.indent === undefined ? 2 : opts.indent;

  const sanitized = sanitizeTrace(trace, maxTextPreviewChars);
  return JSON.stringify(sanitized, null, indent);
}

/**
 * Attaches trace metadata to a memory object using a non-enumerable Symbol
 * property. This keeps the trace out of JSON.stringify and prompt rendering.
 *
 * @param {Object} memory
 * @param {Object} traceMeta — typically the trace object or a lightweight reference
 * @returns {Object} the memory object
 */
export function attachTraceToMemory(memory, traceMeta) {
  if (!memory || typeof memory !== "object") {
    throw new TypeError("attachTraceToMemory requires a memory object");
  }
  Object.defineProperty(memory, MEMORY_TRACE_SYMBOL, {
    value: traceMeta,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return memory;
}

/**
 * Retrieves the trace metadata previously attached to a memory object.
 *
 * @param {Object} memory
 * @returns {Object|undefined}
 */
export function getMemoryTrace(memory) {
  if (!memory || typeof memory !== "object") return undefined;
  return memory[MEMORY_TRACE_SYMBOL];
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function generateTraceId() {
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `rdt-${now}-${rand}`;
}

function normalizeNumber(n) {
  if (n === undefined || n === null) return undefined;
  const num = Number(n);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * Retains only configured namespace identifiers in audit traces.
 *
 * @param {unknown} namespace
 * @returns {string|undefined}
 */
function sanitizeNamespace(namespace) {
  if (typeof namespace !== "string") return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(namespace)
    ? namespace
    : undefined;
}

function sanitizeScoreBreakdown(breakdown) {
  const copy = {};
  for (const key of Object.keys(breakdown)) {
    const val = breakdown[key];
    if (typeof val === "number" && Number.isFinite(val)) {
      copy[key] = val;
    } else if (typeof val === "string") {
      copy[key] = textPreview(val, DEFAULT_MAX_TEXT_PREVIEW_CHARS);
    } else if (typeof val === "boolean") {
      copy[key] = val;
    }
    // Functions, objects, arrays, null are dropped to keep traces serializable.
  }
  return copy;
}

function sanitizeTemporal(temporal) {
  const copy = {};
  for (const key of Object.keys(temporal)) {
    const val = temporal[key];
    if (typeof val === "number" && Number.isFinite(val)) {
      copy[key] = val;
    } else if (typeof val === "string") {
      copy[key] = textPreview(val, DEFAULT_MAX_TEXT_PREVIEW_CHARS);
    } else if (typeof val === "boolean") {
      copy[key] = val;
    }
  }
  return copy;
}

function updateDecisionSummary(summary, action) {
  switch (action) {
    case "inclusion": summary.included++; break;
    case "rejection": summary.rejected++; break;
    case "downrank": summary.downranked++; break;
    case "superseded": summary.superseded++; break;
    case "deduped": summary.deduped++; break;
    case "merged": summary.merged++; break;
    default: break;
  }
}

function sanitizeTrace(trace, maxTextPreviewChars) {
  return {
    traceId: trace.traceId,
    createdAt: trace.createdAt,
    query: {
      text: textPreview(trace.query?.text, maxTextPreviewChars),
      hash: trace.query?.hash,
    },
    config: trace.config,
    candidates: (trace.candidates || []).map((c) => ({
      ...c,
      preview: textPreview(c.preview, maxTextPreviewChars),
    })),
    decisions: (trace.decisions || []).map((d) => ({
      ...d,
      reason: textPreview(d.reason, maxTextPreviewChars),
    })),
    guards: (trace.guards || []).map((g) => ({
      ...g,
      reason: textPreview(g.reason, maxTextPreviewChars),
    })),
    storeDecisions: (trace.storeDecisions || []).map((s) => ({
      ...s,
      reason: textPreview(s.reason, maxTextPreviewChars),
    })),
    summary: summarizeTrace(trace),
  };
}

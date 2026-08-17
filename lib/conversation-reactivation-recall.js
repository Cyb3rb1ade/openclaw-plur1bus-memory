/**
 * lib/conversation-reactivation-recall.js
 *
 * Conversation Reactivation Recall (CRR) — additive post-recall hook.
 * Runs after normal recall and appends a small <memory-reactivation> block
 * when the conversation appears to resume after an idle gap or compaction.
 *
 * Hard constraints:
 * - additive only (never replaces normal recall)
 * - never writes workspace/memory/tag/graph/semantic-lens data
 * - hard timeout enforced by caller
 * - silent fallback on any error
 */

import { tokenize } from "./text-utils.js";
import { normalizeEpistemicStatus } from "./epistemic-status.js";
import { renderPromptMemoryAttrs } from "./prompt-memory-fields.js";
import {
  sanitizeMemoryContextAttribute,
  sanitizeMemoryTextForPrompt,
} from "./memory-context-sanitize.js";
import {
  addTraceCandidate,
  addTraceDecision,
  addTraceGuard,
  summarizeTrace,
} from "./recall-decision-trace.js";
import { buildRecallSafetyPreamble } from "./relevant-memory-context.js";
import { buildTemporalProvenance } from "./temporal-provenance.js";
import { escapeMemoryText } from "./neo-arch.js";
import { loadSemanticLensIndex as loadSemanticLensIndexRaw } from "./semantic-lens-index.js";
import { checkAccess } from "./acl-middleware.js";
import {
  canonicalGraphOwnership,
  filterGraphEdgesForRequest,
  isGraphMemoryLive,
} from "./memory-graph.js";
import { safeDebug } from "./safe-logging.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_IDLE_THRESHOLD_MS = 45 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 50;
const DEFAULT_FADED_THRESHOLD = 0.25;

// Tokens that are too generic to serve as evidence of thematic overlap.
// Associations may suggest; direct evidence must assert.
const GENERIC_TOKENS = new Set([
  "api", "project", "memory", "recall", "test", "user", "bot", "agent", "openclaw", "plur1bus",
]);

const MIN_SIGNIFICANT_OVERLAP = 2;

// Hard safety caps — config values cannot exceed these.
const HARD_MAX_REACTIVATION_MEMORIES = 3;
const HARD_MAX_FADED_REACTIVATION_MEMORIES = 1;
const HARD_MAX_OPEN_THREADS = 3;
const HARD_MAX_COMMUNITIES = 2;

// Hydration budget for community candidates that are not already present in the
// semantic-lens memoryMap. This keeps CRR under its tight caller timeout and
// prevents a large remote index from triggering a flood of DB lookups.
const MAX_COMMUNITY_HYDRATIONS = 6;

const EMPTY_WORKSPACE_ALIASES = Object.freeze({
  paths: Object.freeze([]),
  aliases: Object.freeze([]),
});

function hasCanonicalRequestContext(requestContext) {
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

function hasStoredOwnershipBinding(memory) {
  if (!memory || typeof memory !== "object") return false;
  return [
    memory.scope,
    memory.agentId,
    memory.storedBy,
    memory.workspaceId,
    memory.workspaceKey,
    memory.ownerUserId,
  ].some((value) => value !== undefined && value !== null && value !== "");
}

function sameOwnership(left, right) {
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

function edgeOwnershipForEndpoint(edge, id) {
  if (!edge || typeof edge !== "object") return null;
  return String(edge.source) === String(id) ? edge.sourceOwnership
    : String(edge.target) === String(id) ? edge.targetOwnership
      : null;
}

function authorizeCrrMemory(memory, requestContext, {
  now = Date.now(),
  expectedOwnership = null,
  allowLegacyUnbound = false,
} = {}) {
  if (!memory || memory.id == null || String(memory.id).trim() === "" || !isGraphMemoryLive(memory, now)) return false;
  const canonical = canonicalGraphOwnership(
    memory,
    requestContext?.workspaceAliases || EMPTY_WORKSPACE_ALIASES,
  );
  if (expectedOwnership && !sameOwnership(canonical, expectedOwnership)) return false;

  if (hasCanonicalRequestContext(requestContext)) {
    return Boolean(canonical && checkAccess(requestContext, memory).allowed);
  }
  // Existing lens rows without any ownership metadata remain readable only as
  // legacy, unbound lens data. They are never accepted for graph bridging.
  if (requestContext != null || hasStoredOwnershipBinding(memory)) return false;
  return allowLegacyUnbound;
}

/**
 * Loads the semantic-lens index, preferring the remote cached loader and
 * falling back to a simple read for legacy/test index shapes.
 */
function loadSemanticLensIndexForCrr(workspaceDir) {
  if (!workspaceDir) return { index: { communities: [], memories: [], entries: {} } };
  const record = loadSemanticLensIndexRaw({ workspaceDir });
  if (record?.index) return record;
  const path = join(workspaceDir, ".plur1bus", "semantic-lens-index.json");
  if (!existsSync(path)) return { index: { communities: [], memories: [], entries: {} } };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return { index: { communities: [], memories: [], entries: {} } };
    return { index: parsed };
  } catch {
    return { index: { communities: [], memories: [], entries: {} } };
  }
}

function isRemoteLensShape(raw) {
  return raw && (
    (raw.memoryToCommunity && typeof raw.memoryToCommunity === "object") ||
    (raw.communities && !Array.isArray(raw.communities) && typeof raw.communities === "object")
  );
}

function normalizeCommunities(raw) {
  if (!raw) return [];
  if (Array.isArray(raw.communities)) {
    return raw.communities.map((c) => ({
      id: c?.id,
      representativeMemoryIds: c?.representativeMemoryIds || c?.memoryIds || (c?.representative ? [c.representative] : []),
      bridgeMemoryIds: c?.bridgeMemoryIds || [],
      fadedCandidateMemoryIds: c?.fadedCandidateMemoryIds || [],
    }));
  }
  if (raw.communities && typeof raw.communities === "object") {
    return Object.values(raw.communities).map((c) => ({
      id: c?.id,
      representativeMemoryIds: c?.representativeMemoryIds || [],
      bridgeMemoryIds: c?.bridgeMemoryIds || [],
      fadedCandidateMemoryIds: c?.fadedCandidateMemoryIds || [],
    }));
  }
  return [];
}

function buildMemoryMap(raw, requestContext, now) {
  const map = new Map();
  if (!raw) return map;
  const memories = Array.isArray(raw.memories) ? raw.memories : [];
  for (const m of memories) {
    const normalized = normalizeMemoryEntry(m);
    if (normalized && authorizeCrrMemory(normalized, requestContext, {
      now,
      allowLegacyUnbound: requestContext == null,
    })) {
      map.set(String(normalized.id), normalized);
    }
  }
  const entries = raw.entries && typeof raw.entries === "object" ? raw.entries : {};
  for (const [id, m] of Object.entries(entries)) {
    const key = String(id);
    const normalized = normalizeMemoryEntry(m);
    if (!map.has(key) && normalized && String(normalized.id) === key && authorizeCrrMemory(normalized, requestContext, {
      now,
      allowLegacyUnbound: requestContext == null,
    })) {
      map.set(key, normalized);
    }
  }
  return map;
}

function normalizeSemanticLens(input, requestContext, now) {
  const raw = input?.index ?? input;
  return {
    raw,
    isRemote: isRemoteLensShape(raw),
    communities: normalizeCommunities(raw),
    memoryMap: buildMemoryMap(raw, requestContext, now),
  };
}

// Statuses that mean a memory is no longer current and must never resurface
// in reactivation (mirrors the active-only filter of the main recall pipeline).
const INACTIVE_REACTIVATION_STATUSES = new Set(["superseded", "archived", "deleted", "tombstoned"]);

function normalizeMemoryEntry(maybeEntry) {
  if (!maybeEntry) return null;
  const entry = maybeEntry.entry ?? maybeEntry;
  if (!entry || typeof entry !== "object") return null;
  // Drop explicitly-inactive memories. Entries without a status (e.g. legacy
  // lens rows) are treated as active so reactivation is not over-filtered.
  const status = entry.status ?? entry.plur1bus_status;
  if (status && INACTIVE_REACTIVATION_STATUSES.has(String(status))) return null;
  const epistemicStatus = normalizeEpistemicStatus(entry.epistemicStatus);
  if (epistemicStatus === "invalidated") return null;
  return {
    id: entry.id ?? entry.memory_id ?? entry.memoryId ?? maybeEntry.id,
    category: entry.category ?? "memory",
    display: entry.display || entry.summary || entry.text || "",
    text: entry.text || entry.summary || "",
    summary: entry.summary || "",
    memoryStrength: typeof entry.memoryStrength === "number"
      ? entry.memoryStrength
      : (entry.strength ?? 1.0),
    faded: entry.faded === true,
    status: renderPromptMemoryAttrs({ ...entry, status }).status,
    epistemicStatus,
    expiresAt: entry.expiresAt ?? 0,
    scope: entry.scope ?? "",
    agentId: entry.agentId ?? "",
    storedBy: entry.storedBy ?? "",
    workspaceId: entry.workspaceId ?? "",
    workspaceKey: entry.workspaceKey ?? "",
    ownerUserId: entry.ownerUserId ?? "",
    createdAt: entry.createdAt ?? 0,
    updatedAt: entry.updatedAt ?? undefined,
  };
}

async function resolveMemoryById(id, lens, getMemoryById, {
  requestContext,
  now = Date.now(),
  expectedOwnership = null,
  logger = null,
} = {}) {
  const key = String(id);
  if (lens.memoryMap.has(key)) {
    const normalized = normalizeMemoryEntry(lens.memoryMap.get(key));
    return normalized && String(normalized.id) === key && authorizeCrrMemory(normalized, requestContext, {
      now,
      expectedOwnership,
      allowLegacyUnbound: requestContext == null && !expectedOwnership,
    }) ? normalized : null;
  }
  if (typeof getMemoryById === "function") {
    try {
      const fetched = await getMemoryById(key);
      const normalized = normalizeMemoryEntry(fetched);
      if (normalized && String(normalized.id) === key && authorizeCrrMemory(normalized, requestContext, {
        now,
        expectedOwnership,
        allowLegacyUnbound: requestContext == null && !expectedOwnership,
      })) {
        lens.memoryMap.set(key, normalized);
        return normalized;
      }
    } catch (_err) {
      safeDebug(logger, "conversation-reactivation-recall.hydrate", _err, { memoryId: key });
    }
  }
  return null;
}

function collectKnownMemories(lens, requestContext, now) {
  const out = [];
  for (const m of lens.memoryMap.values()) {
    const normalized = normalizeMemoryEntry(m);
    if (normalized && authorizeCrrMemory(normalized, requestContext, {
      now,
      allowLegacyUnbound: requestContext == null,
    })) out.push(normalized);
  }
  return out;
}

const CONTINUATION_SIGNALS = [
  "weiter",
  "wie machen wir weiter",
  "was war der stand",
  "zurück zum projekt",
  "mach da weiter",
  "was fehlt noch",
  "continue",
  "where were we",
  "back to",
  "status",
  "stand",
  "weitergehen",
  "weitermachen",
  "machen wir weiter",
  "wie geht es weiter",
  "was ist der stand",
  "zurück",
  "return to",
  "pick up",
  "resume",
];

// Module-level in-memory session state. Never persisted.
const sessionState = new Map();

function getSessionKey(agentId, sessionKey) {
  return `${agentId || "default"}:${sessionKey || ""}`;
}

function getState(agentId, sessionKey) {
  const key = getSessionKey(agentId, sessionKey);
  if (!sessionState.has(key)) {
    sessionState.set(key, {});
  }
  return sessionState.get(key);
}

/**
 * Marks the timestamp of the last user turn for a session.
 */
export function markUserTurn(agentId, sessionKey, now) {
  const state = getState(agentId, sessionKey);
  state.lastUserTurnAt = now;
}

/**
 * Marks the timestamp of the last CRR run for a session.
 */
export function markCrrRun(agentId, sessionKey, now) {
  const state = getState(agentId, sessionKey);
  state.lastCrrAt = now;
}

function isContinuationSignal(messageText) {
  const normalized = String(messageText || "").toLowerCase().trim();
  if (normalized.length === 0) return false;
  return CONTINUATION_SIGNALS.some((signal) => normalized.includes(signal));
}

function isShortIrrelevantMessage(messageText) {
  const text = String(messageText || "").trim();
  if (text.length >= 5) return false;
  if (isContinuationSignal(text)) return false;
  return true;
}

/**
 * Decides whether CRR should run for this user turn.
 */
export function shouldRunConversationReactivation({
  cfg,
  now,
  lastUserTurnAt,
  lastCrrAt,
  compactedAt,
  messageText,
  baseRecallTopScore,
}) {
  if (cfg.enabled !== true) return false;
  if (!messageText || !String(messageText).trim()) return false;

  const cooldownMs = (cfg.cooldownMinutes ?? 30) * 60_000;
  if (lastCrrAt && now - lastCrrAt < cooldownMs) return false;

  if (isShortIrrelevantMessage(messageText)) return false;

  const idleThresholdMs = (cfg.idleThresholdMinutes ?? 45) * 60_000;
  const isIdle = lastUserTurnAt && now - lastUserTurnAt > idleThresholdMs;
  const isContinuation = isContinuationSignal(messageText);
  const isFirstRealMessage = !lastUserTurnAt && String(messageText).trim().length >= 5;
  const wasCompacted = compactedAt && lastCrrAt && compactedAt > lastCrrAt;

  const hasStrongRecall = baseRecallTopScore >= 0.85;

  if (hasStrongRecall && !isIdle && !isContinuation && !wasCompacted && !isFirstRealMessage) {
    return false;
  }

  return Boolean(isIdle || isContinuation || wasCompacted || isFirstRealMessage);
}

function significantTokenSet(text) {
  const raw = tokenize(text);
  return new Set([...raw].filter(t => !GENERIC_TOKENS.has(t)));
}

function hasTokenOverlap(a, b, minOverlap = MIN_SIGNIFICANT_OVERLAP) {
  const sa = significantTokenSet(a);
  const sb = significantTokenSet(b);
  if (sa.size === 0 || sb.size === 0) return false;
  let overlap = 0;
  for (const token of sa) {
    if (sb.has(token)) {
      overlap++;
      if (overlap >= minOverlap) return true;
    }
  }
  return false;
}

function hasDisplayText(memory) {
  const text = memory.display || memory.text || memory.summary || "";
  return String(text).trim().length > 0;
}

function makeCandidate(memory, source, extra = {}) {
  return {
    id: memory.id,
    category: memory.category || "memory",
    source,
    display: memory.display || memory.text || memory.summary || "",
    memoryStrength: typeof memory.memoryStrength === "number"
      ? memory.memoryStrength
      : (memory.strength ?? 1.0),
    faded: memory.faded === true || (typeof memory.memoryStrength === "number"
      ? memory.memoryStrength < DEFAULT_FADED_THRESHOLD
      : false),
    createdAt: memory.createdAt ?? 0,
    updatedAt: memory.updatedAt ?? undefined,
    epistemicStatus: memory.epistemicStatus,
    expiresAt: memory.expiresAt ?? 0,
    scope: memory.scope ?? "",
    agentId: memory.agentId ?? "",
    storedBy: memory.storedBy ?? "",
    workspaceId: memory.workspaceId ?? "",
    workspaceKey: memory.workspaceKey ?? "",
    ownerUserId: memory.ownerUserId ?? "",
    ...extra,
  };
}

/**
 * Selects memories to reactivate based on cheap heuristics.
 */
export async function selectReactivationMemories({
  prompt,
  baseRecallIds,
  semanticLens,
  graphEdges,
  cfg,
  getMemoryById,
  decisionTrace,
  requestContext = null,
  now = Date.now(),
  logger = null,
}) {
  cfg = cfg || {};
  const effectiveNow = now ?? Date.now();
  const promptText = String(prompt || "");
  const baseIds = new Set(baseRecallIds ? [...baseRecallIds].map(String) : []);
  const selected = [];
  const selectedIds = new Set();

  const maxMemories = Math.min(HARD_MAX_REACTIVATION_MEMORIES, Math.max(0, cfg.maxReactivationMemories ?? HARD_MAX_REACTIVATION_MEMORIES));
  const maxFaded = Math.min(HARD_MAX_FADED_REACTIVATION_MEMORIES, Math.max(0, cfg.maxFadedReactivationMemories ?? HARD_MAX_FADED_REACTIVATION_MEMORIES));
  const maxThreads = Math.min(HARD_MAX_OPEN_THREADS, Math.max(0, cfg.maxOpenThreads ?? HARD_MAX_OPEN_THREADS));
  const maxCommunities = Math.min(HARD_MAX_COMMUNITIES, Math.max(0, cfg.maxCommunities ?? HARD_MAX_COMMUNITIES));

  if (maxMemories === 0) return { memories: [] };

  const lens = normalizeSemanticLens(semanticLens, requestContext, effectiveNow);
  // Hydration budget for community candidates missing from the lens memoryMap.
  let communityHydrations = 0;

  const trace = decisionTrace || null;

  function traceCandidate(candidate) {
    if (!trace || !candidate || !candidate.id) return;
    addTraceCandidate(trace, {
      id: candidate.id,
      source: "reactivation",
      category: candidate.category,
      text: candidate.display,
      score: candidate.memoryStrength,
    });
  }

  function traceInclusion(memoryId, sourceLabel) {
    if (!trace) return;
    addTraceDecision(trace, {
      memoryId,
      action: "inclusion",
      stage: "reactivation",
      reason: `selected via ${sourceLabel}`,
      scoreBreakdown: { source: "reactivation", evidence: "derived" },
    });
  }

  function traceRejection(memoryId, reason) {
    if (!trace) return;
    addTraceDecision(trace, {
      memoryId,
      action: "rejection",
      stage: "reactivation",
      reason,
    });
  }

  function getRejectionReason(candidate) {
    if (!candidate || !candidate.id) return "invalid candidate";
    const id = String(candidate.id);
    if (baseIds.has(id)) return "already in base recall";
    if (selectedIds.has(id)) return "duplicate candidate";
    if (!hasDisplayText(candidate)) return "no display text";
    const fadedCount = selected.filter((m) => m.faded).length;
    if (candidate.faded && fadedCount >= maxFaded) return "faded limit reached";
    if (selected.length >= maxMemories) return "max reactivation memories reached";
    return null;
  }

  function addCandidate(candidate) {
    if (!candidate || !candidate.id) return false;
    const id = String(candidate.id);
    if (baseIds.has(id)) return false;
    if (selectedIds.has(id)) return false;
    if (!hasDisplayText(candidate)) return false;

    const fadedCount = selected.filter((m) => m.faded).length;
    if (candidate.faded && fadedCount >= maxFaded) return false;

    if (selected.length >= maxMemories) return false;

    selected.push(candidate);
    selectedIds.add(id);
    return true;
  }

  async function resolveCommunityCandidate(id) {
    const key = String(id);
    // Fast path: candidate is already in the lens index, no DB lookup needed.
    if (lens.memoryMap.has(key)) {
      const normalized = normalizeMemoryEntry(lens.memoryMap.get(key));
      return normalized && String(normalized.id) === key && authorizeCrrMemory(normalized, requestContext, {
        now: effectiveNow,
        allowLegacyUnbound: requestContext == null,
      }) ? normalized : null;
    }
    // Budget-limited fallback for candidates referenced by the index but not
    // shipped with it. This prevents a long candidate list from timing out CRR.
    if (communityHydrations >= MAX_COMMUNITY_HYDRATIONS) return null;
    if (typeof getMemoryById !== "function") return null;
    try {
      communityHydrations++;
      const fetched = await getMemoryById(key);
      const normalized = normalizeMemoryEntry(fetched);
      if (normalized && String(normalized.id) === key && authorizeCrrMemory(normalized, requestContext, {
        now: effectiveNow,
        allowLegacyUnbound: requestContext == null,
      })) {
        lens.memoryMap.set(key, normalized);
        return normalized;
      }
    } catch (_err) {
      safeDebug(logger, "conversation-reactivation-recall.community-hydrate", _err, { memoryId: key });
    }
    return null;
  }

  // 1. Representative memories from Semantic-Lens communities matching the prompt.
  const usedCommunityIds = new Set();
  for (const community of lens.communities) {
    if (usedCommunityIds.size >= maxCommunities) break;
    if (!community?.id) continue;

    const candidateIds = [
      ...(community.representativeMemoryIds || []),
      ...(community.bridgeMemoryIds || []),
    ];

    let matchedThisCommunity = false;
    for (let i = 0; i < candidateIds.length && selected.length < maxMemories;) {
      const id = candidateIds[i];
      if (selected.length >= maxMemories) break;

      // Pre-filter candidates already present in the lens map: skip non-overlapping
      // ones without even normalizing them.
      const mapped = lens.memoryMap.get(String(id));
      if (mapped) {
        const mappedMemory = normalizeMemoryEntry(mapped);
        i++;
        if (!authorizeCrrMemory(mappedMemory, requestContext, {
          now: effectiveNow,
          allowLegacyUnbound: requestContext == null,
        })) continue;
        const mappedText = mappedMemory.display || mappedMemory.text || mappedMemory.summary || "";
        if (!hasTokenOverlap(promptText, mappedText)) {
          if (trace) {
            const candidate = makeCandidate(mappedMemory, "semantic-lens-community", { communityId: community.id });
            traceCandidate(candidate);
            traceRejection(candidate.id, "insufficient token overlap");
          }
          continue;
        }
        if (!hasDisplayText(mappedMemory)) {
          if (trace) {
            const candidate = makeCandidate(mappedMemory, "semantic-lens-community", { communityId: community.id });
            traceCandidate(candidate);
            traceRejection(candidate.id, "no display text");
          }
          continue;
        }
        const candidate = makeCandidate(mappedMemory, "semantic-lens-community", { communityId: community.id });
        traceCandidate(candidate);
        const rejectReason = getRejectionReason(candidate);
        const added = addCandidate(candidate);
        if (added) {
          traceInclusion(candidate.id, "semantic-lens-community");
          matchedThisCommunity = true;
        } else {
          traceRejection(candidate.id, rejectReason || "not selected");
        }
        continue;
      }

      const remainingHydrations = MAX_COMMUNITY_HYDRATIONS - communityHydrations;
      if (remainingHydrations <= 0 || typeof getMemoryById !== "function") {
        i++;
        continue;
      }

      const missingIds = [];
      while (i < candidateIds.length && missingIds.length < remainingHydrations) {
        const missingId = candidateIds[i];
        if (lens.memoryMap.has(String(missingId))) break;
        missingIds.push(missingId);
        i++;
      }

      const hydrated = await Promise.all(missingIds.map((missingId) => resolveCommunityCandidate(missingId)));
      for (const memory of hydrated) {
        if (selected.length >= maxMemories) break;
        if (!memory || !hasDisplayText(memory)) {
          if (memory && trace) {
            const candidate = makeCandidate(memory, "semantic-lens-community", { communityId: community.id });
            traceCandidate(candidate);
            traceRejection(candidate.id, "no display text");
          }
          continue;
        }
        const text = memory.display || memory.text || memory.summary || "";
        const candidate = makeCandidate(memory, "semantic-lens-community", { communityId: community.id });
        traceCandidate(candidate);
        if (!hasTokenOverlap(promptText, text)) {
          traceRejection(candidate.id, "insufficient token overlap");
          continue;
        }
        const rejectReason = getRejectionReason(candidate);
        const added = addCandidate(candidate);
        if (added) {
          traceInclusion(candidate.id, "semantic-lens-community");
          matchedThisCommunity = true;
        } else {
          traceRejection(candidate.id, rejectReason || "not selected");
        }
      }
    }
    if (matchedThisCommunity) {
      usedCommunityIds.add(community.id);
    }
  }

  // 2. Bridge memories found via graphEdges from base-recall ids.
  // Only schema-bound edges with both endpoint ACL tuples are eligible. This
  // also rejects all legacy ID-only edges at the runtime orchestrator. Keep a
  // narrow unmarked legacy selector compatibility path for direct callers of
  // this pure helper; runConversationReactivationRecall never forwards it.
  const candidateEdges = Array.isArray(graphEdges) ? graphEdges : [];
  const edges = hasCanonicalRequestContext(requestContext)
    ? filterGraphEdgesForRequest(candidateEdges, requestContext)
    : requestContext == null
      ? candidateEdges.filter((edge) => (
        edge
        && edge.needsRebuild !== true
        && !edge.sourceOwnership
        && !edge.targetOwnership
        && !edge.ownership
      ))
      : [];
  if (baseIds.size > 0 && selected.length < maxMemories) {
    for (const edge of edges) {
      if (!edge || !edge.source || !edge.target) continue;
      const bridgeId = baseIds.has(String(edge.source)) ? String(edge.target) : baseIds.has(String(edge.target)) ? String(edge.source) : null;
      if (!bridgeId) continue;
      if (baseIds.has(bridgeId) || selectedIds.has(bridgeId)) {
        if (trace) {
          traceCandidate({ id: bridgeId, category: "memory", display: "", memoryStrength: undefined });
          traceRejection(bridgeId, baseIds.has(bridgeId) ? "already in base recall" : "duplicate candidate");
        }
        continue;
      }
      const memory = await resolveMemoryById(bridgeId, lens, getMemoryById, {
        requestContext,
        now: effectiveNow,
        expectedOwnership: edgeOwnershipForEndpoint(edge, bridgeId),
        logger,
      });
      if (!memory || !hasDisplayText(memory)) {
        if (memory && trace) {
          const candidate = makeCandidate(memory, "graph-bridge");
          traceCandidate(candidate);
          traceRejection(candidate.id, "no display text");
        }
        continue;
      }
      const candidate = makeCandidate(memory, "graph-bridge");
      traceCandidate(candidate);
      const rejectReason = getRejectionReason(candidate);
      const added = addCandidate(candidate);
      if (added) {
        traceInclusion(candidate.id, "graph-bridge");
      } else {
        traceRejection(candidate.id, rejectReason || "not selected");
      }
      if (selected.length >= maxMemories) break;
    }
  }

  // 3. Open project/plan memories when prompt signals continuation.
  // 4. At most one faded memory, only if strongly matching.
  // Both operate entirely on the lens memoryMap, so they are cheap and share one scan.
  const knownMemories = collectKnownMemories(lens, requestContext, effectiveNow);
  const isContinuation = isContinuationSignal(promptText);
  if (isContinuation && selected.length < maxMemories) {
    let threadsUsed = 0;
    for (const memory of knownMemories) {
      if (!memory || !hasDisplayText(memory)) {
        if (memory && trace) {
          const candidate = makeCandidate(memory, "open-project");
          traceCandidate(candidate);
          traceRejection(candidate.id, "no display text");
        }
        continue;
      }
      const category = String(memory.category || "").toLowerCase();
      if (!["project", "plan", "goal", "task", "decision"].includes(category)) continue;
      const text = memory.display || memory.text || memory.summary || "";
      const candidate = makeCandidate(memory, "open-project");
      traceCandidate(candidate);
      if (!hasTokenOverlap(promptText, text)) {
        traceRejection(candidate.id, "insufficient token overlap");
        continue;
      }
      const rejectReason = getRejectionReason(candidate);
      const added = addCandidate(candidate);
      if (added) {
        traceInclusion(candidate.id, "open-project");
        threadsUsed++;
        if (threadsUsed >= maxThreads) break;
      } else {
        traceRejection(candidate.id, rejectReason || "not selected");
      }
    }
  }

  if (selected.length < maxMemories) {
    for (const memory of knownMemories) {
      if (!memory || !memory.faded || !hasDisplayText(memory)) {
        if (memory && memory.faded && trace) {
          const candidate = makeCandidate(memory, "faded-memory");
          traceCandidate(candidate);
          traceRejection(candidate.id, "no display text");
        }
        continue;
      }
      const text = memory.display || memory.text || memory.summary || "";
      const candidate = makeCandidate(memory, "faded-memory");
      traceCandidate(candidate);
      if (!hasTokenOverlap(promptText, text, 2)) {
        traceRejection(candidate.id, "insufficient token overlap");
        continue;
      }
      const rejectReason = getRejectionReason(candidate);
      const added = addCandidate(candidate);
      if (added) {
        traceInclusion(candidate.id, "faded-memory");
        break;
      } else {
        traceRejection(candidate.id, rejectReason || "not selected");
      }
    }
  }

  return { memories: selected };
}

/**
 * Formats selected reactivation memories into a <memory-reactivation> block.
 */
export function formatReactivationContext(memories, {
  visibleHints = false,
  now = Date.now(),
  requestContext = null,
} = {}) {
  const safeMemories = (Array.isArray(memories) ? memories : []).filter((memory) => (
    authorizeCrrMemory(memory, requestContext, {
      now,
      allowLegacyUnbound: requestContext == null,
    })
  ));
  if (safeMemories.length === 0) return "";

  const items = safeMemories
    .map((m) => {
      const category = sanitizeMemoryContextAttribute(m.category, "memory");
      const id = sanitizeMemoryContextAttribute(m.id, "id");
      const display = sanitizeMemoryTextForPrompt(m.display, 400);
      const fadedAttr = m.faded ? ' faded="true"' : "";
      // Ohne diese Attribute war der Reactivation-Block der einzige Memory-Block
      // ganz ohne Zeitbezug — der Agent konnte reaktivierte Einträge zeitlich
      // nicht einordnen.
      const { ageLabel, freshness } = buildTemporalProvenance(m, { now });
      const temporalAttr = ` age="${escapeMemoryText(ageLabel)}" freshness="${sanitizeMemoryContextAttribute(freshness, "unknown")}"`;
      return `  <memory-record category="${category}" source="reactivation" id="${id}"${fadedAttr}${temporalAttr}><quoted-evidence>${display}</quoted-evidence></memory-record>`;
    })
    .join("\n");

  const hint = visibleHints
    ? "\n[HINT: The following memories were reactivated because the conversation appears to resume after a gap.]"
    : "";

  return `<memory-reactivation untrusted="true" mode="historical-evidence-only">${hint}
${buildRecallSafetyPreamble({ compact: true })}
${items}
</memory-reactivation>`;
}

/**
 * Orchestrates the conversation reactivation recall hook.
 * @param {Object} options CRR inputs, including the canonical request context.
 * @returns {Promise<{context: string, additions: Array, trace: Object|null}>} Additive reactivation result.
 */
export async function runConversationReactivationRecall({
  prompt,
  messageText,
  baseRecallIds,
  baseRecallTopScore,
  workspaceDir,
  neoStore,
  graphEdges,
  requestContext = null,
  cfg,
  agentId,
  sessionKey,
  now,
  logger,
  compactedAt,
  getMemoryById,
  decisionTrace,
}) {
  cfg = cfg || {};
  agentId = agentId || "default";
  sessionKey = sessionKey || "";

  const trace = decisionTrace || null;

  // 1. If disabled, mark user turn and return empty.
  if (cfg.enabled !== true) {
    markUserTurn(agentId, sessionKey, now);
    return { context: "", additions: [], trace };
  }

  try {
    now = now ?? Date.now();
    // 2. Load module-level session state.
    const state = getState(agentId, sessionKey);
    const lastUserTurnAt = state.lastUserTurnAt || null;
    const lastCrrAt = state.lastCrrAt || null;

    // 3. Compute trigger.
    const shouldRun = shouldRunConversationReactivation({
      cfg,
      now,
      lastUserTurnAt,
      lastCrrAt,
      compactedAt,
      messageText,
      baseRecallTopScore: typeof baseRecallTopScore === "number" ? baseRecallTopScore : 0,
    });

    if (!shouldRun) {
      markUserTurn(agentId, sessionKey, now);
      return { context: "", additions: [], trace };
    }

    if (trace) {
      addTraceGuard(trace, {
        name: "reactivation-trigger",
        passed: true,
        reason: "conversation reactivation triggered",
      });
    }

    // 4. Cheap reads.
    const semanticLens = loadSemanticLensIndexForCrr(workspaceDir);
    // Graph edges are only useful when there are base-recall IDs to bridge from.
    const hasBaseIds = baseRecallIds && (baseRecallIds.size > 0 || baseRecallIds.length > 0);
    const rawGraphEdges = Array.isArray(graphEdges)
      ? graphEdges
      : (hasBaseIds && hasCanonicalRequestContext(requestContext) && neoStore && typeof neoStore.readGraphEdges === "function"
          ? neoStore.readGraphEdges(1000)
          : []);
    const safeGraphEdges = filterGraphEdgesForRequest(rawGraphEdges, requestContext);

    // 5. Select memories.
    const { memories } = await selectReactivationMemories({
      prompt,
      baseRecallIds,
      semanticLens,
      graphEdges: safeGraphEdges,
      cfg,
      getMemoryById,
      decisionTrace: trace,
      requestContext,
      now,
      logger,
    });

    // 6. Format context.
    const context = formatReactivationContext(memories, {
      visibleHints: cfg.visibleHints === true,
      requestContext,
      now,
    });

    // 7. Mark CRR run, then mark user turn.
    markCrrRun(agentId, sessionKey, now);
    markUserTurn(agentId, sessionKey, now);

    if (trace) summarizeTrace(trace);

    return { context, additions: memories, trace };
  } catch (err) {
    // 8. Silent fallback.
    logger?.warn?.(`conversation-reactivation-recall: ${err.message}`);
    markUserTurn(agentId, sessionKey, now);
    return { context: "", additions: [], trace };
  }
}

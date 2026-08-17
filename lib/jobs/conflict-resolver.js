/**
 * lib/jobs/conflict-resolver.js — Automatische Konflikt-Auflösung.
 *
 * Liest unaufgelöste Konflikte aus conflict-log.jsonl und versucht,
 * sie via LLM aufzulösen. Nur Konflikte älter als 7 Tage werden
 * berücksichtigt (reife Entscheidungsbasis).
 *
 * Sicherheitsgarantien:
 * - Ohne LLM/Embeddings: Konflikte werden als "uncertain" markiert, NIEMALS auto-applied.
 * - Alle Resolutionen werden als Proposal gespeichert; Apply nur via Safe Reconsolidation.
 * - Recommendation-Feld: "review_only" (schwache Evidenz) oder "apply_via_safe_reconsolidation" (starke Evidenz).
 * - Dieser Job läuft innerhalb der Daily Consolidation, die durch job-rate-limit.js auf 1×/Tag/Agent begrenzt ist.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { readJsonl } from "../jsonl-utils.js";
import {
  LLM_RESULT_CACHE_PURPOSES,
  withLlmCallContext,
  withLlmResultCacheContext,
} from "../llm-result-cache.js";
import {
  LLM_FAILURE_REASONS,
  safeWarnLlmFailure,
  withAbortableLlmTimeout,
} from "../llm-failure.js";


const MAX_LOG_SIZE_MB = 50;

const DEFAULT_OPTS = {
  minAgeDays: 7,
  maxConflicts: 20,
  llmTimeoutMs: 30000,
  dryRun: false,
};

const HIGH_CONFIDENCE_THRESHOLD = 0.9;

// ─── Utilities ─────────────────────────────────────────────────────────────

function readConflictLog(workspaceDir) {
  const path = join(workspaceDir, ".adaptive-learning", "conflict-log.jsonl");
  return readJsonl(path, {
    maxBytes: MAX_LOG_SIZE_MB * 1024 * 1024,
    onSkip: () => console.warn(`conflict-resolver: conflict-log.jsonl too large (> ${MAX_LOG_SIZE_MB}MB), skipping`),
  });
}

function readResolvedLog(workspaceDir) {
  const path = join(workspaceDir, ".adaptive-learning", "conflict-resolved.jsonl");
  return readJsonl(path, {
    maxBytes: MAX_LOG_SIZE_MB * 1024 * 1024,
    onSkip: () => console.warn(`conflict-resolver: conflict-resolved.jsonl too large (> ${MAX_LOG_SIZE_MB}MB), skipping`),
  });
}

function extractKeywords(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\wäöüß\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 4);
}

function keywordOverlap(a, b) {
  const wordsA = new Set(extractKeywords(a));
  const wordsB = new Set(extractKeywords(b));
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.max(wordsA.size, wordsB.size);
}

function groupConflictsByTopic(conflicts) {
  const groups = [];
  for (const c of conflicts) {
    const text = `${c.newText || ""} ${c.existingText || ""}`;
    let placed = false;
    for (const group of groups) {
      const groupText = `${group[0].newText || ""} ${group[0].existingText || ""}`;
      if (keywordOverlap(text, groupText) >= 0.3) {
        group.push(c);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([c]);
  }
  return groups;
}

/**
 * Resolve one conflict with deterministic agent-scoped LLM settings.
 * @param {object} conflict
 * @param {object} llmCfg
 * @param {Function} callLlm
 * @param {number} timeoutMs
 * @param {object} logger
 * @param {string} agentId
 * @returns {Promise<object>}
 */
async function resolveConflictPair(conflict, llmCfg, callLlm, timeoutMs, logger, agentId) {
  const prompt = `Zwei Memory-Fragmente widersprechen sich. Analysiere und entscheide:

Fragment A (Agent ${conflict.existingAgentId || "?"}):
"${String(conflict.existingText || "").slice(0, 500)}"

Fragment B (Agent ${conflict.newAgentId || "?"}):
"${String(conflict.newText || "").slice(0, 500)}"

Antworte NUR mit diesem JSON:
{
  "resolution": "keep_a|keep_b|merge|uncertain",
  "confidence": 0.85,
  "reason": "kurze Begründung",
  "mergedText": "nur wenn resolution=merge"
}

Regeln:
- keep_a: Fragment A ist korrekter
- keep_b: Fragment B ist korrekter
- merge: Beide sind teilweise korrekt, vereinige sie
- uncertain: Nicht eindeutig entscheidbar
- confidence: 0.0–1.0, wie sicher bist du?
- mergedText muss ALLE Informationen aus beiden enthalten
- confidence >= 0.9 bedeutet "hohe Empfehlung", aber NICHT automatisches Anwenden
- Alle Resolutionen werden als Proposal gespeichert; Apply erfolgt nur via Safe Reconsolidation`;
  const callContext = llmCfg?.callContext || {};

  try {
    const result = await withAbortableLlmTimeout(
      (signal) => callLlm(
        [{ role: "user", content: prompt }],
        withLlmCallContext(
          withLlmResultCacheContext(
            { ...llmCfg, jsonMode: true, maxTokens: 400, temperature: 0 },
            agentId,
            LLM_RESULT_CACHE_PURPOSES.CONFLICT_RESOLUTION,
          ),
          callContext.agentId || (typeof callContext.runtimeLlm?.complete === "function" ? undefined : agentId),
          LLM_RESULT_CACHE_PURPOSES.CONFLICT_RESOLUTION,
          { runtimeLlm: callContext.runtimeLlm, signal },
        ),
      ),
      {
        timeoutMs,
        signal: callContext.signal,
        label: "conflict resolution",
      },
    );
    if (!result) {
      return {
        resolution: "uncertain",
        confidence: 0,
        reason: LLM_FAILURE_REASONS.INVALID_RESPONSE,
      };
    }
    const parsed = JSON.parse(result);
    if (!["keep_a", "keep_b", "merge", "uncertain"].includes(parsed.resolution)) {
      return {
        resolution: "uncertain",
        confidence: 0,
        reason: LLM_FAILURE_REASONS.INVALID_RESPONSE,
      };
    }
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    return { ...parsed, confidence };
  } catch (err) {
    const reason = safeWarnLlmFailure(logger, "conflict-resolver.llm", err);
    return { resolution: "uncertain", confidence: 0, reason };
  }
}

function appendResolvedLog(workspaceDir, entry) {
  const dir = join(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "conflict-resolved.jsonl");
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

// ─── Hauptfunktion ─────────────────────────────────────────────────────────

/**
 * Propose deterministic LLM resolutions for one agent's eligible conflicts.
 * @param {object} [opts]
 * @param {string} [opts.agentId]
 * @returns {Promise<object>}
 */
export async function runConflictResolver(opts = {}) {
  const mergedOpts = { ...DEFAULT_OPTS, ...opts };
  const {
    workspaceDir,
    llmCfg,
    callLlm,
    minAgeDays,
    maxConflicts,
    llmTimeoutMs,
    dryRun,
    agentId,
    logger = { info: () => {}, warn: () => {} },
  } = mergedOpts;

  const startTime = Date.now();

  if (!workspaceDir) {
    return { resolved: 0, note: "workspaceDir missing", durationMs: 0 };
  }

  const allConflicts = readConflictLog(workspaceDir);
  if (allConflicts.length === 0) {
    return { resolved: 0, scanned: 0, note: "no_conflicts", durationMs: 0 };
  }

  // Bereits aufgelöste Konflikte deduplizieren
  const alreadyResolved = new Set();
  const resolvedLog = readResolvedLog(workspaceDir);
  for (const r of resolvedLog) {
    const orig = r.original || {};
    const key = `${orig.newMemoryId || ""}::${orig.existingMemoryId || ""}`;
    if (key) alreadyResolved.add(key);
  }

  const cutoff = Date.now() - minAgeDays * 86400000;
  const eligible = allConflicts
    .filter(c => {
      if (!c.timestamp || new Date(c.timestamp).getTime() > cutoff) return false;
      const key = `${c.newMemoryId || ""}::${c.existingMemoryId || ""}`;
      return !alreadyResolved.has(key);
    })
    .slice(0, maxConflicts);

  if (eligible.length === 0) {
    return { resolved: 0, scanned: allConflicts.length, note: "no_eligible_conflicts", durationMs: 0 };
  }

  logger.info?.(`conflict-resolver: ${eligible.length} eligible conflicts (of ${allConflicts.length})`);

  const groups = groupConflictsByTopic(eligible);
  let resolved = 0;
  let proposed = 0;
  let uncertain = 0;
  const errors = [];

  for (const group of groups) {
    for (const conflict of group) {
      if (!llmCfg || !callLlm) {
        uncertain++;
        continue;
      }

      const decision = await resolveConflictPair(conflict, llmCfg, callLlm, llmTimeoutMs, logger, agentId);
      const highConfidence = decision.confidence >= HIGH_CONFIDENCE_THRESHOLD && decision.resolution !== "uncertain";

      const resolvedEntry = {
        original: conflict,
        resolution: decision.resolution,
        confidence: decision.confidence,
        reason: decision.reason,
        recommendation: highConfidence ? "apply_via_safe_reconsolidation" : "review_only",
        resolvedAt: new Date().toISOString(),
        dryRun,
      };

      if (decision.resolution === "uncertain") {
        uncertain++;
      } else if (highConfidence) {
        resolved++;
      } else {
        proposed++;
      }

      if (!dryRun) {
        appendResolvedLog(workspaceDir, resolvedEntry);
      }
    }
  }

  logger.info?.(`conflict-resolver: ${resolved} resolved, ${proposed} proposed, ${uncertain} uncertain`);

  return {
    resolved,
    proposed,
    uncertain,
    scanned: eligible.length,
    groups: groups.length,
    dryRun,
    durationMs: Date.now() - startTime,
    errors: errors.length,
  };
}

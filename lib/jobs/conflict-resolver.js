/**
 * lib/jobs/conflict-resolver.js — Automatische Konflikt-Auflösung.
 *
 * Liest unaufgelöste Konflikte aus conflict-log.jsonl und versucht,
 * sie via LLM aufzulösen. Nur Konflikte älter als 7 Tage werden
 * berücksichtigt (reife Entscheidungsbasis).
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

const MAX_LOG_SIZE_MB = 50;

const DEFAULT_OPTS = {
  minAgeDays: 7,
  maxConflicts: 20,
  llmTimeoutMs: 30000,
  dryRun: false,
};

const AUTO_APPLY_THRESHOLD = 0.9;

// ─── Utilities ─────────────────────────────────────────────────────────────

function readConflictLog(workspaceDir) {
  const path = join(workspaceDir, ".adaptive-learning", "conflict-log.jsonl");
  if (!existsSync(path)) return [];
  const sizeMb = statSync(path).size / (1024 * 1024);
  if (sizeMb > MAX_LOG_SIZE_MB) {
    console.warn(`conflict-resolver: conflict-log.jsonl too large (${sizeMb.toFixed(1)}MB > ${MAX_LOG_SIZE_MB}MB), skipping`);
    return [];
  }
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  return lines
    .map(line => {
      try { return JSON.parse(line); } catch (_) { return null; }
    })
    .filter(Boolean);
}

function readResolvedLog(workspaceDir) {
  const path = join(workspaceDir, ".adaptive-learning", "conflict-resolved.jsonl");
  if (!existsSync(path)) return [];
  const sizeMb = statSync(path).size / (1024 * 1024);
  if (sizeMb > MAX_LOG_SIZE_MB) {
    console.warn(`conflict-resolver: conflict-resolved.jsonl too large (${sizeMb.toFixed(1)}MB > ${MAX_LOG_SIZE_MB}MB), skipping`);
    return [];
  }
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  return lines
    .map(line => {
      try { return JSON.parse(line); } catch (_) { return null; }
    })
    .filter(Boolean);
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

async function resolveConflictPair(conflict, llmCfg, callLlm, timeoutMs, logger) {
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
- Nur bei confidence >= 0.9 wird die Resolution automatisch angewendet`;

  try {
    const result = await Promise.race([
      callLlm([{ role: "user", content: prompt }], { ...llmCfg, jsonMode: true, maxTokens: 400 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    if (!result) return { resolution: "uncertain", confidence: 0, reason: "empty_llm_response" };
    const parsed = JSON.parse(result);
    if (!["keep_a", "keep_b", "merge", "uncertain"].includes(parsed.resolution)) {
      return { resolution: "uncertain", confidence: 0, reason: "invalid_resolution" };
    }
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    return { ...parsed, confidence };
  } catch (err) {
    logger?.warn?.(`conflict-resolver: LLM failed: ${err.message}`);
    return { resolution: "uncertain", reason: `llm_error: ${err.message}` };
  }
}

function appendResolvedLog(workspaceDir, entry) {
  const dir = join(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "conflict-resolved.jsonl");
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

// ─── Hauptfunktion ─────────────────────────────────────────────────────────

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

      const decision = await resolveConflictPair(conflict, llmCfg, callLlm, llmTimeoutMs, logger);
      const autoApply = decision.confidence >= AUTO_APPLY_THRESHOLD && decision.resolution !== "uncertain";

      const resolvedEntry = {
        original: conflict,
        resolution: decision.resolution,
        confidence: decision.confidence,
        reason: decision.reason,
        autoApply,
        resolvedAt: new Date().toISOString(),
        dryRun,
      };

      if (decision.resolution === "uncertain") {
        uncertain++;
      } else if (autoApply) {
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

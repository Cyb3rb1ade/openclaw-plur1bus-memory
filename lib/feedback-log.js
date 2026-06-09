/**
 * lib/feedback-log.js — Feedback-Log für kontinuierliches Lernen (Phase 1b).
 *
 * Nur sammeln + reports generieren. KEIN Auto-Tune.
 * Format: JSONL in .adaptive-learning/feedback-log.jsonl
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonl } from "./jsonl-utils.js";
import { applyRetrievalReinforcement } from "./memory-dynamics.js";

export const FEEDBACK_LOG_FILE = "feedback-log.jsonl";
export const FEEDBACK_REPORT_FILE = "feedback-report.json";

const VALID_FEEDBACK = new Set(["positive", "negative", "neutral"]);

function getAdaptiveDir(workspaceDir) {
  const dir = join(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getLogPath(workspaceDir) {
  return join(getAdaptiveDir(workspaceDir), FEEDBACK_LOG_FILE);
}

function getReportPath(workspaceDir) {
  return join(getAdaptiveDir(workspaceDir), FEEDBACK_REPORT_FILE);
}

/**
 * Schreibt einen Feedback-Eintrag atomar (tmp + rename).
 * Bei gleichem query + memoryId wird der alte Eintrag überschrieben (idempotent).
 */
export function recordFeedback(workspaceDir, query, memoryId, feedback, scoreComponents, options = {}) {
  if (!VALID_FEEDBACK.has(feedback)) {
    throw new Error(`Invalid feedback: "${feedback}". Must be one of: positive, negative, neutral`);
  }

  const logPath = getLogPath(workspaceDir);
  const entries = readJsonl(logPath);

  const newEntry = {
    timestamp: Date.now(),
    query: query ?? "",
    memoryId: memoryId ?? "",
    feedback,
    scoreComponents: scoreComponents ?? {},
  };

  // Idempotenz: gleicher query + memoryId → überschreiben
  const existingIndex = entries.findIndex(
    (e) => e.query === newEntry.query && e.memoryId === newEntry.memoryId
  );
  if (existingIndex >= 0) {
    entries[existingIndex] = newEntry;
  } else {
    entries.push(newEntry);
  }

  // Atomares Schreiben
  const tmpPath = logPath + ".tmp";
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(tmpPath, lines, "utf8");
  renameSync(tmpPath, logPath);

  // Dynamics integration (fire-and-forget, promise returned for testability)
  if (
    options?.applyDynamics === true &&
    options?.dbPool &&
    options?.agentId &&
    memoryId &&
    (feedback === "positive" || feedback === "negative")
  ) {
    return (async () => {
      try {
        const db = options.dbPool.getDb(options.agentId);
        const row = await db.getById(memoryId);
        if (!row) return;

        if (feedback === "positive") {
          const patch = applyRetrievalReinforcement(row, Date.now());
          await db.update(memoryId, patch);
        } else if (feedback === "negative") {
          const weakened = Math.max(0.01, (row.memoryStrength ?? 1.0) * 0.8);
          await db.update(memoryId, {
            status: "review",
            memoryStrength: weakened,
            lastDynamicsAt: Date.now(),
          });
        }
      } catch (_) {
        /* silently ignore dynamics errors to keep feedback logging robust */
      }
    })();
  }
}

/**
 * Liest die letzten N Einträge aus dem Feedback-Log (neueste zuerst).
 */
export function readFeedbackLog(workspaceDir, limit) {
  const logPath = getLogPath(workspaceDir);
  const entries = readJsonl(logPath);
  const reversed = entries.slice().reverse();
  if (limit > 0) return reversed.slice(0, limit);
  return reversed;
}

function averageComponents(entries) {
  if (entries.length === 0) return {};
  const keys = new Set();
  for (const e of entries) {
    if (e.scoreComponents && typeof e.scoreComponents === "object") {
      for (const k of Object.keys(e.scoreComponents)) keys.add(k);
    }
  }
  const result = {};
  for (const k of keys) {
    let sum = 0;
    let count = 0;
    for (const e of entries) {
      const val = e.scoreComponents?.[k];
      if (typeof val === "number") {
        sum += val;
        count++;
      }
    }
    result[k] = count > 0 ? sum / count : 0;
  }
  return result;
}

function buildTopList(entries, feedbackType, limit = 10) {
  const counts = new Map();
  for (const e of entries) {
    if (e.feedback === feedbackType) {
      counts.set(e.memoryId, (counts.get(e.memoryId) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([memoryId, count]) => ({ memoryId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * Generiert einen Feedback-Report und persistiert ihn als JSON.
 */
export function generateFeedbackReport(workspaceDir) {
  const entries = readJsonl(getLogPath(workspaceDir));
  const positive = entries.filter((e) => e.feedback === "positive");
  const negative = entries.filter((e) => e.feedback === "negative");
  const neutral = entries.filter((e) => e.feedback === "neutral");

  const report = {
    generatedAt: Date.now(),
    totalEntries: entries.length,
    positiveCount: positive.length,
    negativeCount: negative.length,
    neutralCount: neutral.length,
    topPositive: buildTopList(entries, "positive", 10),
    topNegative: buildTopList(entries, "negative", 10),
    queriesWithBadRecall: negative.map((e) => ({
      query: e.query,
      memoryId: e.memoryId,
      timestamp: e.timestamp,
    })),
    averageScoreComponents: {
      positive: averageComponents(positive),
      negative: averageComponents(negative),
      neutral: averageComponents(neutral),
    },
  };

  // Persistieren
  const reportPath = getReportPath(workspaceDir);
  const tmpPath = reportPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(report, null, 2), "utf8");
  renameSync(tmpPath, reportPath);

  return report;
}

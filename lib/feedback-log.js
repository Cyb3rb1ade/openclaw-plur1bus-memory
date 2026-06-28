/**
 * lib/feedback-log.js — Feedback-Log für kontinuierliches Lernen (Phase 1b).
 *
 * Nur sammeln + reports generieren. KEIN Auto-Tune.
 * Format: JSONL in .adaptive-learning/feedback-log.jsonl
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonl } from "./jsonl-utils.js";
import { applyRetrievalReinforcement } from "./memory-dynamics.js";
import { safeWarn } from "./safe-logging.js";

export const FEEDBACK_LOG_FILE = "feedback-log.jsonl";
export const FEEDBACK_REPORT_FILE = "feedback-report.json";
export const DEFAULT_MAX_FEEDBACK_LOG_ENTRIES = 5000;

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

function normalizeMaxEntries(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function pruneTail(entries, maxEntries) {
  if (!Number.isFinite(maxEntries) || maxEntries <= 0 || entries.length <= maxEntries) return entries;
  return entries.slice(-maxEntries);
}

function writeJsonlAtomic(path, entries) {
  const tmpPath = path + ".tmp";
  const lines = entries.length > 0 ? entries.map((e) => JSON.stringify(e)).join("\n") + "\n" : "";
  writeFileSync(tmpPath, lines, "utf8");
  renameSync(tmpPath, path);
}

function buildFeedbackEntry(query, memoryId, feedback, scoreComponents) {
  if (!VALID_FEEDBACK.has(feedback)) {
    throw new Error(`Invalid feedback: "${feedback}". Must be one of: positive, negative, neutral`);
  }

  return {
    timestamp: Date.now(),
    query: query ?? "",
    memoryId: memoryId ?? "",
    feedback,
    scoreComponents: scoreComponents ?? {},
  };
}

function upsertFeedbackEntries(entries, newEntries) {
  const updated = entries.slice();
  for (const entry of newEntries) {
    const existingIndex = updated.findIndex(
      (e) => e.query === entry.query && e.memoryId === entry.memoryId
    );
    if (existingIndex >= 0) updated.splice(existingIndex, 1);
    updated.push(entry);
  }
  return updated;
}

function shouldApplyDynamics(entry, options) {
  return (
    options?.applyDynamics === true &&
    options?.dbPool &&
    options?.agentId &&
    entry.memoryId &&
    (entry.feedback === "positive" || entry.feedback === "negative")
  );
}

async function applyFeedbackDynamics(entry, options) {
  try {
    const db = options.dbPool.getDb(options.agentId);
    const row = await db.getById(entry.memoryId);
    if (!row) return;

    if (entry.feedback === "positive") {
      const patch = applyRetrievalReinforcement(row, Date.now());
      await db.update(entry.memoryId, patch);
    } else if (entry.feedback === "negative") {
      const weakened = Math.max(0.01, (row.memoryStrength ?? 1.0) * 0.8);
      await db.update(entry.memoryId, {
        status: "review",
        memoryStrength: weakened,
        lastDynamicsAt: Date.now(),
      });
    }
  } catch (err) {
    safeWarn(options?.logger, "feedback-log.dynamics", err, {
      agentId: options?.agentId,
      memoryId: entry.memoryId,
    });
  }
}

/**
 * Schreibt einen Feedback-Eintrag atomar (tmp + rename).
 * Bei gleichem query + memoryId wird der alte Eintrag überschrieben (idempotent).
 *
 * @param {string} workspaceDir
 * @param {string} query
 * @param {string} memoryId
 * @param {"positive"|"negative"|"neutral"} feedback
 * @param {object} scoreComponents
 * @param {object} [options]
 * @returns {Promise<void>|undefined}
 */
export function recordFeedback(workspaceDir, query, memoryId, feedback, scoreComponents, options = {}) {
  const newEntry = buildFeedbackEntry(query, memoryId, feedback, scoreComponents);

  const logPath = getLogPath(workspaceDir);
  const entries = readJsonl(logPath);
  const maxEntries = normalizeMaxEntries(options.maxEntries, DEFAULT_MAX_FEEDBACK_LOG_ENTRIES);
  const updated = pruneTail(upsertFeedbackEntries(entries, [newEntry]), maxEntries);
  writeJsonlAtomic(logPath, updated);

  // Dynamics integration (fire-and-forget, promise returned for testability)
  if (shouldApplyDynamics(newEntry, options)) {
    return applyFeedbackDynamics(newEntry, options);
  }
}

/**
 * Schreibt mehrere Feedback-Einträge mit einem einzigen atomaren JSONL-Rewrite.
 *
 * @param {string} workspaceDir
 * @param {Array<{query?: string, memoryId?: string, feedback: string, scoreComponents?: object}>} feedbackEntries
 * @param {object} [options]
 * @returns {Promise<void>|undefined}
 */
export function recordFeedbackBatch(workspaceDir, feedbackEntries, options = {}) {
  const normalized = [];
  for (const item of feedbackEntries || []) {
    normalized.push(buildFeedbackEntry(item?.query, item?.memoryId, item?.feedback, item?.scoreComponents));
  }
  if (normalized.length === 0) return undefined;

  const logPath = getLogPath(workspaceDir);
  const entries = readJsonl(logPath);
  const maxEntries = normalizeMaxEntries(options.maxEntries, DEFAULT_MAX_FEEDBACK_LOG_ENTRIES);
  const updated = pruneTail(upsertFeedbackEntries(entries, normalized), maxEntries);
  writeJsonlAtomic(logPath, updated);

  const dynamicEntries = normalized.filter((entry) => shouldApplyDynamics(entry, options));
  if (dynamicEntries.length > 0) {
    return (async () => {
      for (const entry of dynamicEntries) {
        await applyFeedbackDynamics(entry, options);
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

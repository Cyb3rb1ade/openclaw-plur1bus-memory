/**
 * engine/commands/command-helpers.js — command helpers: maintenance nudges, JSON/skill formatting, the direct-cron guard, the Neo/conflict-summary helpers and the pending-confirmation store.
 *
 * Moved verbatim from index.js (engine extraction, step 9 part 1); index.js
 * imports what the host registration still uses and re-exports the public names.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { isGuardedDirectFeatureCronMessage } from "../../lib/setup/feature-cron-plan.js";
import { t } from "../../lib/i18n.js";
import { safeUuid } from "../../lib/sql-safety.js";
import { validateConfirmation } from "../../lib/security.js";
import { findLatestNeoRecord } from "../../lib/neo-arch.js";
import { readFileHeadSync } from "../runtime/env-config.js";
import { readKnowledgePending } from "../knowledge/knowledge-pending.js";

// categorizeMemory kommt jetzt aus lib/categorize.js

/**
 * Baut die Wartungs-Nudges (Knowledge-Update + Conflict-Review) für die
 * before_prompt_build-Hooks. Geteilt zwischen auto-recall on/off (#9 Dedup),
 * lokalisiert via i18n (#11), und liest conflict-log.jsonl nur EINMAL (#2).
 *
 * @returns {{knowledgeNudge: string, conflictNudge: string}}
 */
function buildMaintenanceNudges({ workspaceDir, schicht15Enabled, lang = "en", tone = "default", logger } = {}) {
  let knowledgeNudge = "";
  let conflictNudge = "";
  if (!workspaceDir) return { knowledgeNudge, conflictNudge };

  // Knowledge-update reminder
  if (schicht15Enabled) {
    try {
      const pending = readKnowledgePending(workspaceDir);
      if ((pending.pendingCount || 0) >= 3) {
        const daysSince = pending.lastUpdateAt
          ? Math.floor((Date.now() - new Date(pending.lastUpdateAt).getTime()) / 86400000)
          : null;
        const staleNote = daysSince !== null && daysSince >= 7
          ? t("nudge.knowledge_stale", { lang, tone, vars: { days: daysSince } })
          : "";
        const body = t("nudge.knowledge_pending", { lang, tone, vars: { count: pending.pendingCount, stale: staleNote } });
        knowledgeNudge = `\n<knowledge-update-reminder>\n${body}\n</knowledge-update-reminder>`;
      }
    } catch (e) {
      logger?.debug?.(`maintenance-nudge: knowledge pending read failed: ${e?.message || e}`);
    }
  }

  // Conflict-log reminder — P0-4: nur noch Summary lesen, kein Log-Scan im Prompt-Pfad.
  try {
    let summary = readConflictSummary(workspaceDir);
    if (!summary) {
      // Fallback: einmalig lazy rebuild mit Budget/Timeout, wenn Summary fehlt.
      summary = buildConflictSummaryFromLog(workspaceDir);
    }
    if (summary) {
      const sizeKb = Math.round((summary.sizeBytes || 0) / 1024);
      const lineCount = summary.count || 0;
      const oldestTimestamp = summary.oldestTimestamp || null;
      let showNudge = (summary.sizeBytes || 0) > 1_048_576;
      if (!showNudge && oldestTimestamp && Date.now() - oldestTimestamp > 30 * 86_400_000) {
        showNudge = true;
      }
      if (showNudge && lineCount > 0) {
        const body = t("nudge.conflict_review", { lang, tone, vars: { count: lineCount, sizeKb } });
        conflictNudge = `\n<conflict-review-reminder>\n${body}\n</conflict-review-reminder>`;
      }
    }
  } catch (e) {
    logger?.debug?.(`maintenance-nudge: conflict summary read failed: ${e?.message || e}`);
  }

  return { knowledgeNudge, conflictNudge };
}

function formatJsonCommandResult(value) {
  return { text: JSON.stringify(value, null, 2) };
}

function finiteSkillMetric(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function aggregateSkillMinerRuns(skillRuns, agent) {
  const successfulRuns = skillRuns.filter((run) => run.result && !run.failed);
  const failedRuns = skillRuns.filter((run) => run.failed === true);
  const reports = successfulRuns.map((run) => run.result);
  const aclBindings = skillRuns.length === 1 && successfulRuns.length === 1
    ? reports[0].aclBindings || null
    : null;
  const allSkipped = reports.length > 0 && reports.every((report) => report.skipped === true);
  const allFailed = reports.length === 0 && failedRuns.length > 0;

  return {
    timestamp: new Date().toISOString(),
    agent,
    ...((allSkipped || allFailed)
      ? { skipped: true, reason: allFailed ? "all_partitions_failed" : "all_partitions_skipped" }
      : {}),
    partialFailure: failedRuns.length > 0,
    failedPartitions: failedRuns.map((run) => run.scope),
    scanned: reports.reduce((total, report) => total + finiteSkillMetric(report.scanned), 0),
    proposalsCreated: reports.reduce((total, report) => total + finiteSkillMetric(report.proposalsCreated), 0),
    skippedLowEvidence: reports.reduce((total, report) => total + finiteSkillMetric(report.skippedLowEvidence), 0),
    skippedLowConfidence: reports.reduce((total, report) => total + finiteSkillMetric(report.skippedLowConfidence), 0),
    skippedDuplicate: reports.reduce((total, report) => total + finiteSkillMetric(report.skippedDuplicate), 0),
    pushMessages: reports.flatMap((report) => Array.isArray(report.pushMessages) ? report.pushMessages : []),
    dryRun: reports.length > 0 && reports.every((report) => report.dryRun === true),
    aclBindings,
  };
}

function formatKnownValidityLabel(entry) {
  const validFrom = Number(entry?.validFrom ?? 0);
  const validUntil = Number(entry?.validUntil ?? 0);
  const fromLabel = Number.isFinite(validFrom) && validFrom > 0
    ? new Date(validFrom).toISOString()
    : "unknown";
  const untilLabel = Number.isFinite(validUntil) && validUntil > 0
    ? new Date(validUntil).toISOString()
    : "open";
  return validFrom > 0 || validUntil > 0
    ? `, valid: [${fromLabel}, ${untilLabel})`
    : "";
}

/**
 * Claim known PLUR1BUS feature-cron turns before OpenClaw can admit them to
 * the outer model when the direct dispatcher was unavailable at registration.
 *
 * @param {object} event
 * @param {object} context
 * @param {{hostReady?: boolean}} [options]
 * @returns {{handled: true, reply: {text: string}}|undefined}
 */
function guardUnsafeDirectCronTurn(event, context, { hostReady } = {}) {
  if (
    hostReady !== false
    || context?.trigger !== "cron"
    || !isGuardedDirectFeatureCronMessage(event?.cleanedBody)
  ) {
    return undefined;
  }
  return { handled: true, reply: { text: "NO_REPLY" } };
}

function findNeoRecord(store, id, requester = {}) {
  return findLatestNeoRecord(store, id, requester);
}

function summarizeNeoStore(store) {
  return {
    turns: store.readTurns(10_000).length,
    candidates: store.readCandidates(10_000).length,
    behaviorCards: store.readBehaviorCards(10_000).length,
    hooks: store.readHooks(),
  };
}

function textSuggestsGroupOrigin(text) {
  if (!text || typeof text !== "string") return false;
  return (
    /"is_group_chat"\s*:\s*true/.test(text) ||
    /"group_subject"\s*:/.test(text) ||
    /"group_channel"\s*:/.test(text) ||
    /Guild #/i.test(text) ||
    /\[Discord Guild /i.test(text)
  );
}

function conflictSummaryPath(workspaceDir) {
  return join(workspaceDir, ".adaptive-learning", "conflict-review-summary.json");
}

function readConflictSummary(workspaceDir) {
  try {
    const path = conflictSummaryPath(workspaceDir);
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data && typeof data.count === "number") return data;
  } catch (e) {
    console.warn("[conflict-summary] read failed:", e?.message);
  }
  return null;
}

function writeConflictSummary(workspaceDir, summary) {
  try {
    const path = conflictSummaryPath(workspaceDir);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(summary) + "\n", "utf8");
    renameSync(tmp, path);
  } catch (e) {
    console.warn("[conflict-summary] write failed:", e?.message);
  }
}

function buildConflictSummaryFromLog(workspaceDir, options = {}) {
  const { maxLines = 1000, budgetMs = 50 } = options;
  const logPath = join(workspaceDir, ".adaptive-learning", "conflict-log.jsonl");
  if (!existsSync(logPath)) return null;
  const start = performance.now();
  let stat;
  try { stat = statSync(logPath); } catch (_) { return null; }
  const head = readFileHeadSync(logPath, 1024 * 1024);
  const lines = head.split("\n").filter((l) => l.trim());
  let count = 0;
  let oldestTimestamp = null;
  let newestTimestamp = null;
  let pendingCount = 0;
  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    if (performance.now() - start > budgetMs) break;
    try {
      const record = JSON.parse(lines[i]);
      count++;
      const ts = record.timestamp ? new Date(record.timestamp).getTime() : null;
      if (ts) {
        if (oldestTimestamp === null) oldestTimestamp = ts;
        newestTimestamp = ts;
      }
      if (record.pending || record.status === "pending") pendingCount++;
    } catch (e) {
      console.warn("[conflict-summary] malformed line:", e?.message, lines[i].slice(0, 100));
    }
  }
  return {
    count,
    oldestTimestamp,
    newestTimestamp,
    sizeBytes: stat.size,
    pendingCount,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function updateConflictSummary(workspaceDir, entry) {
  let summary = readConflictSummary(workspaceDir);
  if (!summary) {
    // Bootstrap: appendConflictLog hat den neuen Eintrag bereits in das Log
    // geschrieben bevor dieser Aufruf erfolgt. buildConflictSummaryFromLog
    // zählt ihn daher schon mit — kein weiteres Inkrement nötig.
    const fromLog = buildConflictSummaryFromLog(workspaceDir);
    if (fromLog) {
      fromLog.lastUpdatedAt = new Date().toISOString();
      writeConflictSummary(workspaceDir, fromLog);
      return;
    }
    // Log existiert (noch) nicht — mit Null starten, unten inkrementieren.
    summary = {
      count: 0,
      oldestTimestamp: null,
      newestTimestamp: null,
      sizeBytes: 0,
      pendingCount: 0,
      lastUpdatedAt: new Date().toISOString(),
    };
  }
  const line = JSON.stringify(entry);
  summary.count = (summary.count || 0) + 1;
  const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : null;
  if (ts) {
    if (summary.oldestTimestamp === null || ts < summary.oldestTimestamp) summary.oldestTimestamp = ts;
    if (summary.newestTimestamp === null || ts > summary.newestTimestamp) summary.newestTimestamp = ts;
  }
  summary.sizeBytes = (summary.sizeBytes || 0) + line.length + 1;
  if (entry.pending || entry.status === "pending") {
    summary.pendingCount = (summary.pendingCount || 0) + 1;
  }
  summary.lastUpdatedAt = new Date().toISOString();
  writeConflictSummary(workspaceDir, summary);
}

function appendConflictLog(workspaceDir, entry) {
  try {
    const dir = join(workspaceDir, ".adaptive-learning");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "conflict-log.jsonl"), JSON.stringify(entry) + "\n", "utf8");
    // P0-4: Summary für promptnahe Reads pflegen.
    updateConflictSummary(workspaceDir, entry);
  } catch (e) {
    console.warn("[conflict-log] write failed:", e?.message);
  }
}

// ============================================================================
// Plugin Definition
// ============================================================================

/**
 * Parse a text confirmation command without accepting shortened nonce prefixes.
 * @param {unknown} args Raw command arguments.
 * @returns {{requested: boolean, nonce: string, error?: string}} Parsed confirmation intent.
 */
export function parseConfirmationCommand(args) {
  const input = String(args || "").trim();
  if (!/^confirm(?:\s|:|$)/i.test(input)) {
    return { requested: false, nonce: "" };
  }
  const match = input.match(/^confirm(?:\s+|:)([0-9a-fA-F-]+)$/i);
  if (!match) return { requested: true, nonce: "", error: "invalid_format" };
  try {
    return { requested: true, nonce: safeUuid(match[1]) };
  } catch {
    return { requested: true, nonce: "", error: "invalid_format" };
  }
}

/**
 * Resolve the exact explicit identity tuple used for confirmation creation and completion.
 * @param {object} memoryCtx Canonical Task 1 memory request context.
 * @returns {{userId: string|undefined, chatId: string}} Confirmation identity binding.
 */
export function resolveConfirmationIdentity(memoryCtx) {
  const confirmationChatId = memoryCtx?.conversationPrincipal || memoryCtx?.chatId || "";
  if (!confirmationChatId) throw new Error("memory confirmation requires a verified conversation");
  return {
    userId: memoryCtx?.userId,
    chatId: confirmationChatId,
  };
}

const MAX_PENDING_CONFIRMATIONS = 1024;

/**
 * Remove one pending confirmation and its matching nonce index atomically.
 * @param {Map<string, object>} confirmationStore Pending confirmation records.
 * @param {Map<string, string>} confirmationIndex Exact nonce-to-record-key index.
 * @param {string} key Confirmation record key.
 * @param {object} [pending] Confirmation record when already read.
 */
function deletePendingConfirmation(confirmationStore, confirmationIndex, key, pending = confirmationStore.get(key)) {
  confirmationStore.delete(key);
  const nonce = pending?.nonce;
  if (nonce && confirmationIndex.get(nonce) === key) confirmationIndex.delete(nonce);
}

/**
 * Remove expired confirmation records before insertion or lookup.
 * @param {Map<string, object>} confirmationStore Pending confirmation records.
 * @param {Map<string, string>} confirmationIndex Exact nonce-to-record-key index.
 * @returns {Set<string>} Nonces removed because they had expired.
 */
function sweepExpiredPendingConfirmations(confirmationStore, confirmationIndex) {
  const expiredNonces = new Set();
  const now = Date.now();
  for (const [key, pending] of confirmationStore) {
    if (Number(pending?.expiresAt) <= now) {
      if (pending?.nonce) expiredNonces.add(pending.nonce);
      deletePendingConfirmation(confirmationStore, confirmationIndex, key, pending);
    }
  }
  return expiredNonces;
}

/**
 * Store a pending confirmation under its exact nonce and nonce+target keys.
 * @param {Map<string, object>} confirmationStore Pending confirmation records.
 * @param {Map<string, string>} confirmationIndex Exact nonce-to-record-key index.
 * @param {object} pending Confirmation returned by createConfirmation().
 * @returns {object} The stored confirmation.
 */
export function rememberPendingConfirmation(confirmationStore, confirmationIndex, pending) {
  const nonce = safeUuid(pending?.nonce);
  const targetId = safeUuid(pending?.targetId);
  const key = `${nonce}:${targetId}`;
  sweepExpiredPendingConfirmations(confirmationStore, confirmationIndex);
  const previousKey = confirmationIndex.get(nonce);
  if (previousKey && previousKey !== key) {
    deletePendingConfirmation(confirmationStore, confirmationIndex, previousKey);
  }
  while (confirmationStore.size >= MAX_PENDING_CONFIRMATIONS) {
    const oldest = confirmationStore.entries().next().value;
    if (!oldest) break;
    deletePendingConfirmation(confirmationStore, confirmationIndex, oldest[0], oldest[1]);
  }
  confirmationStore.set(key, pending);
  confirmationIndex.set(nonce, key);
  return pending;
}

/**
 * Redeem one exact pending confirmation without scanning or consuming mismatches.
 * @param {object} options Completion inputs.
 * @param {Map<string, object>} options.confirmationStore Pending confirmation records.
 * @param {Map<string, string>} options.confirmationIndex Exact nonce-to-record-key index.
 * @param {string} options.expectedCommand Required command name.
 * @param {object} options.memoryCtx Canonical Task 1 memory request context.
 * @param {string} options.nonce Complete canonical UUID nonce.
 * @returns {{pending?: object, error?: string}} Completion result.
 */
export function completePendingConfirmation({
  confirmationStore,
  confirmationIndex,
  expectedCommand,
  memoryCtx,
  nonce,
}) {
  try {
    safeUuid(nonce);
  } catch {
    return { error: "invalid_format" };
  }
  const expiredNonces = sweepExpiredPendingConfirmations(confirmationStore, confirmationIndex);
  if (expiredNonces.has(nonce)) return { error: "security.expired" };
  const key = confirmationIndex.get(nonce);
  if (!key) return { error: "not_found_or_expired" };
  const pending = confirmationStore.get(key);
  if (
    !pending
    || pending.nonce !== nonce
    || pending.command !== expectedCommand
    || key !== `${nonce}:${pending.targetId}`
  ) {
    return { error: "not_found_or_expired" };
  }
  const result = validateConfirmation(
    pending.callbackData,
    confirmationStore,
    resolveConfirmationIdentity(memoryCtx),
  );
  if (!result.valid) {
    if (!confirmationStore.has(key)) confirmationIndex.delete(nonce);
    return { error: result.reason || "invalid" };
  }
  deletePendingConfirmation(confirmationStore, confirmationIndex, key, pending);
  return { pending };
}

export { buildMaintenanceNudges, formatJsonCommandResult, aggregateSkillMinerRuns, formatKnownValidityLabel, guardUnsafeDirectCronTurn, findNeoRecord, summarizeNeoStore, textSuggestsGroupOrigin, buildConflictSummaryFromLog, appendConflictLog };

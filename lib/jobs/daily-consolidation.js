/**
 * lib/jobs/daily-consolidation.js
 *
 * Phase 6 — stille tägliche Konsolidierung.
 *
 * Führt sequentiell aus:
 *   1. TTL-Expiration: Lösche abgelaufene Memories
 *   2. Neo-Store Pruning: injizierten Kontext, Duplikate, Cap
 *   3. LanceDB Memory Compaction: Ähnlichkeiten reduzieren
 *   4. Conflict Resolution: Unaufgelöste Konflikte bearbeiten
 *
 * Pusht NICHTS an Telegram — der Aufrufer loggt deterministisch.
 */

import { runMemoryCompaction } from "./memory-compaction.js";
import { runConflictResolver } from "./conflict-resolver.js";
import { writeConsolidationReport } from "./consolidation-report.js";
import { acquireJobLock, releaseJobLock } from "../job-lock.js";
import { checkJobRateLimit, recordJobRun } from "../job-rate-limit.js";
import { processRetrievalLedger, applyDailyDecayToAll } from "./memory-dynamics-maintenance.js";
import { withTimeout, TimeoutError } from "../with-timeout.js";
import { atomicJsonUpdate } from "../atomic-json.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_CONSOLIDATION_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_CONSOLIDATION_LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_DYNAMICS_LEDGER_MAX_UPDATES = 20;
const DEFAULT_DYNAMICS_DECAY_MAX_ROWS = 50;
const DYNAMICS_DECAY_STATE_KEY = "memoryDynamicsDecay";

/**
 * Run the daily maintenance pipeline for one agent.
 * @param {object} db
 * @param {string} agent
 * @param {object} [opts]
 * @param {object|null} [opts.compactionLlmCfg] LLM route owned by memory compaction.
 * @param {object|null} [opts.conflictLlmCfg] LLM route owned by conflict resolution.
 * @returns {Promise<object>}
 */
export async function runConsolidation(db, agent, opts = {}) {
  const logger = opts.logger || { info: () => {}, warn: () => {} };
  const timestamp = new Date().toISOString();
  const neoStore = opts.neoStore;
  const workspaceDir = opts.workspaceDir;
  const workspaceKey = opts.workspaceKey || workspaceDir || null;

  // Guard: kein Workspace → kein sinnvoller Konsolidierungs-Kontext
  if (!workspaceDir) {
    logger.warn?.(`daily-consolidation[${agent}]: skipped — missing workspaceDir`);
    return { timestamp, agent, skipped: true, reason: "missing_workspace_dir" };
  }

  // Rate Limit: 1× pro Tag pro Agent
  const statePath = join(workspaceDir, "run-state.json");
  const rateLimit = checkJobRateLimit("daily-consolidation", agent, workspaceKey, 24 * 60 * 60 * 1000, statePath);
  if (!rateLimit.allowed) {
    logger.warn?.(`daily-consolidation[${agent}]: rate limited — ${Math.ceil(rateLimit.remainingMs / 60000)}min remaining`);
    return { timestamp, agent, skipped: true, reason: "rate_limited", remainingMs: rateLimit.remainingMs };
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_CONSOLIDATION_TIMEOUT_MS;
  const lockStaleMs = Number.isFinite(opts.lockStaleMs)
    ? opts.lockStaleMs
    : Math.max(timeoutMs * 2, DEFAULT_CONSOLIDATION_LOCK_STALE_MS);

  // Atomic Lock
  const lockPath = join(workspaceDir, "locks", `consolidation-${agent}.lock`);
  let lockAcquired = null;
  try {
    lockAcquired = acquireJobLock(lockPath, { staleMs: lockStaleMs });
  } catch (lockErr) {
    logger.warn?.(`daily-consolidation[${agent}]: lock held — ${lockErr.message}`);
    return { timestamp, agent, skipped: true, reason: "lock_held" };
  }

  try {
    return await withTimeout(runConsolidationBody(db, agent, opts, timestamp, logger, neoStore, workspaceDir, workspaceKey, statePath), timeoutMs, `daily-consolidation:${agent}`);
  } catch (err) {
    if (err instanceof TimeoutError) {
      logger.warn?.(`daily-consolidation[${agent}]: timed out after ${timeoutMs}ms`);
      return { timestamp, agent, skipped: true, reason: "timeout", timeoutMs };
    }
    throw err;
  } finally {
    releaseJobLock(lockAcquired);
  }
}

function dynamicsDecayStateKey(agent, workspaceKey) {
  return `${agent || "all"}:${workspaceKey || "all"}`;
}

function readDynamicsDecayCursor(statePath, agent, workspaceKey, logger) {
  if (!statePath || !existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    const cursor = parsed?.[DYNAMICS_DECAY_STATE_KEY]?.[dynamicsDecayStateKey(agent, workspaceKey)]?.cursorId;
    return typeof cursor === "string" && cursor ? cursor : null;
  } catch (err) {
    logger.warn?.(`daily-consolidation[${agent}]: failed to read dynamics decay cursor: ${err.message}`);
    return null;
  }
}

async function recordDynamicsDecayCursor(statePath, agent, workspaceKey, cursorId) {
  if (!statePath || !cursorId) return;
  const stateKey = dynamicsDecayStateKey(agent, workspaceKey);
  await atomicJsonUpdate(statePath, (data) => {
    const state = data || {};
    state[DYNAMICS_DECAY_STATE_KEY] = state[DYNAMICS_DECAY_STATE_KEY] || {};
    state[DYNAMICS_DECAY_STATE_KEY][stateKey] = {
      ...(state[DYNAMICS_DECAY_STATE_KEY][stateKey] || {}),
      cursorId,
      updatedAt: Date.now(),
    };
    return state;
  });
}

async function runConsolidationBody(db, agent, opts, timestamp, logger, neoStore, workspaceDir, workspaceKey, statePath) {
  try {
    if (db && typeof db.init === "function") {
      try {
        await db.init();
      } catch (err) {
        logger.warn?.(`daily-consolidation[${agent}]: db init threw: ${err.message}`);
      }
    }

    // ── 1. TTL-Expiration ────────────────────────────────────────────────────
    let expiredDeleted = 0;
    if (db && typeof db.purgeExpired === "function") {
      try {
        await db.purgeExpired();
        logger.info?.(`daily-consolidation[${agent}]: purgeExpired completed`);
      } catch (err) {
        logger.warn?.(`daily-consolidation[${agent}]: purgeExpired threw: ${err.message}`);
      }
    }

    // ── 1.5 Memory Dynamics (Phase 7) ────────────────────────────────────────
    // Läuft VOR Neo-Store-Pruning, damit Ledger-Einträge verarbeitet werden
    // bevor der Neo-Store gecappt/dedupt wird.
    let dynamicsLedger = null;
    let dynamicsDecay = null;
    if (db && neoStore) {
      try {
        dynamicsLedger = await processRetrievalLedger(db, neoStore, {
          agentId: agent,
          workspaceKey,
          batchSize: 100,
          maxUpdates: opts.dynamicsLedgerMaxUpdates ?? DEFAULT_DYNAMICS_LEDGER_MAX_UPDATES,
          logger,
          dryRun: opts.dryRun === true,
        });
        logger.info?.(`daily-consolidation[${agent}]: dynamics ledger processed=${dynamicsLedger.processed} failed=${dynamicsLedger.failed} updated=${dynamicsLedger.updated || 0} skippedInvalidIds=${dynamicsLedger.skippedInvalidIds || 0} watermark=${dynamicsLedger.watermark}${dynamicsLedger.truncated ? " truncated=true" : ""}`);
      } catch (err) {
        logger.warn?.(`daily-consolidation[${agent}]: dynamics ledger threw: ${err.message}`);
      }
      try {
        const decayCursorId = opts.dynamicsDecayCursorId ?? readDynamicsDecayCursor(statePath, agent, workspaceKey, logger);
        dynamicsDecay = await applyDailyDecayToAll(db, {
          batchSize: 500,
          maxRows: opts.dynamicsDecayMaxRows ?? DEFAULT_DYNAMICS_DECAY_MAX_ROWS,
          cursorId: decayCursorId,
          logger,
          dryRun: opts.dryRun === true,
        });
        if (!opts.dryRun && dynamicsDecay?.nextCursorId) {
          await recordDynamicsDecayCursor(statePath, agent, workspaceKey, dynamicsDecay.nextCursorId);
        }
        logger.info?.(`daily-consolidation[${agent}]: dynamics decay decayed=${dynamicsDecay.decayed} errors=${dynamicsDecay.errors} skippedInvalidIds=${dynamicsDecay.skippedInvalidIds || 0} nextCursorId=${dynamicsDecay.nextCursorId || "none"}${dynamicsDecay.truncated ? " truncated=true" : ""}`);
      } catch (err) {
        logger.warn?.(`daily-consolidation[${agent}]: dynamics decay threw: ${err.message}`);
      }
    }

    // ── 2. Neo-Store Pruning ─────────────────────────────────────────────────
    let neoPrune = null;
    if (neoStore && typeof neoStore.pruneAll === "function") {
      try {
        neoPrune = neoStore.pruneAll({ dryRun: opts.dryRun === true });
        const totals = Object.values(neoPrune).reduce((acc, s) => ({
          removedInjected: acc.removedInjected + (s.removedInjected || 0),
          removedDup: acc.removedDup + (s.removedDup || 0),
          removedCap: acc.removedCap + (s.removedCap || 0),
        }), { removedInjected: 0, removedDup: 0, removedCap: 0 });
        logger.info?.(`daily-consolidation[${agent}]: neo prune removedInjected=${totals.removedInjected} removedDup=${totals.removedDup} removedCap=${totals.removedCap}`);
      } catch (err) {
        logger.warn?.(`daily-consolidation[${agent}]: neo prune threw: ${err.message}`);
      }
    }

    // ── 3. LanceDB Memory Compaction ─────────────────────────────────────────
    let compaction = null;
    if (db && db.table) {
      try {
        compaction = await runMemoryCompaction(db, {
          agentId: agent,
          similarityThreshold: opts.compaction?.similarityThreshold ?? 0.88,
          lookbackDays: opts.compaction?.lookbackDays ?? 30,
          maxBatchSize: opts.compaction?.maxBatchSize ?? 50,
          dryRun: opts.dryRun === true,
          autoApply: opts.compaction?.autoApply === true,
          llmCfg: opts.compactionLlmCfg,
          callLlm: opts.callLlm,
          llmMergeTimeoutMs: opts.llmMergeTimeoutMs ?? 30000,
          logger,
          neoStore,
          workspaceDir,
          embeddings: opts.embeddings,
        });
        logger.info?.(`daily-consolidation[${agent}]: compaction ${compaction.compacted} actions (${compaction.deleted} deleted, ${compaction.merged} merged)`);
      } catch (err) {
        logger.warn?.(`daily-consolidation[${agent}]: compaction threw: ${err.message}`);
      }
    }

    // ── 4. Conflict Resolution ───────────────────────────────────────────────
    let conflictResolution = null;
    if (workspaceDir && opts.conflictLlmCfg && opts.callLlm) {
      try {
        conflictResolution = await runConflictResolver({
          agentId: agent,
          workspaceDir,
          llmCfg: opts.conflictLlmCfg,
          callLlm: opts.callLlm,
          minAgeDays: opts.conflictMinAgeDays ?? 7,
          maxConflicts: opts.maxConflicts ?? 20,
          llmTimeoutMs: opts.llmMergeTimeoutMs ?? 30000,
          dryRun: opts.dryRun === true,
          logger,
        });
        logger.info?.(`daily-consolidation[${agent}]: conflict resolution ${conflictResolution.resolved} resolved, ${conflictResolution.uncertain} uncertain`);
      } catch (err) {
        logger.warn?.(`daily-consolidation[${agent}]: conflict resolver threw: ${err.message}`);
      }
    }

    // ── DB Availability Check (nicht blockierend) ────────────────────────────
    let available = false;
    if (db && typeof db.isAvailable === "function") {
      try {
        available = await db.isAvailable(agent);
      } catch (err) {
        logger.warn?.(`daily-consolidation[${agent}]: isAvailable threw: ${err.message}`);
      }
    } else {
      available = !!db?.table;
    }

    const report = {
      timestamp,
      agent,
      dbAvailable: available,
      expiredDeleted,
      dynamicsLedger: dynamicsLedger || { processed: 0, failed: 0, watermark: 0 },
      dynamicsDecay: dynamicsDecay || { decayed: 0, errors: 0 },
      neoPrune,
      compaction: compaction || { compacted: 0, deleted: 0, merged: 0 },
      conflictResolution: conflictResolution || { resolved: 0, uncertain: 0 },
      dryRun: opts.dryRun === true,
    };

    // Vault-Ausgabe
    if (workspaceDir && !opts.dryRun) {
      try {
        writeConsolidationReport(report, workspaceDir);
      } catch (err) {
        logger.warn?.(`daily-consolidation[${agent}]: vault report failed: ${err.message}`);
      }
    }

    if (!opts.dryRun) {
      await recordJobRun("daily-consolidation", agent, workspaceKey, statePath);
    }

    return report;
  } catch (err) {
    logger.warn?.(`daily-consolidation[${agent}]: body threw: ${err.message}`);
    throw err;
  }
}

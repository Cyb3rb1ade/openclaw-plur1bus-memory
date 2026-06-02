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
import { join } from "node:path";

export async function runConsolidation(db, agent, opts = {}) {
  const logger = opts.logger || { info: () => {}, warn: () => {} };
  const timestamp = new Date().toISOString();
  const neoStore = opts.neoStore;
  const workspaceDir = opts.workspaceDir;

  // Guard: kein Workspace → kein sinnvoller Konsolidierungs-Kontext
  if (!workspaceDir) {
    logger.warn?.(`daily-consolidation[${agent}]: skipped — missing workspaceDir`);
    return { timestamp, agent, skipped: true, reason: "missing_workspace_dir" };
  }

  // Atomic Lock
  const lockPath = join(workspaceDir, "locks", `consolidation-${agent}.lock`);
  let lockAcquired = null;
  try {
    lockAcquired = acquireJobLock(lockPath);
  } catch (lockErr) {
    logger.warn?.(`daily-consolidation[${agent}]: lock held — ${lockErr.message}`);
    return { timestamp, agent, skipped: true, reason: "lock_held" };
  }

  try {
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
        similarityThreshold: opts.compaction?.similarityThreshold ?? 0.88,
        lookbackDays: opts.compaction?.lookbackDays ?? 30,
        maxBatchSize: opts.compaction?.maxBatchSize ?? 50,
        dryRun: opts.dryRun === true,
        llmCfg: opts.llmCfg,
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
  if (workspaceDir && opts.llmCfg && opts.callLlm) {
    try {
      conflictResolution = await runConflictResolver({
        workspaceDir,
        llmCfg: opts.llmCfg,
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
  }

  const report = {
    timestamp,
    agent,
    dbAvailable: available,
    expiredDeleted,
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

    return report;
  } finally {
    releaseJobLock(lockAcquired);
  }
}

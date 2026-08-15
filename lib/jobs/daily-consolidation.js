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

import { buildCompactionPartition, runMemoryCompaction } from "./memory-compaction.js";
import { runConflictResolver } from "./conflict-resolver.js";
import { writeConsolidationReport } from "./consolidation-report.js";
import { acquireJobLock, releaseJobLock } from "../job-lock.js";
import { checkJobRateLimit, recordJobRun } from "../job-rate-limit.js";
import { processRetrievalLedger, applyDailyDecayToAll } from "./memory-dynamics-maintenance.js";
import { withTimeout, TimeoutError } from "../with-timeout.js";
import { atomicJsonUpdate } from "../atomic-json.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { validateOwnershipTuple } from "../acl-middleware.js";

const DEFAULT_CONSOLIDATION_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_CONSOLIDATION_LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_DYNAMICS_LEDGER_MAX_UPDATES = 20;
const DEFAULT_DYNAMICS_DECAY_MAX_ROWS = 50;
const DYNAMICS_DECAY_STATE_KEY = "memoryDynamicsDecay";
const EMPTY_WORKSPACE_ALIASES = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) });
const COMPACTION_OWNERSHIP_SCOPES = new Set(["agent-private", "workspace", "user"]);

function isExplicitOwnershipRow(row) {
  return Boolean(row && (
    row.scope !== undefined
    || row.agentId !== undefined
    || row.storedBy !== undefined
    || row.workspaceId !== undefined
    || row.workspaceKey !== undefined
    || row.ownerUserId !== undefined
  ));
}

async function readAllOwnershipRows(table, logger) {
  const rows = [];
  const seenIds = new Set();
  const pageSize = 500;
  let offset = 0;

  while (true) {
    let query;
    try {
      query = table.query();
      const hasOffset = typeof query.offset === "function";
      if (hasOffset && offset > 0) query = query.offset(offset);
      if (hasOffset && typeof query.limit === "function") query = query.limit(pageSize);
      if (!hasOffset && typeof query.toArray !== "function" && typeof query.limit === "function") {
        query = query.limit(pageSize);
      }
      const page = await query.toArray();
      if (!Array.isArray(page) || page.length === 0) break;

      let newRows = 0;
      for (const row of page) {
        const id = row?.id;
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        rows.push(row);
        newRows += 1;
      }
      if (!hasOffset || page.length < pageSize || newRows === 0) break;
      offset += page.length;
    } catch (error) {
      logger.warn?.(`daily-consolidation: ownership enumeration failed — ${error.message}`);
      throw error;
    }
  }
  return rows;
}

/**
 * Enumerate every valid exact ownership tuple present for one agent.
 * @param {object} table LanceDB table.
 * @param {string} agent Agent identifier to enumerate.
 * @param {object} workspaceAliases Canonical workspace alias snapshot.
 * @param {object} logger Logger used for fail-closed diagnostics.
 * @returns {Promise<{readable: boolean, explicit: boolean, invalid: boolean, partitions: Array<object>}>}
 */
export async function enumerateCompactionPartitions(table, agent, workspaceAliases = EMPTY_WORKSPACE_ALIASES, logger = { warn() {} }) {
  if (!table || typeof table.query !== "function") {
    return { readable: true, explicit: false, invalid: false, partitions: [] };
  }

  let rows;
  try {
    rows = await readAllOwnershipRows(table, logger);
  } catch {
    return { readable: false, explicit: true, invalid: true, partitions: [] };
  }

  const partitions = new Map();
  let explicit = false;
  let invalid = false;
  for (const row of rows) {
    if (!isExplicitOwnershipRow(row)) continue;
    explicit = true;
    const rawAgent = row?.agentId || row?.storedBy || "";
    if (rawAgent && rawAgent !== agent && row?.agentId !== agent && row?.storedBy !== agent) continue;
    const scope = row?.scope || "agent-private";
    if (!COMPACTION_OWNERSHIP_SCOPES.has(scope)) {
      invalid = true;
      continue;
    }
    const ownership = validateOwnershipTuple(row, workspaceAliases);
    if (!ownership.ok || ownership.bindings.agentId !== agent) {
      invalid = true;
      continue;
    }

    const aclPartition = {
      scope,
      agentId: ownership.bindings.agentId,
      workspaceIdentity: ownership.bindings.workspaceIdentity,
      ownerUserId: ownership.bindings.ownerUserId,
    };
    const requestContext = {
      agentId: agent,
      workspaceIdentity: ownership.bindings.workspaceIdentity,
      userPrincipal: ownership.bindings.ownerUserId,
      workspaceAliases,
    };
    try {
      const normalized = buildCompactionPartition(aclPartition, requestContext);
      partitions.set(normalized.key, Object.freeze({
        aclPartition: Object.freeze(aclPartition),
        requestContext: Object.freeze(requestContext),
      }));
    } catch (error) {
      invalid = true;
      logger.warn?.(`daily-consolidation[${agent}]: invalid ownership tuple skipped — ${error.message}`);
    }
  }

  return { readable: true, explicit, invalid, partitions: [...partitions.values()] };
}

function aggregateCompactionResults(partitionResults) {
  const totals = partitionResults.reduce((acc, entry) => {
    const result = entry.result || {};
    for (const field of ["compacted", "deleted", "merged", "plannedDeleted", "plannedMerged", "candidates", "clusters", "executed", "proposals", "errors"]) {
      acc[field] += Number(result[field] || 0);
    }
    return acc;
  }, {
    compacted: 0,
    deleted: 0,
    merged: 0,
    plannedDeleted: 0,
    plannedMerged: 0,
    candidates: 0,
    clusters: 0,
    executed: 0,
    proposals: 0,
    errors: 0,
  });
  return { ...totals, partitionResults };
}

/**
 * Run the daily maintenance pipeline for one agent.
 * @param {object} db
 * @param {string} agent
 * @param {object} [opts]
 * @param {object} [opts.aclPartition] One already-authorized exact partition.
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

  const workspaceAliases = opts.requestContext?.workspaceAliases || opts.workspaceAliases || EMPTY_WORKSPACE_ALIASES;
  const requestedPartition = opts.aclPartition || opts.ownershipPartition || opts.partition || null;
  const singlePartition = requestedPartition ? {
    aclPartition: requestedPartition,
    requestContext: opts.requestContext || {
      agentId: requestedPartition.agentId || agent,
      workspaceIdentity: requestedPartition.workspaceIdentity || "",
      userPrincipal: requestedPartition.ownerUserId || "",
      workspaceAliases,
    },
  } : null;
  let ownershipDiscovery = {
    readable: true,
    explicit: Boolean(singlePartition),
    invalid: false,
    partitions: singlePartition ? [singlePartition] : [],
  };
  if (!singlePartition && db?.table) {
    ownershipDiscovery = await enumerateCompactionPartitions(db.table, agent, workspaceAliases, logger);
  }
  const hasProtectedOwnership = singlePartition
    ? singlePartition.aclPartition.scope !== "workspace"
    : ownershipDiscovery.explicit && (
      ownershipDiscovery.invalid
      || ownershipDiscovery.partitions.some(({ aclPartition }) => aclPartition.scope !== "workspace")
    );
  const workspaceOutputAllowed = !hasProtectedOwnership;
  // A partition-bound caller owns the Neo namespace passed to this job. Keep
  // that store available for protected owner state, while the existing global
  // mixed-ownership mode continues to suppress shared Neo output.
  const bodyNeoStore = singlePartition || workspaceOutputAllowed ? neoStore : null;

  // Rate Limit: 1× pro Tag pro Agent
  const statePath = workspaceOutputAllowed ? join(workspaceDir, "run-state.json") : null;
  const rateLimit = workspaceOutputAllowed
    ? checkJobRateLimit("daily-consolidation", agent, workspaceKey, 24 * 60 * 60 * 1000, statePath)
    : { allowed: true };
  if (!rateLimit.allowed) {
    logger.warn?.(`daily-consolidation[${agent}]: rate limited — ${Math.ceil(rateLimit.remainingMs / 60000)}min remaining`);
    return { timestamp, agent, skipped: true, reason: "rate_limited", remainingMs: rateLimit.remainingMs };
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_CONSOLIDATION_TIMEOUT_MS;
  const lockStaleMs = Number.isFinite(opts.lockStaleMs)
    ? opts.lockStaleMs
    : Math.max(timeoutMs * 2, DEFAULT_CONSOLIDATION_LOCK_STALE_MS);

  // Atomic Lock
  const lockPath = workspaceOutputAllowed ? join(workspaceDir, "locks", `consolidation-${agent}.lock`) : null;
  let lockAcquired = null;
  if (lockPath) {
    try {
      lockAcquired = acquireJobLock(lockPath, { staleMs: lockStaleMs });
    } catch (lockErr) {
      logger.warn?.(`daily-consolidation[${agent}]: lock held — ${lockErr.message}`);
      return { timestamp, agent, skipped: true, reason: "lock_held" };
    }
  }

  try {
    return await withTimeout(
      runConsolidationBody(
        db,
        agent,
        opts,
        timestamp,
        logger,
        bodyNeoStore,
        workspaceDir,
        workspaceKey,
        statePath,
        ownershipDiscovery,
        workspaceOutputAllowed,
      ),
      timeoutMs,
      `daily-consolidation:${agent}`,
    );
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

async function runConsolidationBody(
  db,
  agent,
  opts,
  timestamp,
  logger,
  neoStore,
  workspaceDir,
  workspaceKey,
  statePath,
  ownershipDiscovery,
  workspaceOutputAllowed,
) {
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
      const partitionResults = [];
      const baseCompactionOpts = {
        similarityThreshold: opts.compaction?.similarityThreshold ?? 0.88,
        lookbackDays: opts.compaction?.lookbackDays ?? 30,
        scanLimit: opts.compaction?.scanLimit,
        maxScanRows: opts.compaction?.maxScanRows,
        maxBatchSize: opts.compaction?.maxBatchSize ?? 50,
        dryRun: opts.dryRun === true,
        autoApply: opts.compaction?.autoApply === true,
        llmCfg: opts.compactionLlmCfg,
        callLlm: opts.callLlm,
        llmMergeTimeoutMs: opts.llmMergeTimeoutMs ?? 30000,
        logger,
        neoStore,
        embeddings: opts.embeddings,
      };

      if (ownershipDiscovery?.explicit) {
        for (const partitionEntry of ownershipDiscovery.partitions) {
          const { aclPartition, requestContext } = partitionEntry;
          try {
            const result = await runMemoryCompaction(db, {
              ...baseCompactionOpts,
              agentId: agent,
              requestContext,
              aclPartition,
              workspaceDir: aclPartition.scope === "workspace" && workspaceOutputAllowed ? workspaceDir : null,
            });
            partitionResults.push({ aclPartition, result });
            logger.info?.(`daily-consolidation[${agent}]: compaction ${aclPartition.scope} ${aclPartition.ownerUserId || aclPartition.workspaceIdentity || "private"} ${result.compacted || 0} actions (${result.deleted || 0} deleted, ${result.merged || 0} merged)`);
          } catch (err) {
            logger.warn?.(`daily-consolidation[${agent}]: compaction ${aclPartition.scope} threw: ${err.message}`);
            partitionResults.push({ aclPartition, result: { compacted: 0, deleted: 0, merged: 0, errors: 1, note: "compaction_failed" } });
          }
        }
      } else if (ownershipDiscovery?.readable !== false) {
        try {
          const result = await runMemoryCompaction(db, {
            ...baseCompactionOpts,
            agentId: agent,
            workspaceDir,
          });
          partitionResults.push({ aclPartition: null, result });
          logger.info?.(`daily-consolidation[${agent}]: compaction ${result.compacted || 0} actions (${result.deleted || 0} deleted, ${result.merged || 0} merged)`);
        } catch (err) {
          logger.warn?.(`daily-consolidation[${agent}]: compaction threw: ${err.message}`);
          partitionResults.push({ aclPartition: null, result: { compacted: 0, deleted: 0, merged: 0, errors: 1, note: "compaction_failed" } });
        }
      }
      compaction = aggregateCompactionResults(partitionResults);
    }

    // ── 4. Conflict Resolution ───────────────────────────────────────────────
    let conflictResolution = null;
    if (workspaceOutputAllowed && workspaceDir && opts.conflictLlmCfg && opts.callLlm) {
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
    if (workspaceOutputAllowed && workspaceDir && !opts.dryRun) {
      try {
        writeConsolidationReport(report, workspaceDir);
      } catch (err) {
        logger.warn?.(`daily-consolidation[${agent}]: vault report failed: ${err.message}`);
      }
    }

    if (workspaceOutputAllowed && !opts.dryRun) {
      await recordJobRun("daily-consolidation", agent, workspaceKey, statePath);
    }

    return report;
  } catch (err) {
    logger.warn?.(`daily-consolidation[${agent}]: body threw: ${err.message}`);
    throw err;
  }
}

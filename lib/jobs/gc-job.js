/**
 * lib/jobs/gc-job.js — Hintergrund-Job für Garbage Collection.
 *
 * Läuft wöchentlich (gesteuert durch externen Scheduler/Cron),
 * prüft alle Agent-DBs auf Größe und wendet die GC-Policy an.
 * Schreibt einen Report nach .adaptive-learning/gc-report.json.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDbSize, selectCandidatesForGc, archiveMemories } from "../garbage-collector.js";
import { withTimeout, TimeoutError } from "../with-timeout.js";

const REPORT_FILE = "gc-report.json";
const REPORT_MAX_ENTRIES = 50;
const DEFAULT_GC_TIMEOUT_MS = 120_000; // 2 minutes
const DEFAULT_SCAN_BATCH_SIZE = 500;

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function listAgentIds(baseDbPath) {
  if (!baseDbPath || !existsSync(baseDbPath)) return [];
  const ids = [];
  try {
    for (const entry of readdirSync(baseDbPath, { withFileTypes: true })) {
      if (entry.isDirectory()) ids.push(entry.name);
    }
  } catch (_) {
    return [];
  }
  return ids;
}

/**
 * Kandidaten für die Garbage Collection. Nutzt den Collectable-Scan, der neben
 * den aktiven auch die überholten (`superseded`) Zeilen liefert — der
 * Active-Scan lässt sie bewusst aus, damit Recall/Shared Search/Vault keine
 * alten Fassungen sehen. Ohne diesen Pfad hätte der GC seit der Umstellung auf
 * Soft-Delete gar keine Archivkandidaten mehr.
 */
export async function collectActiveMemories(db, { batchSize = DEFAULT_SCAN_BATCH_SIZE } = {}) {
  if (typeof db?.scanCollectableBatches === "function") {
    const memories = [];
    for await (const batch of db.scanCollectableBatches({ batchSize })) {
      memories.push(...batch);
    }
    return memories;
  }
  if (typeof db?.scanCollectable === "function") return await db.scanCollectable();
  // Ältere/duck-typed DB-Objekte (u. a. in Tests) kennen nur den Active-Scan.
  if (typeof db?.scanActiveBatches === "function") {
    const memories = [];
    for await (const batch of db.scanActiveBatches({ batchSize })) {
      memories.push(...batch);
    }
    return memories;
  }
  return await db.scanActive();
}

async function withDbLease(dbPool, agentId, fn) {
  if (typeof dbPool?.withDb === "function") {
    return await dbPool.withDb(agentId, fn);
  }
  return await fn(dbPool.getDb(agentId));
}

/**
 * Führt den Garbage-Collection-Job für alle Agent-DBs aus.
 *
 * @param {object} opts
 * @param {string} opts.baseDbPath — Root-Pfad der LanceDB-Agent-Datenbanken
 * @param {object} opts.dbPool — AgentDbPool mit withDb(agentId, fn); getDb bleibt als Kompatibilitäts-Fallback
 * @param {object} [opts.policy] — GC-Policy (siehe selectCandidatesForGc)
 * @param {string} [opts.workspaceDir] — Workspace für Report-Schreiben
 * @param {string} [opts.archiveDir] — Override für Archiv-Verzeichnis (default: baseDbPath/../archive)
 * @param {object} [opts.logger]
 * @param {number} [opts.now=Date.now()]
 * @returns {Promise<{ok:boolean, processed:number, totalArchived:number, totalSkipped:number, agents:Array, reportPath:string|null}>}
 */
export async function runGcJob(opts = {}) {
  const {
    baseDbPath,
    dbPool,
    policy = {},
    workspaceDir,
    archiveDir,
    logger = { info: () => {}, warn: () => {}, error: () => {} },
    now = Date.now(),
    timeoutMs = DEFAULT_GC_TIMEOUT_MS,
  } = opts;

  if (!baseDbPath || !dbPool) {
    logger.warn?.("gc-job: missing baseDbPath or dbPool");
    return { ok: false, processed: 0, totalArchived: 0, totalSkipped: 0, agents: [], reportPath: null, reason: "missing_args" };
  }

  // Backwards-compatible: wenn keine Policy konfiguriert → kein GC
  const hasMaxDbSize = typeof policy.maxDbSizeMb === "number";
  const hasMaxCount = typeof policy.maxMemoryCount === "number";
  const hasMinStrength = typeof policy.minMemoryStrength === "number";
  if (!hasMaxDbSize && !hasMaxCount && !hasMinStrength) {
    logger.info?.("gc-job: no policy configured, skipping");
    return { ok: true, processed: 0, totalArchived: 0, totalSkipped: 0, agents: [], reportPath: null, reason: "no_policy" };
  }

  try {
    return await withTimeout(
      runGcJobBody({ baseDbPath, dbPool, policy, workspaceDir, archiveDir, logger, now }),
      timeoutMs,
      "gc-job",
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      logger.warn?.(`gc-job: timed out after ${timeoutMs}ms`);
      return { ok: false, processed: 0, totalArchived: 0, totalSkipped: 0, agents: [], reportPath: null, reason: "timeout", timeoutMs };
    }
    throw err;
  }
}

async function runGcJobBody({ baseDbPath, dbPool, policy, workspaceDir, archiveDir, logger, now }) {
  const agentIds = listAgentIds(baseDbPath);
  if (agentIds.length === 0) {
    logger.info?.("gc-job: no agent dbs found");
    return { ok: true, processed: 0, totalArchived: 0, totalSkipped: 0, agents: [], reportPath: null, reason: "no_agents" };
  }

  const defaultArchiveDir = archiveDir || join(baseDbPath, "..", "archive");
  const results = [];
  let totalArchived = 0;
  let totalSkipped = 0;

  for (const agentId of agentIds) {
    const dbPath = join(baseDbPath, agentId);
    const dbSizeBytes = getDbSize(dbPath);
    const dbSizeMb = dbSizeBytes / (1024 * 1024);

    let callbackStarted = false;
    let agentResult;
    try {
      agentResult = await withDbLease(dbPool, agentId, async (db) => {
        callbackStarted = true;

        let memories = [];
        try {
          memories = await collectActiveMemories(db, { batchSize: policy.scanBatchSize || DEFAULT_SCAN_BATCH_SIZE });
        } catch (e) {
          logger.warn?.(`gc-job: active scan failed for agent ${agentId}: ${e.message}`);
          return { agentId, ok: false, error: e.message, archived: 0, skipped: 0 };
        }

        const mergedPolicy = {
          ...policy,
          dbSizeMb: Math.round(dbSizeMb * 100) / 100,
        };

        const candidates = selectCandidatesForGc(memories, mergedPolicy);
        if (candidates.length === 0) {
          return { agentId, ok: true, archived: 0, skipped: 0, dbSizeMb: mergedPolicy.dbSizeMb, memoryCount: memories.length };
        }

        const agentArchiveDir = join(defaultArchiveDir, agentId);
        const archiveResult = await archiveMemories(db, candidates, agentArchiveDir);

        logger.info?.(`gc-job[${agentId}]: archived ${archiveResult.archived}, skipped ${archiveResult.skipped} (candidates ${candidates.length})`);

        return {
          agentId,
          ok: true,
          archived: archiveResult.archived,
          skipped: archiveResult.skipped,
          candidates: candidates.length,
          dbSizeMb: mergedPolicy.dbSizeMb,
          memoryCount: memories.length,
        };
      });
    } catch (e) {
      if (callbackStarted) throw e;
      logger.warn?.(`gc-job: failed to get db for agent ${agentId}: ${e.message}`);
      results.push({ agentId, ok: false, error: e.message, archived: 0, skipped: 0 });
      continue;
    }

    totalArchived += agentResult.archived;
    totalSkipped += agentResult.skipped;
    results.push(agentResult);
  }

  let reportPath = null;
  if (workspaceDir) {
    const adaptiveDir = join(workspaceDir, ".adaptive-learning");
    mkdirSync(adaptiveDir, { recursive: true });
    reportPath = join(adaptiveDir, REPORT_FILE);

    const existing = readJson(reportPath, { runs: [] });
    const runs = Array.isArray(existing.runs) ? existing.runs : [];
    runs.push({
      timestamp: new Date(now).toISOString(),
      totalArchived,
      totalSkipped,
      agents: results,
    });
    while (runs.length > REPORT_MAX_ENTRIES) runs.shift();

    try {
      writeFileSync(reportPath, JSON.stringify({ runs }, null, 2), "utf8");
    } catch (e) {
      logger.warn?.(`gc-job: failed to write report: ${e.message}`);
      reportPath = null;
    }
  }

  return {
    ok: true,
    processed: results.length,
    totalArchived,
    totalSkipped,
    agents: results,
    reportPath,
  };
}

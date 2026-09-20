import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The "Capacity & Runtime" panel: how full each agent's store is against the
// gc cap, what the last gc run did, whether the process is under memory
// pressure, and which runtime limits are in force. Read-only by design — the
// numbers answer "why is recall slow / why did rows vanish" before anyone has
// to open a log.

const REPORT_RELATIVE_PATH = [".adaptive-learning", "gc-report.json"];
const AGENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_AGENT_ROWS = 8;

// Effective runtime limits worth a glance. Everything else in runtime.* is a
// cache knob nobody tunes from a dashboard.
const RUNTIME_KEYS = Object.freeze([
  ["recallTimeoutMs", "Recall timeout", "ms"],
  ["captureTimeoutMs", "Capture timeout", "ms"],
  ["maxConcurrentRecall", "Concurrent recalls", ""],
  ["maxConcurrentCapturePerAgent", "Concurrent captures per agent", ""],
  ["maxQueueDepthRecall", "Recall queue depth", ""],
  ["maxQueueDepthCapturePerAgent", "Capture queue depth per agent", ""],
  ["backgroundPriority", "Background priority", ""],
  ["pressureGateEnabled", "Pressure gate", ""],
  ["recallCacheTtlMs", "Recall cache TTL", "ms"],
  ["embeddingCacheEnabled", "Embedding cache", ""],
  ["llmResultCacheEnabled", "LLM result cache", ""],
  ["llmResultCacheTtlMs", "LLM result cache TTL", "ms"],
]);

const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * Read the gc job's report from an agent workspace. The job runs once and
 * covers every agent, so the main agent's workspace holds the whole picture.
 * Missing or malformed files yield null; the panel then says so.
 * @param {string|null|undefined} workspaceDir
 * @returns {{runs:number, lastRun:object}|null}
 */
export function readGcReport(workspaceDir) {
  if (typeof workspaceDir !== "string" || !workspaceDir.trim()) return null;
  const path = join(workspaceDir, ...REPORT_RELATIVE_PATH);
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const runs = Array.isArray(parsed?.runs) ? parsed.runs.filter((run) => record(run) && typeof run.timestamp === "string") : [];
  if (!runs.length) return null;
  const last = runs[runs.length - 1];
  const at = Date.parse(last.timestamp);
  return {
    runs: runs.length,
    lastRun: {
      at: Number.isFinite(at) ? at : null,
      totalArchived: finite(last.totalArchived) ?? 0,
      totalSkipped: finite(last.totalSkipped) ?? 0,
      agents: (Array.isArray(last.agents) ? last.agents : [])
        .filter((entry) => record(entry) && typeof entry.agentId === "string" && AGENT_RE.test(entry.agentId))
        .map((entry) => ({
          agentId: entry.agentId,
          memoryCount: finite(entry.memoryCount),
          dbSizeMb: finite(entry.dbSizeMb),
          archived: finite(entry.archived) ?? 0,
          ok: entry.ok !== false,
        })),
    },
  };
}

/**
 * Project the panel's data from config, the health snapshot, the gc report
 * and a pressure reading. Pure: every input is a plain value.
 * @param {object} options
 * @param {object} options.config Effective PLUR1BUS config (defaults applied).
 * @param {object} [options.health] Projected memory health (cards.byAgent).
 * @param {object} [options.gcReport] Result of readGcReport.
 * @param {object} [options.pressure] Result of checkRuntimePressure.
 * @returns {object}
 */
export function projectOperations({ config = {}, health = null, gcReport = null, pressure = null } = {}) {
  const gc = record(config.gc);
  const runtime = record(config.runtime);
  const cap = finite(gc.maxMemoryCount);
  const lastRun = gcReport?.lastRun || null;
  const atGc = new Map((lastRun?.agents || []).map((entry) => [entry.agentId, entry]));
  const counted = (Array.isArray(health?.cards?.byAgent) ? health.cards.byAgent : [])
    .filter((entry) => record(entry) && typeof entry.id === "string" && AGENT_RE.test(entry.id) && finite(entry.cards) !== null)
    .map((entry) => {
      const gcRow = atGc.get(entry.id);
      const cards = entry.cards;
      return {
        id: entry.id,
        cards,
        activeAtGc: gcRow?.memoryCount ?? null,
        dbSizeMb: gcRow?.dbSizeMb ?? null,
        archivedLastRun: gcRow?.archived ?? null,
        // Headroom against the cap uses the live card count; without a cap
        // there is nothing to measure against.
        usedPct: cap ? Math.min(999, Math.round((cards / cap) * 100)) : null,
      };
    })
    .sort((a, b) => b.cards - a.cards);
  return {
    gc: {
      enabled: gc.enabled !== false,
      maxMemoryCount: cap,
      minMemoryStrength: finite(gc.minMemoryStrength),
      maxDbSizeMb: finite(gc.maxDbSizeMb),
      lastRun: lastRun
        ? { at: lastRun.at, totalArchived: lastRun.totalArchived, totalSkipped: lastRun.totalSkipped, agentsChecked: lastRun.agents.length, runs: gcReport.runs }
        : null,
      agents: counted.slice(0, MAX_AGENT_ROWS),
      moreAgents: Math.max(0, counted.length - MAX_AGENT_ROWS),
    },
    pressure: pressure && typeof pressure === "object"
      ? {
          level: ["ok", "warning", "critical"].includes(pressure.level) ? pressure.level : "unknown",
          rssBytes: finite(pressure.rssBytes),
          heapUsedBytes: finite(pressure.heapUsedBytes),
          warningBytes: finite(runtime.rssWarningBytes),
          criticalBytes: finite(runtime.rssCriticalBytes),
          gateEnabled: runtime.pressureGateEnabled !== false,
        }
      : null,
    runtime: RUNTIME_KEYS.map(([key, label, unit]) => {
      const value = runtime[key];
      return { key, label, unit, value: typeof value === "boolean" || typeof value === "string" || finite(value) !== null ? value : null };
    }),
  };
}

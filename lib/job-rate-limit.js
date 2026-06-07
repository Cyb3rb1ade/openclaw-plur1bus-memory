/**
 * lib/job-rate-limit.js — Persistentes Rate-Limiting für teure Hintergrund-Jobs.
 *
 * Speichert lastRunAt pro Job+Agent+Workspace in run-state.json.
 * Keine In-Memory-Lösung — State überlebt Gateway-Restarts.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { atomicJsonUpdate } from "./atomic-json.js";

const RATE_LIMIT_STATE_KEY = "jobRateLimits";

function readRateLimitState(statePath) {
  if (!statePath || !existsSync(statePath)) return {};
  try {
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed[RATE_LIMIT_STATE_KEY] || {};
  } catch {
    return {};
  }
}

function buildKey(jobKey, agentId, workspaceKey) {
  return `${jobKey}:${agentId || "all"}:${workspaceKey || "all"}`;
}

/**
 * Prüft, ob ein Job ausgeführt werden darf.
 * @returns {{allowed: boolean, remainingMs?: number, lastRunAt?: number}}
 */
export function checkJobRateLimit(jobKey, agentId, workspaceKey, intervalMs, statePath) {
  const state = readRateLimitState(statePath);
  const key = buildKey(jobKey, agentId, workspaceKey);
  const lastRunAt = state[key]?.lastRunAt || 0;
  const now = Date.now();
  const elapsed = now - lastRunAt;

  if (elapsed >= intervalMs) {
    return { allowed: true, lastRunAt };
  }
  return { allowed: false, remainingMs: intervalMs - elapsed, lastRunAt };
}

/**
 * Aktualisiert den State nach erfolgreicher Job-Ausführung.
 */
export async function recordJobRun(jobKey, agentId, workspaceKey, statePath) {
  if (!statePath) return;
  const dir = dirname(statePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const key = buildKey(jobKey, agentId, workspaceKey);
  await atomicJsonUpdate(statePath, (data) => {
    const state = data || {};
    state[RATE_LIMIT_STATE_KEY] = state[RATE_LIMIT_STATE_KEY] || {};
    state[RATE_LIMIT_STATE_KEY][key] = {
      lastRunAt: Date.now(),
      runCount: (state[RATE_LIMIT_STATE_KEY][key]?.runCount || 0) + 1,
    };
    return state;
  });
}

/**
 * lib/job-rate-limit.js — Persistentes Rate-Limiting für teure Hintergrund-Jobs.
 *
 * Speichert lastRunAt pro Job+Agent+Workspace in run-state.json.
 * Keine In-Memory-Lösung — State überlebt Gateway-Restarts.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

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

function writeRateLimitState(statePath, rateLimitState) {
  if (!statePath) return;
  const dir = dirname(statePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let fullState = {};
  if (existsSync(statePath)) {
    try {
      fullState = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      fullState = {};
    }
  }
  fullState[RATE_LIMIT_STATE_KEY] = rateLimitState;
  writeFileSync(statePath, JSON.stringify(fullState, null, 2) + "\n");
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
export function recordJobRun(jobKey, agentId, workspaceKey, statePath) {
  const state = readRateLimitState(statePath);
  const key = buildKey(jobKey, agentId, workspaceKey);
  state[key] = { lastRunAt: Date.now(), runCount: (state[key]?.runCount || 0) + 1 };
  writeRateLimitState(statePath, state);
}

/**
 * lib/metrics.js — Lightweight metrics accumulator for /zustand and Doctor.
 * Writes to workspace run-state.json under the "metrics" key.
 * Atomic via atomicJsonUpdate to prevent race conditions.
 *
 * P2F: Graph-recall metrics are now debounced (accumulated in memory,
 * flushed every 5 s) to avoid blocking the hot recall path.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicJsonUpdate } from "./atomic-json.js";
import { createMetricsDebouncer } from "./metrics-debounce.js";

// ─── Internal flush (synchronous disk write) ──────────────────────────────

async function _flushGraphRecallMetrics(workspaceDir, metrics) {
  if (!workspaceDir) return;
  const path = join(workspaceDir, "run-state.json");
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await atomicJsonUpdate(path, (data) => {
    const state = data || {};
    state.metrics = state.metrics || {};
    state.metrics.graphRecall = {
      ...(state.metrics.graphRecall || {}),
      ...metrics,
      lastRun: Date.now(),
    };
    return state;
  });
}

// ─── Debounced accumulator for the hot path ───────────────────────────────

const graphRecallDebouncer = createMetricsDebouncer({
  flushFn: _flushGraphRecallMetrics,
  debounceMs: 5000,
  onError: (err) => {
    // eslint-disable-next-line no-console
    console.warn("[metrics] graphRecall flush failed:", err?.message || err);
  },
});

// ─── Public API ───────────────────────────────────────────────────────────

export async function recordGraphRecallMetrics(workspaceDir, metrics) {
  // Hot-path: accumulate in memory, flush debounced
  graphRecallDebouncer.accumulate(workspaceDir, metrics);
}

export async function flushMetrics() {
  await graphRecallDebouncer.flush();
}

export async function recordObsidianSyncMetrics(workspaceDir, metrics) {
  if (!workspaceDir) return;
  const path = join(workspaceDir, "run-state.json");
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await atomicJsonUpdate(path, (data) => {
    const state = data || {};
    state.metrics = state.metrics || {};
    state.metrics.obsidianSync = {
      ...(state.metrics.obsidianSync || {}),
      ...metrics,
      lastRun: Date.now(),
    };
    return state;
  });
}

export function getMetrics(workspaceDir) {
  if (!workspaceDir) return {};
  try {
    const path = join(workspaceDir, "run-state.json");
    if (!existsSync(path)) return {};
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data.metrics || {};
  } catch {
    return {};
  }
}

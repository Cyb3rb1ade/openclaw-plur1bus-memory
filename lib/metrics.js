/**
 * lib/metrics.js — Lightweight metrics accumulator for /zustand and Doctor.
 * Writes to workspace run-state.json under the "metrics" key.
 * Atomic via atomicJsonUpdate to prevent race conditions.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicJsonUpdate } from "./atomic-json.js";

export async function recordGraphRecallMetrics(workspaceDir, metrics) {
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

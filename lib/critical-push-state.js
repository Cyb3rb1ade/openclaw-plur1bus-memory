/**
 * critical-push-state — Datei-basierte Tageszähler pro Agent.
 *
 * Pfad: <stateDir>/<agent>.json
 *
 * Datei-Format:
 *   { "2026-05-28": 2, "2026-05-27": 1, ... }
 *
 * Auto-Cleanup: Einträge älter als 7 Tage werden via cleanupOldCounts()
 * entfernt. Aufruf üblicherweise vom Cron-Job, bevor neue Counts gelesen
 * werden.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_STATE_DIR = join(homedir(), ".openclaw", "memory", "_critical-push-state");

function resolveDir(opts) {
  return opts?.stateDir || DEFAULT_STATE_DIR;
}

function fileFor(agent, opts) {
  const dir = resolveDir(opts);
  return join(dir, `${agent}.json`);
}

export function loadCounts(agent, opts = {}) {
  const path = fileFor(agent, opts);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) || {};
  } catch {
    return {};
  }
}

function atomicWrite(path, data) {
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export function saveCounts(agent, counts, opts = {}) {
  const path = fileFor(agent, opts);
  atomicWrite(path, counts);
}

export function incrementCount(agent, date, opts = {}) {
  const counts = loadCounts(agent, opts);
  counts[date] = (counts[date] || 0) + 1;
  saveCounts(agent, counts, opts);
  return counts[date];
}

function daysBetween(a, b) {
  // a, b im Format YYYY-MM-DD, beide UTC-interpretiert
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.floor((db - da) / 86400000);
}

/**
 * Entfernt Einträge älter als `maxAgeDays` (default 7) Tage relativ zu
 * `today` (Format YYYY-MM-DD).
 */
export function cleanupOldCounts(agent, today, opts = {}) {
  const maxAge = opts.maxAgeDays ?? 7;
  const counts = loadCounts(agent, opts);
  let changed = false;
  for (const date of Object.keys(counts)) {
    const age = daysBetween(date, today);
    if (age > maxAge) {
      delete counts[date];
      changed = true;
    }
  }
  if (changed) saveCounts(agent, counts, opts);
  return counts;
}

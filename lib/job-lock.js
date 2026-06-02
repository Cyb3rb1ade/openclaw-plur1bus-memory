/**
 * lib/job-lock.js — Atomic file-based locking für Cron-Jobs.
 *
 * Nutzt openSync mit "wx" (fail if exists) für atomare Lock-Erzeugung.
 * Staleness-Check: Locks älter als 10 Min werden als verwaist betrachtet.
 */

import { existsSync, openSync, closeSync, unlinkSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const DEFAULT_STALE_MS = 10 * 60 * 1000; // 10 Minuten

export function acquireJobLock(lockPath, opts = {}) {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const dir = dirname(lockPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (existsSync(lockPath)) {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > staleMs) {
      try { unlinkSync(lockPath); } catch (_) {}
    } else {
      throw new Error(`lock held: ${lockPath} (age=${age}ms)`);
    }
  }

  const fd = openSync(lockPath, "wx");
  writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  closeSync(fd);
  return lockPath;
}

export function releaseJobLock(lockPath) {
  try {
    if (lockPath && existsSync(lockPath)) unlinkSync(lockPath);
  } catch (_) {}
}

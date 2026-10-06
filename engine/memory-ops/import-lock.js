/**
 * engine/memory-ops/import-lock.js — per-agent writer lock for the apply path
 * of `memory.import` (K1).
 *
 * `pool.withWriteDb` is a refcount lease, not a mutex, so two imports of one
 * idempotencyKey could both re-check "absent" and both `store()` the same id.
 * This lock serialises the re-check → store → ledger section per agent:
 *  - in-process: a promise-tail mutex keyed by lock path (two engines in one
 *    process on one store share it, and nobody polls the file lock in-process);
 *  - cross-process: `tryAcquireOwnedLock` from lib/registry-lock.js (O_EXCL,
 *    nonce ownership, pid/incarnation-aware staleness), polled asynchronously
 *    so the event loop is not blocked while another process holds it.
 * The holder refreshes the lock mtime (`heartbeat()`) so a long batch is never
 * judged stale by a waiter while the holder is alive.
 *
 * Lock file: `{baseDbPath}/_imports/.locks/<agentId>.lock` (dir 0700). dryRun
 * never takes it, so a dry run creates no directory.
 */

import { existsSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { dirname } from "node:path";
import { tryAcquireOwnedLock } from "../../lib/registry-lock.js";
import { resolveInside, safeAgentId } from "../../lib/sql-safety.js";

export const IMPORT_LOCK_STALE_MS = 30_000;
export const IMPORT_LOCK_TIMEOUT_MS = 120_000;
const IMPORT_LOCK_RETRY_MS = 25;
const HEARTBEAT_MIN_INTERVAL_MS = 2_000;

/** In-process tails, keyed by absolute lock path. */
const tails = new Map();

/**
 * @param {string} baseDbPath
 * @param {string} agentId
 * @returns {string}
 */
export function importLockPath(baseDbPath, agentId) {
  return resolveInside(baseDbPath, "_imports", ".locks", `${safeAgentId(agentId)}.lock`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `fn` after every earlier holder of `key` in this process has settled. */
async function withInProcessMutex(key, fn) {
  const prev = tails.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = prev.then(() => gate);
  tails.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

function lockBusyError(lockPath, timeoutMs) {
  const err = new Error(`import lock busy (timeout after ${timeoutMs}ms)`);
  err.code = "IMPORT_LOCK_BUSY";
  err.lockPath = lockPath;
  return err;
}

function abortError() {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Runs `fn({heartbeat})` under the in-process mutex and the cross-process file
 * lock for (baseDbPath, agentId). The file lock is released in `finally`, and
 * only if it still carries our nonce.
 *
 * @param {string} baseDbPath
 * @param {string} agentId
 * @param {(ctx: {heartbeat: () => void}) => Promise<any>} fn
 * @param {{staleMs?: number, timeoutMs?: number, retryMs?: number, heartbeatMs?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<any>}
 * @throws {Error} `code: "IMPORT_LOCK_BUSY"` on timeout, an AbortError when
 *   `signal` aborts while waiting, or the fs error from creating the lock.
 */
export async function withImportLock(baseDbPath, agentId, fn, opts = {}) {
  const lockPath = importLockPath(baseDbPath, agentId);
  const staleMs = Number(opts.staleMs ?? IMPORT_LOCK_STALE_MS);
  const timeoutMs = Number(opts.timeoutMs ?? IMPORT_LOCK_TIMEOUT_MS);
  const retryMs = Math.max(1, Number(opts.retryMs ?? IMPORT_LOCK_RETRY_MS));
  const heartbeatMs = Math.max(0, Number(opts.heartbeatMs ?? HEARTBEAT_MIN_INTERVAL_MS));
  const signal = opts.signal;

  return withInProcessMutex(lockPath, async () => {
    const dir = dirname(lockPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + timeoutMs;
    let handle = null;
    for (;;) {
      if (signal?.aborted) throw abortError();
      handle = tryAcquireOwnedLock(lockPath, { staleMs });
      if (handle) break;
      if (Date.now() >= deadline) throw lockBusyError(lockPath, timeoutMs);
      await delay(retryMs);
    }

    let lastBeat = Date.now();
    const heartbeat = () => {
      const now = Date.now();
      if (now - lastBeat < heartbeatMs) return;
      lastBeat = now;
      try {
        // Refresh only a lock that is still ours; a broken-and-retaken lock is never touched.
        const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
        if (parsed?.nonce === handle.nonce) utimesSync(lockPath, new Date(now), new Date(now));
      } catch {
        // gone or unreadable: the stale rules decide; the holder keeps going
      }
    };

    try {
      return await fn({ heartbeat });
    } finally {
      handle.release();
    }
  });
}

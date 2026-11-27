/**
 * engine/memory-ops/import-lock.js — per-agent writer lock for the apply path
 * of `memory.import` (K1) and of `memory.unimport` (1.13.0): no import and
 * unimport of one agent run concurrently.
 *
 * `pool.withWriteDb` is a refcount lease, not a mutex, so two imports of one
 * idempotencyKey could both re-check "absent" and both `store()` the same id.
 * This lock serialises the re-check → store → ledger section per agent:
 *  - in-process: a FIFO waiter queue keyed by lock path (two engines in one
 *    process on one store share it, and nobody polls the file lock in-process);
 *  - cross-process: `tryAcquireOwnedLock` from lib/registry-lock.js (O_EXCL,
 *    nonce ownership, pid/incarnation-aware staleness), polled asynchronously
 *    so the event loop is not blocked while another process holds it.
 * One deadline (`timeoutMs`, default 120 s) covers the in-process queue wait
 * and the file-lock acquire; `signal` is honoured in both. A waiter that times
 * out or aborts leaves the queue without disturbing the other waiters.
 * The holder refreshes the lock mtime (`heartbeat()`) so a long batch is never
 * judged stale by a waiter while the holder is alive. The heartbeat is
 * call-driven (import.js calls it once per pending card), not a timer, so it
 * is not refreshed during a single slow `store()` or the backfill loop; only
 * foreign-host waiters judge by age, at 10 × staleMs = 300 s.
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

/**
 * In-process queues, keyed by absolute lock path: `{ held, waiters }`.
 * Invariant: `waiters.length > 0` implies `held`. Release hands the slot to the
 * first waiter synchronously (no lost wake-up); a waiter that times out or is
 * aborted removes itself before it can be granted, so it never holds or
 * releases the slot.
 */
const queues = new Map();

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

function releaserFor(key, q) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = q.waiters.shift();
    if (next) {
      next.grant();
    } else {
      q.held = false;
      if (queues.get(key) === q) queues.delete(key);
    }
  };
}

/**
 * Takes the in-process slot for `key` in FIFO order. Rejects with
 * IMPORT_LOCK_BUSY at `deadline` or with an AbortError when `signal` aborts,
 * in both cases leaving the queue intact for the other waiters.
 * @returns {Promise<() => void>} idempotent release
 */
function acquireInProcess(key, { deadline, signal, timeoutMs }) {
  let q = queues.get(key);
  if (!q) {
    q = { held: false, waiters: [] };
    queues.set(key, q);
  }
  if (signal?.aborted) return Promise.reject(abortError());
  if (!q.held) {
    q.held = true;
    return Promise.resolve(releaserFor(key, q));
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(lockBusyError(key, timeoutMs));
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener?.("abort", onAbort);
    };
    const drop = (err) => {
      const idx = q.waiters.indexOf(waiter);
      if (idx < 0) return; // already granted
      q.waiters.splice(idx, 1);
      cleanup();
      reject(err);
    };
    function onAbort() { drop(abortError()); }
    const waiter = {
      grant() {
        cleanup();
        resolve(releaserFor(key, q));
      },
    };
    q.waiters.push(waiter);
    timer = setTimeout(() => drop(lockBusyError(key, timeoutMs)), remaining);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function lockBusyError(lockPath, timeoutMs) {
  const err = new Error(`import lock busy (timeout after ${timeoutMs}ms)`);
  err.code = "IMPORT_LOCK_BUSY";
  err.lockPath = lockPath;
  return err;
}

function lockLostError(lockPath) {
  const err = new Error("import lock was lost");
  err.code = "IMPORT_LOCK_LOST";
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
 * @param {(ctx: {heartbeat: () => void, assertHeld: () => void}) => Promise<any>} fn
 *   `assertHeld()` throws `code: "IMPORT_LOCK_LOST"` when the lock file no longer carries our nonce.
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

  // One deadline covers the in-process queue wait and the file-lock acquire.
  const deadline = Date.now() + timeoutMs;
  const releaseInProcess = await acquireInProcess(lockPath, { deadline, signal, timeoutMs });
  try {
    const dir = dirname(lockPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    let handle = null;
    for (;;) {
      if (signal?.aborted) throw abortError();
      handle = tryAcquireOwnedLock(lockPath, { staleMs });
      if (handle) break;
      const left = deadline - Date.now();
      if (left <= 0) throw lockBusyError(lockPath, timeoutMs);
      await delay(Math.min(retryMs, left));
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

    // 1.13.0 fence: `memory.unimport` calls this before every store or ledger
    // write. A lock file that is gone, unreadable or carries another nonce
    // means a waiter judged us stale and took over; the holder must stop.
    const assertHeld = () => {
      let parsed = null;
      try {
        parsed = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {
        parsed = null;
      }
      if (!parsed || parsed.nonce !== handle.nonce) throw lockLostError(lockPath);
    };

    try {
      return await fn({ heartbeat, assertHeld });
    } finally {
      handle.release();
    }
  } finally {
    releaseInProcess();
  }
}

/**
 * scripts/dist/installer/fsutil.mjs — the installer's shared filesystem helpers.
 *
 * Atomic writes (temp `<name>.tmp-<pid>` → fsync → rename) and, on win32, retries of
 * EPERM/EBUSY/EACCES with backoff for up to 10 s (Defender, spec B.5). Nothing here
 * ever hard-links (R-S8).
 */

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const WIN_RETRY = new Set(["EPERM", "EBUSY", "EACCES"]);

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn`; on win32 retry EPERM/EBUSY/EACCES with backoff for up to 10 s. */
export function withWinRetry(fn, { platform = process.platform } = {}) {
  const deadline = Date.now() + 10_000;
  for (let delay = 50; ; delay = Math.min(delay * 2, 1000)) {
    try {
      return fn();
    } catch (err) {
      if (platform !== "win32" || !WIN_RETRY.has(err?.code) || Date.now() > deadline) throw err;
      sleepSync(delay);
    }
  }
}

export function renameWithRetry(from, to) {
  return withWinRetry(() => renameSync(from, to));
}

export function rmTree(path) {
  return withWinRetry(() => rmSync(path, { recursive: true, force: true }));
}

/** temp `<name>.tmp-<pid>` (mode 0600, exclusive) → fsync → rename. */
export function writeFileAtomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  rmSync(tmp, { force: true }); // a stale temp of a reused pid must not lend its mode
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameWithRetry(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

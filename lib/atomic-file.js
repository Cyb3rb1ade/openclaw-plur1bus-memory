/**
 * lib/atomic-file.js — shared atomic JSON/text file IO helpers.
 *
 * Every write goes to a UNIQUE temp sibling (`<name>.<pid>.<random>.tmp`, same
 * directory so the rename stays on one filesystem), is fsynced, then renamed
 * over the target. A fixed `<target>.tmp` name is a cross-process race: two
 * writers share one temp path and the loser's rename fails with ENOENT. On any
 * failure the temp file is removed.
 *
 * `acceptExisting(text)` makes an init-style write idempotent: when the rename
 * fails (typically Windows EPERM/EBUSY while a peer holds the target) and the
 * target already holds content the predicate accepts, the lost race counts as
 * success. ONLY for idempotent values (the same intended content, e.g. a schema
 * version marker); never for read-modify-write state, where a peer's content
 * would silently replace this call's update.
 *
 * Windows: a rename onto a target a peer is renaming or holding open fails with
 * EPERM/EBUSY/EACCES, so the rename is retried with backoff (bounded, default
 * 10 s) on win32 before giving up.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

export function readJsonSafe(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (_) {
    return fallback;
  }
}

const WIN_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
export const WIN_RENAME_RETRY_MS = 10_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * renameSync with a bounded win32 retry for EPERM/EBUSY/EACCES (same policy as
 * lib/snapshot/store-snapshot.js). Other platforms and codes throw at once.
 * @param {string} from
 * @param {string} to
 * @param {{platform?: string, rename?: Function, maxMs?: number}} [options] test seams
 */
export function renameWithWinRetrySync(from, to, { platform = process.platform, rename: doRename = renameSync, maxMs = WIN_RENAME_RETRY_MS } = {}) {
  const start = Date.now();
  let delay = 10;
  for (;;) {
    try {
      return doRename(from, to);
    } catch (error) {
      if (platform !== "win32" || !WIN_RETRY_CODES.has(error?.code) || Date.now() - start > maxMs) throw error;
      sleepSync(delay);
      delay = Math.min(delay * 2, 200);
    }
  }
}

/** Async twin of {@link renameWithWinRetrySync}. */
export async function renameWithWinRetry(from, to, { platform = process.platform, rename: doRename = rename, maxMs = WIN_RENAME_RETRY_MS } = {}) {
  const start = Date.now();
  let delay = 10;
  for (;;) {
    try {
      return await doRename(from, to);
    } catch (error) {
      if (platform !== "win32" || !WIN_RETRY_CODES.has(error?.code) || Date.now() - start > maxMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 200);
    }
  }
}

/**
 * Remove orphaned unique temp files (`[.]<baseName>.<pid>.<12 hex>.tmp`) that a
 * crashed writer left in `dir`, when older than `maxAgeMs`. Best effort.
 * @returns {number} files removed
 */
export function sweepStaleTmp(dir, baseName, { maxAgeMs = 10 * 60_000, now = Date.now() } = {}) {
  const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\.?${escaped}\\.\\d+\\.[0-9a-f]{12}\\.tmp$`);
  let removed = 0;
  let names;
  try { names = readdirSync(dir); } catch (_) { return 0; }
  for (const name of names) {
    if (!re.test(name)) continue;
    const full = join(dir, name);
    try {
      if (now - statSync(full).mtimeMs > maxAgeMs) {
        unlinkSync(full);
        removed++;
      }
    } catch (_) { /* raced with a peer or already gone */ }
  }
  return removed;
}

/**
 * Unique temp path next to `path` (same directory).
 * @param {string} path Target file.
 * @param {{hidden?: boolean}} [options] `hidden` prefixes the name with a dot.
 * @returns {string}
 */
export function uniqueTmpPath(path, { hidden = false } = {}) {
  const name = `${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  return join(dirname(path), hidden ? `.${name}` : name);
}

function acceptsExistingSync(path, acceptExisting) {
  if (typeof acceptExisting !== "function") return false;
  try {
    return acceptExisting(readFileSync(path, "utf8")) === true;
  } catch (_) {
    return false;
  }
}

async function acceptsExisting(path, acceptExisting) {
  if (typeof acceptExisting !== "function") return false;
  try {
    return acceptExisting(await readFile(path, "utf8")) === true;
  } catch (_) {
    return false;
  }
}

/**
 * Atomically replace `path` with `data` (unique tmp + fsync + rename).
 * Does not create the parent directory.
 * @param {string} path
 * @param {string|Buffer} data
 * @param {{mode?: number, fsync?: boolean, hidden?: boolean, acceptExisting?: (text: string) => boolean, winRetryMs?: number}} [options]
 * @returns {boolean} true when this call's rename landed; false when a failed
 *   rename was forgiven because the target already holds accepted content.
 */
export function writeFileAtomicSync(path, data, { mode = 0o666, fsync = true, hidden = false, acceptExisting, winRetryMs = WIN_RENAME_RETRY_MS } = {}) {
  const tmp = uniqueTmpPath(path, { hidden });
  let fd;
  try {
    fd = openSync(tmp, "wx", mode);
    writeFileSync(fd, data, typeof data === "string" ? "utf8" : undefined);
    if (fsync) fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameWithWinRetrySync(tmp, path, { maxMs: winRetryMs });
    return true;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch (_) { /* best effort */ }
    }
    try { unlinkSync(tmp); } catch (_) { /* already gone */ }
    if (acceptsExistingSync(path, acceptExisting)) return false;
    throw error;
  }
}

/** Async twin of {@link writeFileAtomicSync}. */
export async function writeFileAtomic(path, data, { mode = 0o666, fsync = true, hidden = false, acceptExisting, winRetryMs = WIN_RENAME_RETRY_MS } = {}) {
  const tmp = uniqueTmpPath(path, { hidden });
  let handle;
  try {
    handle = await open(tmp, "wx", mode);
    await handle.writeFile(data, typeof data === "string" ? "utf8" : undefined);
    if (fsync) await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithWinRetry(tmp, path, { maxMs: winRetryMs });
    return true;
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch (_) { /* best effort */ }
    }
    try { await unlink(tmp); } catch (_) { /* already gone */ }
    if (await acceptsExisting(path, acceptExisting)) return false;
    throw error;
  }
}

export function writeJsonAtomic(path, data, { pretty = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  writeFileAtomicSync(path, text);
}

export function writeTextAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomicSync(path, text);
}

/** Async text write; creates the parent directory. */
export async function writeTextAtomicAsync(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, text);
}

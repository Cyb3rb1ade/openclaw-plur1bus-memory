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
 * success.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
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
 * @param {{mode?: number, fsync?: boolean, hidden?: boolean, acceptExisting?: (text: string) => boolean}} [options]
 * @returns {boolean} true when this call's rename landed; false when a failed
 *   rename was forgiven because the target already holds accepted content.
 */
export function writeFileAtomicSync(path, data, { mode = 0o666, fsync = true, hidden = false, acceptExisting } = {}) {
  const tmp = uniqueTmpPath(path, { hidden });
  let fd;
  try {
    fd = openSync(tmp, "wx", mode);
    writeFileSync(fd, data, typeof data === "string" ? "utf8" : undefined);
    if (fsync) fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
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
export async function writeFileAtomic(path, data, { mode = 0o666, fsync = true, hidden = false, acceptExisting } = {}) {
  const tmp = uniqueTmpPath(path, { hidden });
  let handle;
  try {
    handle = await open(tmp, "wx", mode);
    await handle.writeFile(data, typeof data === "string" ? "utf8" : undefined);
    if (fsync) await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, path);
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

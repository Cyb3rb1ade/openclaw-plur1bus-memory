/**
 * lib/fsync-atomic.js — unique tmp + fsync + rename + directory fsync.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { uniqueTmpPath } from "./atomic-file.js";

/**
 * Atomically write text with file and directory fsync. The temp file is a
 * unique hidden sibling (`.<name>.<pid>.<random>.tmp`), so concurrent writers
 * of the same target never share a temp path; it is removed on failure.
 * @param {string} path
 * @param {string} content
 * @param {{platform?: string, fsync?: Function, acceptExisting?: (text: string) => boolean}} [options]
 *   `platform` defaults to `process.platform`; `fsync` (default `fsyncSync`) is
 *   a test seam. `acceptExisting` makes a failed rename (lost race) a success
 *   when the target already holds content the predicate accepts.
 */
export function writeTextFsync(path, content, { platform = process.platform, fsync = fsyncSync, acceptExisting } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = uniqueTmpPath(path, { hidden: true });
  let fd;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, String(content), "utf8");
    fsync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(tmp); } catch { /* already gone */ }
    let forgiven = false;
    if (typeof acceptExisting === "function") {
      try { forgiven = acceptExisting(readFileSync(path, "utf8")) === true; } catch { forgiven = false; }
    }
    if (forgiven) return;
    throw error;
  }
  // Windows has no directory fsync: fsync on a directory handle fails with
  // EPERM there, and NTFS journals the rename itself. POSIX keeps it.
  if (platform === "win32") return;
  const dirFd = openSync(dirname(path), "r");
  try {
    fsync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/**
 * Atomically write JSON with file and directory fsync.
 * @param {string} path
 * @param {object} value
 * @param {{acceptExisting?: (text: string) => boolean}} [options]
 */
export function writeJsonFsync(path, value, options = {}) {
  writeTextFsync(path, `${JSON.stringify(value)}\n`, options);
}

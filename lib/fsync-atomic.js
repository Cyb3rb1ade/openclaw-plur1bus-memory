/**
 * lib/fsync-atomic.js — tmp + fsync + rename + directory fsync.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Atomically write text with file and directory fsync.
 * @param {string} path
 * @param {string} content
 * @param {{platform?: string, fsync?: Function}} [options] `platform` defaults to
 *   `process.platform`; `fsync` (default `fsyncSync`) is a test seam.
 */
export function writeTextFsync(path, content, { platform = process.platform, fsync = fsyncSync } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, String(content), "utf8");
    fsync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
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
 */
export function writeJsonFsync(path, value) {
  writeTextFsync(path, `${JSON.stringify(value)}\n`);
}

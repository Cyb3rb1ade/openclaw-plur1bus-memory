/**
 * lib/fsync-atomic.js — tmp + fsync + rename + directory fsync.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Atomically write text with file and directory fsync.
 * @param {string} path
 * @param {string} content
 */
export function writeTextFsync(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, String(content), "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dirFd = openSync(dirname(path), "r");
  try {
    fsyncSync(dirFd);
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

/**
 * lib/private-fs.js
 *
 * Owner-only file and directory modes for sidecar files that hold message text
 * (N2 leak audit I-8). POSIX only: on win32 the mode arguments are ignored by
 * Node and chmod is skipped, so behavior there is unchanged.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { securePath } from "./platform.js";

const IS_WIN32 = process.platform === "win32";
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Tighten an existing path to `mode`. Best effort; never throws.
 *
 * @param {string} path File or directory.
 * @param {number} mode Target mode.
 */
export function tightenMode(path, mode) {
  if (IS_WIN32) return;
  try { securePath(path, { mode }); } catch { /* path vanished or not ours */ }
}

/**
 * mkdir -p with mode 0700; an already existing directory is tightened to 0700.
 *
 * @param {string} dir Directory.
 */
export function ensurePrivateDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  tightenMode(dir, PRIVATE_DIR_MODE);
}

/**
 * writeFileSync with mode 0600; the mode is also applied when the file existed.
 *
 * @param {string} path File.
 * @param {string|Buffer} data Content, unchanged.
 */
export function writePrivateFileSync(path, data) {
  writeFileSync(path, data, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  tightenMode(path, PRIVATE_FILE_MODE);
}

/**
 * appendFileSync with mode 0600; an existing file is tightened on this write.
 *
 * @param {string} path File.
 * @param {string} data Content, unchanged.
 */
export function appendPrivateFileSync(path, data) {
  appendFileSync(path, data, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  tightenMode(path, PRIVATE_FILE_MODE);
}

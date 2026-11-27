/**
 * tests/helpers/fs-snapshot.js — a recursive stat snapshot of a directory
 * tree and the diff between two snapshots. The warm-recall tests (E5 Task 9)
 * use it to prove a run changed nothing on disk.
 */

import { lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Snapshot every entry below `root` (the root itself excluded).
 *
 * @param {string} root Directory to walk; a missing root gives an empty map.
 * @returns {Map<string, {type: "file"|"dir"|"symlink"|"other", size: number, mtimeMs: number}>} Keyed by the path relative to `root`.
 */
export function snapshotTree(root) {
  const out = new Map();
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = join(dir, name);
      let stat;
      try { stat = lstatSync(full); } catch { continue; }
      const type = stat.isDirectory() ? "dir" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other";
      out.set(relative(root, full), { type, size: type === "dir" ? 0 : stat.size, mtimeMs: stat.mtimeMs });
      if (type === "dir") walk(full);
    }
  };
  walk(root);
  return out;
}

/**
 * The entries added, removed and changed (type, size or mtime) from `a` to `b`.
 *
 * @param {Map<string, {type: string, size: number, mtimeMs: number}>} a Earlier snapshot.
 * @param {Map<string, {type: string, size: number, mtimeMs: number}>} b Later snapshot.
 * @returns {{added: string[], removed: string[], changed: string[]}} Sorted relative paths.
 */
export function diffSnapshots(a, b) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [path, entry] of b) {
    const before = a.get(path);
    if (!before) added.push(path);
    else if (before.type !== entry.type || before.size !== entry.size || before.mtimeMs !== entry.mtimeMs) changed.push(path);
  }
  for (const path of a.keys()) if (!b.has(path)) removed.push(path);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/**
 * lib/atomic-file.js — shared atomic JSON/text file IO helpers.
 *
 * Replaces the seven hand-rolled tmp-file+rename copies scattered across the
 * humanization modules. Behavior-preserving: same fail-open read semantics,
 * same tmp-suffix scheme (`${path}.${pid}.${Date.now()}.tmp`), same
 * mkdir-recursive-before-write.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJsonSafe(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (_) {
    return fallback;
  }
}

export function writeJsonAtomic(path, data, { pretty = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

export function writeTextAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/**
 * lib/atomic-json.js — Atomic read-modify-write for JSON files with
 * per-file Promise-Queue (mutex) and reentrancy protection.
 *
 * Reading: a missing file (ENOENT) starts as `{}`. A file that exists but does
 * not parse is NOT replaced by `{}` silently: it is moved aside as
 * `<file>.corrupt-<timestamp>` (original bytes kept), the move is logged, and the
 * update starts from `{}`. Any other IO error (EACCES, EISDIR, EIO, ...) is thrown,
 * so the updater never runs on data that could not be read.
 *
 * Writing: unique temp file, fsync, rename (lib/atomic-file.js `writeFileAtomic`).
 *
 * Reentrancy: an update of file F started from inside the updater of F would wait
 * in F's queue for the update that is waiting for it. It is detected through the
 * async call chain and rejects at once instead.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { access, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";

const fileQueues = new Map();
/** Files whose update is running in the current async call chain. */
const heldFiles = new AsyncLocalStorage();

async function quarantineCorrupt(filePath, parseError) {
  const stamp = Date.now();
  let aside = `${filePath}.corrupt-${stamp}`;
  for (let k = 2; await access(aside).then(() => true, () => false); k++) aside = `${filePath}.corrupt-${stamp}-${k}`;
  await rename(filePath, aside); // a failing rename throws: never overwrite what we could not set aside
  console.warn(`[memory-lancedb-namespaced] atomic-json: ${filePath} is not valid JSON (${parseError?.message ?? parseError}); moved to ${aside}, continuing with an empty object`);
}

async function readJson(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (parseError) {
    await quarantineCorrupt(filePath, parseError);
    return {};
  }
}

/**
 * Apply an atomic JSON read-modify-write behind a per-file async queue.
 * @param {string} filePath JSON file path to update.
 * @param {(data: object) => object|Promise<object>} updater Function that returns the updated JSON value.
 * @returns {Promise<object>} The updated JSON value.
 * @throws {Error} on a nested update of the same file, a non-ENOENT read error, a failed
 *   quarantine of a corrupt file, or a failed write.
 */
export async function atomicJsonUpdate(filePath, updater) {
  const key = resolve(filePath);
  const outer = heldFiles.getStore();
  if (outer?.has(key)) {
    throw new Error(`Nested atomicJsonUpdate for same file is not allowed: ${filePath}`);
  }
  const held = new Set(outer ?? []);
  held.add(key);

  const prev = fileQueues.get(key) || Promise.resolve();
  const next = prev
    // Swallow predecessor error so the queue continues — intentional. The
    // failed operation already settled its own promise; we don't propagate
    // it forward because the next writer is independent of the previous one.
    .catch(() => {})
    .then(() => heldFiles.run(held, async () => {
      const data = await readJson(filePath);
      const updated = await updater(data);
      await writeFileAtomic(filePath, JSON.stringify(updated));
      return updated;
    }));
  fileQueues.set(key, next);
  next.catch(() => {}).finally(() => {
    if (fileQueues.get(key) === next) fileQueues.delete(key);
  });
  return next;
}

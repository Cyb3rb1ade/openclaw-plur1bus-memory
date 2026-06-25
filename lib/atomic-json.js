/**
 * lib/atomic-json.js — Atomic read-modify-write for JSON files with
 * per-file Promise-Queue (mutex) and reentrancy protection.
 */

import { readFile, rename, writeFile } from "node:fs/promises";

const fileQueues = new Map();
const activeFiles = new Set();

async function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (_) { /* ignore parse errors, return fallback */ }
  return fallback;
}

/**
 * Apply an atomic JSON read-modify-write behind a per-file async queue.
 * @param {string} filePath JSON file path to update.
 * @param {(data: object) => object|Promise<object>} updater Function that returns the updated JSON value.
 * @returns {Promise<object>} The updated JSON value.
 */
export async function atomicJsonUpdate(filePath, updater) {
  const prev = fileQueues.get(filePath) || Promise.resolve();
  const next = prev
    // Swallow predecessor error so the queue continues — intentional. The
    // failed operation already settled its own promise; we don't propagate
    // it forward because the next writer is independent of the previous one.
    .catch(() => {})
    .then(async () => {
      if (activeFiles.has(filePath)) {
        throw new Error(`Nested atomicJsonUpdate for same file is not allowed: ${filePath}`);
      }
      activeFiles.add(filePath);
      try {
        const data = await readJson(filePath);
        const updated = await updater(data);
        const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await writeFile(tmp, JSON.stringify(updated));
        await rename(tmp, filePath);
        return updated;
      } finally {
        activeFiles.delete(filePath);
      }
    });
  fileQueues.set(filePath, next);
  next.catch(() => {}).finally(() => {
    if (fileQueues.get(filePath) === next) fileQueues.delete(filePath);
  });
  return next;
}

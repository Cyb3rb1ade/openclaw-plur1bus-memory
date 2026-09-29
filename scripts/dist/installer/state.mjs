/**
 * scripts/dist/installer/state.mjs — the installer's own state file.
 *
 * `<stateDir>/memory/.plur1bus-installer.json`, mode 0600:
 *   { schema: 1, previousSlot, installedVersion, source, licence?, inProgress?: { op, step, snapshotId, previousVersion } }
 * Written atomically (temp `<name>.tmp-<pid>` → fsync → rename; on Windows the
 * rename retries EPERM/EBUSY/EACCES for up to 10 s). It never holds config
 * values or credentials.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

export const STATE_SCHEMA = 1;
export const STATE_FILE = ".plur1bus-installer.json";
const WIN_RETRY = new Set(["EPERM", "EBUSY", "EACCES"]);

export function statePath(stateDir) {
  return join(stateDir, "memory", STATE_FILE);
}

/** @returns {null | { schema: 1, previousSlot: string|null, installedVersion: string|null, source: string|null, licence?: object, inProgress?: object }} */
export function readState(stateDir) {
  let text;
  try {
    text = readFileSync(statePath(stateDir), "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  const s = JSON.parse(text);
  if (!s || typeof s !== "object" || s.schema !== STATE_SCHEMA) {
    throw new Error(`${statePath(stateDir)}: unknown installer state schema ${JSON.stringify(s?.schema)}`);
  }
  return s;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from, to) {
  const deadline = Date.now() + 10_000;
  for (let delay = 50; ; delay = Math.min(delay * 2, 1000)) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (process.platform !== "win32" || !WIN_RETRY.has(err?.code) || Date.now() > deadline) throw err;
      sleepSync(delay);
    }
  }
}

export function writeState(stateDir, s) {
  const target = statePath(stateDir);
  mkdirSync(join(stateDir, "memory"), { recursive: true });
  const doc = { schema: STATE_SCHEMA, previousSlot: s.previousSlot ?? null, installedVersion: s.installedVersion ?? null, source: s.source ?? null };
  if (s.licence) doc.licence = s.licence;
  if (s.inProgress) doc.inProgress = s.inProgress;
  const tmp = `${target}.tmp-${process.pid}`;
  rmSync(tmp, { force: true }); // a stale temp of a reused pid must not lend its mode
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(doc, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameWithRetry(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return doc;
}

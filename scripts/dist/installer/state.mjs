/**
 * scripts/dist/installer/state.mjs — the installer's own state file.
 *
 * `<stateDir>/memory/.plur1bus-installer.json`, mode 0600:
 *   { schema: 1, previousSlot, installedVersion, source, licence?, inProgress?: { op, step, snapshotId, previousVersion } }
 * Written atomically (temp `<name>.tmp-<pid>` → fsync → rename; on Windows the
 * rename retries EPERM/EBUSY/EACCES for up to 10 s). It never holds config
 * values or credentials.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./fsutil.mjs";

export const STATE_SCHEMA = 1;
export const STATE_FILE = ".plur1bus-installer.json";

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

export function writeState(stateDir, s) {
  const target = statePath(stateDir);
  mkdirSync(join(stateDir, "memory"), { recursive: true });
  const doc = { schema: STATE_SCHEMA, previousSlot: s.previousSlot ?? null, installedVersion: s.installedVersion ?? null, source: s.source ?? null };
  if (s.licence) doc.licence = s.licence;
  if (s.inProgress) doc.inProgress = s.inProgress;
  writeFileAtomic(target, `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

/**
 * scripts/dist/installer/hermes/state.mjs — the Hermes installer's state file (ruling F19).
 *
 * `$HERMES_HOME/.plur1bus-installer.json`, schema 1, mode 0600, written atomically (temp → fsync →
 * rename, Windows retries). It records what a run changed, so a rollback, a resumed run after a kill,
 * and Task 9's update and uninstall can undo exactly that and nothing else:
 *   installedVersion, previousProvider (memory.provider before the first install; null = built-in),
 *   plur1busHome, bin, agentId, sidecarFresh (this run created the PLUR1BUS home), binFresh,
 *   previousBin, providerPrev, agentCreated, registryAdded, registryPreexisted (this home was registered before the
 *   first attempt: a rollback then never unbinds it), bindingPrev (the previous binding text),
 *   configEdit ({ method: "cli" } or { method: "line", undo, backup }), useClass, licence,
 *   the progress marks sidecarInstalled, setupRan, providerInstalled, pluginsDirCreated, bindingWritten,
 *   inProgress?: { op: "install"|"update"|"uninstall", step, version }; `update` / `uninstall` hold those runs' progress
 *   (Task 9: hermes/update.mjs, hermes/uninstall.mjs).
 * Resume rule (F19): a run that finds `inProgress` finishes the install: it carries the recorded pre-install
 * values (previousProvider, sidecarFresh, …) and re-runs the steps, each of which checks and skips what is
 * already done (sidecar version, agent, registry entry, provider MANIFEST); any failure rolls back with the
 * carried values. `--rollback` (or a recorded `rollback-failed`) only rolls back. Leftover
 * `plugins/plur1bus.tmp-*` directories are removed first.
 * It never holds config values other than memory.provider, and no secret.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../fsutil.mjs";

export const HERMES_STATE_SCHEMA = 1;
export const HERMES_STATE_FILE = ".plur1bus-installer.json";

const FIELDS = [
  "installedVersion", "previousProvider", "plur1busHome", "bin", "agentId", "sidecarFresh", "binFresh", "previousBin",
  "providerPrev", "agentCreated", "registryAdded", "bindingPrev", "configEdit", "useClass", "licence", "inProgress",
  // Task 9: an update's or uninstall's own progress (op "update" | "uninstall")
  "update", "uninstall",
  // I1: an install's update-grade progress when it replaces an older shared host sidecar (same shape as update)
  "hostUpdate",
  // memory.provider exactly as Hermes reported it before the install ("" for unset; "none", "builtin" … kept apart)
  "previousProviderRaw",
  // progress marks, set before each change (a killed run's rollback undoes exactly what they name)
  "sidecarInstalled", "setupRan", "providerInstalled", "providerPreexisted", "pluginsDirCreated", "bindingWritten", "registryPending", "registryPreexisted",
];

export function hermesStatePath(hermesHome) {
  return join(hermesHome, HERMES_STATE_FILE);
}

/** @returns {null | Record<string, any>} */
export function readHermesState(hermesHome) {
  let text;
  try {
    text = readFileSync(hermesStatePath(hermesHome), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    throw new Error(`${hermesStatePath(hermesHome)}: not valid JSON`);
  }
  if (!s || typeof s !== "object" || s.schema !== HERMES_STATE_SCHEMA) throw new Error(`${hermesStatePath(hermesHome)}: unknown installer state schema ${JSON.stringify(s?.schema)}`);
  return s;
}

export function writeHermesState(hermesHome, s) {
  const doc = { schema: HERMES_STATE_SCHEMA };
  for (const k of FIELDS) if (s[k] !== undefined && s[k] !== null) doc[k] = s[k];
  if (s.previousProvider === null) doc.previousProvider = null;
  writeFileAtomic(hermesStatePath(hermesHome), `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

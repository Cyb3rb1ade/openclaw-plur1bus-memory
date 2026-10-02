/**
 * scripts/dist/installer/hermes/provider.mjs — the `plur1bus` directory provider in `$HERMES_HOME/plugins/`.
 *
 * The tarball (HM2 Task 7, HM2-R21: `plur1bus/**` plus `plur1bus/MANIFEST.json`
 * `{ schema: "plur1bus.hermes-provider/1", version, files: { "<archive path>": sha256 } }`) is
 * extracted by ../untar.mjs into `plugins/plur1bus.tmp-<pid>/`, and MANIFEST.json is re-checked
 * (every file listed, every listed file present, every hash equal, the version the feed names).
 * Only then is an existing `plugins/plur1bus` moved to `plugins/.plur1bus-prev-<ts>` and the new
 * directory renamed into place. A rollback removes ours and renames the previous one back; a finished
 * install removes the previous one. Hermes writes `__pycache__/` into the directory on first import
 * (fact sheet §d): every later check ignores it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { renameWithRetry, rmTree } from "../fsutil.mjs";
import { extractTarGz, sha256Hex } from "../untar.mjs";

export const PROVIDER_NAME = "plur1bus";
export const PROVIDER_MANIFEST_SCHEMA = "plur1bus.hermes-provider/1";
export const MAX_PROVIDER_BYTES = 16 * 1024 * 1024;

export const pluginsDir = (hermesHome) => join(hermesHome, "plugins");
export const providerDir = (hermesHome) => join(pluginsDir(hermesHome), PROVIDER_NAME);
export const previousProviderPath = (hermesHome, now = Date.now) => join(pluginsDir(hermesHome), `.${PROVIDER_NAME}-prev-${now()}`);

function listFiles(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__pycache__") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

/**
 * Check a provider directory against its MANIFEST.json (paths in the manifest carry the `plur1bus/` prefix).
 * @returns {{ ok: boolean, detail: string, version: string|null }}
 */
export function checkProviderDir(dir, { version = null } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf8"));
  } catch (err) {
    return { ok: false, detail: `MANIFEST.json ${err?.code === "ENOENT" ? "missing" : "unreadable"}`, version: null };
  }
  if (manifest?.schema !== PROVIDER_MANIFEST_SCHEMA || !manifest.files || typeof manifest.files !== "object") {
    return { ok: false, detail: `MANIFEST.json is not a ${PROVIDER_MANIFEST_SCHEMA} document`, version: null };
  }
  const v = typeof manifest.version === "string" ? manifest.version : null;
  if (version && v !== version) return { ok: false, detail: `provider version ${v} is not the feed's ${version}`, version: v };
  const expected = new Map(Object.entries(manifest.files).map(([k, h]) => [k, h]));
  const present = listFiles(dir).map((p) => `${PROVIDER_NAME}/${relative(dir, p).split(sep).join("/")}`).filter((p) => p !== `${PROVIDER_NAME}/MANIFEST.json`);
  for (const p of present) {
    if (!expected.has(p)) return { ok: false, detail: `${p} is not in MANIFEST.json`, version: v };
    const h = sha256Hex(readFileSync(join(dir, ...p.split("/").slice(1))));
    if (h !== expected.get(p)) return { ok: false, detail: `${p} does not match MANIFEST.json`, version: v };
  }
  if (present.length !== expected.size) {
    const have = new Set(present);
    return { ok: false, detail: `${[...expected.keys()].find((k) => !have.has(k))} is missing`, version: v };
  }
  return { ok: true, detail: `${present.length} files match MANIFEST.json (provider ${v})`, version: v };
}

/** Remove what a killed run left: `plugins/plur1bus.tmp-*` staging directories. @returns {string[]} removed */
export function removeStaging(hermesHome) {
  const dir = pluginsDir(hermesHome);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed = [];
  for (const n of names) {
    if (/^plur1bus\.tmp-\d+$/.test(n)) {
      rmTree(join(dir, n));
      removed.push(n);
    }
  }
  return removed;
}

/**
 * @param {{ hermesHome: string, tarball: string, sha256?: string|null, version?: string|null, now?: () => number, previousDirName?: string|null }} a
 *   `previousDirName` lets the caller record where an existing directory will go before anything moves.
 * @returns {Promise<{ dir: string, previousDir: string|null, files: number }>}
 */
export async function installProvider({ hermesHome, tarball, sha256 = null, version = null, now = Date.now, previousDirName = null, onPoint = null }) {
  if (sha256) {
    const got = sha256Hex(readFileSync(tarball));
    if (got !== sha256) throw new Error(`SHA-256 of the provider tarball (${got.slice(0, 12)}…) does not match the feed (${sha256.slice(0, 12)}…)`);
  }
  const plugins = pluginsDir(hermesHome);
  const staging = join(plugins, `${PROVIDER_NAME}.tmp-${process.pid}`);
  rmTree(staging);
  let previousDir = null;
  try {
    const { files } = await extractTarGz({ file: tarball, dest: staging, maxBytes: MAX_PROVIDER_BYTES });
    const outside = files.find((f) => !f.startsWith(`${PROVIDER_NAME}/`));
    if (outside) throw new Error(`the provider tarball holds ${outside} outside ${PROVIDER_NAME}/`);
    const staged = join(staging, PROVIDER_NAME);
    const check = checkProviderDir(staged, { version });
    if (!check.ok) throw new Error(`the provider tarball fails its MANIFEST.json check: ${check.detail}`);
    const target = providerDir(hermesHome);
    onPoint?.("provider.staged");
    if (existsSync(target)) {
      previousDir = previousDirName ?? previousProviderPath(hermesHome, now);
      renameWithRetry(target, previousDir); // one atomic rename: the existing directory is never copied or deleted here
      onPoint?.("provider.moved-aside");
    }
    try {
      renameWithRetry(staged, target);
    } catch (err) {
      if (previousDir) renameWithRetry(previousDir, target);
      previousDir = null;
      throw err;
    }
    return { dir: target, previousDir, files: files.length };
  } finally {
    rmTree(staging);
  }
}

/**
 * Undo installProvider (R17a: only after memory.provider was restored). Only what this run created is removed:
 *   * `preexisted` false: `plugins/plur1bus` (if any) is ours → removed;
 *   * `preexisted` true and `previousDir` on disk: the existing directory was moved aside → ours (if any) is
 *     removed and the previous one renamed back;
 *   * `preexisted` true and `previousDir` not on disk: the move never happened (or was already undone), so
 *     `plugins/plur1bus` is still the pre-existing directory → left as it is.
 * `preexisted` defaults to `Boolean(previousDir)` (the install records `previousDir` only for an existing directory).
 * @returns {"removed"|"restored"|"kept"}
 */
export async function restoreProvider({ hermesHome, previousDir, preexisted = Boolean(previousDir) }) {
  const target = providerDir(hermesHome);
  if (!preexisted) {
    rmTree(target);
    return "removed";
  }
  if (previousDir && existsSync(previousDir) && statSync(previousDir).isDirectory()) {
    rmTree(target);
    renameWithRetry(previousDir, target);
    return "restored";
  }
  return "kept";
}

/** True when `plugins/plur1bus` is this run's copy (resume: never replace a pre-existing directory that was not moved aside). */
export function providerDirIsOurs({ preexisted, previousDir }) {
  return !preexisted || Boolean(previousDir && existsSync(previousDir));
}

export function dropPreviousProvider(previousDir) {
  if (previousDir) rmTree(previousDir);
}

/**
 * lib/setup/harness-coexistence.js — OpenClaw-side HM4 coexistence guards (T7:
 * one engine per store). Adapter/setup logic, not engine.
 *
 * Harness home resolution is copied from PLUR1BUS-Harness:
 *
 *   - packages/core/src/paths.ts `resolveHome`
 *   - crates/plur1bus/src/paths.rs `resolve_home`
 *
 * Order: `--home` / `home` option (the plugin has no CLI `--home`; the option
 * exists so the copy stays faithful), then `$PLUR1BUS_HOME` when non-empty
 * (empty counts as unset, same as Node truthiness and the Rust
 * `.filter(|s| !s.is_empty())` comment at resolve_home), then the platform
 * default: win32 `%LOCALAPPDATA%\PLUR1BUS` (or `<homedir>/AppData/Local/PLUR1BUS`),
 * else `<homedir>/.plur1bus`.
 *
 * A resolved path is a Harness install only when `<home>/manifest.json` exists
 * (HB9, crates/plur1bus/src/install/manifest.rs). `layout().configPath`
 * (`<home>/config.json`) is not used as a marker: a generic config.json walk
 * would false-positive, and this repo's HM1-R17 selftest already required the
 * install manifest. Ancestors of the store path are not walked.
 *
 * Path comparison follows crates/plur1bus/src/coexistence.rs
 * `canonical_or_resolved` / `comparison_path` / `is_within`: realpath the
 * existing prefix, fold case on win32/darwin, refuse a symlink into the home.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** HB9 install marker at the resolved harness home. */
export const HARNESS_INSTALL_MANIFEST = "manifest.json";

/** Typed error code for a store path inside a harness home. */
export const STORE_INSIDE_HARNESS_HOME = "store-inside-harness-home";

/** Selftest info line when a Harness is found and this store is outside it. */
export const HARNESS_COEXISTENCE_NOTICE =
  "PLUR1BUS Harness found: separate memory until you migrate (`plur1bus import openclaw`) or switch this plugin to thin client";

const HINT =
  "choose a path outside the Harness home, or use the Harness as the memory (import)";

/**
 * @param {string} storePath
 * @param {string} harnessHome
 * @returns {string}
 */
export function storeInsideHarnessHomeMessage(storePath, harnessHome) {
  return `store path ${storePath} is inside harness home ${harnessHome}; ${HINT}`;
}

/** Typed refusal when a plugin store path lies inside a Harness home. */
export class StoreInsideHarnessHomeError extends Error {
  /**
   * @param {string} storePath Canonical store path.
   * @param {string} harnessHome Canonical harness home.
   */
  constructor(storePath, harnessHome) {
    super(storeInsideHarnessHomeMessage(storePath, harnessHome));
    this.name = "StoreInsideHarnessHomeError";
    this.code = STORE_INSIDE_HARNESS_HOME;
    this.storePath = storePath;
    this.harnessHome = harnessHome;
  }
}

/**
 * Read an env value. Empty or whitespace-only is unset. On win32 the key is
 * matched case-insensitively (crates/plur1bus/src/coexistence.rs HostEnvironment::get).
 * @param {NodeJS.ProcessEnv|object|undefined} env
 * @param {string} name
 * @param {string} platform
 * @returns {string|undefined}
 */
function envValue(env, name, platform) {
  if (!env || typeof env !== "object") return undefined;
  let raw = env[name];
  if ((raw === undefined || raw === null) && platform === "win32") {
    const found = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
    if (found !== undefined) raw = env[found];
  }
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

/**
 * The active Harness home, copied from `resolveHome` / `resolve_home`.
 *
 * The plugin has no CLI `--home`. Pass `home` only in tests that exercise the
 * same first slot the Harness CLI uses.
 *
 * Host `path.join` / `path.resolve` are used so a real temp dir on this
 * machine stays a real path. Injected `platform` selects the default layout
 * (`.plur1bus` vs `AppData/Local/PLUR1BUS`) and win32 env-key folding.
 *
 * @param {{home?: string, env?: object, platform?: string, homedir?: string, localAppData?: string}} [o]
 * @returns {string}
 */
export function resolveHarnessHome(o = {}) {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  if (typeof o.home === "string" && o.home.trim()) return resolve(o.home.trim());
  const fromEnv = envValue(env, "PLUR1BUS_HOME", platform);
  if (fromEnv) return resolve(fromEnv);
  const home = o.homedir ?? osHomedir();
  if (platform === "win32") {
    const lad = (typeof o.localAppData === "string" && o.localAppData.trim())
      ? o.localAppData.trim()
      : (envValue(env, "LOCALAPPDATA", platform) ?? join(home, "AppData", "Local"));
    return join(lad, "PLUR1BUS");
  }
  return join(home, ".plur1bus");
}

/**
 * Resolve symlinks for the part of `path` that exists, keep the rest.
 * Same shape as crates/plur1bus/src/coexistence.rs `canonical_or_resolved`.
 * @param {string} input
 * @returns {string}
 */
export function canonicalPath(input) {
  let head = resolve(input);
  const tail = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return resolve(input);
    tail.unshift(head.slice(parent.length).replace(/^[\\/]+/, ""));
    head = parent;
  }
  try {
    return join(realpathSync.native(head), ...tail);
  } catch {
    return resolve(input);
  }
}

/**
 * Slash-normalized path used for containment, case-folded on win32/darwin.
 * Copied from crates/plur1bus/src/coexistence.rs `comparison_path`.
 * @param {string} input
 * @param {string} platform
 * @returns {string}
 */
function comparisonPath(input, platform) {
  let value = String(input).replace(/\\/g, "/");
  if (value.length > 1) value = value.replace(/\/+$/, "");
  if (platform === "win32" || platform === "darwin") return value.toLowerCase();
  return value;
}

/**
 * Whether `storePath` lies inside `home` (or is `home`), after canonicalisation.
 * @param {string} storePath
 * @param {string} home
 * @param {string} [platform]
 * @returns {boolean}
 */
export function storeInsideHarnessHome(storePath, home, platform = process.platform) {
  const inner = comparisonPath(canonicalPath(storePath), platform);
  const outer = comparisonPath(canonicalPath(home), platform);
  return inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * Whether `dir` is a Harness install: HB9 `<dir>/manifest.json` exists.
 * Does not read the file and does not walk ancestors.
 * @param {string} dir
 * @returns {boolean}
 */
export function isHarnessInstall(dir) {
  if (!dir) return false;
  return existsSync(join(dir, HARNESS_INSTALL_MANIFEST));
}

/**
 * The active Harness home when its install marker is present, else `null`.
 * @param {{home?: string, env?: object, platform?: string, homedir?: string, localAppData?: string}} [o]
 * @returns {string|null}
 */
export function findHarnessHome(o = {}) {
  const resolved = resolveHarnessHome(o);
  if (!isHarnessInstall(resolved)) return null;
  return canonicalPath(resolved);
}

/**
 * Inspect a plugin store path against the active Harness home.
 * Does not read the Harness store.
 *
 * @param {{storePath?: string, home?: string, env?: object, platform?: string, homedir?: string, localAppData?: string}} [o]
 * @returns {{harnessHome: string|null, inside: boolean, violation: boolean, error: StoreInsideHarnessHomeError|null, notice: string|null}}
 */
export function inspectHarnessCoexistence(o = {}) {
  const platform = o.platform ?? process.platform;
  const harnessHome = findHarnessHome(o);
  const notice = harnessHome ? HARNESS_COEXISTENCE_NOTICE : null;
  if (!o.storePath || !harnessHome) {
    return { harnessHome, inside: false, violation: false, error: null, notice };
  }
  const inside = storeInsideHarnessHome(o.storePath, harnessHome, platform);
  if (!inside) {
    return { harnessHome, inside: false, violation: false, error: null, notice };
  }
  const error = new StoreInsideHarnessHomeError(canonicalPath(o.storePath), harnessHome);
  return { harnessHome, inside: true, violation: true, error, notice: null };
}

/**
 * Setup/installer helper: refuse a store path inside a Harness home.
 * @param {string} storePath
 * @param {{home?: string, env?: object, platform?: string, homedir?: string, localAppData?: string}} [o]
 * @returns {{harnessHome: string|null, inside: boolean, violation: boolean, error: StoreInsideHarnessHomeError|null, notice: string|null}}
 */
export function assertStoreOutsideHarnessHome(storePath, o = {}) {
  const result = inspectHarnessCoexistence({ ...o, storePath });
  if (result.violation) throw result.error;
  return result;
}

/**
 * Gateway load: warn when the live store is inside a Harness home, never throw.
 * Existing violating config must keep serving so the operator can move
 * `baseDbPath`. Selftest and the setup helper refuse the same path.
 *
 * @param {{storePath?: string, logger?: {warn?: Function, debug?: Function}, home?: string, env?: object, platform?: string, homedir?: string, localAppData?: string}} [o]
 * @returns {{harnessHome: string|null, inside: boolean, violation: boolean, error: StoreInsideHarnessHomeError|null, notice: string|null}}
 */
export function warnIfStoreInsideHarnessHome(o = {}) {
  try {
    const result = inspectHarnessCoexistence(o);
    if (result.violation && typeof o.logger?.warn === "function") {
      o.logger.warn(result.error.message);
    }
    return result;
  } catch (error) {
    if (typeof o.logger?.debug === "function") {
      o.logger.debug(`harness coexistence check skipped: ${error?.message ?? error}`);
    }
    return { harnessHome: null, inside: false, violation: false, error: null, notice: null };
  }
}

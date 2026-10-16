/**
 * lib/host-paths.js — path defaults for lib/ modules on the engine graph.
 *
 * Nothing here reads process.env. A host binds overrides (the OpenClaw adapter
 * binds lib/host-services.js envHostPaths(), which reads OPENCLAW_* per call);
 * unbound, standalone defaults are ~/.openclaw; an owning engine supplies
 * its HostServices defaults. One binding per process: the engine
 * is the only memory owner in a process (host-contract), so last bind wins.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const NONE = Object.freeze({
  openclawHome: () => undefined,
  configPathOverride: () => undefined,
  stateDirOverride: () => undefined,
});

let overrides = NONE;
let defaults = null;

/**
 * Bind lazy adapter overrides and the owning host's fallback paths.
 * @param {{openclawHome?: () => string|undefined, configPathOverride?: () => string|undefined, stateDirOverride?: () => string|undefined}|null|undefined} next
 * @param {{stateDir: string, configPath: () => string}|null} [hostDefaults] HostServices paths; absent for standalone legacy helpers.
 */
export function bindHostPaths(next, hostDefaults = null) {
  overrides = { ...NONE, ...(next || {}) };
  defaults = hostDefaults;
}

export function resetHostPaths() {
  overrides = NONE;
  defaults = null;
}

/** The host's raw OPENCLAW_HOME-equivalent, or undefined when unset. */
export function hostHomeOverride() {
  return overrides.openclawHome() || undefined;
}

export function hostStateDir() {
  return hostHomeOverride() || defaults?.stateDir || join(homedir(), ".openclaw");
}

export function hostConfigPathOverride() {
  return overrides.configPathOverride() || undefined;
}

export function hostConfigPath() {
  return hostConfigPathOverride() || defaults?.configPath() || join(hostStateDir(), "openclaw.json");
}

export function hostStateDirOverride() {
  return overrides.stateDirOverride() || undefined;
}

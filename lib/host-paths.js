/**
 * lib/host-paths.js — path defaults for lib/ modules on the engine graph.
 *
 * Nothing here reads process.env. A host binds overrides (the OpenClaw adapter
 * binds lib/host-services.js envHostPaths(), which reads OPENCLAW_* per call);
 * unbound, every default is ~/.openclaw. One binding per process: the engine
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

/** @param {{openclawHome?: () => string|undefined, configPathOverride?: () => string|undefined, stateDirOverride?: () => string|undefined}|null|undefined} next */
export function bindHostPaths(next) {
  overrides = { ...NONE, ...(next || {}) };
}

export function resetHostPaths() {
  overrides = NONE;
}

/** The host's raw OPENCLAW_HOME-equivalent, or undefined when unset. */
export function hostHomeOverride() {
  return overrides.openclawHome() || undefined;
}

export function hostStateDir() {
  return hostHomeOverride() || join(homedir(), ".openclaw");
}

export function hostConfigPathOverride() {
  return overrides.configPathOverride() || undefined;
}

export function hostConfigPath() {
  return hostConfigPathOverride() || join(hostStateDir(), "openclaw.json");
}

export function hostStateDirOverride() {
  return overrides.stateDirOverride() || undefined;
}

/**
 * lib/host-services.js — the `HostServices` seam (PR-02).
 *
 * One object carrying everything the engine needs from a host, so engine code
 * stops reaching for the OpenClaw `api` capability surface. `createHostServices`
 * builds it from an OpenClaw `api`; `createStubHost` builds an inert one for
 * tests and for the harness's own contract tests.
 *
 * The shape is `HostServices` in types/engine.d.ts (contract 1.1.0).
 *
 * Two properties are deliberately accessors, not values:
 *   - `runtime` — `api.runtime` may be a proxy that throws on every property
 *     access outside "full" registration, and the real runtime can appear
 *     after registration. `runtimeIfUsable` must therefore run on *every*
 *     read (lib/runtime-shutdown.js:35-49). Caching it here would change
 *     behaviour.
 *   - `llm` — same reason, plus it must stay `undefined` when the host has none.
 *
 * `logger` is normalised into four total methods. `index.js` mixes hard calls
 * (`api.logger.warn(...)`) with guarded ones (`api.logger?.info?.(...)`), and
 * many test stubs pass a partial logger; a partial logger must keep no-opping
 * rather than throwing once the guards are gone.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { canonicalIdentityPath, ipcAddress, isUnsafeLink, securePath } from "./platform.js";
import { runtimeIfUsable } from "./runtime-shutdown.js";

const LOG_METHODS = Object.freeze(["info", "warn", "error", "debug"]);

function noop() {}

/**
 * Turn any logger-ish value into four total methods.
 * @param {object|null|undefined} logger Host logger, possibly partial.
 * @returns {{info: Function, warn: Function, error: Function, debug: Function}} Total logger.
 */
export function normalizeLogger(logger) {
  const out = {};
  for (const method of LOG_METHODS) {
    const fn = logger && typeof logger[method] === "function" ? logger[method].bind(logger) : noop;
    out[method] = fn;
  }
  return Object.freeze(out);
}

/**
 * The host's private state directory. Mirrors today's OPENCLAW_HOME reads
 * (index.js:12425) but never falls back to `process.env.HOME`, which is unset
 * on Windows (host-contract f.2).
 * @param {object} [env] Environment to read.
 * @returns {string} State directory.
 */
export function resolveStateDir(env = process.env) {
  return env.OPENCLAW_HOME || join(homedir(), ".openclaw");
}

/** The four platform decisions, as the `PlatformCapabilities` contract shape. */
export const platformCapabilities = Object.freeze({
  securePath,
  ipcAddress,
  isUnsafeLink,
  canonicalIdentityPath,
});

/**
 * Build `HostServices` from an OpenClaw plugin API.
 * @param {object} api OpenClaw plugin API capability surface.
 * @param {{clock?: () => number, stateDir?: string|null, platform?: object}} [options] Overrides.
 * @returns {object} HostServices.
 */
export function createHostServices(api = {}, {
  clock = () => Date.now(),
  stateDir = null,
  platform = platformCapabilities,
} = {}) {
  const host = {
    logger: normalizeLogger(api?.logger),
    stateDir: stateDir ?? resolveStateDir(),
    config() { return api?.config ?? {}; },
    workspaceDir(agentId) {
      const resolver = runtimeIfUsable(api)?.agent?.resolveAgentWorkspaceDir;
      if (typeof resolver !== "function") return undefined;
      return resolver(api?.config, agentId);
    },
    clock,
    platform,
    /** Escape hatch for the adapter shell only; removed at PR-14. */
    api,
  };
  Object.defineProperty(host, "runtime", {
    get() { return runtimeIfUsable(api) ?? null; },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(host, "llm", {
    get() {
      const llm = runtimeIfUsable(api)?.llm;
      return llm && typeof llm.complete === "function" ? llm : undefined;
    },
    enumerable: true,
    configurable: true,
  });
  return host;
}

/**
 * An inert `HostServices` for tests and harness contract tests. Everything is
 * a no-op or empty; `overrides` is shallow-merged last so a test can supply
 * exactly the one member it cares about.
 * @param {object} [overrides] Members to replace.
 * @returns {object} HostServices.
 */
export function createStubHost(overrides = {}) {
  const host = {
    logger: normalizeLogger(overrides.logger),
    stateDir: overrides.stateDir ?? join(homedir(), ".plur1bus-stub"),
    config: overrides.config ?? (() => ({})),
    workspaceDir: overrides.workspaceDir ?? (() => undefined),
    clock: overrides.clock ?? (() => Date.now()),
    platform: overrides.platform ?? platformCapabilities,
    runtime: overrides.runtime ?? null,
    llm: overrides.llm,
    secrets: overrides.secrets,
    events: overrides.events,
    api: overrides.api ?? null,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "logger") continue;
    host[key] = value;
  }
  return host;
}

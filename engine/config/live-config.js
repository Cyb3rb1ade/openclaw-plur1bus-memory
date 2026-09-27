/**
 * engine/config/live-config.js — the engine's one host-neutral re-read of its
 * own config at run time.
 *
 * The engine reads its config once, from createEngine's `config` argument
 * (every key is readAt "construction" in 1.9.0). The exception is a
 * verification read: the re-embedding switch probe re-reads
 * `reembedding.activeGeneration` to confirm the host has switched. Paths that
 * may be re-read are listed in HOST_REREAD_PATHS; this list is deliberately not
 * `livePaths()` — a re-read does not make a key live.
 *
 * Hosts differ in what `config()` returns: OpenClaw returns the whole host
 * config with the engine's config under its plugin entry (and may expose a
 * fresher `runtime.config.current()`); a harness-style host without a runtime
 * returns the engine config itself.
 */

/** The engine's entry key in an OpenClaw-style host config. */
export const PLUGIN_CONFIG_KEY = "memory-lancedb-namespaced";

/** Config paths the engine may re-read from the host at run time. */
export const HOST_REREAD_PATHS = Object.freeze(["reembedding.activeGeneration"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The engine's own config as the host sees it now:
 * `host.runtime?.config?.current?.() || host.config()`, then
 * `.plugins.entries[PLUGIN_CONFIG_KEY].config` when that is an object;
 * otherwise, only when `host.runtime` is null (a harness-style host whose
 * config() IS the engine config), the object itself; otherwise null. Never throws.
 *
 * @param {object} host
 * @returns {Record<string, unknown> | null}
 */
export function livePluginConfig(host) {
  try {
    const current = host?.runtime?.config?.current?.() || host?.config?.();
    const entryConfig = current?.plugins?.entries?.[PLUGIN_CONFIG_KEY]?.config;
    if (isPlainObject(entryConfig)) return entryConfig;
    if (host?.runtime == null && isPlainObject(current)) return current;
    return null;
  } catch {
    return null;
  }
}

/**
 * Read one HOST_REREAD_PATHS path from livePluginConfig(host). A path not in
 * the list throws TypeError; a missing value is undefined.
 *
 * @param {object} host
 * @param {string} path
 * @returns {unknown}
 */
export function readLiveConfigValue(host, path) {
  if (!HOST_REREAD_PATHS.includes(path)) {
    throw new TypeError("config path is not a host re-read path");
  }
  let value = livePluginConfig(host);
  for (const segment of path.split(".")) {
    if (!isPlainObject(value) || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

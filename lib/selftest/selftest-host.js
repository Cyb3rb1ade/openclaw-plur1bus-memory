/**
 * lib/selftest/selftest-host.js — what the selftest's throw-away engine is
 * built from (HM1 Task 2, HM1-R6, HM1-R17).
 *
 *   - `selftestEmbeddingPlan` decides which embedder the selftest uses: the
 *     configured local profile for `local-transformers`, the pinned E5
 *     profile when no provider is configured, and the configured remote
 *     provider only when `--remote` is given.
 *   - `selftestRerankPlan` decides whether the rerank step can run at all.
 *   - `buildSelftestEngineConfig` is the engine config: the plugin config's
 *     embedding/reranker/licence choices over a closed set of keys, with the
 *     temp store as `baseDbPath` and every feature that writes outside that
 *     store (vault mirror, dreaming, neo corpus, jobs) switched off.
 *   - `createSelftestHost` is the `createStubHost` the engine runs on; it binds
 *     the same OPENCLAW_* path overrides the plugin binds, so the model cache
 *     resolves where real use resolves it.
 *   - `harnessHomes`/`storeInsideHarnessHome` implement the coexistence check.
 *
 * No `api.` here (scripts/lint-no-api-outside-adapter.mjs).
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { createStubHost, envHostPaths } from "../host-services.js";
import { bindHostPaths } from "../host-paths.js";
import { resolveLocalModelCacheDir } from "../providers/config-normalize.js";
import { DEFAULT_LOCAL_MODEL_CACHE, DEFAULT_LOCAL_RERANKER_MODEL } from "../providers/dimensions.js";
import { resolveEnvVars } from "../providers/env.js";
import { E5_EMBEDDING_PROFILE, pinnedLocalModelProfile } from "../providers/local-model-artifacts.js";

export const LOCAL_PROVIDER = "local-transformers";

const E5_DIMENSIONS = 384;

// Everything that would write outside the throw-away store, call an LLM, or
// start background work is off in the selftest engine.
const FEATURES_OFF = Object.freeze({
  obsidianBridge: { enabled: false },
  neo: { enabled: false },
  gc: { enabled: false },
  merging: { enabled: false },
  dreaming: { enabled: false },
  skillMiner: { enabled: false },
  temporalContext: { enabled: false },
  conversationReactivationRecall: { enabled: false },
});

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Which embedder the selftest uses (HM1-R6).
 * @param {object} pluginConfig The plugin's `plugins.entries.<id>.config`.
 * @param {{remote?: boolean}} [options]
 * @returns {{kind: "local", profile: object|null, model: string, embedding: object}
 *   |{kind: "remote", run: boolean, embedding: object}}
 */
export function selftestEmbeddingPlan(pluginConfig = {}, { remote = false } = {}) {
  const configured = plainObject(pluginConfig.embedding);
  if (configured.provider === LOCAL_PROVIDER) {
    const local = plainObject(configured.local);
    const model = typeof local.model === "string" && local.model.trim() ? local.model.trim() : E5_EMBEDDING_PROFILE.model;
    return { kind: "local", profile: pinnedLocalModelProfile(model), model, embedding: configured };
  }
  if (!configured.provider) {
    // The fresh-store default (lib/providers/legacy-provider-migration.js):
    // pinned E5, in the cache the configured `cacheDir` (if any) names.
    const embedding = {
      provider: LOCAL_PROVIDER,
      local: {
        model: E5_EMBEDDING_PROFILE.model,
        dimensions: E5_DIMENSIONS,
        ...(plainObject(configured.local).cacheDir ? { cacheDir: configured.local.cacheDir } : {}),
      },
      ...(configured.cacheDir ? { cacheDir: configured.cacheDir } : {}),
    };
    return { kind: "local", profile: E5_EMBEDDING_PROFILE, model: E5_EMBEDDING_PROFILE.model, embedding };
  }
  return { kind: "remote", run: remote === true, embedding: configured };
}

/** The engine embedding config used when the embed step does not run: never invoked. */
export function inertEmbeddingConfig() {
  return { provider: LOCAL_PROVIDER, local: { model: E5_EMBEDDING_PROFILE.model, dimensions: E5_DIMENSIONS } };
}

/**
 * Whether the rerank step can run: an enabled local reranker with a pinned profile.
 * @param {object} pluginConfig
 * @returns {{run: false, reason: string}|{run: true, profile: object, cacheDir: string, reranker: object}}
 */
export function selftestRerankPlan(pluginConfig = {}) {
  const reranker = plainObject(pluginConfig.reranker);
  if (reranker.enabled === false || reranker.provider === "disabled") return { run: false, reason: "reranker-disabled" };
  if (reranker.provider !== LOCAL_PROVIDER) return { run: false, reason: "reranker-not-local" };
  const local = plainObject(reranker.local);
  const model = local.model || reranker.model || DEFAULT_LOCAL_RERANKER_MODEL;
  const profile = pinnedLocalModelProfile(model);
  if (!profile || profile.role !== "reranker") return { run: false, reason: "reranker-unpinned" };
  // Same resolution as lib/providers/config-normalize.js normalizeRerankerConfig
  // + LocalTransformersRerankerProvider.
  const cacheDir = resolveEnvVars(local.cacheDir || DEFAULT_LOCAL_MODEL_CACHE, { groups: ["localPath"], label: "local model cacheDir" });
  return { run: true, profile, cacheDir, reranker };
}

/**
 * The model cache the plugin's local embedding provider resolves for this config.
 * Binds the OPENCLAW_* overrides first, exactly as the plugin does at register().
 * @param {object} embedding Embedding config (selftestEmbeddingPlan().embedding).
 * @param {object} env Environment.
 * @returns {string}
 */
export function localModelCacheDir(embedding, env) {
  bindHostPaths(envHostPaths(env));
  return resolveLocalModelCacheDir(embedding);
}

/**
 * The selftest engine config: a closed set of plugin choices over the temp store.
 * Credentials enter only through `embedding`/`reranker` and only when the
 * matching step runs; nothing here is ever reported.
 * @param {{pluginConfig: object, baseDbPath: string, embedding: object, reranker?: object|null}} input
 * @returns {object}
 */
export function buildSelftestEngineConfig({ pluginConfig = {}, baseDbPath, embedding, reranker = null }) {
  const config = {
    baseDbPath,
    embedding,
    reranker: reranker ?? { enabled: false, provider: "disabled" },
    autoCapture: true,
    autoRecall: true,
    ...structuredClone(FEATURES_OFF),
  };
  if (typeof pluginConfig.language === "string") config.language = pluginConfig.language;
  // The licence acknowledgement travels with its preparation profile (the
  // config contract requires `profile` whenever `modelPreparation` exists).
  // The engine only builds the preparation coordinator; the Gateway starts it.
  const preparation = plainObject(pluginConfig.modelPreparation);
  if (typeof preparation.profile === "string" && preparation.profile) {
    config.modelPreparation = {
      profile: preparation.profile,
      acceptNonCommercialLicense: preparation.acceptNonCommercialLicense === true,
    };
  }
  return config;
}

/**
 * The HostServices the throw-away engine runs on.
 * @param {{stateDir: string, config: object, logger?: object, env: object}} input
 * @returns {object}
 */
export function createSelftestHost({ stateDir, config, logger, env }) {
  const workspace = join(stateDir, "workspace");
  return createStubHost({
    stateDir,
    config: () => config,
    logger,
    pathOverrides: envHostPaths(env),
    workspaceDir: async () => workspace,
  });
}

/**
 * Harness home candidates in the harness's own order (crates/plur1bus/src/paths.rs
 * resolve_home): $PLUR1BUS_HOME, then the platform default. A candidate is a
 * harness home only when its manifest.json exists (HB9).
 * @param {{env: object, platform: string, homeDir: string}} input
 * @returns {string[]} Existing harness homes, first match first.
 */
export function harnessHomes({ env, platform, homeDir }) {
  const candidates = [];
  if (env.PLUR1BUS_HOME) candidates.push(resolve(env.PLUR1BUS_HOME));
  if (platform === "win32") {
    candidates.push(join(env.LOCALAPPDATA || join(homeDir, "AppData", "Local"), "PLUR1BUS"));
  } else {
    candidates.push(join(homeDir, ".plur1bus"));
  }
  return [...new Set(candidates)].filter((dir) => existsSync(join(dir, "manifest.json")));
}

/**
 * The user's real store path (R-S7): configured baseDbPath, else
 * `<home>/.openclaw/memory/lancedb-namespaced` regardless of OPENCLAW_STATE_DIR.
 * @param {object} pluginConfig
 * @param {{homeDir: string, resolvePath?: (p: string) => string}} options
 * @returns {string}
 */
export function userStorePath(pluginConfig, { homeDir, resolvePath }) {
  const configured = typeof pluginConfig.baseDbPath === "string" && pluginConfig.baseDbPath.trim()
    ? pluginConfig.baseDbPath.trim()
    : null;
  if (!configured) return join(homeDir, ".openclaw", "memory", "lancedb-namespaced");
  // The host resolver is used when it answers; inside an OpenClaw CLI action
  // (2026.8.2, discovery registration) api.resolvePath returned undefined.
  const hostResolved = typeof resolvePath === "function" ? resolvePath(configured) : undefined;
  if (typeof hostResolved === "string" && hostResolved) return resolve(hostResolved);
  if (configured === "~" || configured.startsWith("~/") || configured.startsWith("~\\")) {
    return resolve(join(homeDir, configured.slice(1)));
  }
  return resolve(configured);
}

// Resolve symlinks for the part of `path` that exists, keep the rest.
function canonical(path) {
  let head = resolve(path);
  const tail = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return resolve(path);
    tail.unshift(head.slice(parent.length).replace(/^[\\/]+/, ""));
    head = parent;
  }
  try {
    return join(realpathSync.native(head), ...tail);
  } catch {
    return resolve(path);
  }
}

/**
 * Whether `storePath` lies inside `home` (or is `home`).
 * @param {string} storePath
 * @param {string} home
 * @param {string} [platform]
 * @returns {boolean}
 */
export function storeInsideHarnessHome(storePath, home, platform = process.platform) {
  const fold = (p) => (platform === "win32" || platform === "darwin" ? p.toLowerCase() : p);
  const rel = relative(fold(canonical(home)), fold(canonical(storePath)));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

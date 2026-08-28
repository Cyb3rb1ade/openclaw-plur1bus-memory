#!/usr/bin/env node
// Usage: embed-promoted-memories.mjs [--dry-run|--apply] [--json]
//   [--agent <id>] [--openclaw-home <dir>] [--plugin-dir <dir>]
//   [--embedding-api-key-env <ENV_NAME>]

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyPromotionReindex,
  discoverPromotionTargets,
  planPromotionReindex,
  resolvePromotionDbRoot,
} from "../lib/promoted-memory-reindex.js";
import { redactError } from "../lib/safe-logging.js";
import { resolveInside, safeAgentId } from "../lib/sql-safety.js";
import { openclaw } from "./lib/openclaw-cli.mjs";

/**
 * Parses the promoted-memory reindex CLI contract.
 *
 * @param {string[]} argv
 * @returns {{apply: boolean, dryRun: boolean, json: boolean, agents: string[], openclawHome?: string, pluginDir?: string, embeddingApiKeyEnv?: string}}
 */
export function parseArgs(argv) {
  const options = { apply: false, dryRun: true, json: false, agents: [] };
  let explicitDryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      explicitDryRun = true;
    } else if (arg === "--apply") {
      options.apply = true;
      options.dryRun = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--agent") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--agent requires a value");
      options.agents.push(safeAgentId(value));
      index += 1;
    } else if (arg === "--openclaw-home" || arg === "--plugin-dir" || arg === "--embedding-api-key-env") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--openclaw-home") options.openclawHome = value;
      else if (arg === "--plugin-dir") options.pluginDir = value;
      else {
        if (!isValidEnvName(value)) throw new Error("--embedding-api-key-env requires a valid environment variable name");
        options.embeddingApiKeyEnv = value;
      }
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (explicitDryRun && options.apply) throw new Error("--dry-run and --apply cannot be combined");
  return options;
}

const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

function isValidEnvName(value) {
  return typeof value === "string"
    && value !== REDACTED_SENTINEL
    && /^[A-Z_][A-Z0-9_]{0,127}$/.test(value);
}

/**
 * Drops OpenClaw redaction sentinels so provider defaults/env lookup remain usable.
 *
 * @param {unknown} value
 * @param {string|null} [restoredApiKeyEnv]
 * @returns {unknown}
 */
export function sanitizeEffectivePluginConfig(value, restoredApiKeyEnv = null) {
  if (Array.isArray(value)) return value.map((item) => sanitizeEffectivePluginConfig(item, null));
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === REDACTED_SENTINEL) continue;
    clean[key] = sanitizeEffectivePluginConfig(child, null);
  }
  if (
    restoredApiKeyEnv
    && clean.embedding
    && typeof clean.embedding === "object"
    && (
      value?.embedding?.apiKeyEnv === REDACTED_SENTINEL
      || value?.embedding?.apiKey === REDACTED_SENTINEL
    )
  ) clean.embedding.apiKeyEnv = restoredApiKeyEnv;
  return clean;
}

function readAuthoredApiKeyEnv(runtime, openclawHome) {
  let authored;
  if (typeof runtime.loadAuthoredConfig === "function") {
    authored = runtime.loadAuthoredConfig(openclawHome);
  } else {
    const configPath = resolveInside(openclawHome, "openclaw.json");
    try {
      authored = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      return null;
    }
  }
  const value = authored?.plugins?.entries?.["memory-lancedb-namespaced"]?.config?.embedding?.apiKeyEnv;
  return isValidEnvName(value) ? value : null;
}

async function loadEffectiveConfig(runtime, openclawHome, requireProviderConfig, apiKeyEnvOverride) {
  if (typeof runtime.loadConfig === "function") return runtime.loadConfig();
  const openclawImpl = runtime.openclawImpl || openclaw;
  const cliOptions = {
    env: {
      ...process.env,
      OPENCLAW_HOME: dirname(openclawHome),
      OPENCLAW_STATE_DIR: openclawHome,
    },
  };
  const agentsResult = openclawImpl(["config", "get", "agents", "--json"], 30000, cliOptions);
  const pluginResult = openclawImpl([
    "config",
    "get",
    "plugins.entries.memory-lancedb-namespaced.config",
    "--json",
  ], 30000, cliOptions);
  if (!agentsResult?.ok || !pluginResult?.ok) {
    throw new Error("OpenClaw effective configuration is unavailable");
  }
  const agents = JSON.parse(agentsResult.stdout);
  const rawPluginConfig = JSON.parse(pluginResult.stdout);
  let restoredApiKeyEnv = null;
  const redactedApiKeyEnv = rawPluginConfig?.embedding?.apiKeyEnv === REDACTED_SENTINEL;
  const redactedLiteralApiKey = rawPluginConfig?.embedding?.apiKey === REDACTED_SENTINEL;
  if (requireProviderConfig && (redactedApiKeyEnv || redactedLiteralApiKey)) {
    restoredApiKeyEnv = apiKeyEnvOverride
      || (redactedApiKeyEnv ? readAuthoredApiKeyEnv(runtime, openclawHome) : null);
    if (!isValidEnvName(restoredApiKeyEnv)) throw new Error(
      "embedding API-key configuration is redacted; pass --embedding-api-key-env <ENV_NAME>",
    );
  }
  const pluginConfig = sanitizeEffectivePluginConfig(rawPluginConfig, restoredApiKeyEnv);
  if (!agents || typeof agents !== "object" || !pluginConfig || typeof pluginConfig !== "object") {
    throw new Error("OpenClaw effective configuration is invalid");
  }
  return {
    agents,
    plugins: { entries: { "memory-lancedb-namespaced": { config: pluginConfig } } },
  };
}

/**
 * Executes the CLI with injectable output and runtime dependencies.
 *
 * @param {string[]} argv
 * @param {object} [runtime]
 * @returns {Promise<number>}
 */
export async function runCli(argv, runtime = {}) {
  const stdout = runtime.stdout || process.stdout;
  const stderr = runtime.stderr || process.stderr;
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`embed-promoted-memories usage error: ${redactError(error).message}\n`);
    return 2;
  }
  const openclawHome = options.openclawHome || runtime.openclawHome || process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
  const pluginDir = options.pluginDir || runtime.pluginDir || dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    const config = await loadEffectiveConfig(
      runtime,
      openclawHome,
      options.apply,
      options.embeddingApiKeyEnv,
    );
    const targets = discoverPromotionTargets(config, openclawHome, { agents: options.agents });
    if (options.agents.length > 0) {
      const found = new Set(targets.map((target) => target.agentId));
      const missing = options.agents.filter((agentId) => !found.has(agentId));
      if (missing.length > 0) throw new Error(`no MEMORY.md target found for requested agent count=${missing.length}`);
    }
    const pluginConfig = config?.plugins?.entries?.["memory-lancedb-namespaced"]?.config || {};
    const dbRoot = resolvePromotionDbRoot(pluginConfig, openclawHome);
    const plan = planPromotionReindex({ targets, openclawHome, dbRoot });
    let MemoryDBClass = null;
    if (options.apply && typeof runtime.createMemoryDb !== "function") {
      ({ MemoryDB: MemoryDBClass } = await import(pathToFileURL(join(pluginDir, "index.js")).href));
    }
    const result = await applyPromotionReindex(plan, {
      apply: options.apply,
      createEmbedder: async () => {
        if (typeof runtime.createEmbedder === "function") return runtime.createEmbedder(pluginConfig);
        const [{ normalizeEmbeddingConfig }, { createEmbeddingProvider }] = await Promise.all([
          import(pathToFileURL(join(pluginDir, "lib", "providers", "config-normalize.js")).href),
          import(pathToFileURL(join(pluginDir, "lib", "providers", "factory.js")).href),
        ]);
        const normalized = normalizeEmbeddingConfig(pluginConfig.embedding || {}, {
          acceptNonCommercialLicense: pluginConfig.modelPreparation?.acceptNonCommercialLicense === true,
        });
        const provider = createEmbeddingProvider(normalized);
        return {
          dimensions: Number(provider.dimensions()),
          embed: (text, context = {}) => provider.embedPassage(text, { scopeId: context.agentId }),
        };
      },
      createMemoryDb: ({ dbPath, vectorDim }) => {
        if (typeof runtime.createMemoryDb === "function") return runtime.createMemoryDb({ dbPath, vectorDim });
        return new MemoryDBClass(dbPath, vectorDim);
      },
    });
    stdout.write(`${options.json ? JSON.stringify(result) : `reindex ${result.mode}: planned=${result.counts.planned} inserted=${result.counts.inserted} skipped=${result.counts.skipped} failed=${result.counts.failed}`}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    stderr.write(`embed-promoted-memories failed: ${redactError(error).message}\n`);
    return 1;
  }
}

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (IS_MAIN) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

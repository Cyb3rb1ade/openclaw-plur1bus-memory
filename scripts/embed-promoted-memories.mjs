#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyPromotionReindex,
  discoverPromotionTargets,
  planPromotionReindex,
} from "../lib/promoted-memory-reindex.js";
import { redactError } from "../lib/safe-logging.js";
import { safeAgentId } from "../lib/sql-safety.js";

/**
 * Parses the promoted-memory reindex CLI contract.
 *
 * @param {string[]} argv
 * @returns {{apply: boolean, dryRun: boolean, json: boolean, agents: string[], openclawHome?: string, pluginDir?: string}}
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
    } else if (arg === "--openclaw-home" || arg === "--plugin-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--openclaw-home") options.openclawHome = value;
      else options.pluginDir = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (explicitDryRun && options.apply) throw new Error("--dry-run and --apply cannot be combined");
  return options;
}

function readConfig(configPath) {
  if (!existsSync(configPath)) throw new Error("OpenClaw configuration is missing");
  return JSON.parse(readFileSync(configPath, "utf8"));
}

/**
 * Executes the CLI with injectable output and runtime dependencies.
 *
 * @param {string[]} argv
 * @param {object} [runtime]
 * @returns {Promise<number>}
 */
export async function runCli(argv, runtime = {}) {
  const options = parseArgs(argv);
  const openclawHome = options.openclawHome || runtime.openclawHome || join(homedir(), ".openclaw");
  const pluginDir = options.pluginDir || runtime.pluginDir || dirname(dirname(fileURLToPath(import.meta.url)));
  const stdout = runtime.stdout || process.stdout;
  const stderr = runtime.stderr || process.stderr;
  try {
    const config = readConfig(join(openclawHome, "openclaw.json"));
    const targets = discoverPromotionTargets(config, openclawHome, { agents: options.agents });
    if (options.agents.length > 0) {
      const found = new Set(targets.map((target) => target.agentId));
      const missing = options.agents.filter((agentId) => !found.has(agentId));
      if (missing.length > 0) throw new Error(`no MEMORY.md target found for requested agent count=${missing.length}`);
    }
    const plan = planPromotionReindex({ targets, openclawHome });
    const pluginConfig = config?.plugins?.entries?.["memory-lancedb-namespaced"]?.config || {};
    let MemoryDBClass = null;
    if (options.apply && typeof runtime.createMemoryDb !== "function") {
      ({ MemoryDB: MemoryDBClass } = await import(pathToFileURL(join(pluginDir, "index.js")).href));
    }
    const result = await applyPromotionReindex(plan, {
      apply: options.apply,
      createEmbedder: async () => {
        if (typeof runtime.createEmbedder === "function") return runtime.createEmbedder();
        const [{ normalizeEmbeddingConfig }, { createEmbeddingProvider }] = await Promise.all([
          import(pathToFileURL(join(pluginDir, "lib", "providers", "config-normalize.js")).href),
          import(pathToFileURL(join(pluginDir, "lib", "providers", "factory.js")).href),
        ]);
        const normalized = normalizeEmbeddingConfig(pluginConfig.embedding || {});
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

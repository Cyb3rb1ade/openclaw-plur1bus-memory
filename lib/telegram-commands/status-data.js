/**
 * /status — Data-Collector.
 *
 * Liest die echte openclaw.json und sammelt Anomalien als issues.
 *
 * Der Pfad zum Bridge-Flag ist BEWUSST vollqualifiziert:
 *   plugins.entries["memory-lancedb-namespaced"].config.obsidianBridge.enabled
 *
 * Die plugin-interne Variante (api.pluginConfig.obsidianBridge.enabled)
 * spiegelt nur die ".config." Schicht und wäre für den User-facing
 * Status-String missverständlich.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getMetrics } from "../metrics.js";

const FEATURE_DESCRIPTIONS = {
  vaultSync: {
    title: "Vault-Sync ist aus",
    whatItDoes: "spiegelt deine Erinnerungen in den Obsidian-Vault",
    whatYouLose: "du siehst Erinnerungen nur über /memory, nicht im Vault",
    configPath: 'plugins.entries[memory-lancedb-namespaced].config.obsidianBridge.enabled',
  },
};

function resolveOpenClawConfigPath() {
  if (process.env.OPENCLAW_CONFIG_PATH) return process.env.OPENCLAW_CONFIG_PATH;
  const home = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
  return join(home, "openclaw.json");
}

function readOpenClawConfig(path = resolveOpenClawConfigPath()) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { __readError: err.message };
  }
}

function buildVaultSyncIssue(cfg, configPath) {
  const entry = cfg?.plugins?.entries?.["memory-lancedb-namespaced"];
  const enabled = entry?.config?.obsidianBridge?.enabled;
  if (enabled === true) return null;
  const desc = FEATURE_DESCRIPTIONS.vaultSync;
  return {
    key: "vaultSync",
    title: desc.title,
    reason: `in ${configPath} steht "${desc.configPath}: ${enabled === false ? "false" : "fehlt"}"`,
    howToFix: "/einschalten vaultSync",
    whatItDoes: desc.whatItDoes,
    whatYouLose: desc.whatYouLose,
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.configPath]    — overridable für Tests
 * @param {object} [opts.openclawConfig] — pre-loaded Config (Tests)
 * @param {object} [opts.memoryStats]    — { cardCount, lastUpdateMinutes }
 * @param {object} [opts.syncStats]      — { active, devices }
 * @param {string} [opts.plausibilityLastRun]
 */
export function collectStatusData(opts = {}) {
  const configPath = opts.configPath || resolveOpenClawConfigPath();
  const cfg = opts.openclawConfig || readOpenClawConfig(configPath);

  const issues = [];
  const vaultIssue = buildVaultSyncIssue(cfg, configPath);
  if (vaultIssue) issues.push(vaultIssue);

  // Memory cardCount: echter Wert vom Aufrufer (DB.countRows), sonst unbekannt
  const memory = opts.memoryStats || { cardCount: null, lastUpdateMinutes: null };

  // Sync-Status: nur wenn explizit konfiguriert, sonst transparent
  const sync = opts.syncStats || { active: null, devices: 0, status: "nicht konfiguriert" };

  const plausibility = {
    lastRun: opts.plausibilityLastRun || new Date().toISOString(),
  };

  // Graph-Recall Metriken — aus run-state.json oder opts
  const persistedMetrics = opts.workspaceDir ? getMetrics(opts.workspaceDir) : {};
  const graphRecall = opts.graphRecall || persistedMetrics.graphRecall || {
    edgesTotal: null,
    edgesByType: null,
    hydrationMissRate: null,
    graphOnlyResultsAdded: null,
    recallLatencyMs: null,
  };

  // Obsidian Sync Metriken — aus run-state.json oder opts
  const obsidianSync = opts.obsidianSync || persistedMetrics.obsidianSync || {
    filesScanned: null,
    filesSkipped: null,
    filesWritten: null,
  };

  return { memory, sync, plausibility, issues, emotional: opts.emotional || null, graphRecall, obsidianSync };
}

export { resolveOpenClawConfigPath, readOpenClawConfig };

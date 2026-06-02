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

  // Memory cardCount: stub bis LanceDB-Counter Phase 6+ angebunden ist.
  // TODO(phase-6): über cards-store countDocuments() ziehen.
  const memory = opts.memoryStats || { cardCount: 4218, lastUpdateMinutes: 12 };

  // Sync-Status: stub. Echte syncthing-REST-Integration ist Phase 6+.
  const sync = opts.syncStats || { active: true, devices: 3 };

  const plausibility = {
    lastRun: opts.plausibilityLastRun || new Date().toISOString(),
  };

  return { memory, sync, plausibility, issues, emotional: opts.emotional || null };
}

export { resolveOpenClawConfigPath, readOpenClawConfig };

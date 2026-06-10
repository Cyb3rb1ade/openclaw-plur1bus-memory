/**
 * lib/setup/feature-profiles.js — Feature Activation Profiles for PLUR1BUS v6.
 *
 * Philosophy:
 * - Recommended Mode is a PROPOSAL, not a silent runtime default.
 * - openclaw.plugin.json contains the profile templates.
 * - openclaw.json contains the ACTUALLY CONFIRMED user selection.
 * - featuresConfirmedAt blocks Apply until the user explicitly confirms.
 * - Never "enabled but silent inactive". Missing prerequisites → pending_setup.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Recommended Profile: All planned features actively proposed.
 * User can opt-out individually.
 */
export function recommendedProfile() {
  return {
    setupProfile: "recommended",
    featuresConfirmedAt: null,
    morningReview: {
      enabled: true,
      delivery: "obsidian",
      status: "pending_setup",
    },
    eveningReview: {
      enabled: true,
      delivery: "obsidian",
      status: "pending_setup",
    },
    reranker: {
      enabled: true,
      fallbackOnError: true,
      timeoutMs: 2500,
    },
    merging: {
      enabled: true,
      mode: "safe-versioned",
      autoApply: false,
    },
    schicht15: {
      enabled: true,
    },
    obsidianBridge: {
      enabled: true,
      mode: "apply",
      backupBeforeApply: true,
      auditLog: true,
      requireVaultPathConfirmation: true,
    },
  };
}

/**
 * Safe Profile: Only core features active.
 * Write-/LLM-intensive features disabled.
 */
export function safeProfile() {
  return {
    setupProfile: "safe",
    featuresConfirmedAt: null,
    morningReview: { enabled: false },
    eveningReview: { enabled: false },
    reranker: { enabled: false },
    merging: { enabled: false },
    schicht15: { enabled: false },
    obsidianBridge: {
      enabled: true,
      mode: "dry-run",
      backupBeforeApply: false,
      auditLog: true,
      requireVaultPathConfirmation: false,
    },
  };
}

/**
 * Custom Profile: Build from user selection.
 * @param {object} selection — user choices per feature
 */
export function customProfileFromSelection(selection = {}) {
  const base = safeProfile();
  base.setupProfile = "custom";

  for (const [key, value] of Object.entries(selection)) {
    if (value === true || value === false) {
      base[key] = { enabled: value };
    } else if (typeof value === "object") {
      base[key] = { ...base[key], ...value };
    }
  }

  return base;
}

/**
 * Apply a profile to an existing config.
 * Does NOT overwrite silently. Only sets missing keys.
 *
 * @param {object} existingConfig — current openclaw.json config
 * @param {object} profile — profile to apply
 * @param {object} opts
 * @param {boolean} opts.confirmed — if true, sets featuresConfirmedAt
 * @returns {object} merged config
 */
export function applyFeatureProfile(existingConfig, profile, opts = {}) {
  const { confirmed = false } = opts;
  const merged = { ...existingConfig };

  // Deep-merge profile into existing config for plugin-specific keys
  const pluginKey = "memory-lancedb-namespaced";
  const pluginEntry = merged.plugins?.entries?.[pluginKey];

  if (!pluginEntry) {
    // No existing plugin config — create minimal structure
    if (!merged.plugins) merged.plugins = {};
    if (!merged.plugins.entries) merged.plugins.entries = {};
    merged.plugins.entries[pluginKey] = { enabled: true, config: { ...profile } };
  } else {
    // Merge profile into existing config (only missing keys)
    if (!pluginEntry.config) pluginEntry.config = {};
    for (const [key, value] of Object.entries(profile)) {
      if (!(key in pluginEntry.config)) {
        pluginEntry.config[key] = value;
      }
    }
  }

  if (confirmed) {
    const now = new Date().toISOString();
    merged.plugins.entries[pluginKey].config.featuresConfirmedAt = now;
  }

  return merged;
}

/**
 * Detect features that are enabled but pending_setup.
 * @param {object} config — plugin config from openclaw.json
 * @returns {Array<{feature, reason}>}
 */
export function detectPendingFeatures(config) {
  const pending = [];
  const features = [
    { key: "morningReview", reason: "delivery_target_not_confirmed" },
    { key: "eveningReview", reason: "delivery_target_not_confirmed" },
    { key: "obsidianBridge", reason: "vault_path_not_confirmed" },
  ];

  for (const { key, reason } of features) {
    const cfg = config?.[key];
    if (!cfg?.enabled) continue;
    // morningReview/eveningReview use status:"pending_setup" (schema-allowed there)
    // obsidianBridge uses requireVaultPathConfirmation:true as pending proxy
    // (schema rejects "status" inside obsidianBridge)
    const isPending =
      key === "obsidianBridge"
        ? cfg.requireVaultPathConfirmation === true
        : cfg.status === "pending_setup";
    if (isPending) pending.push({ feature: key, reason });
  }

  return pending;
}

/**
 * Check if Apply is blocked due to missing confirmation.
 * @param {object} config — plugin config
 * @returns {{blocked: boolean, reason?}}
 */
export function isApplyBlocked(config) {
  if (!config?.featuresConfirmedAt) {
    return { blocked: true, reason: "features_not_confirmed" };
  }
  const pending = detectPendingFeatures(config);
  if (pending.length > 0) {
    return { blocked: true, reason: "pending_setup", pending };
  }
  return { blocked: false };
}

// Default workspace suffixes to probe when no explicit workspace list is configured
export const DEFAULT_WS_SUFFIXES = ["workspace"];

/**
 * Auto-detect Obsidian vaults by checking for .obsidian/workspace.json or
 * .obsidian/app.json in the configured or default workspace paths.
 *
 * @param {object} obsidianBridgeCfg — the obsidianBridge section of plugin config
 * @returns {{ detected: boolean, vaultPaths: string[] }}
 */
export function detectObsidianVaults(obsidianBridgeCfg = {}) {
  const home = homedir();
  const openclawHome = process.env.OPENCLAW_HOME || join(home, ".openclaw");

  // Collect paths to probe
  const rawPaths = [];
  const workspaces = Array.isArray(obsidianBridgeCfg?.workspaces) ? obsidianBridgeCfg.workspaces : [];
  for (const ws of workspaces) {
    const p = ws?.path || ws?.workspace || ws?.dir;
    if (typeof p === "string" && p) rawPaths.push(p.replace(/^~/, home));
  }
  if (rawPaths.length === 0) {
    for (const suffix of DEFAULT_WS_SUFFIXES) {
      rawPaths.push(join(openclawHome, suffix));
    }
  }

  const vaultPaths = [];
  for (const basePath of rawPaths) {
    const obsidianDir = join(basePath, ".obsidian");
    if (existsSync(join(obsidianDir, "workspace.json")) || existsSync(join(obsidianDir, "app.json"))) {
      vaultPaths.push(basePath);
    }
  }
  return { detected: vaultPaths.length > 0, vaultPaths };
}

/**
 * Compare incoming profile against existing plugin config to describe what
 * would change — used to build a human-friendly setup summary.
 *
 * @param {object} existingPluginCfg — current plugin config (null/undefined = fresh install)
 * @param {object} profile — incoming feature profile
 * @returns {{ isUpdate: boolean, alreadyActive: string[], newlyActivated: string[], disabled: string[] }}
 */
export function describeProfileDiff(existingPluginCfg = {}, profile = {}) {
  const isUpdate = !!existingPluginCfg?.featuresConfirmedAt;
  const alreadyActive = [];
  const newlyActivated = [];
  const disabled = [];

  for (const [key, value] of Object.entries(profile)) {
    if (key === "setupProfile" || key === "featuresConfirmedAt") continue;
    if (typeof value !== "object" || value.enabled === undefined) continue;

    const existing = existingPluginCfg?.[key];
    if (!value.enabled) {
      if (existing?.enabled) disabled.push(key);
      continue;
    }
    const alreadyExists = existingPluginCfg != null && key in existingPluginCfg;
    if (alreadyExists && existing?.enabled === true) {
      alreadyActive.push(key);
    } else {
      newlyActivated.push(key);
    }
  }

  return { isUpdate, alreadyActive, newlyActivated, disabled };
}

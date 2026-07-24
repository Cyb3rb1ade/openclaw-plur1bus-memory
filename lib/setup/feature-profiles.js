/**
 * lib/setup/feature-profiles.js — explicit PLUR1BUS feature profiles.
 *
 * Philosophy:
 * - Missing runtime values follow the manifest.
 * - Safe and Recommended are explicit selections.
 * - Existing explicit values remain the source of truth for Recommended.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  ConfigContractError,
  PLUGIN_CONFIG_PATH,
  manifestConfigDefaults,
  resolveEffectiveConfig,
  validatePluginConfig,
} from "./config-contract.js";

/** OpenClaw entry key for the PLUR1BUS memory plugin. */
export const PLUGIN_KEY = "memory-lancedb-namespaced";

/** One-shot onboarding notice shown after installation. */
export const PLUR1BUS_START_NOTICE =
  "PLUR1BUS — Make your agent yours!\n\nPlease complete the installation by running:\n\n/plur1bus start";

const FEATURE_DEFINITIONS = [
  { key: "autoCapture", label: "Auto Capture", path: ["autoCapture"] },
  { key: "autoRecall", label: "Auto Recall", path: ["autoRecall"] },
  { key: "neo", label: "Neo Context Injection", path: ["neo", "enabled"] },
  { key: "recallDedup", label: "Recall Dedup", path: ["recall", "dedup"] },
  { key: "recallCanonicalFirst", label: "Canonical-First Recall", path: ["recall", "canonicalFirst"] },
  { key: "temporalContext", label: "Temporal Continuity Context", path: ["temporalContext", "enabled"] },
  { key: "embeddingCache", label: "Embedding Cache", path: ["runtime", "embeddingCacheEnabled"] },
  { key: "llmResultCache", label: "LLM Result Cache", path: ["runtime", "llmResultCacheEnabled"] },
  { key: "reranker", label: "Reranker", path: ["reranker", "enabled"] },
  { key: "emotionT2", label: "Emotion Tier 2", path: ["emotion", "t2", "enabled"] },
  { key: "emotionT3", label: "Emotion Tier 3, provider-gated/fail-soft", path: ["emotion", "t3", "enabled"] },
  { key: "metaCognition", label: "Meta-Cognition", path: ["metaCognition", "enabled"] },
  { key: "metaCognitionLlmReport", label: "Meta-Cognition LLM Report, budgeted/fail-soft", path: ["metaCognition", "llmReport"] },
  { key: "merging", label: "Merging", path: ["merging", "enabled"] },
  { key: "mergingAutoApply", label: "Low-risk Merge Auto-Apply", path: ["merging", "autoApply"] },
  { key: "schicht15", label: "Schicht 1.5 Knowledge Promotion", path: ["schicht15", "enabled"] },
  { key: "skillMiner", label: "Skill Miner", path: ["skillMiner", "enabled"] },
  { key: "dailyConsolidation", label: "Daily Consolidation", path: ["dailyConsolidation", "enabled"] },
  { key: "obsidianBridge", label: "Obsidian Bridge", path: ["obsidianBridge", "enabled"] },
  { key: "morningReview", label: "Morning Review", path: ["obsidianBridge", "morningReview", "enabled"] },
  { key: "eveningReview", label: "Evening Review", path: ["obsidianBridge", "eveningReview", "enabled"] },
  { key: "dashboardLayer", label: "Dashboard Layer", path: ["obsidianBridge", "dashboardLayer", "enabled"] },
  { key: "semanticGraph", label: "Semantic Graph", path: ["obsidianBridge", "semanticGraph", "enabled"] },
  { key: "provenanceGraph", label: "Provenance Graph", path: ["obsidianBridge", "provenanceGraph", "enabled"] },
  { key: "adversarialDeep", label: "Adversarial Deep", path: ["obsidianBridge", "adversarialDeep", "enabled"] },
  { key: "criticalPush", label: "Critical Push, rate-limited", path: ["criticalPush", "enabled"] },
  { key: "soulPatch", label: "SoulPatch", path: ["obsidianBridge", "soulPatch", "enabled"] },
  { key: "soulPatchCreateIfMissing", label: "SoulPatch createIfMissing", path: ["obsidianBridge", "soulPatch", "createIfMissing"] },
  { key: "soulPatchBackup", label: "SoulPatch backup", path: ["obsidianBridge", "soulPatch", "backup"] },
];

function clone(value) {
  return value == null || typeof value !== "object" ? value : structuredClone(value);
}

const MANIFEST_DEFAULTS = manifestConfigDefaults();

/** Manifest-aligned features used by setup/status presentation. */
export const CORE_FEATURES = FEATURE_DEFINITIONS.map((feature) => ({
  ...feature,
  defaultValue: getPath(MANIFEST_DEFAULTS, feature.path),
}));

const CORE_FEATURE_BY_KEY = new Map(CORE_FEATURES.map((feature) => [feature.key, feature]));

function getPath(obj, path) {
  let cur = obj;
  for (const part of path) {
    if (cur == null || typeof cur !== "object" || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(obj, path, value, { overwrite = true } = {}) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const part = path[i];
    if (cur[part] == null || typeof cur[part] !== "object" || Array.isArray(cur[part])) {
      cur[part] = {};
    }
    cur = cur[part];
  }
  const leaf = path[path.length - 1];
  if (overwrite || cur[leaf] === undefined) cur[leaf] = clone(value);
}

function mergeMissing(target, defaults) {
  for (const [key, value] of Object.entries(defaults || {})) {
    if (target[key] === undefined) {
      target[key] = clone(value);
    } else if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      mergeMissing(target[key], value);
    }
  }
  return target;
}

const SAFE_ENFORCED_VALUES = [
  [["reranker", "enabled"], false],
  [["emotion", "t3", "enabled"], false],
  [["metaCognition", "llmReport"], false],
  [["merging", "enabled"], false],
  [["merging", "autoApply"], false],
  [["schicht15", "enabled"], false],
  [["skillMiner", "enabled"], false],
  [["dailyConsolidation", "enabled"], false],
  [["criticalPush", "enabled"], false],
  [["obsidianBridge", "enabled"], false],
  [["obsidianBridge", "mode"], "augment"],
  [["obsidianBridge", "allowWrite"], false],
  [["obsidianBridge", "writeManagedBlocks"], false],
  [["obsidianBridge", "dryRun"], true],
  [["obsidianBridge", "requireVaultPathConfirmation"], true],
  [["obsidianBridge", "autoApplyLowRisk"], false],
  [["obsidianBridge", "dashboardLayer", "enabled"], false],
  [["obsidianBridge", "semanticGraph", "enabled"], false],
  [["obsidianBridge", "semanticGraph", "proposalOnly"], true],
  [["obsidianBridge", "semanticGraph", "mutateMemory"], false],
  [["obsidianBridge", "provenanceGraph", "enabled"], false],
  [["obsidianBridge", "adversarialDeep", "enabled"], false],
  [["obsidianBridge", "soulPatch", "enabled"], false],
  [["obsidianBridge", "soulPatch", "createIfMissing"], false],
  [["obsidianBridge", "morningReview", "enabled"], false],
  [["obsidianBridge", "eveningReview", "enabled"], false],
];

const RECOMMENDED_SAFETY_VALUES = [
  [["reranker", "timeoutMs"], 5000],
  [["merging", "autoApply"], false],
  [["merging", "mode"], "safe-versioned"],
  [["merging", "autoApplyRisk"], "low-only"],
  [["merging", "backupBeforeApply"], true],
  [["merging", "auditLog"], true],
  [["obsidianBridge", "mode"], "augment"],
  [["obsidianBridge", "dryRun"], true],
  [["obsidianBridge", "requireVaultPathConfirmation"], true],
  [["obsidianBridge", "autoApplyLowRisk"], false],
  [["obsidianBridge", "semanticGraph", "proposalOnly"], true],
  [["obsidianBridge", "semanticGraph", "mutateMemory"], false],
  [["obsidianBridge", "morningReview", "status"], "pending_setup"],
  [["obsidianBridge", "eveningReview", "status"], "pending_setup"],
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalize legacy hooks and review aliases on a plugin entry before strict writes.
 * @param {object} entry - Plugin entry to normalize in place.
 * @param {{profileName?: string}} [opts] - Explicit profile compatibility context.
 * @returns {object} The normalized plugin entry.
 */
export function normalizePluginEntryCompatibility(entry, { profileName } = {}) {
  if (!isPlainObject(entry.config)) entry.config = {};
  if (Object.hasOwn(entry.config, "hooks")) {
    if (!isPlainObject(entry.config.hooks)) {
      throw new ConfigContractError(
        `Invalid plugin config at ${PLUGIN_CONFIG_PATH}.hooks: expected object`,
        `${PLUGIN_CONFIG_PATH}.hooks`,
      );
    }
    if (!Object.hasOwn(entry, "hooks")) entry.hooks = clone(entry.config.hooks);
    delete entry.config.hooks;
  }

  if (profileName === "recommended" && isPlainObject(entry.config.merging)) {
    for (const key of ["backupBeforeApply", "auditLog"]) {
      if (entry.config.merging[key] === false) entry.config.merging[key] = true;
    }
  }

  const normalized = validatePluginConfig(entry.config);
  for (const review of ["morningReview", "eveningReview"]) {
    if (!Object.hasOwn(normalized, review)) continue;
    if (!isPlainObject(normalized.obsidianBridge)) normalized.obsidianBridge = {};
    normalized.obsidianBridge[review] = clone(normalized[review]);
    delete normalized[review];
  }
  entry.config = normalized;
  return entry;
}

function explicitProfileBase(profileName) {
  const config = clone(MANIFEST_DEFAULTS);
  config.setupProfile = profileName;
  return config;
}

/** @returns {object} Explicit Recommended profile compatibility alias. */
export function fullExperienceDefaults() {
  return recommendedProfile();
}

/** @returns {Array<object>} Cloned setup/status feature descriptors. */
export function listCoreFeatures() {
  return CORE_FEATURES.map((feature) => ({ ...feature, path: [...feature.path] }));
}

/**
 * @param {object} config - Plugin config to inspect.
 * @returns {Array<object>} Feature descriptors missing from the supplied config.
 */
export function detectMissingCoreFeatures(config = {}) {
  return CORE_FEATURES
    .filter((feature) => getPath(config, feature.path) === undefined)
    .map((feature) => ({ ...feature, path: [...feature.path] }));
}

/**
 * Resolve legacy callers through the safe manifest contract without activation.
 * @param {object} existingConfig - Raw plugin config.
 * @returns {object} Manifest-derived effective config.
 */
export function applyFullExperiencePolicy(existingConfig = {}) {
  return resolveEffectiveConfig(existingConfig || {});
}

/**
 * Build the explicit Recommended profile while retaining mutation safety gates.
 * @returns {object} Schema-valid profile config.
 */
export function recommendedProfile() {
  const config = explicitProfileBase("recommended");
  setPath(config, ["reranker", "enabled"], true);
  setPath(config, ["reranker", "timeoutMs"], 5000);
  setPath(config, ["emotion", "t2", "enabled"], true);
  setPath(config, ["emotion", "t3", "enabled"], true);
  setPath(config, ["metaCognition", "enabled"], true);
  setPath(config, ["metaCognition", "llmReport"], true);
  setPath(config, ["merging", "enabled"], true);
  setPath(config, ["merging", "autoApply"], false);
  setPath(config, ["merging", "mode"], "safe-versioned");
  setPath(config, ["merging", "autoApplyRisk"], "low-only");
  setPath(config, ["merging", "backupBeforeApply"], true);
  setPath(config, ["merging", "auditLog"], true);
  setPath(config, ["schicht15", "enabled"], true);
  setPath(config, ["schicht15", "maxPromotionsPerRun"], 3);
  setPath(config, ["skillMiner", "enabled"], true);
  setPath(config, ["dailyConsolidation", "enabled"], true);
  setPath(config, ["criticalPush", "enabled"], true);
  setPath(config, ["obsidianBridge", "enabled"], true);
  setPath(config, ["obsidianBridge", "mode"], "augment");
  setPath(config, ["obsidianBridge", "allowWrite"], true);
  setPath(config, ["obsidianBridge", "writeManagedBlocks"], true);
  setPath(config, ["obsidianBridge", "dryRun"], true);
  setPath(config, ["obsidianBridge", "requireVaultPathConfirmation"], true);
  setPath(config, ["obsidianBridge", "autoApplyLowRisk"], false);
  setPath(config, ["obsidianBridge", "semanticGraph", "enabled"], true);
  setPath(config, ["obsidianBridge", "semanticGraph", "proposalOnly"], true);
  setPath(config, ["obsidianBridge", "semanticGraph", "mutateMemory"], false);
  setPath(config, ["obsidianBridge", "adversarialDeep", "llmClassifier"], true);
  setPath(config, ["obsidianBridge", "morningReview", "enabled"], true);
  setPath(config, ["obsidianBridge", "morningReview", "status"], "pending_setup");
  setPath(config, ["obsidianBridge", "eveningReview", "enabled"], true);
  setPath(config, ["obsidianBridge", "eveningReview", "status"], "pending_setup");
  return validatePluginConfig(config);
}

/**
 * Build the explicit Safe profile with every listed mutator disabled.
 * @returns {object} Schema-valid profile config.
 */
export function safeProfile() {
  const config = explicitProfileBase("safe");
  for (const [path, value] of SAFE_ENFORCED_VALUES) setPath(config, path, value);
  return validatePluginConfig(config);
}

/**
 * Custom Profile: Build from user selection.
 * @param {object} selection - User choices per feature.
 * @returns {object} Schema-valid custom profile.
 */
export function customProfileFromSelection(selection = {}) {
  const base = safeProfile();
  base.setupProfile = "custom";

  for (const [key, value] of Object.entries(selection)) {
    const feature = CORE_FEATURE_BY_KEY.get(key);
    if (feature && (value === true || value === false)) {
      setPath(base, feature.path, value);
    } else if (feature && isPlainObject(value)) {
      const parentPath = feature.path.slice(0, -1);
      const current = getPath(base, parentPath);
      setPath(base, parentPath, { ...(isPlainObject(current) ? current : {}), ...clone(value) });
    } else if (isPlainObject(value)) {
      base[key] = { ...(isPlainObject(base[key]) ? base[key] : {}), ...clone(value) };
    } else {
      base[key] = clone(value);
    }
  }
  return validatePluginConfig(base);
}

/**
 * Apply an explicit profile, including its narrow safety compatibility policy, to a cloned OpenClaw document.
 * @param {object} existingConfig - Current openclaw.json document.
 * @param {object} profile - Explicit Safe, Recommended, or Custom profile.
 * @param {{confirmedAt?: string, disabledFeatures?: string[]}} [opts] - Confirmation metadata and explicit disables.
 * @returns {object} Validated cloned document.
 */
export function applyFeatureProfile(existingConfig, profile, opts = {}) {
  const merged = clone(existingConfig || {});
  if (!isPlainObject(merged.plugins)) merged.plugins = {};
  if (!isPlainObject(merged.plugins.entries)) merged.plugins.entries = {};
  if (!isPlainObject(merged.plugins.entries[PLUGIN_KEY])) merged.plugins.entries[PLUGIN_KEY] = {};

  const normalizedProfile = validatePluginConfig(profile || {});
  const profileName = normalizedProfile.setupProfile;
  if (!new Set(["recommended", "safe", "custom"]).has(profileName)) {
    throw new ConfigContractError(
      `Invalid plugin config at ${PLUGIN_CONFIG_PATH}.setupProfile: explicit profile is required`,
      `${PLUGIN_CONFIG_PATH}.setupProfile`,
    );
  }
  const pluginEntry = normalizePluginEntryCompatibility(merged.plugins.entries[PLUGIN_KEY], { profileName });

  const nextConfig = mergeMissing(clone(pluginEntry.config), normalizedProfile);
  if (profileName === "safe") {
    for (const [path, value] of SAFE_ENFORCED_VALUES) setPath(nextConfig, path, value);
  } else if (profileName === "recommended") {
    for (const [path, value] of RECOMMENDED_SAFETY_VALUES) setPath(nextConfig, path, value);
  }
  for (const key of opts.disabledFeatures || []) {
    const feature = CORE_FEATURE_BY_KEY.get(key);
    if (feature) setPath(nextConfig, feature.path, false);
  }
  nextConfig.setupProfile = profileName;
  nextConfig.featuresConfirmedAt = opts.confirmedAt || new Date().toISOString();

  pluginEntry.enabled = true;
  pluginEntry.config = validatePluginConfig(nextConfig);
  return merged;
}

/**
 * Detect features that are enabled but pending_setup.
 * @param {object} config — plugin config from openclaw.json
 * @returns {Array<{feature, reason}>}
 */
export function detectPendingFeatures(config) {
  const pending = [];
  const bridge = config?.obsidianBridge || {};
  const reviews = [
    { key: "morningReview", config: bridge.morningReview },
    { key: "eveningReview", config: bridge.eveningReview },
  ];
  for (const review of reviews) {
    if (review.config?.enabled && review.config.status === "pending_setup") {
      pending.push({ feature: review.key, reason: "delivery_target_not_confirmed" });
    }
  }
  if (bridge.enabled && bridge.requireVaultPathConfirmation === true) {
    pending.push({ feature: "obsidianBridge", reason: "vault_path_not_confirmed" });
  }

  return pending;
}

/**
 * Check if Apply is blocked due to missing confirmation.
 * @param {object} config — plugin config
 * @returns {{blocked: boolean, reason?}}
 */
export function isApplyBlocked(config) {
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
  const isUpdate = existingPluginCfg != null && Object.keys(existingPluginCfg || {}).length > 0;
  const alreadyActive = [];
  const newlyActivated = [];
  const disabled = [];

  for (const feature of CORE_FEATURES) {
    const value = getPath(profile, feature.path);
    if (value === undefined) continue;
    const existing = getPath(existingPluginCfg, feature.path);
    if (value === false) {
      if (existing === true) disabled.push(feature.key);
      continue;
    }
    if (value !== true) continue;
    if (existing === true) {
      alreadyActive.push(feature.key);
    } else {
      newlyActivated.push(feature.key);
    }
  }

  return { isUpdate, alreadyActive, newlyActivated, disabled };
}

/**
 * Summarize explicit and missing manifest-aligned feature values.
 * @param {object} config - Raw plugin config.
 * @returns {{active: object[], disabled: object[], missing: object[]}} Feature groups.
 */
export function summarizeFullExperienceStatus(config = {}) {
  const active = [];
  const disabled = [];
  const missing = [];

  for (const feature of CORE_FEATURES) {
    const value = getPath(config, feature.path);
    if (value === undefined) missing.push(feature);
    else if (value === false) disabled.push(feature);
    else active.push(feature);
  }

  return { active, disabled, missing };
}

/**
 * Render the read-only `/plur1bus start` feature status.
 * @param {object} config - Raw plugin config.
 * @param {{vaultPath?: string|null, workspaceRoot?: string|null, reviewRoot?: string|null}} [opts] - Display overrides.
 * @returns {string} Human-readable status.
 */
export function renderPlur1busStartStatus(config = {}, opts = {}) {
  const { vaultPath = null, workspaceRoot = null, reviewRoot = null } = opts;
  const status = summarizeFullExperienceStatus(config);
  const bridge = config.obsidianBridge || {};
  const resolvedReviewRoot = reviewRoot || bridge.reviewRoot || "plur1bus";
  const lines = [
    "PLUR1BUS — Make your agent yours!",
    "",
    `Active: ${status.active.length}  Disabled: ${status.disabled.length}  New/missing: ${status.missing.length}`,
    "",
    "Active:",
    ...status.active.map((feature) => `- ${feature.label}`),
  ];
  if (status.disabled.length > 0) {
    lines.push("", "Disabled:", ...status.disabled.map((feature) => `- ${feature.label}`));
  }
  if (status.missing.length > 0) {
    lines.push("", "New/missing:", ...status.missing.map((feature) => `- ${feature.label} (follows manifest default)`));
  }
  lines.push(
    "",
    `Obsidian: vaultPath=${vaultPath || bridge.vaultPath || "(auto-bootstrap)"} workspaceRoot=${workspaceRoot || bridge.workspaceRoot || "(system-wide)"} reviewRoot=${resolvedReviewRoot}`,
    `Reviews: morning=${bridge.morningReview?.enabled === false ? "off" : "on"} evening=${bridge.eveningReview?.enabled === false ? "off" : "on"} dashboard=${bridge.dashboardLayer?.enabled === false ? "off" : "on"}`,
    "",
    "Use /plur1bus enable|disable <feature>."
  );
  return lines.join("\n");
}

export function pendingNoticePath(openclawHome = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw")) {
  return join(openclawHome, "state", "plur1bus-pending-notice.json");
}

export function writePlur1busStartNotice(openclawHome, opts = {}) {
  const noticePath = pendingNoticePath(openclawHome);
  const payload = {
    kind: "plur1bus_start_notice",
    text: opts.text || PLUR1BUS_START_NOTICE,
    createdAt: new Date().toISOString(),
    ttlMs: opts.ttlMs ?? 7 * 24 * 60 * 60 * 1000,
  };
  mkdirSync(dirname(noticePath), { recursive: true });
  const tmp = `${noticePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, noticePath);
  return { ok: true, path: noticePath, payload };
}

export function consumePlur1busStartNotice(openclawHome) {
  const noticePath = pendingNoticePath(openclawHome);
  if (!existsSync(noticePath)) return null;
  let payload;
  try {
    payload = JSON.parse(readFileSync(noticePath, "utf8"));
  } catch (_err) {
    try { unlinkSync(noticePath); } catch (_) { /* ignore */ }
    return null;
  }
  try { unlinkSync(noticePath); } catch (_) { /* ignore */ }
  if (payload?.ttlMs && payload?.createdAt) {
    const age = Date.now() - Date.parse(payload.createdAt);
    if (Number.isFinite(age) && age > payload.ttlMs) return null;
  }
  if (payload?.kind !== "plur1bus_start_notice" || typeof payload.text !== "string") return null;
  return payload.text;
}

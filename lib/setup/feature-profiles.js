/**
 * lib/setup/feature-profiles.js — PLUR1BUS Full Experience policy.
 *
 * Philosophy:
 * - Fresh installs get the complete PLUR1BUS core experience.
 * - Updates preserve the current config as the source of truth.
 * - Missing new core features are default-on and remain opt-out.
 * - No feature-selection history is written.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PLUGIN_KEY = "memory-lancedb-namespaced";

export const PLUR1BUS_START_NOTICE =
  "PLUR1BUS — Make your agent yours!\n\nPlease complete the installation by running:\n\n/plur1bus start";

export const CORE_FEATURES = [
  { key: "autoCapture", label: "Auto Capture", path: ["autoCapture"], defaultValue: true },
  { key: "autoRecall", label: "Auto Recall", path: ["autoRecall"], defaultValue: true },
  { key: "neo", label: "Neo Context Injection", path: ["neo", "enabled"], defaultValue: true },
  { key: "recallDedup", label: "Recall Dedup", path: ["recall", "dedup"], defaultValue: true },
  { key: "recallCanonicalFirst", label: "Canonical-First Recall", path: ["recall", "canonicalFirst"], defaultValue: true },
  { key: "temporalContext", label: "Temporal Continuity Context", path: ["temporalContext", "enabled"], defaultValue: true },
  { key: "embeddingCache", label: "Embedding Cache", path: ["runtime", "embeddingCacheEnabled"], defaultValue: true },
  { key: "reranker", label: "Reranker", path: ["reranker", "enabled"], defaultValue: true },
  { key: "emotionT2", label: "Emotion Tier 2", path: ["emotion", "t2", "enabled"], defaultValue: true },
  { key: "emotionT3", label: "Emotion Tier 3, provider-gated/fail-soft", path: ["emotion", "t3", "enabled"], defaultValue: true },
  { key: "metaCognition", label: "Meta-Cognition", path: ["metaCognition", "enabled"], defaultValue: true },
  { key: "metaCognitionLlmReport", label: "Meta-Cognition LLM Report, budgeted/fail-soft", path: ["metaCognition", "llmReport"], defaultValue: true },
  { key: "merging", label: "Merging", path: ["merging", "enabled"], defaultValue: true },
  { key: "mergingAutoApply", label: "Low-risk Merge Auto-Apply", path: ["merging", "autoApply"], defaultValue: true },
  { key: "schicht15", label: "Schicht 1.5 Knowledge Promotion", path: ["schicht15", "enabled"], defaultValue: true },
  { key: "skillMiner", label: "Skill Miner", path: ["skillMiner", "enabled"], defaultValue: true },
  { key: "dailyConsolidation", label: "Daily Consolidation", path: ["dailyConsolidation", "enabled"], defaultValue: true },
  { key: "obsidianBridge", label: "Obsidian Bridge", path: ["obsidianBridge", "enabled"], defaultValue: true },
  { key: "morningReview", label: "Morning Review", path: ["morningReview", "enabled"], defaultValue: true },
  { key: "eveningReview", label: "Evening Review", path: ["eveningReview", "enabled"], defaultValue: true },
  { key: "dashboardLayer", label: "Dashboard Layer", path: ["obsidianBridge", "dashboardLayer", "enabled"], defaultValue: true },
  { key: "semanticGraph", label: "Semantic Graph", path: ["obsidianBridge", "semanticGraph", "enabled"], defaultValue: true },
  { key: "provenanceGraph", label: "Provenance Graph", path: ["obsidianBridge", "provenanceGraph", "enabled"], defaultValue: true },
  { key: "adversarialDeep", label: "Adversarial Deep", path: ["obsidianBridge", "adversarialDeep", "enabled"], defaultValue: true },
  { key: "criticalPush", label: "Critical Push, rate-limited", path: ["criticalPush", "enabled"], defaultValue: true },
  { key: "soulPatch", label: "SoulPatch", path: ["obsidianBridge", "soulPatch", "enabled"], defaultValue: true },
  { key: "soulPatchCreateIfMissing", label: "SoulPatch createIfMissing", path: ["obsidianBridge", "soulPatch", "createIfMissing"], defaultValue: true },
  { key: "soulPatchBackup", label: "SoulPatch backup", path: ["obsidianBridge", "soulPatch", "backup"], defaultValue: true },
];

const CORE_FEATURE_BY_KEY = new Map(CORE_FEATURES.map((feature) => [feature.key, feature]));

function clone(value) {
  return value == null || typeof value !== "object" ? value : JSON.parse(JSON.stringify(value));
}

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

function stripFeatureSelectionHistory(config) {
  delete config.featurePolicy;
  delete config.featuresConfirmedAt;
  delete config.setupProfile;
  return config;
}

function enforceRerankerInvariants(config) {
  if (getPath(config, ["reranker", "enabled"]) === true) {
    setPath(config, ["emotion", "t2", "enabled"], true);
    setPath(config, ["emotion", "t3", "enabled"], true);
    setPath(config, ["emotion", "t3", "fallbackOnError"], true, { overwrite: false });
    setPath(config, ["emotion", "t3", "onlyWhenProviderAvailable"], true, { overwrite: false });
    setPath(config, ["metaCognition", "enabled"], true);
    setPath(config, ["metaCognition", "llmReport"], true, { overwrite: false });
    setPath(config, ["metaCognition", "llmReportMode"], "budgeted", { overwrite: false });
    setPath(config, ["metaCognition", "fallbackOnError"], true, { overwrite: false });
  }
}

export function fullExperienceDefaults() {
  const config = {};
  for (const feature of CORE_FEATURES) {
    setPath(config, feature.path, feature.defaultValue);
  }
  mergeMissing(config, {
    reranker: { fallbackOnError: true, timeoutMs: 2500 },
    emotion: {
      tier: "auto",
      t3: { fallbackOnError: true, onlyWhenProviderAvailable: true },
    },
    metaCognition: { llmReportMode: "budgeted", fallbackOnError: true },
    merging: {
      mode: "safe-versioned",
      autoApplyRisk: "low-only",
      backupBeforeApply: true,
      auditLog: true,
      maxAutoApplyPerRun: 5,
    },
    schicht15: { minImportance: 0.7, maxPromotionsPerRun: 3 },
    skillMiner: { maxPerRun: 5, minConfidence: 0.6, minEvidenceScore: 3 },
    criticalPush: { maxPerDay: 3 },
    obsidianBridge: {
      mode: "apply",
      reviewRoot: "plur1bus",
      requireUserApproval: true,
      applyApprovedOnly: true,
      writeManagedBlocks: true,
      allowWrite: true,
      allowDotObsidianWrite: false,
      backupBeforeApply: true,
      auditLog: true,
      requireVaultPathConfirmation: false,
      autoApplyLowRisk: true,
      dryRun: false,
      dashboardLayer: {
        records: true,
        markdownDashboards: true,
        bases: false,
        dataview: false,
        tasks: false,
        autoLinkSuggestions: true,
      },
      semanticGraph: {
        proposalOnly: false,
        writeDerivedEdges: true,
        mutateMemory: false,
      },
      provenanceGraph: { enabled: true },
      adversarialDeep: {
        semanticContradictionScan: true,
        evidenceScoring: true,
        llmClassifier: true,
        fallbackOnError: true,
        onlyWhenProviderAvailable: true,
      },
      soulPatch: {
        force: false,
        migrateLegacy: false,
        promptForLegacyMigration: true,
      },
    },
    morningReview: {
      delivery: "obsidian",
      status: "active",
    },
    eveningReview: {
      delivery: "obsidian",
      status: "active",
    },
  });
  enforceRerankerInvariants(config);
  return config;
}

export function listCoreFeatures() {
  return CORE_FEATURES.map((feature) => ({ ...feature, path: [...feature.path] }));
}

export function detectMissingCoreFeatures(config = {}) {
  return CORE_FEATURES
    .filter((feature) => getPath(config, feature.path) === undefined)
    .map((feature) => ({ ...feature, path: [...feature.path] }));
}

export function applyFullExperiencePolicy(existingConfig = {}, opts = {}) {
  const { forceFullExperience = false, disabledFeatures = [] } = opts;
  const disabled = new Set(disabledFeatures);
  const defaults = fullExperienceDefaults();
  const merged = mergeMissing(clone(existingConfig || {}), defaults);

  if (forceFullExperience) {
    for (const feature of CORE_FEATURES) {
      setPath(merged, feature.path, feature.defaultValue);
    }
  }

  for (const key of disabled) {
    const feature = CORE_FEATURE_BY_KEY.get(key);
    if (feature) setPath(merged, feature.path, false);
  }

  stripFeatureSelectionHistory(merged);
  enforceRerankerInvariants(merged);
  return merged;
}

/**
 * Recommended Profile: the complete PLUR1BUS Full Experience.
 */
export function recommendedProfile() {
  return fullExperienceDefaults();
}

/**
 * Safe Profile: Only core features active.
 * Write-/LLM-intensive features disabled.
 */
export function safeProfile() {
  return {
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
 * @param {boolean} opts.forceFullExperience — if true, rewrites core feature selections from Full Experience defaults
 * @returns {object} merged config
 */
export function applyFeatureProfile(existingConfig, profile, opts = {}) {
  const { forceFullExperience = false, disabledFeatures = [] } = opts;
  const merged = { ...existingConfig };

  // Deep-merge profile into existing config for plugin-specific keys
  const pluginKey = PLUGIN_KEY;
  const pluginEntry = merged.plugins?.entries?.[pluginKey];
  const profileWithoutHistory = stripFeatureSelectionHistory(clone(profile || {}));

  if (!pluginEntry) {
    // No existing plugin config — create minimal structure
    if (!merged.plugins) merged.plugins = {};
    if (!merged.plugins.entries) merged.plugins.entries = {};
    merged.plugins.entries[pluginKey] = {
      enabled: true,
      config: applyFullExperiencePolicy(profileWithoutHistory, { forceFullExperience: true, disabledFeatures }),
    };
  } else {
    // Merge profile into existing config while preserving configured values.
    if (!pluginEntry.config) pluginEntry.config = {};
    const baseConfig = mergeMissing(clone(pluginEntry.config), profileWithoutHistory);
    pluginEntry.config = applyFullExperiencePolicy(baseConfig, { forceFullExperience, disabledFeatures });
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

  for (const [key, value] of Object.entries(profile)) {
    if (key === "setupProfile") continue;
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
    lines.push("", "New/missing:", ...status.missing.map((feature) => `- ${feature.label} (defaults on during update)`));
  }
  lines.push(
    "",
    `Obsidian: vaultPath=${vaultPath || bridge.vaultPath || "(auto-bootstrap)"} workspaceRoot=${workspaceRoot || bridge.workspaceRoot || "(system-wide)"} reviewRoot=${resolvedReviewRoot}`,
    `Reviews: morning=${config.morningReview?.enabled === false ? "off" : "on"} evening=${config.eveningReview?.enabled === false ? "off" : "on"} dashboard=${bridge.dashboardLayer?.enabled === false ? "off" : "on"}`,
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

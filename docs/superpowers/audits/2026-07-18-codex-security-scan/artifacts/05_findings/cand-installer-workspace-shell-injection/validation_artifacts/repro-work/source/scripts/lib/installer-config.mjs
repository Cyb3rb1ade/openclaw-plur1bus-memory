#!/usr/bin/env node
/**
 * scripts/lib/installer-config.mjs — tested installer helpers for PLUR1BUS config policy.
 */

import {
  applyFullExperiencePolicy,
  listCoreFeatures,
} from "../../lib/setup/feature-profiles.js";

export const INSTALL_LOG_FILE = "plur1bus-install-log.jsonl";
export const INSTALL_LOG_KIND = "plur1bus_install";
export const INSTALL_LOG_SCHEMA_VERSION = 1;

function clone(value) {
  return value == null || typeof value !== "object" ? value : JSON.parse(JSON.stringify(value));
}

function hasObjectValue(value) {
  return value != null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

function getPath(obj, path) {
  let cur = obj;
  for (const part of path) {
    if (cur == null || typeof cur !== "object" || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const part = path[i];
    if (cur[part] == null || typeof cur[part] !== "object" || Array.isArray(cur[part])) {
      cur[part] = {};
    }
    cur = cur[part];
  }
  cur[path[path.length - 1]] = value;
}

function isForceMode(mode) {
  return mode === "fresh" || mode === "enable-all" || mode === "force";
}

function featureKeySet(items) {
  return new Set(items.map((feature) => feature.key));
}

function restoreExplicitDisabledFeatures(originalConfig, mergedConfig) {
  for (const feature of listCoreFeatures()) {
    if (getPath(originalConfig || {}, feature.path) === false) {
      setPath(mergedConfig, feature.path, false);
    }
  }
  return mergedConfig;
}

/**
 * Apply installer feature policy to a memory plugin entry.
 * @param {object} pluginEntry - The generated or existing plugin entry.
 * @param {{mode?: "fresh"|"preserve"|"enable-all"|"force"}} opts - Feature policy mode.
 * @returns {object} A cloned plugin entry with full-experience defaults merged into config.
 */
export function applyInstallerFeaturePolicy(pluginEntry = {}, opts = {}) {
  const mode = opts.mode || "preserve";
  const entry = clone(pluginEntry || {});
  entry.enabled = true;
  entry.config = applyFullExperiencePolicy(entry.config || {}, {
    forceFullExperience: isForceMode(mode),
  });
  if (!isForceMode(mode)) {
    entry.config = restoreExplicitDisabledFeatures(pluginEntry?.config || {}, entry.config);
  }
  return entry;
}

/**
 * Summarize configured core feature state.
 * @param {object} config - Plugin config object.
 * @returns {{active: object[], disabled: object[], missing: object[]}} Feature state buckets.
 */
export function summarizeCoreFeatureState(config = {}) {
  const active = [];
  const disabled = [];
  const missing = [];

  for (const feature of listCoreFeatures()) {
    const value = getPath(config || {}, feature.path);
    if (value === undefined) missing.push(feature);
    else if (value === false) disabled.push(feature);
    else active.push(feature);
  }

  return { active, disabled, missing };
}

/**
 * Parse append-only PLUR1BUS installer log content.
 * @param {string} content - JSONL content from state/plur1bus-install-log.jsonl.
 * @returns {{events: object[], lastEvent: object|null, ignoredLines: number}} Parsed installer events.
 */
export function parseInstallLog(content = "") {
  const events = [];
  let ignoredLines = 0;

  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (_err) {
      ignoredLines += 1;
      continue;
    }
    if (event?.kind !== INSTALL_LOG_KIND) {
      ignoredLines += 1;
      continue;
    }
    events.push(event);
  }

  return {
    events,
    lastEvent: events.length > 0 ? events[events.length - 1] : null,
    ignoredLines,
  };
}

/**
 * Detect whether an install should be treated as an update.
 * @param {{existingPluginEntry?: object|null, installLogContent?: string}} input - Existing config and log content.
 * @returns {{isUpdate: boolean, detectedBy: {config: boolean, log: boolean}, lastLogEvent: object|null, logEventCount: number, ignoredLogLines: number}} Detection result.
 */
export function detectExistingInstall(input = {}) {
  const parsed = parseInstallLog(input.installLogContent || "");
  const detectedBy = {
    config: hasObjectValue(input.existingPluginEntry),
    log: parsed.events.length > 0,
  };
  return {
    isUpdate: detectedBy.config || detectedBy.log,
    detectedBy,
    lastLogEvent: parsed.lastEvent,
    logEventCount: parsed.events.length,
    ignoredLogLines: parsed.ignoredLines,
  };
}

/**
 * Build a user-facing feature update plan before patching openclaw.json.
 * @param {{existingPluginConfig?: object|null, proposedPluginConfig?: object|null, installLogContent?: string, mode?: string}} input - Existing/proposed config and policy mode.
 * @returns {object} Feature state diff and update detection metadata.
 */
export function createFeatureUpdatePlan(input = {}) {
  const existingPluginConfig = input.existingPluginConfig || {};
  const proposedPluginConfig = input.proposedPluginConfig || {};
  const mode = input.mode || "preserve";
  const existingPluginEntry =
    Object.hasOwn(input, "existingPluginEntry")
      ? input.existingPluginEntry
      : (hasObjectValue(existingPluginConfig) ? { enabled: true, config: existingPluginConfig } : null);
  const detection = detectExistingInstall({
    existingPluginEntry,
    installLogContent: input.installLogContent || "",
  });

  const before = summarizeCoreFeatureState(existingPluginConfig);
  const afterConfig = applyInstallerFeaturePolicy(
    { enabled: true, config: proposedPluginConfig },
    { mode },
  ).config;
  const after = summarizeCoreFeatureState(afterConfig);

  const beforeMissing = featureKeySet(before.missing);
  const beforeDisabled = featureKeySet(before.disabled);

  const newlyActivated = after.active.filter((feature) => beforeMissing.has(feature.key));
  const preservedDisabled = after.disabled.filter((feature) => beforeDisabled.has(feature.key));
  const reactivated = after.active.filter((feature) => beforeDisabled.has(feature.key));
  const newlyDisabled = after.disabled.filter((feature) => !beforeDisabled.has(feature.key));

  return {
    isUpdate: detection.isUpdate,
    detectedBy: detection.detectedBy,
    logEventCount: detection.logEventCount,
    ignoredLogLines: detection.ignoredLogLines,
    mode,
    before,
    after,
    afterConfig,
    newlyActivated,
    preservedDisabled,
    reactivated,
    newlyDisabled,
  };
}

/**
 * Build a secret-free installer ledger event.
 * @param {object} input - Event metadata and before/after plugin configs.
 * @returns {object} JSON-serializable append-only installer event.
 */
export function buildInstallLogEvent(input = {}) {
  const before = summarizeCoreFeatureState(input.beforeConfig || {});
  const after = summarizeCoreFeatureState(input.afterConfig || {});
  const plan = createFeatureUpdatePlan({
    existingPluginConfig: input.beforeConfig || {},
    proposedPluginConfig: input.afterConfig || {},
    mode: input.featureMode || "preserve",
  });

  return {
    kind: INSTALL_LOG_KIND,
    schemaVersion: INSTALL_LOG_SCHEMA_VERSION,
    createdAt: input.createdAt || new Date().toISOString(),
    packageVersion: input.packageVersion || null,
    installMode: input.installMode || "install",
    featureMode: input.featureMode || "preserve",
    detectedBy: input.detectedBy || { config: false, log: false },
    featureSummary: {
      active: after.active.map((feature) => feature.key),
      disabled: after.disabled.map((feature) => feature.key),
      missing: after.missing.map((feature) => feature.key),
    },
    changes: {
      newlyActivated: plan.newlyActivated.map((feature) => feature.key),
      preservedDisabled: plan.preservedDisabled.map((feature) => feature.key),
      reactivated: plan.reactivated.map((feature) => feature.key),
      previouslyMissing: before.missing.map((feature) => feature.key),
    },
    dataSafety: {
      memoryDataDeleted: false,
      configBackedUp: true,
      installLogAppendOnly: true,
    },
  };
}

function readJsonEnv(name, fallback = {}) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${name} contains invalid JSON: ${err.message}`);
  }
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const command = process.argv[2];
  const input = readJsonEnv("PLUR1BUS_INSTALLER_INPUT", {});

  if (command === "complete-plugin-entry") {
    writeJson(applyInstallerFeaturePolicy(input.pluginEntry || {}, { mode: input.mode || "preserve" }));
    return;
  }
  if (command === "feature-plan") {
    writeJson(createFeatureUpdatePlan(input));
    return;
  }
  if (command === "install-event") {
    writeJson(buildInstallLogEvent(input));
    return;
  }

  console.error("Usage: PLUR1BUS_INSTALLER_INPUT=<json> node scripts/lib/installer-config.mjs <complete-plugin-entry|feature-plan|install-event>");
  process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

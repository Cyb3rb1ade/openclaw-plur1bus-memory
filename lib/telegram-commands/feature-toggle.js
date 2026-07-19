/**
 * /enable + /disable — Feature toggle.
 *
 * Writes directly to $OPENCLAW_CONFIG_PATH or $HOME/.openclaw/openclaw.json.
 * Whitelist prevents arbitrary paths from being set.
 *
 * Restart hint is part of the user response because plugin code reads values
 * at register() time — hot reload is not guaranteed.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { acquireJobLock, releaseJobLock } from "../job-lock.js";
import { t } from "../i18n.js";

/**
 * Performs a read-modify-write operation on openclaw.json under a
 * file lock so concurrent writers (toggle, /plur1bus setup,
 * multiple agents) don't overwrite each other.
 *
 * @param {string} configPath
 * @param {() => any} fn — the critical section (read + write)
 */
export function withConfigLock(configPath, fn, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  const lockPath = `${configPath}.lock`;
  try {
    acquireJobLock(lockPath, { staleMs: 30_000 });
  } catch (err) {
    return { ok: false, error: t("toggle.lock_error", { lang, tone, vars: { error: err.message } }) };
  }
  try {
    return fn();
  } finally {
    releaseJobLock(lockPath);
  }
}

/** Canonical config paths writable through `/enable` and `/disable`. */
export const FEATURE_WHITELIST = {
  temporalContext: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'temporalContext', 'enabled'],
    description: 'Temporal Continuity Context',
  },
  embeddingCache: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'runtime', 'embeddingCacheEnabled'],
    description: 'Embedding Cache',
  },
  autoCapture: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'autoCapture'],
    description: 'Auto Capture',
  },
  autoRecall: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'autoRecall'],
    description: 'Auto Recall',
  },
  vaultSync: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'obsidianBridge', 'enabled'],
    description: 'Vault-Sync (Obsidian-Bridge)',
  },
  obsidianBridge: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'obsidianBridge', 'enabled'],
    description: 'Obsidian Bridge',
  },
  kritischPush: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'criticalPush', 'enabled'],
    description: 'Push bei kritischen Memories',
  },
  criticalPush: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'criticalPush', 'enabled'],
    description: 'Critical Push',
  },
  dailyConsolidation: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'dailyConsolidation', 'enabled'],
    description: 'Tägliche Konsolidierung',
  },
  reranker: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'reranker', 'enabled'],
    description: 'Reranker',
  },
  emotionTier: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'emotion', 't3', 'enabled'],
    description: 'Emotion Tier-3 (LLM-basiert)',
  },
  emotion: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'emotion', 't2', 'enabled'],
    description: 'Emotion Tier-2',
  },
  metaCognition: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'metaCognition', 'enabled'],
    description: 'Meta-Cognition',
  },
  merging: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'merging', 'enabled'],
    description: 'Merging',
  },
  lowRiskMergeAutoApply: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'merging', 'autoApply'],
    description: 'Low-risk Merge Auto-Apply',
  },
  schicht15: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'schicht15', 'enabled'],
    description: 'Schicht 1.5 Knowledge Promotion',
  },
  skillMiner: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'skillMiner', 'enabled'],
    description: 'Skill Miner',
  },
  morningReview: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'obsidianBridge', 'morningReview', 'enabled'],
    description: 'Morning Review',
  },
  eveningReview: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'obsidianBridge', 'eveningReview', 'enabled'],
    description: 'Evening Review',
  },
  dashboardLayer: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'obsidianBridge', 'dashboardLayer', 'enabled'],
    description: 'Dashboard Layer',
  },
  semanticGraph: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'obsidianBridge', 'semanticGraph', 'enabled'],
    description: 'Semantic Graph',
  },
  provenanceGraph: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'obsidianBridge', 'provenanceGraph', 'enabled'],
    description: 'Provenance Graph',
  },
  adversarialDeep: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'obsidianBridge', 'adversarialDeep', 'enabled'],
    description: 'Adversarial Deep',
  },
  soulPatch: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'obsidianBridge', 'soulPatch', 'enabled'],
    description: 'SoulPatch',
  },
};

export function listFeatures() {
  return Object.keys(FEATURE_WHITELIST);
}

function resolveOpenClawConfigPath() {
  if (process.env.OPENCLAW_CONFIG_PATH) return process.env.OPENCLAW_CONFIG_PATH;
  const home = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
  return join(home, "openclaw.json");
}

function setDeep(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (cur[seg] === undefined || cur[seg] === null || typeof cur[seg] !== "object") {
      cur[seg] = {};
    }
    cur = cur[seg];
  }
  cur[path[path.length - 1]] = value;
}

function atomicWriteJson(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

/**
 * @param {string} name      — Feature key from whitelist
 * @param {boolean} enable   — true = on, false = off
 * @param {object} [opts]
 * @param {string} [opts.configPath]
 * @param {string} [opts.lang]
 * @param {string} [opts.tone]
 */
export function toggleFeature(name, enable, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  const known = listFeatures();
  if (!name) {
    return {
      ok: false,
      error: t("toggle.no_feature", { lang, tone }),
      knownFeatures: known,
    };
  }
  const def = FEATURE_WHITELIST[name];
  if (!def) {
    return {
      ok: false,
      error: t("toggle.unknown_feature", { lang, tone, vars: { name, known: known.join(", ") } }),
      knownFeatures: known,
    };
  }
  const path = opts.configPath || resolveOpenClawConfigPath();
  if (!existsSync(path)) {
    return { ok: false, error: t("toggle.config_not_found", { lang, tone, vars: { path } }), knownFeatures: known };
  }
  return withConfigLock(path, () => {
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      return { ok: false, error: t("toggle.config_read_error", { lang, tone, vars: { error: err.message } }), knownFeatures: known };
    }
    setDeep(cfg, def.configPath, !!enable);
    try {
      atomicWriteJson(path, cfg);
    } catch (err) {
      return { ok: false, error: t("toggle.write_error", { lang, tone, vars: { error: err.message } }), knownFeatures: known };
    }
    return { ok: true, feature: name, enabled: !!enable, description: def.description };
  }, { lang, tone });
}

export function renderToggleResult(result, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  if (!result?.ok) {
    const known = result?.knownFeatures || listFeatures();
    const errLine = result?.error || t("toggle.unknown_error", { lang, tone });
    return t("toggle.error_known", { lang, tone, vars: { error: errLine, known: known.join(", ") } });
  }
  const label = getFeatureDescription(result.feature, lang, tone);
  const state = result.enabled
    ? t("toggle.state_on", { lang, tone })
    : t("toggle.state_off", { lang, tone });
  return t("toggle.success", { lang, tone, vars: { label, state } });
}

function getFeatureDescription(name, lang, tone) {
  const desc = t(`toggle.feature.${name}`, { lang, tone });
  if (desc && !desc.startsWith("toggle.feature.")) return desc;
  return FEATURE_WHITELIST[name]?.description || name;
}

export function renderFeatureList(opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  const known = listFeatures();
  const lines = [t("toggle.list_header", { lang, tone })];
  for (const name of known) {
    lines.push(t("toggle.list_item", { lang, tone, vars: { name, description: getFeatureDescription(name, lang, tone) } }));
  }
  lines.push("");
  lines.push(t("toggle.list_usage", { lang, tone }));
  return lines.join("\n");
}

import { basename, dirname } from "node:path";

import { ConfigContractError, PLUGIN_CONFIG_PATH } from "./setup/config-contract.js";

const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const NAMESPACE_CONFIG_PATH = `${PLUGIN_CONFIG_PATH}.namespaces`;
const NAMESPACE_KEYS = new Set([
  "activeWriteNamespace",
  "activeRecallNamespaces",
  "legacyReadOnlyNamespaces",
  "crossNamespaceRecall",
]);

/** Default named-layout namespace used when no writer is supplied. */
export const DEFAULT_NAMESPACE = "lancedb-namespaced";

function errorAt(configPath, detail) {
  throw new ConfigContractError(`Invalid plugin config at ${configPath}: ${detail}`, configPath);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateNamespace(value, configPath) {
  if (typeof value !== "string" || !NAMESPACE_PATTERN.test(value)) {
    errorAt(configPath, `namespace identifier must match pattern ${NAMESPACE_PATTERN.source}`);
  }
  return value;
}

function normalizeNamespaceArray(config, key, path, { requiredItem = false } = {}) {
  if (!hasOwn(config, key)) return null;
  const value = config[key];
  const configPath = `${path}.${key}`;
  if (!Array.isArray(value)) errorAt(configPath, "expected array");
  if (requiredItem && value.length === 0) errorAt(configPath, "must contain at least one item");

  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const namespaceName = validateNamespace(value[index], `${configPath}[${index}]`);
    if (seen.has(namespaceName)) continue;
    seen.add(namespaceName);
    normalized.push(namespaceName);
  }
  return normalized;
}

function normalizeNamespaceConfig(config = {}, path = NAMESPACE_CONFIG_PATH) {
  if (!isPlainObject(config)) errorAt(path, "expected object");
  for (const key of Object.keys(config)) {
    if (!NAMESPACE_KEYS.has(key)) errorAt(`${path}.${key}`, "unknown property");
  }

  const activeWriteNamespace = hasOwn(config, "activeWriteNamespace")
    ? validateNamespace(config.activeWriteNamespace, `${path}.activeWriteNamespace`)
    : DEFAULT_NAMESPACE;
  const suppliedActive = normalizeNamespaceArray(config, "activeRecallNamespaces", path, { requiredItem: true });
  const activeRecallNamespaces = suppliedActive ?? [activeWriteNamespace];
  const legacyReadOnlyNamespaces = normalizeNamespaceArray(config, "legacyReadOnlyNamespaces", path) ?? [];

  if (hasOwn(config, "crossNamespaceRecall") && typeof config.crossNamespaceRecall !== "boolean") {
    errorAt(`${path}.crossNamespaceRecall`, "expected boolean");
  }
  const crossNamespaceRecall = config.crossNamespaceRecall === true;

  if (!activeRecallNamespaces.includes(activeWriteNamespace)) {
    errorAt(
      `${path}.activeRecallNamespaces`,
      `must include active writer ${JSON.stringify(activeWriteNamespace)}`,
    );
  }

  const activeSet = new Set(activeRecallNamespaces);
  for (let index = 0; index < legacyReadOnlyNamespaces.length; index += 1) {
    const namespaceName = legacyReadOnlyNamespaces[index];
    if (activeSet.has(namespaceName)) {
      const sourceIndex = config.legacyReadOnlyNamespaces.indexOf(namespaceName);
      errorAt(
        `${path}.legacyReadOnlyNamespaces[${sourceIndex}]`,
        `namespace ${JSON.stringify(namespaceName)} overlaps the active recall set`,
      );
    }
  }

  const recallReadNamespaces = crossNamespaceRecall
    ? [...activeRecallNamespaces, ...legacyReadOnlyNamespaces]
    : [...activeRecallNamespaces];
  return {
    activeWriteNamespace,
    activeRecallNamespaces,
    legacyReadOnlyNamespaces,
    recallReadNamespaces,
    crossNamespaceRecall,
  };
}

/**
 * Resolve a base DB path and optional namespace config into one immutable routing layout.
 * @param {string} baseDbPath - Existing flat DB path or named-layout root/active leaf.
 * @param {object} effectiveNamespaces - Effective namespace configuration.
 * @param {{explicit?: boolean, path?: string}} [options] - Presence flag and diagnostic path.
 * @returns {Readonly<object>} Deeply frozen legacy-flat or named namespace layout.
 */
export function resolveNamespaceLayout(
  baseDbPath,
  effectiveNamespaces = {},
  { explicit = false, path = NAMESPACE_CONFIG_PATH } = {},
) {
  if (!explicit) {
    return deepFreeze({
      mode: "legacy-flat",
      baseDir: baseDbPath,
      baseDbPath,
      activeWriteNamespace: null,
      activeRecallNamespaces: [],
      legacyReadOnlyNamespaces: [],
      recallReadNamespaces: [],
      crossNamespaceRecall: false,
    });
  }

  const normalized = normalizeNamespaceConfig(effectiveNamespaces, path);
  const leaf = basename(baseDbPath);
  let baseDir = baseDbPath;
  if (leaf === normalized.activeWriteNamespace) {
    baseDir = dirname(baseDbPath);
  } else {
    const configuredNonWriters = new Set([
      ...normalized.activeRecallNamespaces.filter((name) => name !== normalized.activeWriteNamespace),
      ...normalized.legacyReadOnlyNamespaces,
    ]);
    if (configuredNonWriters.has(leaf)) {
      errorAt(path, `ambiguous baseDbPath ending in configured non-writer namespace ${JSON.stringify(leaf)}`);
    }
  }

  return deepFreeze({
    mode: "named",
    baseDir,
    baseDbPath,
    ...normalized,
  });
}

/**
 * Resolve the validated active writer using named-layout semantic defaults.
 * @param {object} nsCfg - Namespace configuration.
 * @returns {string} Active write namespace.
 */
export function resolveWriteNamespace(nsCfg = {}) {
  return normalizeNamespaceConfig(nsCfg).activeWriteNamespace;
}

/**
 * Resolve the validated, stably deduplicated namespace recall order.
 * @param {object} nsCfg - Namespace configuration.
 * @returns {string[]} Namespace names eligible for recall.
 */
export function resolveRecallReadNamespaces(nsCfg = {}) {
  return normalizeNamespaceConfig(nsCfg).recallReadNamespaces;
}

/**
 * Test membership in the validated legacy-read-only namespace set.
 * @param {string} namespaceName - Namespace name to test.
 * @param {object} nsCfg - Namespace configuration.
 * @returns {boolean} Whether the namespace is configured read-only.
 */
export function isLegacyReadOnly(namespaceName, nsCfg = {}) {
  return normalizeNamespaceConfig(nsCfg).legacyReadOnlyNamespaces.includes(namespaceName);
}

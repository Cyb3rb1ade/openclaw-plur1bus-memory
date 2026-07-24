import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { validateTimeZone } from "../time-window.js";

const manifestUrl = new URL("../../openclaw.plugin.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
const configSchema = manifest.configSchema;
const MISSING = Symbol("missing-config-value");
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const TIMEZONE_PATHS = [
  ["timezone"],
  ["styleDirective", "timezone"],
  ["afterthought", "timezone"],
  ["skillMiner", "timezone"],
  ["morningReview", "timezone"],
  ["eveningReview", "timezone"],
  ["obsidianBridge", "morningReview", "timezone"],
  ["obsidianBridge", "eveningReview", "timezone"],
];
const REVIEW_ALIASES = ["morningReview", "eveningReview"];

/** Canonical OpenClaw path for this plugin's runtime config. */
export const PLUGIN_CONFIG_PATH = "plugins.entries.memory-lancedb-namespaced.config";

/** Configuration error carrying the complete rejected config path. */
export class ConfigContractError extends Error {
  /**
   * @param {string} message - Human-readable validation failure.
   * @param {string} configPath - Complete path to the rejected value.
   */
  constructor(message, configPath) {
    super(message);
    this.name = "ConfigContractError";
    this.code = "INVALID_PLUGIN_CONFIG";
    this.configPath = configPath;
  }
}

function clone(value) {
  return structuredClone(value);
}

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

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function typeMatches(value, expected) {
  switch (expected) {
    case "object": return isPlainObject(value);
    case "array": return Array.isArray(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "null": return value === null;
    default: return typeof value === expected;
  }
}

function validateType(value, schema, configPath) {
  if (schema.type === undefined) return;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((type) => typeMatches(value, type))) {
    errorAt(configPath, `expected ${types.join(" or ")}, received ${valueType(value)}`);
  }
}

function validateBounds(value, schema, configPath) {
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errorAt(configPath, `must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errorAt(configPath, `must be at most ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errorAt(configPath, `must be greater than ${schema.exclusiveMinimum}`);
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      errorAt(configPath, `must be less than ${schema.exclusiveMaximum}`);
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errorAt(configPath, `must contain at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errorAt(configPath, `must contain at most ${schema.maxLength} characters`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errorAt(configPath, `must contain at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errorAt(configPath, `must contain at most ${schema.maxItems} items`);
    }
  }
}

function validateNode(value, schema, configPath) {
  validateType(value, schema, configPath);

  if (schema.const !== undefined && !isDeepStrictEqual(value, schema.const)) {
    errorAt(configPath, `must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => isDeepStrictEqual(item, value))) {
    errorAt(configPath, `must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  }
  if (typeof value === "string" && schema.pattern !== undefined) {
    const expression = new RegExp(schema.pattern);
    if (!expression.test(value)) errorAt(configPath, `must match pattern ${schema.pattern}`);
  }
  validateBounds(value, schema, configPath);

  if (Array.isArray(value)) {
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        validateNode(value[index], schema.items, `${configPath}[${index}]`);
      }
    }
    return;
  }
  if (!isPlainObject(value)) return;

  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) errorAt(`${configPath}.${key}`, "unsafe property name");
  }
  for (const requiredKey of schema.required || []) {
    if (!hasOwn(value, requiredKey)) errorAt(`${configPath}.${requiredKey}`, "required value is missing");
  }

  const properties = schema.properties || {};
  for (const [key, childValue] of Object.entries(value)) {
    if (hasOwn(properties, key)) {
      validateNode(childValue, properties[key], `${configPath}.${key}`);
    } else if (schema.additionalProperties === false) {
      errorAt(`${configPath}.${key}`, "unknown property");
    } else if (isPlainObject(schema.additionalProperties)) {
      validateNode(childValue, schema.additionalProperties, `${configPath}.${key}`);
    }
  }
}

function materializeNode(schema, supplied = MISSING) {
  let value = supplied;
  if (value === MISSING && hasOwn(schema, "default")) value = clone(schema.default);

  const supportsObject = schema.type === "object"
    || (Array.isArray(schema.type) && schema.type.includes("object"));
  if (value === MISSING && supportsObject && schema.properties) {
    const output = {};
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      const child = materializeNode(childSchema);
      if (child !== MISSING) output[key] = child;
    }
    return Object.keys(output).length > 0 ? output : MISSING;
  }
  if (value === MISSING) return MISSING;

  if (isPlainObject(value) && schema.properties) {
    const output = clone(value);
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      const child = materializeNode(childSchema, hasOwn(output, key) ? output[key] : MISSING);
      if (child !== MISSING) output[key] = child;
    }
    return output;
  }
  if (Array.isArray(value) && schema.items) {
    return value.map((item) => materializeNode(schema.items, item));
  }
  return clone(value);
}

function getPath(value, parts) {
  let current = value;
  for (const part of parts) {
    if (!isPlainObject(current) || !hasOwn(current, part)) return MISSING;
    current = current[part];
  }
  return current;
}

function setPath(value, parts, nextValue) {
  let current = value;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = clone(nextValue);
}

function normalizeReviewAliases(config, path) {
  for (const review of REVIEW_ALIASES) {
    const legacy = getPath(config, [review]);
    if (legacy === MISSING) continue;
    const nestedParts = ["obsidianBridge", review];
    const nested = getPath(config, nestedParts);
    if (nested !== MISSING && !isDeepStrictEqual(legacy, nested)) {
      const legacyPath = `${path}.${review}`;
      const nestedPath = `${path}.obsidianBridge.${review}`;
      throw new ConfigContractError(
        `Invalid plugin config: conflicting review aliases at ${legacyPath} and ${nestedPath}`,
        nestedPath,
      );
    }
    if (nested === MISSING) setPath(config, nestedParts, legacy);
  }
  return config;
}

function validateTimezones(config, path) {
  for (const parts of TIMEZONE_PATHS) {
    const value = getPath(config, parts);
    if (value === MISSING) continue;
    const configPath = `${path}.${parts.join(".")}`;
    try {
      validateTimeZone(value, { path: configPath });
    } catch (error) {
      throw new ConfigContractError(error.message, configPath);
    }
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** @returns {object} A deeply frozen clone containing only manifest defaults. */
export function manifestConfigDefaults() {
  return resolveEffectiveConfig({});
}

/**
 * Validate and compatibility-normalize raw plugin config without adding defaults.
 * @param {object} rawConfig - Raw plugin config.
 * @param {{path?: string}} [opts] - Complete path prefix for diagnostics.
 * @returns {object} A private normalized clone.
 */
export function validatePluginConfig(rawConfig, { path = PLUGIN_CONFIG_PATH } = {}) {
  validateNode(rawConfig, configSchema, path);
  const normalized = normalizeReviewAliases(clone(rawConfig), path);
  validateNode(normalized, configSchema, path);
  validateTimezones(normalized, path);
  return normalized;
}

/**
 * Resolve raw plugin config through validation, aliases, and manifest defaults.
 * @param {object} rawConfig - Raw plugin config.
 * @param {{path?: string}} [opts] - Complete path prefix for diagnostics.
 * @returns {object} A deeply frozen effective config clone.
 */
export function resolveEffectiveConfig(rawConfig = {}, { path = PLUGIN_CONFIG_PATH } = {}) {
  const normalized = validatePluginConfig(rawConfig, { path });
  const effective = materializeNode(configSchema, normalized);
  validateNode(effective, configSchema, path);
  return deepFreeze(effective);
}

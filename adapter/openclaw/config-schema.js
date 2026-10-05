/**
 * adapter/openclaw/config-schema.js — derives the OpenClaw manifest's config
 * surface from the host-neutral engine config schema
 * (engine/config/engine-config.schema.json).
 *
 * openclaw.plugin.json `configSchema` is the engine schema without its
 * engine-only root keys (`$schema`, `$id`, `x-contract`) and without the
 * engine-only keywords (`readAt`, `x-tier`, `x-sensitive`) in any node;
 * `configContracts.secretInputs.paths` lists the SecretInput paths (`$ref` to
 * `#/$defs/secretInput`, secretInputPaths) — not every `x-sensitive` path: a
 * SecretRef surface needs a schema node that accepts a SecretRef and engine
 * code that resolves it, which the `*.headers` maps and `reminders.webhookUrl`
 * do not have (E5-R24). Every
 * other manifest field is hand-maintained and passed through untouched.
 * scripts/gen-openclaw-config-schema.mjs writes the result (`--check` detects
 * drift).
 */
import { secretInputPaths } from "../../engine/config/engine-config-schema.js";

/** Root keys of the engine schema that the OpenClaw manifest does not carry. */
export const ENGINE_ONLY_ROOT_KEYS = Object.freeze(["$schema", "$id", "x-contract"]);

/** Annotation keywords the engine schema adds to its nodes; OpenClaw does not know them. */
export const ENGINE_ONLY_KEYWORDS = Object.freeze(["readAt", "x-tier", "x-sensitive"]);

/**
 * OpenClaw-only config keys. The engine schema stays host-neutral; the
 * generator merges these into openclaw.plugin.json after deriving.
 * `runtime.deferPostTurnLlm` stays in the engine schema (default false) and
 * is overridden here so OpenClaw's manifest default matches the release line.
 */
export const ADAPTER_ONLY_GROUP_REASONING_FILTER = Object.freeze({
  type: "object",
  additionalProperties: false,
  description: "In group chats, do not start a turn on messages that look like another bot's visible reasoning (for example \"🧠 …\" from /reasoning stream). Providers reject requests that contain another model's thinking as reasoning_extraction. The bot stays silent, with no model call.",
  properties: {
    enabled: {
      type: "boolean",
      default: true,
    },
    prefixes: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Starts that mark a reasoning block (case-insensitive). Defaults: 🧠, 💭, <think>, <thinking>, reasoning:, thinking:.",
    },
  },
});

export const ADAPTER_ONLY_TRACE_REGISTRATIONS = Object.freeze({
  type: "boolean",
  default: false,
  description: "7.18.5 diagnostic for openclaw/openclaw#163029: log the call stack of every plugin registration (warn level), to show where OpenClaw's mid-turn plugin reloads come from. Off by default.",
});

/**
 * Merge adapter-only keys into a derived OpenClaw configSchema. Key order
 * matches the pre-split manifest (groupReasoningFilter after captureChunkingJev,
 * traceRegistrations after detachPostTurnWork).
 *
 * @param {object} schema
 * @returns {object}
 */
export function mergeAdapterOnlyConfigSchema(schema) {
  const properties = {};
  let insertedGroup = false;
  for (const [key, value] of Object.entries(schema.properties || {})) {
    properties[key] = value;
    if (key === "captureChunkingJev") {
      properties.groupReasoningFilter = ADAPTER_ONLY_GROUP_REASONING_FILTER;
      insertedGroup = true;
    }
  }
  if (!insertedGroup) properties.groupReasoningFilter = ADAPTER_ONLY_GROUP_REASONING_FILTER;

  const runtimeNode = properties.runtime;
  if (runtimeNode && typeof runtimeNode === "object") {
    const runtimeProperties = {};
    let insertedTrace = false;
    for (const [key, value] of Object.entries(runtimeNode.properties || {})) {
      runtimeProperties[key] = key === "deferPostTurnLlm"
        ? { ...value, default: true }
        : value;
      if (key === "detachPostTurnWork") {
        runtimeProperties.traceRegistrations = ADAPTER_ONLY_TRACE_REGISTRATIONS;
        insertedTrace = true;
      }
    }
    if (!insertedTrace) runtimeProperties.traceRegistrations = ADAPTER_ONLY_TRACE_REGISTRATIONS;
    properties.runtime = { ...runtimeNode, properties: runtimeProperties };
  }

  return { ...schema, properties };
}

function withoutKeywords(node) {
  if (Array.isArray(node)) return node.map(withoutKeywords);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (ENGINE_ONLY_KEYWORDS.includes(key)) continue;
    out[key] = withoutKeywords(value);
  }
  return out;
}

/**
 * Deep copy of the engine schema without the engine-only root keys and, in
 * every object node (including `$defs`), without ENGINE_ONLY_KEYWORDS. Key
 * order is kept; the input is not modified.
 *
 * @param {object} engineSchema
 * @returns {object}
 */
export function deriveOpenClawConfigSchema(engineSchema) {
  const out = {};
  for (const [key, value] of Object.entries(engineSchema)) {
    if (ENGINE_ONLY_ROOT_KEYS.includes(key) || ENGINE_ONLY_KEYWORDS.includes(key)) continue;
    out[key] = withoutKeywords(value);
  }
  return mergeAdapterOnlyConfigSchema(out);
}

/**
 * The manifest's `configContracts.secretInputs.paths`: every SecretInput path
 * (secretInputPaths) in schema order.
 *
 * @param {object} engineSchema
 * @returns {Array<{ path: string; expected: "string" }>}
 */
export function deriveSecretInputPaths(engineSchema) {
  return secretInputPaths(engineSchema).map((path) => ({ path, expected: "string" }));
}

/**
 * The manifest with `configSchema` and `configContracts.secretInputs.paths`
 * replaced by the derived values; every other field, and the key order, is
 * untouched. The input is not modified.
 *
 * @param {object} manifest  parsed openclaw.plugin.json
 * @param {object} engineSchema
 * @returns {object}
 */
export function applyEngineSchemaToManifest(manifest, engineSchema) {
  const out = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key === "configSchema") {
      out[key] = deriveOpenClawConfigSchema(engineSchema);
    } else if (key === "configContracts") {
      out[key] = {
        ...value,
        secretInputs: { ...value?.secretInputs, paths: deriveSecretInputPaths(engineSchema) },
      };
    } else {
      out[key] = value;
    }
  }
  return out;
}

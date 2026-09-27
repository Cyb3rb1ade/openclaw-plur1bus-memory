/**
 * adapter/openclaw/config-schema.js — derives the OpenClaw manifest's config
 * surface from the host-neutral engine config schema
 * (engine/config/engine-config.schema.json).
 *
 * openclaw.plugin.json `configSchema` is the engine schema without its
 * engine-only root keys (`$schema`, `$id`, `x-contract`) and without the
 * engine-only keywords (`readAt`, `x-tier`, `x-sensitive`) in any node;
 * `configContracts.secretInputs.paths` lists the `x-sensitive` paths. Every
 * other manifest field is hand-maintained and passed through untouched.
 * scripts/gen-openclaw-config-schema.mjs writes the result (`--check` detects
 * drift).
 */
import { sensitivePaths } from "../../engine/config/engine-config-schema.js";

/** Root keys of the engine schema that the OpenClaw manifest does not carry. */
export const ENGINE_ONLY_ROOT_KEYS = Object.freeze(["$schema", "$id", "x-contract"]);

/** Annotation keywords the engine schema adds to its nodes; OpenClaw does not know them. */
export const ENGINE_ONLY_KEYWORDS = Object.freeze(["readAt", "x-tier", "x-sensitive"]);

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
  return out;
}

/**
 * The manifest's `configContracts.secretInputs.paths`: every `x-sensitive`
 * path in schema order.
 *
 * @param {object} engineSchema
 * @returns {Array<{ path: string; expected: "string" }>}
 */
export function deriveSecretInputPaths(engineSchema) {
  return sensitivePaths(engineSchema).map((path) => ({ path, expected: "string" }));
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

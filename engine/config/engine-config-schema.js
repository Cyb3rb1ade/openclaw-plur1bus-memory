/**
 * engine/config/engine-config-schema.js — loader for engine/config/engine-config.schema.json
 * (types/engine.d.ts `EngineConfigSchema`, contract 1.9.0).
 *
 * The JSON is the host-neutral engine config schema: the OpenClaw manifest's
 * `configSchema` plus three annotations — `readAt` (when the engine reads a
 * value: once at `createEngine`, or live per operation), `x-tier` (basic or
 * advanced) and `x-sensitive` (credential inputs). Every top-level key declares
 * `readAt`; a nested node may override it, so a path's readAt is that of the
 * nearest (deepest) node on the path that declares one.
 *
 * The schema is read once from the package, deep-frozen and cached; callers
 * share the same object and cannot mutate it. Only `properties` chains form
 * config paths — `$defs`, `items` and friends are validation detail.
 */
import { readFileSync } from "node:fs";

/** Package-relative location of the schema file (it ships with the package and the deploy). */
export const ENGINE_CONFIG_SCHEMA_FILE = "engine/config/engine-config.schema.json";

let cached = null;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function childrenOf(node) {
  const props = node?.properties;
  return props && typeof props === "object" && !Array.isArray(props) ? props : null;
}

/**
 * Visit every config path below `props` depth-first in schema order, with the
 * readAt it resolves to.
 */
function walk(props, prefix, inheritedReadAt, visit) {
  for (const [name, node] of Object.entries(props)) {
    if (!node || typeof node !== "object") continue;
    const path = prefix ? `${prefix}.${name}` : name;
    const readAt = typeof node.readAt === "string" ? node.readAt : inheritedReadAt;
    visit(path, node, readAt);
    const children = childrenOf(node);
    if (children) walk(children, path, readAt, visit);
  }
}

/**
 * The parsed engine config schema, deep-frozen and cached.
 *
 * @returns {import("../../types/engine").EngineConfigSchema}
 */
export function loadEngineConfigSchema() {
  if (!cached) {
    const text = readFileSync(new URL("./engine-config.schema.json", import.meta.url), "utf8");
    cached = deepFreeze(JSON.parse(text));
  }
  return cached;
}

/**
 * readAt of a dotted config path: that of the nearest node on the path that
 * declares `readAt`. An unknown path (or one no node on it declares) gives null.
 *
 * @param {string} path  e.g. "recall.softBudgetMs"
 * @param {object} [schema]
 * @returns {import("../../types/engine").EngineConfigReadAt | null}
 */
export function readAtOf(path, schema = loadEngineConfigSchema()) {
  if (typeof path !== "string" || path === "") return null;
  let props = childrenOf(schema);
  let readAt = null;
  for (const segment of path.split(".")) {
    const node = props && Object.hasOwn(props, segment) ? props[segment] : null;
    if (!node || typeof node !== "object") return null;
    if (typeof node.readAt === "string") readAt = node.readAt;
    props = childrenOf(node);
  }
  return readAt;
}

/**
 * Every dotted path whose resolved readAt is "live", sorted.
 *
 * @param {object} [schema]
 * @returns {string[]}
 */
export function livePaths(schema = loadEngineConfigSchema()) {
  const out = [];
  const root = childrenOf(schema);
  if (root) walk(root, "", null, (path, _node, readAt) => { if (readAt === "live") out.push(path); });
  return out.sort();
}

/**
 * Every dotted path of a node with `"x-sensitive": true`, in depth-first schema order.
 *
 * @param {object} [schema]
 * @returns {string[]}
 */
export function sensitivePaths(schema = loadEngineConfigSchema()) {
  const out = [];
  const root = childrenOf(schema);
  if (root) walk(root, "", null, (path, node) => { if (node["x-sensitive"] === true) out.push(path); });
  return out;
}

/**
 * The top-level config keys in schema order, as `EngineConfigKey`s.
 *
 * @param {object} [schema]
 * @returns {import("../../types/engine").EngineConfigKey[]}
 */
export function engineConfigKeys(schema = loadEngineConfigSchema()) {
  const root = childrenOf(schema) ?? {};
  const live = livePaths(schema);
  const sensitive = sensitivePaths(schema);
  return Object.entries(root).map(([key, node]) => {
    const prefix = `${key}.`;
    const readAt = node.readAt;
    const entry = {
      key,
      type: node.type ?? (Object.hasOwn(node, "enum") ? "enum" : null),
    };
    if (Object.hasOwn(node, "default")) entry.default = node.default;
    entry.description = node.description;
    entry.readAt = readAt;
    entry.liveOverrides = live.filter((path) => path.startsWith(prefix) && readAtOf(path, schema) !== readAt);
    entry.tier = node["x-tier"];
    entry.sensitive = sensitive.some((path) => path === key || path.startsWith(prefix));
    return entry;
  });
}

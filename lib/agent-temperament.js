// Temperament pro Agent im Dashboard.
//
// Gleiche Ablage wie `/plur1bus temperament <preset>`:
// plugins.entries.<id>.config.emotion.temperaments.<agent> = {...Preset, preset}.
// Die Karte schreibt aber ueber OpenClaws serialisierten Config-Writer
// (mutateConfigFile), nicht ueber den eigenen Datei-Schreibweg des Befehls.
// Weil der Schluessel unter dem eigenen Plugin-Eintrag liegt, laedt OpenClaw das
// Plugin danach neu (etwa eine Minute); der Stimmungs-Pool baut sich dann mit
// dem neuen Profil auf, die aktuelle Stimmung bleibt erhalten.
//
// Aufloesung wie in createEmotionalStatePool (lib/emotional-state.js):
//   main            → eigene Wahl, sonst der eingebaute main-Standard (1.2 / ×1.0)
//   jeder andere    → eigene Wahl, sonst die Zeile "default", sonst ausgewogen
// `default` gilt also nie fuer main.

import { DEFAULT_TEMPERAMENTS, TEMPERAMENT_PRESETS } from "./emotional-state.js";
import { configuredAgentModels } from "./featureModels.js";
import { validateInput } from "./input-limits.js";

const PLUGIN_ID = "memory-lancedb-namespaced";
const AGENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const COMPARED_KEYS = ["sensitivity", "decayMultiplier", "blendFactor", "moodInfluence"];

/** Row key of the shared fallback temperament ("All other agents"). */
export const DEFAULT_TEMPERAMENT_ROW = "default";

/** Error code of a request for an agent that has no temperament row. */
export const TEMPERAMENT_DENIED = "denied_choice";

/** English glosses for the stored (German) preset names. */
export const TEMPERAMENT_GLOSS = Object.freeze({
  ausgewogen: "balanced",
  warm: "warm",
  "kühl": "cool",
  feurig: "fiery",
  stoisch: "stoic",
});

const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const validAgentId = (value) => typeof value === "string" && AGENT_RE.test(value) && !UNSAFE_KEYS.has(value);
const isPreset = (name) => typeof name === "string" && Object.hasOwn(TEMPERAMENT_PRESETS, name);
// Same defaulting as EmotionalState: anything but a positive finite number is 1.0.
const factor = (value) => Number.isFinite(value) && value > 0 ? value : 1.0;
const formatFactor = (value) => Number.isInteger(value) ? value.toFixed(1) : String(value);

/**
 * The stored entry for one preset: a deep copy plus its name, exactly the
 * shape `/plur1bus temperament` writes. TEMPERAMENT_PRESETS is frozen only at
 * the top level, so a shallow spread would share the `baseline` object.
 * @param {string} name Preset name.
 * @returns {object|null} Fresh entry, or null for an unknown name.
 */
export function temperamentEntry(name) {
  if (!isPreset(name)) return null;
  return { ...structuredClone(TEMPERAMENT_PRESETS[name]), preset: name };
}

// Key-order independent JSON, so the running and the saved side compare equal
// whenever their values do.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function matchesPresetValues(entry, name) {
  const preset = TEMPERAMENT_PRESETS[name];
  if (!preset) return false;
  for (const key of COMPARED_KEYS) {
    if ((entry[key] ?? null) !== (preset[key] ?? null)) return false;
  }
  return stableJson(entry.baseline ?? null) === stableJson(preset.baseline ?? null);
}

// A preset name for an entry: its stored name when that is a known preset.
// Only the built-in defaults, which carry no name, are named by their values;
// a saved entry without a known name is "custom", as dreams and reply style
// read nothing but the stored name.
function describeEntry(entry, { builtin = false } = {}) {
  const named = isPreset(entry.preset) ? entry.preset : null;
  const preset = named ?? (builtin
    ? Object.keys(TEMPERAMENT_PRESETS).find((name) => matchesPresetValues(entry, name)) ?? null
    : null);
  return {
    preset,
    differs: Boolean(named) && !matchesPresetValues(entry, named),
    sensitivity: factor(entry.sensitivity),
    decayMultiplier: factor(entry.decayMultiplier),
  };
}

function ownEntry(temperaments, id) {
  return Object.hasOwn(temperaments, id) && isRecord(temperaments[id]) ? temperaments[id] : null;
}

function fallbackTemperament(temperaments, id) {
  if (id === "main") return { source: "builtin", ...describeEntry(DEFAULT_TEMPERAMENTS.main, { builtin: true }) };
  const shared = id === DEFAULT_TEMPERAMENT_ROW ? null : ownEntry(temperaments, DEFAULT_TEMPERAMENT_ROW);
  if (shared) return { source: "default-row", ...describeEntry(shared) };
  return { source: "builtin", ...describeEntry(DEFAULT_TEMPERAMENTS.default, { builtin: true }) };
}

/**
 * What applies to one agent, resolved the way the emotional-state pool does.
 * @param {object} temperaments `emotion.temperaments` of the running config.
 * @param {string} id Agent id, or "default" for the shared row.
 * @returns {{source: "own"|"default-row"|"builtin", preset: string|null, differs: boolean, sensitivity: number, decayMultiplier: number}}
 */
export function effectiveTemperament(temperaments, id) {
  const own = ownEntry(record(temperaments), id);
  return own ? { source: "own", ...describeEntry(own) } : fallbackTemperament(record(temperaments), id);
}

// The select option: German name (the stored value), English gloss when it
// differs, and the two factors.
function presetOptionLabel(id, preset) {
  const gloss = TEMPERAMENT_GLOSS[id] && TEMPERAMENT_GLOSS[id] !== id ? ` — ${TEMPERAMENT_GLOSS[id]}` : "";
  return `${id}${gloss} · reacts ×${formatFactor(factor(preset.sensitivity))} · mood lasts ×${formatFactor(factor(preset.decayMultiplier))}`;
}

// The legend line: gloss, the two factors and the resting mood.
function presetLegend(id, preset) {
  const baseline = Object.entries(record(preset.baseline))
    .filter(([, value]) => Number.isFinite(value))
    .map(([dimension, value]) => `${dimension} ${value}`);
  const gloss = TEMPERAMENT_GLOSS[id] && TEMPERAMENT_GLOSS[id] !== id ? `${TEMPERAMENT_GLOSS[id]}: ` : "";
  return `${gloss}reacts ×${formatFactor(factor(preset.sensitivity))}, mood lasts ×${formatFactor(factor(preset.decayMultiplier))}, `
    + (baseline.length ? `resting mood ${baseline.join(", ")}.` : "neutral resting mood.");
}

function chosenValue(temperaments, id) {
  const own = ownEntry(temperaments, id);
  return own ? (isPreset(own.preset) ? own.preset : "custom") : "";
}

function temperamentLabel(resolved) {
  const name = resolved.source === "builtin" && !resolved.preset
    ? "built-in default"
    : resolved.preset
      ? `${resolved.preset}${resolved.source === "builtin" ? " (built-in)" : ""}${resolved.differs ? " (values differ from the preset)" : ""}`
      : "custom values";
  const via = resolved.source === "default-row" ? ", from \"All other agents\"" : "";
  return `${name}${via} · reacts ×${formatFactor(resolved.sensitivity)} · mood lasts ×${formatFactor(resolved.decayMultiplier)}`;
}

function bindingAgentIds(hostConfig) {
  const ids = new Set();
  for (const binding of Array.isArray(hostConfig?.bindings) ? hostConfig.bindings : []) {
    if (validAgentId(binding?.agentId)) ids.add(binding.agentId);
  }
  return ids;
}

function heartbeatAgentIds(hostConfig) {
  const entries = record(hostConfig?.agents).entries;
  const list = Array.isArray(entries)
    ? entries
    : isRecord(entries)
      ? Object.entries(entries).map(([id, agent]) => ({ ...record(agent), id }))
      : Array.isArray(record(hostConfig?.agents).list) ? hostConfig.agents.list : [];
  return new Set(list
    .filter((agent) => agent?.heartbeat === true || isRecord(agent?.heartbeat))
    .map((agent) => agent?.id)
    .filter(validAgentId));
}

/**
 * The agents the temperament card lists, in this order: chat agents (those
 * with a channel binding, plus legacy heartbeat agents) in config order, else
 * `main`; every other agent that already has a saved entry, so a choice never
 * disappears; and last the shared row "default". Subagents get no row of their
 * own; they follow the shared row.
 * @param {object} config PLUR1BUS config (only `emotion.temperaments` is read).
 * @param {object} hostConfig OpenClaw config.
 * @returns {string[]} Row ids.
 */
export function temperamentRowIds(config = {}, hostConfig = {}) {
  const known = configuredAgentModels(hostConfig).map((agent) => agent.id);
  const position = (id) => {
    const index = known.indexOf(id);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const byConfigOrder = (left, right) => position(left) - position(right) || left.localeCompare(right);
  const chat = [...new Set([...bindingAgentIds(hostConfig), ...heartbeatAgentIds(hostConfig)])]
    .filter((id) => id !== DEFAULT_TEMPERAMENT_ROW)
    .sort(byConfigOrder);
  const rows = chat.length ? chat : ["main"];
  const saved = Object.keys(record(record(config?.emotion).temperaments))
    .filter((id) => validAgentId(id) && id !== DEFAULT_TEMPERAMENT_ROW && !rows.includes(id))
    .sort(byConfigOrder);
  return [...rows, ...saved, DEFAULT_TEMPERAMENT_ROW];
}

/**
 * Dashboard projection: the closed preset list with preformatted option and
 * legend text, and one row per listed agent. `running` and `fallback` describe
 * the running config. `chosen` (what the select shows) comes from the saved
 * file when it is known, so during the reload lag the select holds the saved
 * choice and an untouched Save writes nothing; without the file it is the
 * running choice. Nothing else from either config leaves this function.
 * @param {object} config Running PLUR1BUS config.
 * @param {object} hostConfig OpenClaw config.
 * @param {object|null} [saved] Effective PLUR1BUS config read from openclaw.json, or null when unknown.
 * @returns {{presets: Array<{id: string, gloss: string, label: string, legend: string}>, agents: Array<{id: string, label: string, chosen: string, running: string, fallback: string}>}}
 */
export function projectAgentTemperaments(config = {}, hostConfig = {}, saved = null) {
  const temperaments = record(record(config?.emotion).temperaments);
  const savedTemperaments = isRecord(saved) ? record(record(saved.emotion).temperaments) : null;
  const labels = new Map(configuredAgentModels(hostConfig).map((agent) => [agent.id, agent.label]));
  return {
    presets: Object.entries(TEMPERAMENT_PRESETS).map(([id, preset]) => ({
      id,
      gloss: TEMPERAMENT_GLOSS[id] ?? id,
      label: presetOptionLabel(id, preset),
      legend: presetLegend(id, preset),
    })),
    agents: temperamentRowIds(config, hostConfig).map((id) => ({
      id,
      label: id === DEFAULT_TEMPERAMENT_ROW ? "All other agents" : labels.get(id) ?? id,
      chosen: chosenValue(savedTemperaments ?? temperaments, id),
      running: temperamentLabel(effectiveTemperament(temperaments, id)),
      fallback: temperamentLabel(fallbackTemperament(temperaments, id)),
    })),
  };
}

/**
 * Ids `temperament:<agent>` whose entry differs between the running config
 * and the file, for the saved-but-not-running marker.
 * @param {object} running Effective running config.
 * @param {object} file Effective config read from openclaw.json.
 * @returns {string[]}
 */
export function temperamentPendingIds(running = {}, file = {}) {
  const a = record(record(running?.emotion).temperaments);
  const b = record(record(file?.emotion).temperaments);
  const out = [];
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!validAgentId(id)) continue;
    if (stableJson(Object.hasOwn(a, id) ? a[id] : null) !== stableJson(Object.hasOwn(b, id) ? b[id] : null)) out.push(`temperament:${id}`);
  }
  return out;
}

/**
 * Normalizes untrusted form input. An empty temperament removes the agent's
 * own choice. The preset name is NFC-normalized ("kühl" may arrive decomposed).
 * @param {{agentId?: unknown, temperament?: unknown}} request
 * @returns {Readonly<{agentId: string, temperament: string}>|null} Normalized request, or null when invalid.
 */
export function normalizeTemperamentRequest(request = {}) {
  const agentId = request?.agentId;
  const temperament = request?.temperament;
  if (typeof agentId !== "string" || typeof temperament !== "string") return null;
  if (!validateInput(agentId, { maxLength: 64, required: true, name: "agent" }).ok) return null;
  if (!validateInput(temperament, { maxLength: 32, required: false, name: "temperament" }).ok) return null;
  if (!validAgentId(agentId)) return null;
  const name = temperament.normalize("NFC");
  if (name !== "" && !isPreset(name)) return null;
  return Object.freeze({ agentId, temperament: name });
}

/**
 * Shape check for untrusted form input.
 * @param {{agentId?: unknown, temperament?: unknown}} request
 * @returns {boolean}
 */
export function validTemperamentRequest(request = {}) {
  return normalizeTemperamentRequest(request) !== null;
}

/**
 * The plugin config with one agent's temperament set or removed; other
 * agents and other `emotion.*` keys stay. Pure.
 * @param {object} config Raw plugin config.
 * @param {string} agentId Row id.
 * @param {string} temperament Preset name, or "" to remove the choice.
 * @returns {object} Next plugin config.
 */
export function withTemperament(config, agentId, temperament) {
  const current = record(config);
  const emotion = { ...record(current.emotion) };
  const temperaments = { ...record(emotion.temperaments) };
  if (temperament) temperaments[agentId] = temperamentEntry(temperament);
  else delete temperaments[agentId];
  if (Object.keys(temperaments).length) emotion.temperaments = temperaments;
  else delete emotion.temperaments;
  return { ...current, emotion };
}

class Unchanged extends Error {}

/**
 * Writes one agent's temperament through OpenClaw's serialized config writer,
 * at the key `/plur1bus temperament` uses. The row set and the preset are
 * checked again against the draft; `validate` (resolveEffectiveConfig) runs on
 * the result before anything is assigned. A request that would leave the file
 * as it is writes nothing, because every write to this plugin's entry costs a
 * plugin reload.
 * @param {object} options
 * @param {object} options.api Plugin API.
 * @param {(config: object) => unknown} options.validate Throws on a config the schema rejects.
 * @param {string} [options.pluginId]
 * @returns {(request: {agentId: string, temperament: string}) => Promise<{agentId: string, temperament: string, changed: boolean}>}
 */
export function createTemperamentMutator({ api, validate, pluginId = PLUGIN_ID } = {}) {
  const mutateConfigFile = api?.runtime?.config?.mutateConfigFile;
  if (typeof mutateConfigFile !== "function") throw new Error("OpenClaw config mutation is unavailable");
  if (typeof validate !== "function") throw new Error("A config validator is required for the temperament switch");
  return async (request) => {
    const parsed = normalizeTemperamentRequest(request);
    if (!parsed) throw Object.assign(new Error("Invalid temperament selection"), { code: TEMPERAMENT_DENIED });
    const { agentId, temperament } = parsed;
    try {
      await mutateConfigFile({ afterWrite: { mode: "auto" }, mutate(draft) {
        const entry = draft?.plugins?.entries?.[pluginId];
        if (!isRecord(entry)) throw new Error("Active PLUR1BUS config entry is unavailable");
        const config = record(entry.config);
        if (!temperamentRowIds(config, draft).includes(agentId)) {
          throw Object.assign(new Error(`${agentId} has no temperament row`), { code: TEMPERAMENT_DENIED });
        }
        const before = ownEntry(record(record(config.emotion).temperaments), agentId);
        if (stableJson(before) === stableJson(temperament ? temperamentEntry(temperament) : null)) throw new Unchanged();
        const next = withTemperament(config, agentId, temperament);
        validate(next); // throws on a schema violation; nothing has been assigned yet
        entry.config = next;
        return Object.freeze({ agentId, temperament });
      } });
    } catch (error) {
      if (error instanceof Unchanged) return Object.freeze({ agentId, temperament, changed: false });
      throw error;
    }
    return Object.freeze({ agentId, temperament, changed: true });
  };
}

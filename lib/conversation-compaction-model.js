// Kompaktierungsmodell des Gespraechsverlaufs pro Chat-Agent.
//
// Gemeint ist OpenClaws Kompaktierung des Kontexts (`/compact`, Auto-Compaction),
// nicht "Memory compaction" aus der Task-Tabelle: das ist der naechtliche
// Aufraeumjob im Gedaechtnis-Speicher und laeuft ueber llmRouter.agentModels.
//
// Die Wahl steht nur an einer Stelle: agents.entries.<agent>.compaction.model.
// Ein Spiegel in der Plugin-Config waere hier schaedlich — jede Aenderung am
// eigenen Config-Eintrag laesst OpenClaw das Plugin neu laden, und kein
// Startskript schreibt `compaction` um, vor dem die Wahl geschuetzt werden
// muesste. Hosts ohne den Schluessel lehnen den Schreibversuch bei der
// Validierung ab; das wird als eigener Fehlercode gemeldet.

import { projectChatModels, validChatModelRequest } from "./chat-model.js";

/** Error code of a write the host refused because it lacks the per-agent key. */
export const COMPACTION_MODEL_UNSUPPORTED = "compaction_model_unsupported";

// The host's InvalidConfigError lists one line per issue, `<path>: <message>`:
// `agents.entries.main: Unrecognized key: "compaction"` before per-agent
// compaction existed, `…main.compaction: Unrecognized key: "model"` once only
// the summary limit was per agent. Ids that are not plain identifiers appear
// in brackets, and a line may start with a `file:line — ` location.
const UNSUPPORTED_RE = /agents\.entries[^\n:]*:\s*Unrecognized keys?:\s*"(?:compaction|model)"/;

const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const modelString = (value) => typeof value === "string" ? value.trim().slice(0, 256) : "";

function agentEntry(hostConfig, agentId) {
  const entries = record(hostConfig?.agents).entries;
  const entry = Array.isArray(entries)
    ? entries.find((agent) => agent?.id === agentId)
    : Object.hasOwn(record(entries), agentId) ? entries[agentId] : null;
  return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
}

/**
 * Dashboard projection: the shared compaction model and one row per chat agent.
 * An empty `shared` means sessions summarize with their own model.
 * @param {object} hostConfig OpenClaw config.
 * @returns {{shared: string, agents: Array<{id: string, label: string, chosen: string, models: Array<object>}>}}
 */
export function projectCompactionModels(hostConfig = {}) {
  const defaults = record(record(hostConfig?.agents).defaults);
  return {
    shared: modelString(record(defaults.compaction).model),
    agents: projectChatModels({}, hostConfig).agents.map((agent) => ({
      id: agent.id,
      label: agent.label,
      chosen: modelString(record(agentEntry(hostConfig, agent.id)?.compaction).model),
      models: agent.models,
    })),
  };
}

function assertCompactionModelAllowed(hostConfig, agentId, model) {
  const agent = projectCompactionModels(hostConfig).agents.find((entry) => entry.id === agentId);
  if (!agent) throw new Error(`${agentId} is not a chat agent`);
  if (model && !agent.models.some((option) => option.id === model)) {
    throw new Error(`${model} is not allowed for ${agentId}`);
  }
}

const chosenModel = (hostConfig, agentId) => modelString(record(agentEntry(hostConfig, agentId)?.compaction).model);

function withCompactionModel(hostConfig, agentId, model) {
  const entry = agentEntry(hostConfig, agentId);
  if (!entry) return hostConfig;
  const { model: _previous, ...rest } = record(entry.compaction);
  const { compaction: _compaction, ...agent } = entry;
  const next = model || Object.keys(rest).length ? { ...agent, compaction: model ? { ...rest, model } : rest } : agent;
  const entries = hostConfig.agents.entries;
  return {
    ...hostConfig,
    agents: {
      ...hostConfig.agents,
      entries: Array.isArray(entries)
        ? entries.map((candidate) => candidate === entry ? next : candidate)
        : { ...entries, [agentId]: next },
    },
  };
}

/**
 * Remembers choices OpenClaw has written to openclaw.json but not yet taken
 * into its running config. The host applies a config write only after its
 * reload check, which takes seconds to minutes; until then the dashboard would
 * show the previous choice next to "saved". A remembered choice is dropped as
 * soon as the running value changes (the host caught up, or someone set a
 * different one) and after `ttlMs` at the latest.
 * @param {object} [options]
 * @param {() => number} [options.now] Clock in milliseconds.
 * @param {number} [options.ttlMs] Longest time a choice is shown without the host confirming it.
 * @returns {{record: (hostConfig: object, agentId: string, model: string) => void, overlay: (hostConfig: object|null) => object|null}}
 */
export function createPendingCompactionModels({ now = Date.now, ttlMs = 5 * 60_000 } = {}) {
  const pending = new Map();
  return {
    record(hostConfig, agentId, model) {
      const before = chosenModel(hostConfig, agentId);
      if (before === model) pending.delete(agentId);
      else pending.set(agentId, { before, model, at: now() });
    },
    overlay(hostConfig) {
      if (!hostConfig || !pending.size) return hostConfig;
      let shown = hostConfig;
      for (const [agentId, write] of pending) {
        if (now() - write.at > ttlMs || chosenModel(hostConfig, agentId) !== write.before) pending.delete(agentId);
        else shown = withCompactionModel(shown, agentId, write.model);
      }
      return shown;
    },
  };
}

/**
 * Writes one chat agent's conversation compaction model through OpenClaw's
 * serialized config writer. An empty model removes the agent's choice, so the
 * shared model (or the session's own) applies again. Other per-agent
 * compaction settings, such as `maxSummaryChars`, are kept.
 * @param {object} options
 * @param {object} options.api Plugin API.
 * @param {{record: Function}} [options.pending] Store from `createPendingCompactionModels`; told about each accepted write.
 * @returns {(request: {agentId: string, model: string}) => Promise<{agentId: string, model: string}>}
 */
export function createCompactionModelMutator({ api, pending } = {}) {
  const mutateConfigFile = api?.runtime?.config?.mutateConfigFile;
  if (typeof mutateConfigFile !== "function") throw new Error("OpenClaw config mutation is unavailable");
  return async (request) => {
    if (!validChatModelRequest(request)) throw new Error("Invalid compaction model selection");
    const { agentId, model } = request;
    const running = api.runtime.config.current?.() ?? null;
    try {
      await mutateConfigFile({ afterWrite: { mode: "auto" }, mutate(draft) {
        assertCompactionModelAllowed(draft, agentId, model);
        const entry = agentEntry(draft, agentId);
        const { model: _previous, ...rest } = record(entry.compaction);
        if (model) entry.compaction = { ...rest, model };
        else if (Object.keys(rest).length) entry.compaction = rest;
        else delete entry.compaction;
        return { agentId, model };
      } });
    } catch (error) {
      if (!UNSUPPORTED_RE.test(String(error?.message ?? ""))) throw error;
      throw Object.assign(new Error("This OpenClaw version has no per-agent compaction model", { cause: error }), { code: COMPACTION_MODEL_UNSUPPORTED });
    }
    if (running) pending?.record(running, agentId, model);
    return { agentId, model };
  };
}

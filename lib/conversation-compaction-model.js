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

/**
 * Writes one chat agent's conversation compaction model through OpenClaw's
 * serialized config writer. An empty model removes the agent's choice, so the
 * shared model (or the session's own) applies again. Other per-agent
 * compaction settings, such as `maxSummaryChars`, are kept.
 * @param {object} options
 * @param {object} options.api Plugin API.
 * @returns {(request: {agentId: string, model: string}) => Promise<{agentId: string, model: string}>}
 */
export function createCompactionModelMutator({ api } = {}) {
  const mutateConfigFile = api?.runtime?.config?.mutateConfigFile;
  if (typeof mutateConfigFile !== "function") throw new Error("OpenClaw config mutation is unavailable");
  return async (request) => {
    if (!validChatModelRequest(request)) throw new Error("Invalid compaction model selection");
    const { agentId, model } = request;
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
    return { agentId, model };
  };
}

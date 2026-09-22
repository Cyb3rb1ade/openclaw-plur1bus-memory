// Chat-Modell pro Workspace: welches Modell ein Chat-Agent (Bernd, Bernhardine,
// Heisenberg — die Agenten mit Heartbeat) zum Antworten nutzt.
//
// Die Wahl steht an zwei Stellen, aus zwei Gruenden:
//   - plugins.entries.<id>.config.chatModels.<agent> haelt die Absicht fest.
//     Ein Startskript, das Agentenmodelle aus einem Profil neu schreibt, kann
//     sie dort lesen und stehen lassen (so haelt es applyPluginModels() schon
//     mit llmRouter.agentModels).
//   - agents.entries.<agent>.model.primary laesst sie sofort wirken, fuer alle
//     kuenftigen Sitzungen. Die Fallbacks bleiben unberuehrt.
// Aktive Sitzungen folgen dem Agenten nur, wenn sie nicht gepinnt sind. Deshalb
// werden ihre Pins mit derselben Host-Funktion geloest, die auch der Wechsel
// zurueck auf das Standardmodell benutzt. sessions.patch mit einem Modell waere
// der falsche Weg: es schreibt nebenbei die Agenten-Konfiguration um.

import { configuredAgentModels } from "./featureModels.js";
import { validateInput } from "./input-limits.js";

const PLUGIN_ID = "memory-lancedb-namespaced";
const AGENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$/;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
// Heartbeat-Sitzungen laufen absichtlich auf einem guenstigen Modell.
const HEARTBEAT_SESSION_RE = /:heartbeat$/;

const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const validAgentId = (value) => typeof value === "string" && AGENT_RE.test(value) && !UNSAFE_KEYS.has(value);
const validModelRef = (value) => typeof value === "string" && MODEL_RE.test(value) && value.includes("/");

function agentRecords(hostConfig) {
  const entries = record(hostConfig?.agents).entries;
  if (Array.isArray(entries)) return entries.filter((agent) => validAgentId(agent?.id));
  return Object.entries(record(entries)).filter(([id]) => validAgentId(id)).map(([id, agent]) => ({ ...record(agent), id }));
}

function isChatAgent(agent) {
  return agent?.heartbeat === true || (agent?.heartbeat && typeof agent.heartbeat === "object");
}

/**
 * Splits `provider/model` at the first slash; nested model ids keep theirs.
 * @param {string} ref Model reference.
 * @returns {{provider: string, model: string}|null}
 */
export function splitModelRef(ref) {
  if (!validModelRef(ref)) return null;
  const index = ref.indexOf("/");
  return { provider: ref.slice(0, index), model: ref.slice(index + 1) };
}

/**
 * Models one agent may chat with: known to it and admitted by modelPolicy.allow.
 * An absent allow list, or one containing "*", admits every known model.
 * @param {object} hostConfig OpenClaw config.
 * @param {string} agentId Agent id.
 * @returns {Array<{id: string, label: string}>}
 */
export function chatModelOptions(hostConfig, agentId) {
  const agent = configuredAgentModels(hostConfig).find((entry) => entry.id === agentId);
  if (!agent) return [];
  const allow = record(record(record(hostConfig?.agents).defaults).modelPolicy).allow;
  const open = !Array.isArray(allow) || allow.includes("*");
  return agent.models.filter((model) => open || allow.includes(model.id));
}

/**
 * Dashboard projection: one row per chat agent, without credentials.
 * @param {object} config PLUR1BUS config.
 * @param {object} hostConfig OpenClaw config.
 * @returns {{agents: Array<object>}}
 */
export function projectChatModels(config = {}, hostConfig = {}) {
  const choices = record(config?.chatModels);
  const running = new Map(configuredAgentModels(hostConfig).map((agent) => [agent.id, agent]));
  return {
    agents: agentRecords(hostConfig).filter(isChatAgent).map((agent) => ({
      id: agent.id,
      label: running.get(agent.id)?.label ?? agent.id,
      running: running.get(agent.id)?.defaultModel ?? "",
      chosen: validModelRef(choices[agent.id]) ? choices[agent.id] : "",
      models: chatModelOptions(hostConfig, agent.id),
    })),
  };
}

/**
 * Shape check for untrusted form input. An empty model removes the choice.
 * @param {{agentId?: unknown, model?: unknown}} request
 * @returns {boolean}
 */
export function validChatModelRequest(request = {}) {
  if (typeof request.agentId !== "string" || typeof request.model !== "string") return false;
  if (!validateInput(request.agentId, { maxLength: 64, required: true, name: "agent" }).ok) return false;
  if (!validateInput(request.model, { maxLength: 256, required: false, name: "model" }).ok) return false;
  return validAgentId(request.agentId) && (request.model === "" || validModelRef(request.model));
}

function writeAgentPrimary(draft, agentId, model) {
  const agents = draft.agents;
  const entries = agents?.entries;
  const target = Array.isArray(entries)
    ? entries.find((agent) => agent?.id === agentId)
    : record(entries)[agentId];
  if (!target || typeof target !== "object") throw new Error(`Agent ${agentId} is not configured`);
  const current = target.model;
  // A bare string model has no fallbacks to keep; an object keeps them.
  target.model = current && typeof current === "object" && !Array.isArray(current)
    ? { ...current, primary: model }
    : { primary: model };
}

async function releaseSessionPins({ api, agentId, model, loadModelSession, logger }) {
  const session = api?.runtime?.agent?.session;
  if (typeof session?.listSessionEntries !== "function" || typeof session?.patchSessionEntry !== "function") return 0;
  const selection = { ...splitModelRef(model), isDefault: true };
  let modelSession;
  try {
    modelSession = await loadModelSession();
  } catch (error) {
    logger?.warn?.(`chat-model: session release unavailable, active sessions keep their pins until their next model change: ${error?.message || error}`);
    return 0;
  }
  if (typeof modelSession?.applyModelOverrideToSessionEntry !== "function") return 0;
  const locked = typeof modelSession.isModelSelectionLocked === "function" ? modelSession.isModelSelectionLocked : () => false;

  let released = 0;
  for (const { sessionKey, entry } of session.listSessionEntries({ agentId }) ?? []) {
    if (typeof sessionKey !== "string" || HEARTBEAT_SESSION_RE.test(sessionKey)) continue;
    if (!entry || locked(entry)) continue;
    // Probe on a copy first: a session with nothing to release costs no write.
    if (modelSession.applyModelOverrideToSessionEntry({ entry: { ...entry }, selection }).updated !== true) continue;
    try {
      let changed = false;
      await session.patchSessionEntry({
        agentId,
        sessionKey,
        replaceEntry: true,
        preserveActivity: true,
        update(current) {
          if (locked(current)) return null;
          const next = { ...current };
          changed = modelSession.applyModelOverrideToSessionEntry({ entry: next, selection }).updated === true;
          return changed ? next : null;
        },
      });
      if (changed) released += 1;
    } catch (error) {
      logger?.warn?.(`chat-model: could not release session ${sessionKey}: ${error?.message || error}`);
    }
  }
  return released;
}

/**
 * Writes one chat agent's model through OpenClaw's serialized config writer,
 * then releases that agent's session pins so active sessions follow.
 * @param {object} options
 * @param {object} options.api Plugin API.
 * @param {() => Promise<object>} options.loadModelSession Loads openclaw/plugin-sdk/model-session-runtime.
 * @param {string} [options.pluginId]
 * @returns {(request: {agentId: string, model: string}) => Promise<{agentId: string, model: string, releasedSessions: number}>}
 */
export function createChatModelMutator({ api, loadModelSession, pluginId = PLUGIN_ID } = {}) {
  const mutateConfigFile = api?.runtime?.config?.mutateConfigFile;
  if (typeof mutateConfigFile !== "function") throw new Error("OpenClaw config mutation is unavailable");
  return async (request) => {
    if (!validChatModelRequest(request)) throw new Error("Invalid chat model selection");
    const { agentId, model } = request;
    await mutateConfigFile({ afterWrite: { mode: "auto" }, mutate(draft) {
      const agent = agentRecords(draft).find((entry) => entry.id === agentId);
      if (!agent || !isChatAgent(agent)) throw new Error(`${agentId} is not a chat agent`);
      if (model && !chatModelOptions(draft, agentId).some((option) => option.id === model)) {
        throw new Error(`${model} is not allowed for ${agentId}`);
      }
      const entry = draft?.plugins?.entries?.[pluginId];
      if (!entry || typeof entry !== "object") throw new Error("Active PLUR1BUS config entry is unavailable");
      const config = record(entry.config);
      const chatModels = { ...record(config.chatModels) };
      if (model) chatModels[agentId] = model;
      else delete chatModels[agentId];
      const { chatModels: _previous, ...rest } = config;
      entry.config = Object.keys(chatModels).length ? { ...rest, chatModels } : rest;
      // Reset only drops the intent. The running primary stays until the next
      // start, when the model profile puts its own default back.
      if (model) writeAgentPrimary(draft, agentId, model);
      return { agentId, model };
    } });
    const releasedSessions = model
      ? await releaseSessionPins({ api, agentId, model, loadModelSession, logger: api?.logger })
      : 0;
    return { agentId, model, releasedSessions };
  };
}

import { validateInput } from "./input-limits.js";

const AGENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$/;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** LLM tasks, their dashboard cards, and existing feature-local fallback config. */
export const FEATURE_MODEL_DEFINITIONS = Object.freeze([
  ["merging", "merging", "Merge decisions", ["merging"]],
  ["capture-summary", "capture", "Capture summary", []],
  ["recall-query-summary", "recall", "Query summary", []],
  ["memory-compaction", "daily-consolidation", "Memory compaction", []],
  ["conflict-resolution", "daily-consolidation", "Conflict resolution", []],
  ["rem-pattern-analysis", "rem", "Pattern analysis", []],
  ["conversation-insights", "neo", "Conversation insights", []],
  ["dream-narrative", "rem", "Dream narrative", []],
  ["dream-echo", "dream-echo", "Dream echo", []],
  ["episode-extraction", "capture", "Episode extraction", []],
  ["afterthought", "afterthought", "Afterthought", ["afterthought"]],
  ["persona-voice", "persona-voice", "Persona voice", ["personaVoice"]],
  ["wiki", "obsidian", "Wiki answer synthesis", []],
  ["continuity-overlay", "continuity", "Continuity overlay", ["continuityEngine", "overlays"]],
  ["overlay-audit-contradiction", "continuity", "Overlay contradiction audit", []],
  ["memory-text-contradiction", "contradiction", "Memory contradiction check", []],
  ["emotionT3", "emotion-t3", "Emotion analysis", ["emotion", "t3"]],
  ["emotion-encoding", "emotion-t3", "Memory importance / encoding", ["emotion", "t3"]],
  ["schicht15", "knowledge-promotion", "Knowledge promotion", ["schicht15"]],
  ["skillMiner", "skill-miner", "Skill extraction", ["skillMiner"]],
  ["criticalPush", "critical-push", "Critical classification", ["criticalPush"]],
].map(([id, card, label, path]) => Object.freeze({ id, card, label, path: Object.freeze(path) })));

const FEATURE_IDS = new Set(FEATURE_MODEL_DEFINITIONS.map(({ id }) => id));
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const own = (value, key) => Object.hasOwn(record(value), key) ? value[key] : undefined;
const modelId = (value) => typeof value === "string" && MODEL_RE.test(value) ? value : null;
const agentId = (value) => typeof value === "string" && AGENT_RE.test(value) && !UNSAFE_KEYS.has(value) ? value : null;
const primary = (model) => typeof model === "string" ? model : record(model).primary;

/**
 * List explicitly configured models, inheriting defaults and agent-local aliases.
 * @param {object} hostConfig OpenClaw config, never returned to the browser.
 * @returns {Array<object>} Agent IDs, names, default models and safe model choices.
 */
export function configuredAgentModels(hostConfig = {}) {
  const agents = record(hostConfig.agents);
  const defaults = record(agents.defaults);
  const listed = Array.isArray(agents.list) ? agents.list : [];
  const known = listed.length ? listed : [{ id: "main" }];
  const seen = new Set();
  return known.filter((agent) => {
    if (!agentId(agent?.id) || seen.has(agent.id)) return false;
    seen.add(agent.id);
    return true;
  }).map((agent) => {
    const choices = new Map();
    const aliases = new Map();
    for (const models of [defaults.models, agent.models]) {
      for (const [id, metadata] of Object.entries(record(models))) {
        if (!modelId(id) || !id.includes("/")) continue; // Only concrete provider/model refs.
        const alias = record(metadata).alias;
        const previousLabel = choices.get(id)?.label;
        if (Object.hasOwn(record(metadata), "alias")) {
          if (previousLabel && aliases.get(previousLabel.toLowerCase()) === id) aliases.delete(previousLabel.toLowerCase());
          const label = typeof alias === "string" && alias.trim() ? alias.trim().slice(0, 160) : id;
          choices.set(id, { id, label });
          if (label !== id) aliases.set(label.toLowerCase(), id);
        } else {
          choices.set(id, { id, label: previousLabel || id });
        }
      }
    }
    const resolveModel = (value) => {
      const id = modelId(value);
      return id?.includes("/") ? id : typeof value === "string" ? aliases.get(value.trim().toLowerCase()) || null : null;
    };
    const defaultModel = resolveModel(primary(agent.model)) || resolveModel(primary(defaults.model));
    const fallbacks = record(agent.model).fallbacks ?? record(defaults.model).fallbacks;
    for (const value of [defaultModel, ...(Array.isArray(fallbacks) ? fallbacks : [])]) {
      const id = resolveModel(value);
      if (id && !choices.has(id)) choices.set(id, { id, label: id });
    }
    return { id: agent.id, label: typeof agent.name === "string" ? agent.name.slice(0, 160) : agent.id, defaultModel, models: [...choices.values()] };
  });
}

/**
 * Collect immutable per-agent overrides for one runtime route.
 * @param {object} config PLUR1BUS config.
 * @param {string} feature Registered LLM task.
 * @returns {Readonly<object>} Agent-to-model map.
 */
export function featureModelOverrides(config, feature) {
  if (!FEATURE_IDS.has(feature)) return Object.freeze({});
  return Object.freeze(Object.fromEntries(Object.entries(record(config?.llmRouter?.agentModels))
    .filter(([id, models]) => agentId(id) && modelId(own(models, feature)))
    .map(([id, models]) => [id, models[feature]])));
}

/**
 * Project model controls without credentials, endpoints or arbitrary host metadata.
 * @param {object} config PLUR1BUS config.
 * @param {object} hostConfig OpenClaw config.
 * @returns {object} Safe agent-specific feature choices and inherited routes.
 */
export function projectFeatureModels(config = {}, hostConfig = {}) {
  const policy = record(hostConfig.plugins?.entries?.["memory-lancedb-namespaced"]?.llm);
  return { agents: configuredAgentModels(hostConfig).map((agent) => ({
    ...agent,
    models: agent.models.map((model) => ({ ...model, requiresPermission: policy.allowModelOverride !== true
      || [policy.allowedModels, policy.allowedCompletionModels].some((list) => Array.isArray(list) && !list.includes("*") && !list.includes(model.id)) })),
    features: FEATURE_MODEL_DEFINITIONS.map((definition) => {
      const local = definition.path.length ? record(definition.path.reduce((value, key) => own(value, key), config)) : {};
      const direct = Boolean(local.baseUrl || local.apiKey || Object.keys(record(local.headers)).length);
      const inheritedModel = modelId(local.model) || (direct ? null : modelId(config.llmRouter?.defaultModel) || agent.defaultModel);
      return {
        id: definition.id, card: definition.card, label: definition.label,
        model: modelId(own(own(config.llmRouter?.agentModels, agent.id), definition.id)) || "",
        inheritedModel, direct,
      };
    }),
  })) };
}

/**
 * Validate untrusted dashboard input without truncation or implicit coercion.
 * @param {object} request Agent, feature and model (empty resets the override).
 * @returns {boolean} Whether the request has a supported shape.
 */
export function validFeatureModelRequest(request = {}) {
  return [[request.agentId, 64, true], [request.feature, 64, true], [request.model, 256, false]]
    .every(([value, maxLength, required]) => typeof value === "string" && validateInput(value, { maxLength, required, name: "model selection" }).ok)
    && Boolean(agentId(request.agentId)) && FEATURE_IDS.has(request.feature)
    && (request.model === "" || Boolean(modelId(request.model)));
}

/**
 * Persist an agent's model choice through OpenClaw's serialized config writer.
 * @param {object} options Host API and optional plugin ID.
 * @returns {Function} Async, revalidated model selection writer.
 */
export function createFeatureModelMutator({ api, pluginId = "memory-lancedb-namespaced" } = {}) {
  const mutateConfigFile = api?.runtime?.config?.mutateConfigFile;
  if (typeof mutateConfigFile !== "function") throw new Error("OpenClaw config mutation is unavailable");
  return async (request) => {
    if (!validFeatureModelRequest(request)) throw new Error("Invalid feature model selection");
    return mutateConfigFile({ afterWrite: { mode: "auto" }, mutate(draft) {
      const { agentId: id, feature, model } = request;
      const agent = configuredAgentModels(draft).find((entry) => entry.id === id);
      if (!agent || (model && !agent.models.some((entry) => entry.id === model))) throw new Error("Model is no longer configured for this agent");
      const entry = draft?.plugins?.entries?.[pluginId];
      if (!entry || typeof entry !== "object") throw new Error("Active PLUR1BUS config entry is unavailable");
      const config = record(entry.config);
      const router = record(config.llmRouter);
      const agentModels = { ...record(router.agentModels) };
      const models = { ...record(own(agentModels, id)) };
      if (model) models[feature] = model;
      else delete models[feature];
      if (Object.keys(models).length) agentModels[id] = models;
      else delete agentModels[id];
      // Only an explicit non-default selection grants permission, never a
      // config read, upgrade or reset. Preserve other trust bits and append
      // only this model to existing restrictive lists.
      if (model) {
        const policy = record(entry.llm);
        const nextPolicy = { ...policy, allowModelOverride: true };
        for (const key of ["allowedModels", "allowedCompletionModels"]) {
          const list = policy[key];
          if (list !== undefined && !Array.isArray(list)) throw new Error("Invalid plugin model permissions");
          if (Array.isArray(list) && !list.includes("*") && !list.includes(model)) nextPolicy[key] = [...list, model];
        }
        if (policy.allowModelOverride !== true && policy.allowedModels === undefined) nextPolicy.allowedModels = [model];
        entry.llm = nextPolicy;
      }
      entry.config = { ...config, llmRouter: { ...router, agentModels } };
      return { agentId: id, feature, model };
    } });
  };
}

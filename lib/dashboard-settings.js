import { readFileSync, statSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { FEATURE_DEFINITIONS } from "./feature-definitions.js";
import { resolveEffectiveConfig } from "./setup/config-contract.js";

// Every switch the operator tab may write, in one closed table. A feature
// toggle is just a boolean setting whose path comes from FEATURE_DEFINITIONS,
// so toggles and operator decisions share one action, one validator, one
// mutator and one renderer. Anything not listed here cannot be written from
// the page, whatever the form says.
//
// Deliberately absent: `dreaming.enabled` (the memory-core sidecar switch,
// which the projection comments say must stay off), `controlUi.writeActions`
// (the gate itself), `security.*` and `featureCronSetup.auto` (install-time),
// and every threshold somebody measured once — a slider invites fiddling.

// decisionTrace (trace.enabled) and semanticCompression (semanticCompression.enabled)
// read paths the config schema does not declare; the validator would refuse
// every write, so they are not offered. The projection still shows their state.
const TOGGLE_EXCLUDED = new Set(["dreamingSidecarCompat", "decisionTrace", "semanticCompression"]);

// Card per feature name, mirrored from FEATURE_CARD_DEFINITIONS so a toggle
// lands on the card that shows its state. "neo" has two cards; the toggle
// goes on the Neo Layer card.
const FEATURE_CARDS = Object.freeze({
  autoCapture: "capture", autoRecall: "recall", skillMiner: "skill-miner", featureCronSetup: "feature-cron",
  neo: "neo", obsidianBridge: "obsidian", reranker: "reranker", merging: "merging",
  dailyConsolidation: "daily-consolidation", garbageCollection: "gc", emotionTier3: "emotion-t3",
  knowledgePromotion: "knowledge-promotion", criticalPush: "critical-push", afterthought: "afterthought",
  personaVoice: "persona-voice", dreamEcho: "dream-echo", continuityEngine: "continuity",
  replyOutcomeTracking: "reply-outcome", contradictionDisclosure: "contradiction", semanticLens: "semantic-lens",
  queryRefinement: "query-refinement", decisionTrace: "decision-trace", semanticCompression: "semantic-compression",
  metaCognition: "meta-cognition", temporalContext: "temporal-context",
  conversationReactivationRecall: "reactivation", reactionNudge: "reaction-nudge",
  morningReview: "morning-review", eveningReview: "evening-review",
});

const TOGGLES = FEATURE_DEFINITIONS
  .filter((definition) => !TOGGLE_EXCLUDED.has(definition.name) && FEATURE_CARDS[definition.name])
  .map((definition) => ({
    id: `feature.${definition.name}`,
    path: definition.path,
    card: FEATURE_CARDS[definition.name],
    label: "Enabled",
    type: definition.name === "reactionNudge" ? "enum" : "boolean",
    values: definition.name === "reactionNudge" ? ["auto", true, false] : [true, false],
    defaultValue: definition.name === "reactionNudge" ? "auto" : definition.defaultValue,
    hint: definition.name === "reactionNudge"
      ? "auto follows the channel's reaction support."
      : ["conversationReactivationRecall", "morningReview", "eveningReview"].includes(definition.name)
        ? "Off by default, unlike most features."
        : "",
  }));

const DECISIONS = [
  ["schicht15.maxPromotionsPerRun", "knowledge-promotion", "Promotions per run", "number", { min: 0, max: 1000, integer: true, defaultValue: 0 },
    "KNOWLEDGE.md promotions per 24-hour window; 0 is unlimited. A low cap once blocked every promotion for weeks."],
  ["skillMiner.autoApply", "skill-miner", "Auto-apply", "enum", { values: ["host", "on", "off"], defaultValue: "host" },
    "host follows skills.workshop.autonomous.mode; on applies every mined skill; off keeps them all pending here."],
  ["merging.autoApply", "merging", "Auto-apply merges", "boolean", { defaultValue: false },
    "Apply low-risk merge decisions without review. A backup is kept before each apply."],
  ["gc.maxMemoryCount", "gc", "Memory cap per agent", "number", { min: 1, max: 10_000_000, integer: true, guard: "gc" },
    "Active rows per agent before the weakest are archived. A value below the largest current count is refused."],
  // Recall width. Both are operator decisions, not measured thresholds: the
  // LOCOMO runs of 20.09.2026 reached 89.2 % evidence coverage at 15 memories
  // drawn from 40 candidates, and never measured another point in the field.
  // The ceiling of 100 is the pipeline's own (recall-pipeline.js
  // hardCandidateLimit); a higher number here would not reach the search.
  ["recall.candidateTopK", "recall", "Candidates per recall", "number", { min: 5, max: 100, integer: true, defaultValue: 40 },
    "Rows the vector search fetches before ranking. The reranker picks the prompt set from these, so a wider field gives it more to choose from and costs reranking time, not context."],
  ["recall.maxPromptMemories", "recall", "Memories per prompt", "number", { min: 5, max: 100, integer: true, defaultValue: 12 },
    "Memories that reach the prompt once ranking is done. Past roughly 17000 characters the inject budget truncates the memory block, so high values buy less than they promise."],
  ["llmRouter.errorDiagnostics", "neo", "LLM error diagnostics", "boolean", { defaultValue: false },
    "Writes the redacted message of each failed model call to llm-router-errors.log. The message can contain prompt fragments; switch on only while debugging."],
  ["criticalPush.maxPerDay", "critical-push", "Pushes per day", "number", { min: 0, max: 100, integer: true, defaultValue: 3 },
    "Urgent findings pushed to the operator per day."],
  ["styleDirective.timeOfDay", "style-directive", "Time of day", "boolean", { defaultValue: true }, "Lets the reply reflect the current time of day."],
  ["styleDirective.opinion", "style-directive", "Opinion", "boolean", { defaultValue: true }, "Allows a stated opinion where one is warranted."],
  ["styleDirective.askBack", "style-directive", "Ask back", "boolean", { defaultValue: true }, "Allows a follow-up question instead of a guess."],
  ["continuityEngine.associativeRecall.enabled", "continuity", "Associative recall", "boolean", { defaultValue: true }, "Follows links between memories during recall."],
  ["continuityEngine.patternSurfacing.enabled", "continuity", "Pattern surfacing", "boolean", { defaultValue: false }, "Mentions recurring patterns in the reply."],
  ["continuityEngine.tasteGate.enabled", "continuity", "Taste gate", "boolean", { defaultValue: true }, "Limits associations per session to the best-matching ones."],
  ["continuityEngine.overlays.enabled", "continuity", "Overlays", "boolean", { defaultValue: true }, "Adds the continuity overlay to the prompt."],
  ["continuityEngine.contradictionDetection.enabled", "continuity", "Contradiction detection", "boolean", { defaultValue: false }, "Checks overlays against each other."],
  ["continuityEngine.doctor.enabled", "continuity", "Doctor", "boolean", { defaultValue: false }, "Self-check of the continuity graph."],
  ["dreaming.narrative.enabled", "rem", "Dream narrative", "boolean", { defaultValue: true }, "Writes a narrative from each consolidation."],
  ["dreaming.narrative.diary", "rem", "Dream diary", "boolean", { defaultValue: true }, "Appends each narrative to the agent's DREAMS.md."],
  ["dreaming.narrative.storeAsMemory", "rem", "Store narrative", "boolean", { defaultValue: true }, "Keeps each narrative as a memory of its own."],
  ["memoryDynamics.flashbulbEncoding", "emotion-t3", "Flashbulb encoding", "boolean", { defaultValue: false }, "Near-permanent strength for highly emotional memories."],
  ["llmRouter.defaultModel", "llm-tasks", "Default model for all agents", "model", {},
    "What every task uses when neither the agent nor the task has a choice. Saving a model the plugin's permissions do not yet allow grants exactly that model."],
].map(([id, card, label, type, spec, hint]) => ({
  id, path: Object.freeze(id.split(".")), card, label, type, hint,
  values: spec.values ? Object.freeze(spec.values) : type === "boolean" ? Object.freeze([true, false]) : undefined,
  min: spec.min, max: spec.max, integer: spec.integer === true, guard: spec.guard, defaultValue: spec.defaultValue,
}));

export const DASHBOARD_SETTINGS = Object.freeze([...TOGGLES, ...DECISIONS].map((setting) => Object.freeze(setting)));
const BY_ID = new Map(DASHBOARD_SETTINGS.map((setting) => [setting.id, setting]));
const SETTING_ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const UNSAFE = new Set(["__proto__", "prototype", "constructor"]);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$/;

const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

/** Resolve one setting by its closed id. */
export function dashboardSetting(id) {
  return typeof id === "string" && SETTING_ID_RE.test(id) ? BY_ID.get(id) || null : null;
}

function getPath(config, path) {
  let node = config;
  for (const key of path) {
    if (!node || typeof node !== "object" || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/**
 * The value the running config expresses for a setting, or its default.
 * Toggles follow the projection's rule: only an explicit false is off.
 */
export function settingValue(config, setting) {
  const raw = getPath(config, setting.path);
  if (setting.id.startsWith("feature.")) {
    if (setting.type === "enum") return raw === true || raw === false || raw === "auto" ? raw : setting.defaultValue;
    return raw === undefined ? setting.defaultValue : raw !== false;
  }
  if (setting.type === "number") return typeof raw === "number" && Number.isFinite(raw) ? raw : setting.defaultValue ?? null;
  if (setting.type === "model") return typeof raw === "string" && MODEL_RE.test(raw) ? raw : "";
  if (setting.type === "boolean") return typeof raw === "boolean" ? raw : setting.defaultValue;
  return setting.values.includes(raw) ? raw : setting.defaultValue;
}

/**
 * Parse an untrusted form value against one setting. Returns { ok, value }
 * so a wrong value never turns into a write.
 */
export function parseSettingValue(setting, raw) {
  if (!setting || typeof raw !== "string" || raw.length > 256) return { ok: false };
  const text = raw.trim();
  // An empty model removes the default; a model name is only checked for shape
  // here — the mutator checks it against the host's catalogue.
  if (setting.type === "model") return text === "" || MODEL_RE.test(text) ? { ok: true, value: text } : { ok: false };
  if (text.length > 64) return { ok: false };
  if (setting.type === "number") {
    if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false };
    const value = Number(text);
    if (!Number.isFinite(value)) return { ok: false };
    if (setting.integer && !Number.isInteger(value)) return { ok: false };
    if (setting.min !== undefined && value < setting.min) return { ok: false };
    if (setting.max !== undefined && value > setting.max) return { ok: false };
    return { ok: true, value };
  }
  const match = setting.values.find((candidate) => String(candidate) === text);
  return match === undefined ? { ok: false } : { ok: true, value: match };
}

/** Settings grouped by card for the renderer, values only — never the whole config. */
export function projectDashboardSettings(config = {}) {
  const byCard = {};
  for (const setting of DASHBOARD_SETTINGS) {
    (byCard[setting.card] ||= []).push({
      id: setting.id, label: setting.label, hint: setting.hint, type: setting.type,
      value: settingValue(config, setting),
      values: setting.values ? [...setting.values] : undefined,
      min: setting.min, max: setting.max,
    });
  }
  return { byCard };
}

function assign(config, path, value) {
  const next = { ...record(config) };
  let node = next;
  for (const key of path.slice(0, -1)) {
    if (UNSAFE.has(key)) throw new Error("Invalid setting path");
    node[key] = { ...record(node[key]) };
    node = node[key];
  }
  const last = path[path.length - 1];
  if (UNSAFE.has(last)) throw new Error("Invalid setting path");
  node[last] = value;
  return next;
}

function remove(config, path) {
  const next = { ...record(config) };
  let node = next;
  for (const key of path.slice(0, -1)) {
    if (!record(node[key]) || !Object.hasOwn(node, key)) return next;
    node[key] = { ...record(node[key]) };
    node = node[key];
  }
  delete node[path[path.length - 1]];
  return next;
}

/**
 * Persist one setting through OpenClaw's serialized config writer.
 * `validate` (resolveEffectiveConfig) runs on the result before the write so a
 * value the schema rejects never reaches openclaw.json — a bad write there
 * has blocked a gateway start before. `maxAgentCards` feeds the gc guard.
 */
export function createSettingMutator({ api, pluginId = "memory-lancedb-namespaced", validate, maxAgentCards, modelCatalog, grantModel } = {}) {
  const mutateConfigFile = api?.runtime?.config?.mutateConfigFile;
  if (typeof mutateConfigFile !== "function") throw new Error("OpenClaw mutateConfigFile capability is required for the settings switch");
  if (typeof validate !== "function") throw new Error("a config validator is required for the settings switch");
  return async ({ id, value: raw }) => {
    const setting = dashboardSetting(id);
    const parsed = parseSettingValue(setting, raw);
    if (!setting || !parsed.ok) throw new Error("Invalid setting");
    if (setting.guard === "gc") {
      const largest = typeof maxAgentCards === "function" ? await maxAgentCards() : null;
      if (!Number.isSafeInteger(largest) || largest < 0) {
        const error = new Error("refused: current agent counts are unavailable; refresh health before changing the GC cap");
        error.code = "denied_unknown_count";
        throw error;
      }
      if (parsed.value < largest) {
        const error = new Error(`refused: ${parsed.value} is below the largest current count (${largest})`);
        error.code = "denied_value";
        throw error;
      }
    }
    return mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate(draft) {
        const entry = draft?.plugins?.entries?.[pluginId];
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("active PLUR1BUS config entry is unavailable");
        if (setting.type === "model" && parsed.value) {
          // Re-checked inside the mutation against the draft, like a task choice.
          const catalogue = typeof modelCatalog === "function" ? modelCatalog(draft) : null;
          if (!catalogue || !catalogue.has(parsed.value)) throw new Error("Model is no longer configured on this host");
          if (typeof grantModel === "function") grantModel(entry, parsed.value);
        }
        // An empty model means "no default": remove the key instead of writing "".
        const next = setting.type === "model" && !parsed.value ? remove(entry.config, setting.path) : assign(entry.config, setting.path, parsed.value);
        validate(next); // throws on a schema violation; nothing has been written yet
        entry.config = next;
        return Object.freeze({ id: setting.id, value: parsed.value });
      },
    });
  };
}

/**
 * Return the largest store the gc job would prune, or unknown.
 *
 * Deliberately *not* derived from `cards.byAgent`: that list follows the public
 * id contract, which both hides stores gc prunes (`_neo`, `_customer`) and
 * shows stores gc ignores (`agent.v2`). The health scan counts gc's own set and
 * publishes the maximum, withdrawing it to null as soon as one of those counts
 * is missing — absence leaves no row behind to inspect. Anything but a usable
 * count is unknown, so a layer that drops the number refuses rather than
 * permits.
 */
export function largestKnownAgentCount(snapshot) {
  const largest = snapshot?.cards?.largestAgentCards;
  return Number.isSafeInteger(largest) && largest >= 0 ? largest : null;
}

// ---------------------------------------------------------------------------
// Saved vs. running. A dashboard write lands in openclaw.json at once, but
// the plugin only sees it after the host has reloaded it — a minute or so,
// and on this host the reload can also fail and roll back. Without a marker
// the page keeps rendering the old value and the operator clicks again. The
// plugin gets no file reader from the host, so it resolves the path the way
// the host does and reads exactly one subtree.
// ---------------------------------------------------------------------------

const HOST_CONFIG_FILE = "openclaw.json";

/** Where the host keeps its config: the same precedence the CLI uses. */
export function resolveHostConfigPath(env = process.env, homedir = osHomedir()) {
  const explicit = typeof env.OPENCLAW_CONFIG_PATH === "string" && env.OPENCLAW_CONFIG_PATH.trim();
  if (explicit) return explicit;
  const stateDir = typeof env.OPENCLAW_STATE_DIR === "string" && env.OPENCLAW_STATE_DIR.trim();
  if (stateDir) return join(stateDir, HOST_CONFIG_FILE);
  const home = typeof env.OPENCLAW_HOME === "string" && env.OPENCLAW_HOME.trim();
  return join(home || join(homedir, ".openclaw"), HOST_CONFIG_FILE);
}

/**
 * The plugin's config subtree as it stands in the file, plus the file's
 * modification time. Never throws: a missing or unreadable file is a status,
 * not a 503. Only `plugins.entries.<id>.config` leaves this function — the
 * file also holds API keys.
 *
 * The subtree is normalized exactly like the running config. Without that,
 * every comparison drowns in schema defaults: the running config carries
 * `merging.enabled: false` from the schema while the file says nothing, and
 * the two sides disagree on keys nobody touched. A file the schema rejects
 * cannot be compared at all and counts as unreadable.
 * @returns {{status:"ok"|"missing"|"unreadable", config:object|null, mtimeMs:number|null, path:string}}
 */
export function readPluginConfigFile({ env = process.env, homedir = osHomedir(), pluginId = "memory-lancedb-namespaced", path = null } = {}) {
  const file = path || resolveHostConfigPath(env, homedir);
  let mtimeMs = null;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return { status: "missing", config: null, mtimeMs: null, path: file };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const entry = parsed?.plugins?.entries?.[pluginId];
    const raw = entry && typeof entry === "object" && !Array.isArray(entry) ? record(entry.config) : {};
    return { status: "ok", config: resolveEffectiveConfig(raw), mtimeMs, path: file };
  } catch {
    return { status: "unreadable", config: null, mtimeMs, path: file };
  }
}

const MODEL_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Which dashboard-writable values differ between the running config and the
 * file. Compared on the allowlist only: every DASHBOARD_SETTINGS entry (via
 * settingValue on both sides), the storage mode, the host-wide default model
 * and each llmRouter.agentModels cell. Returns ids the renderer can mark:
 * setting ids, "capture.chunking", "model:<agent>.<task>".
 * @param {object} running Effective running config.
 * @param {object|null} file Config subtree from the file (null = unknown).
 * @returns {Set<string>}
 */
export function pendingChanges(running = {}, file = null) {
  const out = new Set();
  if (!file || typeof file !== "object") return out;
  for (const setting of DASHBOARD_SETTINGS) {
    if (settingValue(running, setting) !== settingValue(file, setting)) out.add(setting.id);
  }
  const mode = (config) => (config?.captureChunking === false ? "ganz" : config?.captureChunkingMode === "geteilt" ? "geteilt" : "beides");
  if (mode(running) !== mode(file)) out.add("capture.chunking");
  const cells = (config) => {
    const map = new Map();
    for (const [agent, models] of Object.entries(record(config?.llmRouter?.agentModels))) {
      if (!MODEL_KEY_RE.test(agent) || !models || typeof models !== "object") continue;
      for (const [task, model] of Object.entries(models)) {
        if (typeof model === "string" && (MODEL_KEY_RE.test(task) || task === "*")) map.set(`${agent}.${task}`, model);
      }
    }
    return map;
  };
  const a = cells(running); const b = cells(file);
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(key) !== b.get(key)) out.add(`model:${key}`);
  }
  return out;
}

/**
 * Projection of the saved-vs-running state: ids only, never values.
 * @param {object} running Effective running config.
 * @param {{status:string, config:object|null, mtimeMs:number|null}|null} fileState
 */
export function projectPendingChanges(running = {}, fileState = null) {
  if (!fileState || typeof fileState !== "object") return { status: "unknown", ids: [], count: 0, savedAt: null };
  if (fileState.status !== "ok") return { status: fileState.status, ids: [], count: 0, savedAt: fileState.mtimeMs ?? null };
  const ids = [...pendingChanges(running, fileState.config)].sort();
  return { status: "ok", ids, count: ids.length, savedAt: fileState.mtimeMs ?? null };
}

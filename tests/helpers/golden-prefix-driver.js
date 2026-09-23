/**
 * tests/helpers/golden-prefix-driver.js
 *
 * Runs one golden-prefix scenario through the real `before_prompt_build`
 * handler with a stub OpenClaw `api`, a frozen clock and a deterministic
 * embedding provider. No network, no model download, no write outside
 * os.tmpdir(). The string it returns is the exact `prependContext` the model
 * would have seen.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin, { MemoryDB } from "../../index.js";
import { LocalTransformersEmbeddingProvider } from "../../lib/providers/embedding-local-transformers.js";

/** 2026-01-15T12:00:00Z — every scenario is evaluated at this instant. */
export const FROZEN_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** intfloat/multilingual-e5-small is fixed at 384 dims; the config contract
 *  rejects any other value (lib/providers/config-normalize.js:27). */
export const VECTOR_DIM = 384;

/**
 * Replace globalThis.Date with a frozen subclass. `Date.now()` and `new Date()`
 * return `now`; every other static (UTC, parse) is inherited.
 * @param {number} [now]
 * @returns {() => void} restore function
 */
export function freezeClock(now = FROZEN_NOW) {
  const RealDate = globalThis.Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() { return now; }
  }
  globalThis.Date = FrozenDate;
  return () => { globalThis.Date = RealDate; };
}

/**
 * One topic -> one unit vector on one axis. Two texts with the same topic get
 * distance 0; two texts with different topics get distance sqrt(2).
 * @param {string} topic
 * @returns {number[]}
 */
export function topicVector(topic) {
  const digest = createHash("sha256").update(String(topic)).digest();
  const axis = ((digest[0] << 8) | digest[1]) % VECTOR_DIM;
  const out = new Array(VECTOR_DIM).fill(0);
  out[axis] = 1;
  return out;
}

function stubEmbedder(topicOf) {
  const proto = LocalTransformersEmbeddingProvider.prototype;
  const originalQuery = proto.embedQuery;
  const originalPassage = proto.embedPassage;
  proto.embedQuery = async (text) => topicVector(topicOf(text));
  proto.embedPassage = async (text) => topicVector(topicOf(text));
  return () => { proto.embedQuery = originalQuery; proto.embedPassage = originalPassage; };
}

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) { return { baseSessionKey: value, threadId: "" }; },
  normalizeOptionalAccountId(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
  normalizeMessageChannel(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
});

function makeApi(pluginConfig) {
  const handlers = new Map();
  const noop = () => {};
  return {
    pluginConfig,
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    resolvePath: (value) => value,
    registerCommand: noop,
    registerTool(factory) { this.toolFactory = factory; },
    registerService: noop,
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
      return { dispose: noop };
    },
    handlers,
  };
}

/**
 * Every feature that would reach the network, a model file or a background
 * scheduler is off. Scenario `config` is merged on top.
 * @param {string} baseDbPath
 * @param {object} [overrides]
 */
export function baseConfig(baseDbPath, overrides = {}) {
  return {
    baseDbPath,
    embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
    autoCapture: false,
    autoRecall: true,
    merging: { enabled: false },
    duplicateThreshold: 0.9999,
    obsidianBridge: { enabled: false },
    neo: { enabled: false },
    gc: { enabled: false },
    continuityEngine: { enabled: false },
    conversationReactivationRecall: { enabled: false },
    replyOutcomeTracking: { enabled: false },
    temporalContext: { enabled: false },
    personaVoice: { enabled: false },
    emotion: { t3: { enabled: false } },
    dreaming: { enabled: false },
    skillMiner: { enabled: false },
    runtime: { recallTimeoutMs: 10_000 },
    recall: {
      dedup: false,
      canonicalFirst: true,
      canonicalMaxItems: 1,
      maxPromptMemories: 5,
      decisionTrace: { enabled: false, includeInPrompt: false },
      globalInjectMaxChars: 17_000,
    },
    ...overrides,
  };
}

/**
 * @param {object} scenario
 * @returns {Promise<string|null>} the exact prependContext, or null when the
 *   handler returned undefined.
 */
export async function runScenario(scenario) {
  const restoreClock = freezeClock();
  const topics = new Map(Object.entries(scenario.topics || {}));
  const topicOf = (text) => topics.get(String(text)) ?? String(text);
  const restoreEmbedder = stubEmbedder(topicOf);
  const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-golden-db-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-golden-ws-"));
  const stateDir = mkdtempSync(join(tmpdir(), "plur1bus-golden-state-"));
  const previousHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = stateDir;
  try {
    mkdirSync(join(workspaceDir, "memory"), { recursive: true });
    if (scenario.knowledge) {
      writeFileSync(join(workspaceDir, "memory", "KNOWLEDGE.md"), scenario.knowledge);
    }
    const db = new MemoryDB(join(baseDbPath, scenario.agentId), VECTOR_DIM);
    for (const memory of scenario.memories) {
      await db.store({
        id: memory.id,
        text: memory.text,
        summary: memory.summary,
        vector: topicVector(topicOf(memory.text)),
        category: memory.category,
        createdAt: FROZEN_NOW - (memory.ageDays ?? 1) * 86_400_000,
        storedBy: scenario.agentId,
        workspaceKey: scenario.workspaceKey,
      });
    }
    const api = makeApi(baseConfig(baseDbPath, scenario.config));
    plugin.register(api, { importRouting: async () => routingCapability });
    const hooks = api.handlers.get("before_prompt_build");
    const hook = hooks?.at(-1);
    if (typeof hook !== "function") throw new Error(`${scenario.name}: before_prompt_build not registered`);
    const result = await hook(scenario.event, { ...scenario.ctx, workspaceDir });
    for (const stop of api.handlers.get("gateway_stop") || []) await stop();
    return result?.prependContext ?? null;
  } finally {
    if (previousHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previousHome;
    restoreEmbedder();
    restoreClock();
    rmSync(baseDbPath, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
}

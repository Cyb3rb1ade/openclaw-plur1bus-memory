import { strict as assert } from "node:assert";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const VECTOR_DIM = 384;
const turnStorage = new AsyncLocalStorage();
const originalOpenClawHome = process.env.OPENCLAW_HOME;

function makeApi(baseDbPath, runtimeLlm, pluginConfig = {}) {
  const handlers = {};
  const gatewayMethods = [];
  const services = [];
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      autoCapture: true,
      autoRecall: false,
      merging: { enabled: true },
      neo: { enabled: true },
      obsidianBridge: { enabled: false },
      featureCronSetup: { auto: false },
      gc: { enabled: false },
      healthWatch: { gatewayLog: false },
      ...pluginConfig,
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: { llm: runtimeLlm, agent: { async resolveAgentWorkspaceDir() { return baseDbPath; } } },
    resolvePath: (value) => value,
    registerCommand() {},
    registerTool() {},
    registerGatewayMethod: (...args) => gatewayMethods.push(args),
    registerService: (service) => services.push(service),
    on(event, fn) { (handlers[event] ||= []).push(fn); },
    async emit(event, ...args) { for (const fn of handlers[event] || []) await fn(...args); },
    gatewayMethods,
    services,
  };
}

async function runScenario(t, pluginConfig) {
  const baseDbPath = makeTempDir("plur1bus-hw-wiring-db-");
  const openclawHome = makeTempDir("plur1bus-hw-wiring-home-");
  process.env.OPENCLAW_HOME = openclawHome;
  mkdirSync(join(openclawHome, ".openclaw", "memory", "_archive"), { recursive: true });
  const originalBatch = LocalTransformersEmbeddingProvider.prototype.embedBatch;
  const originalEmbed = LocalTransformersEmbeddingProvider.prototype.embed;
  LocalTransformersEmbeddingProvider.prototype.embedBatch = async (texts) => texts.map(() => Array(VECTOR_DIM).fill(0.1));
  LocalTransformersEmbeddingProvider.prototype.embed = async () => Array(VECTOR_DIM).fill(0.1);
  const seenInTurn = [];
  const runtimeLlm = {
    async complete(params) {
      seenInTurn.push({ feature: params?.purpose ?? params?.feature, store: turnStorage.getStore() ?? null });
      throw Object.assign(new Error("upstream unavailable"), { name: "LlmCompleteError", code: "LLM_UNAVAILABLE" });
    },
  };
  const api = makeApi(baseDbPath, runtimeLlm, pluginConfig);
  t.after(async () => {
    await api.emit("gateway_stop");
    await Promise.all(api.services.map((service) => service?.stop?.()));
    LocalTransformersEmbeddingProvider.prototype.embedBatch = originalBatch;
    LocalTransformersEmbeddingProvider.prototype.embed = originalEmbed;
    if (originalOpenClawHome === undefined) delete process.env.OPENCLAW_HOME; else process.env.OPENCLAW_HOME = originalOpenClawHome;
  });
  const { default: plugin } = await import(`../index.js?hw-wiring=${Date.now()}-${Math.random()}`);
  plugin.register(api, { importRouting: async () => ({ isIncognitoSessionKey: () => false }) });
  await turnStorage.run({ turn: 1 }, () => api.emit("agent_end", {
    success: true,
    turnId: "turn-1",
    sessionKey: "agent:main:main",
    messages: [
      { role: "user", content: "I prefer dark mode and two spaces indentation." },
      { role: "assistant", content: "Noted, I will remember that preference." },
    ],
  }, { agentId: "main", workspaceDir: baseDbPath }));
  for (let i = 0; i < 100 && seenInTurn.length === 0; i += 1) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 200));
  const method = api.gatewayMethods.find(([name]) => name === "plur1bus.control.status");
  assert.ok(method, "control status method is registered");
  const responses = [];
  await method[1]({ params: {}, respond: (...args) => responses.push(args) });
  return { seenInTurn, status: responses[0][1].status };
}

// End to end through the OpenClaw adapter: register() with a fake API, one
// agent_end turn whose post-turn episode extraction hits a failing runtime LLM,
// then the dashboard projection behind plur1bus.control.status.
test("health watch is wired: route failures reach the dashboard, detachPostTurnWork reaches capture", async (t) => {
  // Engine default is inline; OpenClaw adapter defers. This test pins the
  // inline path that detachPostTurnWork wraps.
  const detached = await runScenario(t, { runtime: { detachPostTurnWork: true, deferPostTurnLlm: false } });
  const attached = await runScenario(t, { runtime: { deferPostTurnLlm: false } });

  for (const { status } of [detached, attached]) {
    const failures = status.healthWatch?.llm?.failures;
    assert.ok(Array.isArray(failures), "healthWatch.llm.failures is projected, not null");
    const row = failures.find((entry) => entry.feature === "episode-extraction");
    assert.ok(row && row.count >= 1, "the failed episode-extraction route call is counted");
    assert.equal(row.hint, "unavailable");
  }

  assert.ok(detached.seenInTurn.length >= 1 && attached.seenInTurn.length >= 1, "post-turn work reached the LLM");
  assert.ok(detached.seenInTurn.every((call) => call.store === null),
    "runtime.detachPostTurnWork: true runs post-turn work outside the turn's async context");
  assert.ok(attached.seenInTurn.every((call) => call.store?.turn === 1),
    "by default post-turn work still inherits the turn's async context");
});

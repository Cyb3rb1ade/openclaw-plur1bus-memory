import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inferEmotionalValenceAsync, setEmotionConfig } from "../lib/emotion.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";

// 7.12.22: Tier 3 laeuft fuer neue Erinnerungen nicht mehr im Turn, sondern
// im Feature-Cron `emotion-refine`. Diese Tests decken die drei Stellen ab:
// die Pending-Entscheidung im Capture-Pfad, den Cron-Lauf gegen eine echte
// Tabelle und das Verhalten bei Provider-Ausfall.

const VECTOR_DIM = 384;
const MEMORY_ID = "33333333-3333-4333-8333-333333333333";

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) {
    return { baseSessionKey: value, threadId: "" };
  },
  normalizeOptionalAccountId(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
  normalizeMessageChannel(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
});

const T3_RESPONSE = JSON.stringify({
  valence: 0.8,
  arousal: 0.6,
  dominance: 0.5,
  intensity: 0.7,
  primary_emotion: "joy",
  secondary_emotion: null,
  emotion_labels: { joy: 0.9, trust: 0.3 },
  language: "de",
  confidence: 0.92,
});

function makeVector(offset = 0) {
  const vector = Array(VECTOR_DIM).fill(0.1);
  vector[0] = 0.1 + offset;
  return vector;
}

async function loadFreshPlugin() {
  return import(`../index.js?emotion-refine=${Date.now()}-${Math.random()}`);
}

function createApi(baseDbPath, configOverrides = {}, runtimeLlm = null) {
  const commands = [];
  const toolFactories = [];
  const logs = [];
  const record = (level) => (...args) => logs.push([level, ...args]);
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      merging: { enabled: false },
      obsidianBridge: { enabled: false },
      featureCronSetup: { auto: false },
      gc: { enabled: false },
      ...configOverrides,
    },
    logger: { debug: record("debug"), error: record("error"), info: record("info"), warn: record("warn") },
    runtime: {
      ...(runtimeLlm ? { llm: runtimeLlm } : {}),
      agent: {
        async resolveAgentWorkspaceDir(config) { return config?.workspaceDir || baseDbPath; },
      },
    },
    resolvePath: (value) => value,
    registerCommand(command) { commands.push(command); },
    registerTool(factory) { toolFactories.push(factory); },
    registerService() {},
    on() {},
    _commands: commands,
    _toolFactories: toolFactories,
    _logs: logs,
  };
}

function findCommand(api) {
  const command = api._commands.find((candidate) => candidate.name === "plur1bus");
  assert.ok(command, "plur1bus command must be registered");
  return command;
}

function withTempPaths(t) {
  const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-emotion-refine-db-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-emotion-refine-ws-"));
  t.after(() => {
    rmSync(baseDbPath, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });
  return { baseDbPath, workspaceDir };
}

function installEmbeddingStub(t) {
  const original = LocalTransformersEmbeddingProvider.prototype.embedPassage;
  LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => makeVector(0.2);
  t.after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedPassage = original;
  });
}

async function seedPending(pluginModule, baseDbPath, agentId, overrides = {}) {
  const db = new pluginModule.MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
  try {
    await db.store({
      id: overrides.id || MEMORY_ID,
      text: overrides.text || "Ich freue mich riesig, dass der Umzug endlich geklappt hat!",
      vector: makeVector(),
      category: "fact",
      createdAt: Date.now(),
      storedBy: agentId,
      origin: "dm",
      status: overrides.status || "active",
      emotionalValence: "",
      emotionalIntensity: 0,
      emotionalDominant: "neutral",
      emotionStatus: overrides.emotionStatus || "pending_t3",
    });
  } finally {
    await db.shutdown();
  }
}

async function readRow(pluginModule, baseDbPath, agentId, id) {
  const db = new pluginModule.MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
  try {
    await db.init();
    const rows = await db.table.query().where(`id = "${id}"`).limit(1).toArray();
    return rows[0] || null;
  } finally {
    await db.shutdown();
  }
}

test("skipTier3 keeps the local tier-1/2 score and exposes confidence and tier", async () => {
  let t3Calls = 0;
  setEmotionConfig({
    tier: "auto",
    t2: { enabled: true },
    t3: { enabled: true, callLlm: async () => { t3Calls++; return T3_RESPONSE; }, timeoutMs: 1000 },
    escalationConfidence: 0.85,
  });
  try {
    const local = await inferEmotionalValenceAsync("Der Server steht unter /srv/data.", "user", null, { skipTier3: true });
    assert.equal(t3Calls, 0, "skipTier3 must never reach the LLM");
    assert.ok(Number.isFinite(local.confidence));
    assert.ok(local.tierUsed === 1 || local.tierUsed === 2);

    const escalated = await inferEmotionalValenceAsync("Der Server steht unter /srv/data.", "user", null, {});
    assert.equal(t3Calls, 1, "without skipTier3 the low-confidence text escalates");
    assert.equal(escalated.tierUsed, 3);
    assert.equal(escalated.emotionalDominant, "joy");
  } finally {
    setEmotionConfig({ tier: "auto", t2: { enabled: true }, t3: { enabled: false }, escalationConfidence: 0.85 });
  }
});

test("memory_store defers tier 3: row is stored with emotionStatus=pending_t3 and no LLM call", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "emotion-defer-agent";
  const calls = [];
  const runtimeLlm = {
    async complete(params) {
      calls.push(params);
      return { text: T3_RESPONSE, provider: "fake", model: "fake", agentId, usage: {} };
    },
  };
  const pluginModule = await loadFreshPlugin();
  const api = createApi(baseDbPath, { emotion: { t3: { enabled: true } } }, runtimeLlm);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });
  assert.match(JSON.stringify(api._logs), /emotion tier-3 capture mode deferred/);

  const storeTool = api._toolFactories.at(-1)({ agentId, workspaceDir })
    .find((tool) => tool.name === "memory_store");
  assert.ok(storeTool);
  const result = await storeTool.execute("store-call", {
    text: "Der Backup-Server steht unter /srv/data und laeuft mit Node 24.",
    category: "fact",
  });
  assert.equal(calls.length, 0, "the store path must not call the tier-3 LLM in deferred mode");

  const db = new pluginModule.MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
  try {
    await db.init();
    const rows = await db.table.query().where("emotionStatus = 'pending_t3'").limit(5).toArray();
    assert.equal(rows.length, 1, `exactly one pending row expected (${JSON.stringify(result)})`);
    assert.equal(rows[0].emotionalDominant, "neutral");
  } finally {
    await db.shutdown();
  }
});

test("internal emotion-refine refines pending rows with tier 3 and marks them final", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  const agentId = "emotion-refine-agent";
  const calls = [];
  const runtimeLlm = {
    async complete(params) {
      calls.push(params);
      return { text: T3_RESPONSE, provider: "fake", model: "fake", agentId, usage: {} };
    },
  };
  const pluginModule = await loadFreshPlugin();
  await seedPending(pluginModule, baseDbPath, agentId);
  await seedPending(pluginModule, baseDbPath, agentId, {
    id: "44444444-4444-4444-8444-444444444444",
    text: "Alte Version, bereits ueberholt.",
    status: "superseded",
  });
  const api = createApi(baseDbPath, { emotion: { t3: { enabled: true } } }, runtimeLlm);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const result = await findCommand(api).handler({
    args: "internal emotion-refine",
    agentId,
    channel: "cron",
    workspaceDir,
    runtimeContext: { llm: runtimeLlm },
  });
  const payload = JSON.parse(result.text.replace(/^[^{]*/, ""));
  assert.equal(payload.job, "emotion-refine");
  assert.equal(payload.refined, 1);
  assert.equal(payload.finalized, 1, "superseded rows are closed without an LLM call");
  assert.equal(payload.failed, 0);
  assert.equal(payload.pending, 0);
  assert.equal(calls.length, 1);

  const row = await readRow(pluginModule, baseDbPath, agentId, MEMORY_ID);
  assert.equal(row.emotionStatus, "final");
  assert.equal(row.emotionalDominant, "joy");
  assert.ok(Number(row.emotionalIntensity) > 0.6);
  assert.match(String(row.emotionalValence), /joy:0\.9/);
  const superseded = await readRow(pluginModule, baseDbPath, agentId, "44444444-4444-4444-8444-444444444444");
  assert.equal(superseded.emotionStatus, "final");
  assert.equal(superseded.emotionalDominant, "neutral");
});

test("internal emotion-refine leaves rows pending when the provider fails", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  const agentId = "emotion-refine-fail-agent";
  const runtimeLlm = {
    async complete() {
      throw new Error("provider down");
    },
  };
  const pluginModule = await loadFreshPlugin();
  await seedPending(pluginModule, baseDbPath, agentId);
  const api = createApi(baseDbPath, { emotion: { t3: { enabled: true } } }, runtimeLlm);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const result = await findCommand(api).handler({
    args: "internal emotion-refine",
    agentId,
    channel: "cron",
    workspaceDir,
    runtimeContext: { llm: runtimeLlm },
  });
  const payload = JSON.parse(result.text.replace(/^[^{]*/, ""));
  assert.equal(payload.refined, 0);
  assert.equal(payload.failed, 1);
  assert.equal(payload.pending, 1);

  const row = await readRow(pluginModule, baseDbPath, agentId, MEMORY_ID);
  assert.equal(row.emotionStatus, "pending_t3");
});

test("internal emotion-refine is skipped when tier 3 is disabled", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  const pluginModule = await loadFreshPlugin();
  const api = createApi(baseDbPath, { emotion: { t3: { enabled: false } } });
  pluginModule.default.register(api, { importRouting: async () => routingCapability });
  const result = await findCommand(api).handler({
    args: "internal emotion-refine",
    agentId: "emotion-refine-off",
    channel: "cron",
    workspaceDir,
  });
  const payload = JSON.parse(result.text.replace(/^[^{]*/, ""));
  assert.equal(payload.skipped, true);
  assert.equal(payload.reason, "emotion_t3_disabled");
});

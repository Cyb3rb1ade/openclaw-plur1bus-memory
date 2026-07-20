import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import OpenAI from "openai";

import {
  prepareReviewBundle,
  updateReviewBundleItems,
} from "../lib/obsidian-control-room.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { safeProfile } from "../lib/setup/feature-profiles.js";

const VECTOR_DIM = 384;

function makeVector(offset = 0) {
  const vector = Array(VECTOR_DIM).fill(0.1);
  vector[0] = 0.1 + offset;
  return vector;
}

async function loadFreshPlugin() {
  return import(`../index.js?openclaw-llm-runtime=${Date.now()}-${Math.random()}`);
}

function createLogger() {
  const calls = [];
  const record = (level) => (...args) => calls.push([level, ...args]);
  return {
    calls,
    debug: record("debug"),
    error: record("error"),
    info: record("info"),
    warn: record("warn"),
  };
}

function createApi(baseDbPath, configOverrides = {}, runtimeLlm = null) {
  const commands = [];
  const toolFactories = [];
  const logger = createLogger();
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      obsidianBridge: { enabled: false },
      featureCronSetup: { auto: false },
      gc: { enabled: false },
      ...configOverrides,
    },
    logger,
    runtime: runtimeLlm ? { llm: runtimeLlm } : {},
    resolvePath: (value) => value,
    registerCommand(command) {
      commands.push(command);
    },
    registerTool(factory) {
      toolFactories.push(factory);
    },
    registerService() {},
    on() {},
    _commands: commands,
    _toolFactories: toolFactories,
  };
}

function findCommand(api, name = "plur1bus") {
  const command = api._commands.find((candidate) => candidate.name === name);
  assert.ok(command, `${name} command must be registered`);
  return command;
}

function createTools(api, context) {
  assert.ok(api._toolFactories.length > 0, "memory tool factory must be registered");
  return api._toolFactories.at(-1)(context);
}

async function seedMemory(pluginModule, baseDbPath, agentId, overrides = {}) {
  const db = new pluginModule.MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
  const id = overrides.id || "11111111-1111-4111-8111-111111111111";
  await db.store({
    id,
    text: overrides.text || "Projekt Alpha nutzt den Auth-Service intern.",
    vector: makeVector(),
    category: overrides.category || "fact",
    createdAt: Date.now(),
    storedBy: agentId,
    origin: overrides.origin || "dm",
    trustLevel: overrides.trustLevel || "untrusted",
    type: overrides.type || "",
    status: "active",
  });
  if (overrides.unclassified === true) {
    await db.table.update({ where: `id = "${id}"`, values: { type: "" } });
  }
  await db.shutdown();
}

async function readMemory(pluginModule, baseDbPath, agentId, id) {
  const db = new pluginModule.MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
  try {
    return await db.getById(id);
  } finally {
    await db.shutdown();
  }
}

function withTempPaths(t) {
  const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-openclaw-llm-db-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-openclaw-llm-ws-"));
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

function installDirectOpenAiStub(t, calls, responseText) {
  const original = OpenAI.prototype.post;
  OpenAI.prototype.post = async function post(path, options) {
    calls.push({
      path,
      body: options?.body,
      apiKey: this.apiKey,
      baseUrl: this.baseURL,
    });
    return {
      choices: [{ message: { content: responseText } }],
      usage: {},
    };
  };
  t.after(() => {
    OpenAI.prototype.post = original;
  });
}

test("registration resolves enabled core routes without making an LLM call", async (t) => {
  const { baseDbPath } = withTempPaths(t);
  const calls = [];
  const runtimeLlm = {
    async complete(params) {
      calls.push(params);
      return { text: "unused", provider: "fake", model: "fake", agentId: "default", usage: {} };
    },
  };
  const pluginModule = await loadFreshPlugin();
  const api = createApi(baseDbPath, {
    merging: { enabled: true },
    schicht15: { enabled: true },
    skillMiner: { enabled: true },
    criticalPush: { enabled: true },
    emotion: { tier: "t3", t3: { enabled: true } },
  }, runtimeLlm);

  assert.doesNotThrow(() => pluginModule.default.register(api));
  assert.equal(calls.length, 0);
  assert.doesNotMatch(JSON.stringify(api.logger.calls), /model is empty; disabling/i);
});

test("global memory_store merge uses the target agent OpenClaw default", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "global-merge-agent";
  const calls = [];
  const runtimeLlm = {
    async complete(params) {
      calls.push(params);
      return {
        text: JSON.stringify({ merge: false, reason: "keep separate" }),
        provider: "fake-host",
        model: `model-for-${params.agentId}`,
        agentId: params.agentId,
        usage: {},
      };
    },
  };
  const pluginModule = await loadFreshPlugin();
  await seedMemory(pluginModule, baseDbPath, agentId);
  const api = createApi(baseDbPath, {
    duplicateThreshold: 0.9999,
    merging: { enabled: true, autoApply: true },
    emotion: { t3: { enabled: false } },
  }, runtimeLlm);
  pluginModule.default.register(api);

  const storeTool = createTools(api, { agentId, workspaceDir })
    .find((tool) => tool.name === "memory_store");
  assert.ok(storeTool);
  const result = await storeTool.execute("merge-call", {
    text: "Projekt Alpha nutzt den Auth-Service extern.",
    category: "fact",
  });

  assert.match(result.content[0].text, /Memory stored/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, agentId);
  assert.equal(calls[0].purpose, "merge-decision");
  assert.equal(Object.hasOwn(calls[0], "model"), false);
});

test("Obsidian command merge uses its session-bound runtime without agentId", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "command-merge-agent";
  const workspaceKey = "workspace-command-merge";
  const bundleId = `rb-command-merge-${Date.now()}`;
  const globalCalls = [];
  const sessionCalls = [];
  const secret = "sk-live-command-secret prompt=private x-api-key=hidden header=secret";
  const obsidianConfig = { enabled: false, vaultPath: workspaceDir };
  const prepared = await prepareReviewBundle(obsidianConfig, {
    agentId,
    workspaceKey,
    workspaceDir,
    bundleId,
    proposals: [{
      type: "memory_promotion",
      risk: "low",
      text: "Projekt Alpha nutzt den Auth-Service extern.",
      category: "fact",
      scope: "workspace",
      origin: "internal",
      reason: "Approved command-bound merge fixture.",
    }],
  });
  assert.equal(prepared.items.length, 1);
  updateReviewBundleItems(obsidianConfig, bundleId, "approve", "all", { agentId });

  const pluginModule = await loadFreshPlugin();
  await seedMemory(pluginModule, baseDbPath, agentId);
  const api = createApi(baseDbPath, {
    duplicateThreshold: 0.9999,
    merging: { enabled: true, autoApply: true },
    obsidianBridge: obsidianConfig,
    emotion: { t3: { enabled: false } },
  }, {
    async complete(params) {
      globalCalls.push(params);
      return {
        text: JSON.stringify({ merge: false, reason: "keep separate" }),
        provider: "global",
        model: "global-model",
        agentId: params.agentId,
        usage: {},
      };
    },
  });
  pluginModule.default.register(api);
  const sessionRuntime = {
    async complete(params) {
      sessionCalls.push(params);
      throw new Error(secret);
    },
  };

  const result = await findCommand(api).handler({
    args: `obsidian review apply ${bundleId}`,
    agentId,
    workspaceDir,
    workspaceKey,
    runtimeContext: { llm: sessionRuntime },
    message: {
      from: { id: "command-owner" },
      chat: { id: "command-private", type: "private" },
    },
  });

  assert.match(result.text, /Applied: 1/);
  assert.equal(globalCalls.length, 0);
  assert.equal(sessionCalls.length, 1);
  assert.equal(Object.hasOwn(sessionCalls[0], "agentId"), false);
  assert.equal(Object.hasOwn(sessionCalls[0], "model"), false);
  assert.equal(sessionCalls[0].purpose, "merge-decision");
  assert.doesNotMatch(
    JSON.stringify({ result, logs: api.logger.calls }),
    /sk-live-command-secret|prompt=private|x-api-key|header=secret/i,
  );
});

test("a merging feature model is a native override only for the merging call", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "merge-model-agent";
  const calls = [];
  const runtimeLlm = {
    async complete(params) {
      calls.push(params);
      return {
        text: JSON.stringify({ merge: false, reason: "keep separate" }),
        provider: "fake-host",
        model: params.model,
        agentId: params.agentId,
        usage: {},
      };
    },
  };
  const pluginModule = await loadFreshPlugin();
  await seedMemory(pluginModule, baseDbPath, agentId);
  const api = createApi(baseDbPath, {
    duplicateThreshold: 0.9999,
    merging: { enabled: true, autoApply: true, model: "native/merging-override" },
    emotion: { t3: { enabled: false } },
  }, runtimeLlm);
  pluginModule.default.register(api);

  const storeTool = createTools(api, { agentId, workspaceDir })
    .find((tool) => tool.name === "memory_store");
  const result = await storeTool.execute("merge-model-call", {
    text: "Projekt Alpha nutzt den Auth-Service extern.",
    category: "fact",
  });

  assert.match(result.content[0].text, /Memory stored/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, agentId);
  assert.equal(calls[0].model, "native/merging-override");
});

test("a complete feature-local direct override bypasses the OpenClaw runtime", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "direct-merge-agent";
  const nativeCalls = [];
  const directCalls = [];
  installDirectOpenAiStub(
    t,
    directCalls,
    JSON.stringify({ merge: false, reason: "keep separate" }),
  );
  const pluginModule = await loadFreshPlugin();
  await seedMemory(pluginModule, baseDbPath, agentId);
  const api = createApi(baseDbPath, {
    duplicateThreshold: 0.9999,
    merging: {
      enabled: true,
      autoApply: true,
      model: "direct/merging-model",
      baseUrl: "https://direct-merge.invalid/v1",
      apiKey: "direct-secret",
    },
    emotion: { t3: { enabled: false } },
  }, {
    async complete(params) {
      nativeCalls.push(params);
      return { text: "unexpected", provider: "native", model: "native", usage: {} };
    },
  });
  pluginModule.default.register(api);

  const storeTool = createTools(api, { agentId, workspaceDir })
    .find((tool) => tool.name === "memory_store");
  const result = await storeTool.execute("direct-merge-call", {
    text: "Projekt Alpha nutzt den Auth-Service extern.",
    category: "fact",
  });

  assert.match(result.content[0].text, /Memory stored/);
  assert.equal(nativeCalls.length, 0);
  assert.equal(directCalls.length, 1);
  assert.equal(directCalls[0].body.model, "direct/merging-model");
  assert.equal(directCalls[0].apiKey, "direct-secret");
  assert.equal(directCalls[0].baseUrl, "https://direct-merge.invalid/v1");
});

test("feature-local direct transport without a model is unavailable and makes no call", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "partial-direct-agent";
  const nativeCalls = [];
  const directCalls = [];
  installDirectOpenAiStub(t, directCalls, "unexpected");
  const pluginModule = await loadFreshPlugin();
  await seedMemory(pluginModule, baseDbPath, agentId);
  const api = createApi(baseDbPath, {
    duplicateThreshold: 0.9999,
    merging: {
      enabled: true,
      autoApply: true,
      baseUrl: "https://partial-direct.invalid/v1",
    },
    emotion: { t3: { enabled: false } },
  }, {
    async complete(params) {
      nativeCalls.push(params);
      return { text: "unexpected", provider: "native", model: "native", usage: {} };
    },
  });
  pluginModule.default.register(api);

  const storeTool = createTools(api, { agentId, workspaceDir })
    .find((tool) => tool.name === "memory_store");
  const result = await storeTool.execute("partial-direct-call", {
    text: "Projekt Alpha nutzt den Auth-Service extern.",
    category: "fact",
  });

  assert.match(result.content[0].text, /Memory stored/);
  assert.equal(nativeCalls.length, 0);
  assert.equal(directCalls.length, 0);
  assert.match(JSON.stringify(api.logger.calls), /ambiguous-partial-override/);
  assert.doesNotMatch(JSON.stringify(api.logger.calls), /partial-direct\.invalid/);
});

test("a missing OpenClaw runtime makes native merging fail soft", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "missing-runtime-agent";
  const pluginModule = await loadFreshPlugin();
  await seedMemory(pluginModule, baseDbPath, agentId);
  const api = createApi(baseDbPath, {
    duplicateThreshold: 0.9999,
    merging: { enabled: true, autoApply: true },
    emotion: { t3: { enabled: false } },
  });
  pluginModule.default.register(api);

  const storeTool = createTools(api, { agentId, workspaceDir })
    .find((tool) => tool.name === "memory_store");
  const result = await storeTool.execute("missing-runtime-call", {
    text: "Projekt Alpha nutzt den Auth-Service extern.",
    category: "fact",
  });

  assert.match(result.content[0].text, /Memory stored/);
  assert.match(JSON.stringify(api.logger.calls), /openclaw-runtime-unavailable/);
  assert.doesNotMatch(JSON.stringify(api.logger.calls), /kimi-for-coding/);
});

test("an unresolved feature-local credential makes no native or direct request", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "missing-credential-agent";
  const missingEnv = "PLUR1BUS_TEST_MISSING_RUNTIME_CREDENTIAL_90210";
  const previous = process.env[missingEnv];
  delete process.env[missingEnv];
  t.after(() => {
    if (previous === undefined) delete process.env[missingEnv];
    else process.env[missingEnv] = previous;
  });
  const nativeCalls = [];
  const directCalls = [];
  installDirectOpenAiStub(t, directCalls, "unexpected");
  const pluginModule = await loadFreshPlugin();
  await seedMemory(pluginModule, baseDbPath, agentId);
  const api = createApi(baseDbPath, {
    duplicateThreshold: 0.9999,
    merging: {
      enabled: true,
      autoApply: true,
      model: "direct/missing-credential",
      baseUrl: "https://missing-credential.invalid/v1",
      apiKey: `\${${missingEnv}}`,
    },
    emotion: { t3: { enabled: false } },
  }, {
    async complete(params) {
      nativeCalls.push(params);
      return { text: "unexpected", provider: "native", model: "native", usage: {} };
    },
  });
  pluginModule.default.register(api);

  const storeTool = createTools(api, { agentId, workspaceDir })
    .find((tool) => tool.name === "memory_store");
  const result = await storeTool.execute("missing-credential-call", {
    text: "Projekt Alpha nutzt den Auth-Service extern.",
    category: "fact",
  });

  const logs = JSON.stringify(api.logger.calls);
  assert.match(result.content[0].text, /Memory stored/);
  assert.equal(nativeCalls.length, 0);
  assert.equal(directCalls.length, 0);
  assert.match(logs, /direct-credential-unavailable/);
  assert.doesNotMatch(logs, new RegExp(missingEnv));
  assert.doesNotMatch(logs, /missing-credential\.invalid/);
});

test("critical classifier command prefers its session-bound runtime and does not inherit merging.model", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  const agentId = "critical-session-agent";
  const globalCalls = [];
  const sessionCalls = [];
  const globalRuntime = {
    async complete(params) {
      globalCalls.push(params);
      return { text: "fakt", provider: "global", model: "global-model", agentId, usage: {} };
    },
  };
  const sessionRuntime = {
    async complete(params) {
      sessionCalls.push(params);
      return { text: "fakt", provider: "session", model: "session-model", agentId, usage: {} };
    },
  };
  const pluginModule = await loadFreshPlugin();
  await seedMemory(pluginModule, baseDbPath, agentId, {
    id: "22222222-2222-4222-8222-222222222222",
    text: "A routine informational memory for classification.",
    unclassified: true,
  });
  const api = createApi(baseDbPath, {
    merging: { enabled: true, model: "foreign/merging-model" },
    criticalPush: { enabled: true },
    emotion: { t3: { enabled: false } },
  }, globalRuntime);
  pluginModule.default.register(api);

  const result = await findCommand(api).handler({
    args: "internal classify-recent",
    agentId,
    channel: "cron",
    workspaceDir,
    workspaceKey: "workspace-critical",
    runtimeContext: { llm: sessionRuntime },
  });

  assert.match(result.text, /"processed": 1/);
  assert.equal(globalCalls.length, 0);
  assert.equal(sessionCalls.length, 1);
  assert.equal(Object.hasOwn(sessionCalls[0], "agentId"), false);
  assert.equal(Object.hasOwn(sessionCalls[0], "model"), false);
  assert.equal(sessionCalls[0].purpose, "critical-push-classification");
});

test("Critical Push leaves cards unclassified when no native runtime is available", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  const agentId = "critical-missing-runtime-agent";
  const memoryId = "66666666-6666-4666-8666-666666666666";
  const pluginModule = await loadFreshPlugin();
  await seedMemory(pluginModule, baseDbPath, agentId, {
    id: memoryId,
    text: "A routine informational memory that must remain unclassified.",
    unclassified: true,
  });
  const api = createApi(baseDbPath, {
    criticalPush: { enabled: true },
    emotion: { t3: { enabled: false } },
  });
  pluginModule.default.register(api);

  const result = await findCommand(api).handler({
    args: "internal classify-recent",
    agentId,
    channel: "cron",
    workspaceDir,
    workspaceKey: "workspace-critical-missing-runtime",
  });
  const stored = await readMemory(pluginModule, baseDbPath, agentId, memoryId);

  assert.match(result.text, /"processed": 0/);
  assert.match(result.text, /no classification model configured/i);
  assert.equal(stored.type, "");
});

test("Critical Push direct override works without a host runtime", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  const agentId = "critical-direct-agent";
  const memoryId = "88888888-8888-4888-8888-888888888888";
  const directCalls = [];
  installDirectOpenAiStub(t, directCalls, "person");
  const pluginModule = await loadFreshPlugin();
  await seedMemory(pluginModule, baseDbPath, agentId, {
    id: memoryId,
    text: "Alex Example is the new project lead.",
    unclassified: true,
  });
  const api = createApi(baseDbPath, {
    criticalPush: {
      enabled: true,
      model: "direct/critical-model",
      baseUrl: "https://direct-critical.invalid/v1",
      apiKey: "direct-critical-secret",
    },
    emotion: { t3: { enabled: false } },
  });
  pluginModule.default.register(api);

  const result = await findCommand(api).handler({
    args: "internal classify-recent",
    agentId,
    channel: "cron",
    workspaceDir,
    workspaceKey: "workspace-critical-direct",
  });
  const stored = await readMemory(pluginModule, baseDbPath, agentId, memoryId);

  assert.match(result.text, /"processed": 1/);
  assert.equal(directCalls.length, 1);
  assert.equal(directCalls[0].body.model, "direct/critical-model");
  assert.equal(stored.type, "person");
});

test("Critical Push policy rejection leaves cards unclassified and diagnostics sanitized", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  const agentId = "critical-policy-agent";
  const memoryId = "77777777-7777-4777-8777-777777777777";
  const secret = "sk-live-policy-secret prompt=private x-api-key=hidden";
  const pluginModule = await loadFreshPlugin();
  await seedMemory(pluginModule, baseDbPath, agentId, {
    id: memoryId,
    text: "A private policy-rejection memory that must remain unclassified.",
    unclassified: true,
  });
  const api = createApi(baseDbPath, {
    criticalPush: { enabled: true },
    emotion: { t3: { enabled: false } },
  }, {
    async complete() {
      throw new Error(secret);
    },
  });
  pluginModule.default.register(api);

  const result = await findCommand(api).handler({
    args: "internal classify-recent",
    agentId,
    channel: "cron",
    workspaceDir,
    workspaceKey: "workspace-critical-policy",
  });
  const stored = await readMemory(pluginModule, baseDbPath, agentId, memoryId);
  const diagnostics = JSON.stringify({ result, logs: api.logger.calls });

  assert.match(result.text, /"processed": 0/);
  assert.equal(stored.type, "");
  assert.doesNotMatch(diagnostics, /sk-live-policy-secret|private policy-rejection memory|x-api-key/i);
});

test("Schicht 1.5 uses only its own config and the global target agent", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  const agentId = "schicht-agent";
  const calls = [];
  const runtimeLlm = {
    async complete(params) {
      calls.push(params);
      return {
        text: "# Knowledge\n\n- A curated note.",
        provider: "fake-host",
        model: `model-for-${params.agentId}`,
        agentId: params.agentId,
        usage: {},
      };
    },
  };
  const pluginModule = await loadFreshPlugin();
  const api = createApi(baseDbPath, {
    merging: { enabled: true, model: "foreign/merging-model" },
    schicht15: { enabled: true },
    emotion: { t3: { enabled: false } },
  }, runtimeLlm);
  pluginModule.default.register(api);

  const knowledgeTool = createTools(api, { agentId, workspaceDir, workspaceKey: "workspace-schicht" })
    .find((tool) => tool.name === "knowledge_update");
  assert.ok(knowledgeTool);
  const result = await knowledgeTool.execute("knowledge-call", { note: "Keep the curated note." });

  assert.doesNotMatch(result.content[0].text, /not enabled/i);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, agentId);
  assert.equal(calls[0].purpose, "knowledge-update");
  assert.equal(Object.hasOwn(calls[0], "model"), false);
});

test("Schicht 1.5 sanitizes provider failures in responses and logs", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  const agentId = "schicht-error-agent";
  const secret = "sk-live-schicht-secret prompt=private x-api-key=hidden header=secret";
  const calls = [];
  const pluginModule = await loadFreshPlugin();
  const api = createApi(baseDbPath, {
    schicht15: { enabled: true },
    emotion: { t3: { enabled: false } },
  }, {
    async complete(params) {
      calls.push(params);
      throw new Error(secret);
    },
  });
  pluginModule.default.register(api);

  const knowledgeTool = createTools(api, { agentId, workspaceDir, workspaceKey: "workspace-schicht-error" })
    .find((tool) => tool.name === "knowledge_update");
  const result = await knowledgeTool.execute("knowledge-error-call", { note: "Trigger a safe failure." });
  const diagnostics = JSON.stringify({ result, logs: api.logger.calls });

  assert.equal(calls.length, 1);
  assert.match(result.content[0].text, /knowledge_update failed/i);
  assert.doesNotMatch(diagnostics, /sk-live-schicht-secret|prompt=private|x-api-key|header=secret/i);
});

test("Skill Miner uses its feature-local native default through the command runtime", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  const agentId = "skill-session-agent";
  const globalCalls = [];
  const sessionCalls = [];
  const pluginModule = await loadFreshPlugin();
  await seedMemory(pluginModule, baseDbPath, agentId, {
    id: "33333333-3333-4333-8333-333333333333",
    text: "Always verify deployment checks before publishing releases.",
    origin: "user_confirmation",
    trustLevel: "validated",
  });
  const api = createApi(baseDbPath, {
    merging: { enabled: true, model: "foreign/merging-model" },
    skillMiner: { enabled: true, minEvidenceScore: 3 },
    emotion: { t3: { enabled: false } },
  }, {
    async complete(params) {
      globalCalls.push(params);
      return { text: "{}", provider: "global", model: "global-model", agentId, usage: {} };
    },
  });
  pluginModule.default.register(api);
  const sessionRuntime = {
    async complete(params) {
      sessionCalls.push(params);
      return {
        text: JSON.stringify({
          skillName: "verify-before-release",
          skillTitle: "Verify before release",
          description: "Run deployment checks before publishing.",
          instructions: "Run the focused checks and inspect their output.",
          examples: ["Verify a release"],
          confidence: 0.9,
          category: "workflow",
        }),
        provider: "session",
        model: "session-model",
        agentId,
        usage: {},
      };
    },
  };

  const result = await findCommand(api).handler({
    args: "internal skill-miner",
    agentId,
    channel: "cron",
    workspaceDir,
    workspaceKey: "workspace-skill",
    runtimeContext: { llm: sessionRuntime },
  });

  assert.match(result.text, /"proposalsCreated": 1/);
  assert.equal(globalCalls.length, 0);
  assert.equal(sessionCalls.length, 1);
  assert.equal(Object.hasOwn(sessionCalls[0], "agentId"), false);
  assert.equal(Object.hasOwn(sessionCalls[0], "model"), false);
  assert.equal(sessionCalls[0].purpose, "skill-extraction");
});

test("Emotion Tier 3 uses its own native-default route with global agent scope", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "emotion-agent";
  const calls = [];
  const runtimeLlm = {
    async complete(params) {
      calls.push(params);
      return {
        text: JSON.stringify({
          valence: 0.1,
          arousal: 0.2,
          dominance: 0,
          intensity: 0.3,
          primary_emotion: "neutral",
          secondary_emotion: null,
          emotion_labels: { neutral: 1 },
          confidence: 0.9,
          language: "en",
        }),
        provider: "fake-host",
        model: `emotion-model-for-${params.agentId}`,
        agentId: params.agentId,
        usage: {},
      };
    },
  };
  const pluginModule = await loadFreshPlugin();
  const api = createApi(baseDbPath, {
    merging: { enabled: true, model: "foreign/merging-model", autoApply: false },
    emotion: { tier: "t3", t3: { enabled: true } },
  }, runtimeLlm);
  pluginModule.default.register(api);

  const storeTool = createTools(api, { agentId, workspaceDir })
    .find((tool) => tool.name === "memory_store");
  const result = await storeTool.execute("emotion-call", {
    text: "This memory has deliberately ambiguous emotional content.",
    category: "fact",
  });

  assert.match(result.content[0].text, /Memory stored/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, agentId);
  assert.equal(calls[0].purpose, "emotion-classification");
  assert.equal(Object.hasOwn(calls[0], "model"), false);
});

test("host policy denial is attempted once and never retried without the target agent", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "denied-agent";
  const secret = "sk-live-merge-secret prompt=private x-api-key=hidden header=secret";
  const calls = [];
  const runtimeLlm = {
    async complete(params) {
      calls.push(params);
      throw new Error(secret);
    },
  };
  const pluginModule = await loadFreshPlugin();
  await seedMemory(pluginModule, baseDbPath, agentId, {
    id: "44444444-4444-4444-8444-444444444444",
  });
  const api = createApi(baseDbPath, {
    duplicateThreshold: 0.9999,
    merging: { enabled: true, autoApply: true },
    emotion: { t3: { enabled: false } },
  }, runtimeLlm);
  pluginModule.default.register(api);

  const storeTool = createTools(api, { agentId, workspaceDir })
    .find((tool) => tool.name === "memory_store");
  const result = await storeTool.execute("denied-call", {
    text: "Projekt Alpha nutzt den Auth-Service extern.",
    category: "fact",
  });

  assert.match(result.content[0].text, /Memory stored/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, agentId);
  assert.doesNotMatch(
    JSON.stringify({ result, logs: api.logger.calls }),
    /sk-live-merge-secret|prompt=private|x-api-key|header=secret/i,
  );
});

test("native model policy denial is attempted once without a fallback model", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const agentId = "model-denied-agent";
  const calls = [];
  const runtimeLlm = {
    async complete(params) {
      calls.push(params);
      throw new Error("Plugin LLM completion cannot override the primary model.");
    },
  };
  const pluginModule = await loadFreshPlugin();
  await seedMemory(pluginModule, baseDbPath, agentId, {
    id: "55555555-5555-4555-8555-555555555555",
  });
  const api = createApi(baseDbPath, {
    duplicateThreshold: 0.9999,
    merging: { enabled: true, autoApply: true, model: "blocked/primary-override" },
    emotion: { t3: { enabled: false } },
  }, runtimeLlm);
  pluginModule.default.register(api);

  const storeTool = createTools(api, { agentId, workspaceDir })
    .find((tool) => tool.name === "memory_store");
  const result = await storeTool.execute("model-denied-call", {
    text: "Projekt Alpha nutzt den Auth-Service extern.",
    category: "fact",
  });

  assert.match(result.content[0].text, /Memory stored/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, agentId);
  assert.equal(calls[0].model, "blocked/primary-override");
});

test("the real Safe profile makes no core or generic enhancement chat call", async (t) => {
  const { baseDbPath, workspaceDir } = withTempPaths(t);
  installEmbeddingStub(t);
  const nativeCalls = [];
  const directCalls = [];
  installDirectOpenAiStub(t, directCalls, "unexpected");
  const runtimeLlm = {
    async complete(params) {
      nativeCalls.push(params);
      return { text: "unexpected", provider: "fake", model: "fake", agentId: params.agentId, usage: {} };
    },
  };
  const pluginModule = await loadFreshPlugin();
  const profile = safeProfile();
  const api = createApi(baseDbPath, {
    ...profile,
    baseDbPath,
    embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
    featureCronSetup: { ...profile.featureCronSetup, auto: false },
  }, runtimeLlm);
  pluginModule.default.register(api);

  const agentId = "safe-agent";
  const tools = createTools(api, { agentId, workspaceDir });
  await tools.find((tool) => tool.name === "memory_store").execute("safe-store", {
    text: "A deterministic safe-profile memory.",
    category: "fact",
  });
  await tools.find((tool) => tool.name === "knowledge_update").execute("safe-knowledge", { note: "ignored" });
  const command = findCommand(api);
  const commandContext = {
    agentId,
    channel: "cron",
    workspaceDir,
    workspaceKey: "workspace-safe",
    runtimeContext: { llm: runtimeLlm },
  };
  for (const job of [
    "classify-recent",
    "skill-miner",
    "consolidate-daily",
    "rem-dream",
    "afterthought",
    "persona-evolve",
    "meta-reflect",
  ]) {
    await command.handler({ ...commandContext, args: `internal ${job}` });
  }

  assert.equal(nativeCalls.length, 0);
  assert.equal(directCalls.length, 0);
});

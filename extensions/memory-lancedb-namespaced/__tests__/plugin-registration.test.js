import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.js";
import { createNeoStore } from "../lib/neo-arch.js";

function makeApi(pluginConfig) {
  const registered = {
    hooks: [],
    tools: [],
    commands: [],
    services: [],
    memoryEmbeddingProviders: [],
    promptSupplements: [],
    corpusSupplements: [],
  };
  const api = {
    pluginConfig,
    runtime: {},
    logger: { info() {}, warn() {}, debug() {} },
    resolvePath(value) { return value; },
    registerTool(factory, opts) { registered.tools.push({ factory, opts }); },
    registerCommand(command) { registered.commands.push(command); },
    registerService(service) { registered.services.push(service); },
    registerMemoryEmbeddingProvider(adapter) { registered.memoryEmbeddingProviders.push(adapter); },
    registerMemoryPromptSupplement(builder) { registered.promptSupplements.push(builder); },
    registerMemoryCorpusSupplement(supplement) { registered.corpusSupplements.push(supplement); },
    on(name, handler, opts) { registered.hooks.push({ name, handler, opts }); },
  };
  plugin.register(api);
  return registered;
}

function baseConfig(tmp, overrides = {}) {
  return {
    embedding: { apiKey: "test-key", dimensions: 1536 },
    baseDbPath: join(tmp, "db"),
    ...overrides,
  };
}

test("plugin keeps autoCapture default-on and autoCapture false only disables hook capture", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-plugin-"));
  try {
    const defaultRegistered = makeApi(baseConfig(tmp));
    assert.ok(defaultRegistered.hooks.some(h => h.name === "agent_end"));
    assert.ok(defaultRegistered.tools.length > 0, "manual memory tools remain registered");

    const disabledRegistered = makeApi(baseConfig(tmp, { autoCapture: false }));
    assert.ok(!disabledRegistered.hooks.some(h => h.name === "agent_end"));
    assert.ok(disabledRegistered.tools.length > 0, "autoCapture false must not disable manual memory tools");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plugin registers OpenClaw-native memory embedding providers without becoming the memory slot owner", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-plugin-"));
  try {
    let memoryCapabilityCalls = 0;
    const registered = makeApi(baseConfig(tmp, {
      neo: { enabled: true, mode: "slot" },
      embedding: { dimensions: 1536 },
    }));
    assert.deepEqual(
      registered.memoryEmbeddingProviders.map(adapter => adapter.id),
      ["plur1bus-openai", "plur1bus-openai-compatible", "plur1bus-e5-small"]
    );

    const memoryCapabilityApi = "register" + "MemoryCapability";
    const api = {
      pluginConfig: baseConfig(tmp, { embedding: { dimensions: 1536 } }),
      runtime: {},
      logger: { info() {}, warn() {}, debug() {} },
      resolvePath(value) { return value; },
      registerTool() {},
      registerCommand() {},
      registerService() {},
      registerMemoryEmbeddingProvider() {},
      registerMemoryPromptSupplement() {},
      registerMemoryCorpusSupplement() {},
      [memoryCapabilityApi]() { memoryCapabilityCalls += 1; },
      on() {},
    };
    plugin.register(api);
    assert.equal(memoryCapabilityCalls, 0, "PLUR1BUS must not call the memory capability API");
    assert.equal(plugin.kind, "extension");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plugin declares factory tool names for OpenClaw runtime inspect", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-plugin-"));
  try {
    const registered = makeApi(baseConfig(tmp));
    assert.deepEqual(
      registered.tools[0]?.opts?.names,
      ["memory_recall", "memory_store", "memory_forget", "knowledge_update"],
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("missing registerMemoryEmbeddingProvider API is a warned no-op", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-plugin-"));
  try {
    const warnings = [];
    const memoryCapabilityApi = "register" + "MemoryCapability";
    const api = {
      pluginConfig: baseConfig(tmp, { embedding: { dimensions: 1536 } }),
      runtime: {},
      logger: { info() {}, warn(message) { warnings.push(message); }, debug() {} },
      resolvePath(value) { return value; },
      registerTool() {},
      registerCommand() {},
      registerService() {},
      registerMemoryPromptSupplement() {},
      registerMemoryCorpusSupplement() {},
      [memoryCapabilityApi]() { throw new Error("memory capability API must not be called"); },
      on() {},
    };
    plugin.register(api);
    assert.ok(warnings.some(message => String(message).includes("registerMemoryEmbeddingProvider API unavailable")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plugin registers without embedding secrets for inspect and doctor flows", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-plugin-"));
  try {
    const registered = makeApi({
      baseDbPath: join(tmp, "db"),
      embedding: { dimensions: 1536 },
    });
    assert.ok(registered.tools.length > 0);
    assert.ok(registered.commands.some(command => command.name === "plur1bus"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plugin routes /plur1bus obsidian commands through the control-room layer", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-plugin-"));
  try {
    const registered = makeApi(baseConfig(tmp, {
      obsidianBridge: { enabled: false },
    }));
    const command = registered.commands.find(item => item.name === "plur1bus");
    const result = await command.handler({ args: "obsidian doctor", workspaceDir: tmp, workspaceKey: "main", agentId: "main" });
    assert.match(result.text, /missing_vault_path|bridge_disabled/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plugin registers local-transformers config without api keys or model imports", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-plugin-"));
  try {
    const registered = makeApi({
      baseDbPath: join(tmp, "db"),
      embedding: {
        provider: "local-transformers",
        local: {
          model: "intfloat/multilingual-e5-small",
          dimensions: 384,
        },
      },
      reranker: {
        provider: "local-transformers",
        enabled: true,
        local: {
          model: "Alibaba-NLP/gte-reranker-modernbert-base",
        },
      },
    });
    assert.ok(registered.tools.length > 0);
    assert.ok(registered.commands.some(command => command.name === "plur1bus"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("autoRecall false disables dynamic prompt recall but leaves manual and corpus recall available", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-plugin-"));
  try {
    const registered = makeApi(baseConfig(tmp, { autoRecall: false }));
    const beforePrompt = registered.hooks.find(h => h.name === "before_prompt_build");
    assert.ok(beforePrompt, "hook remains registered for dispatch tracking and non-recall maintenance");
    const result = await beforePrompt.handler({ prompt: "agent crons allowed" }, { workspaceKey: "workspace-a", agentId: "agent-a" });
    assert.equal(result, undefined, "autoRecall false must not inject PLUR1BUS recall context");
    assert.ok(registered.corpusSupplements.length > 0, "CorpusSupplement remains available");
    assert.ok(registered.tools.length > 0, "memory_recall remains available via manual tools");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("before_prompt_build dedupes dynamic PLUR1BUS recall by turn key", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-plugin-"));
  try {
    const cfg = baseConfig(tmp, { neo: { enabled: true } });
    const store = createNeoStore(join(cfg.baseDbPath, "_neo"), "workspace-a");
    store.appendCandidates([{
      id: "m1",
      workspaceKey: "workspace-a",
      statement: "OpenClaw managed agent crons are allowed.",
      category: "tooling_constraint",
      status: "promoted",
      salience: 0.9,
      recency: 1,
      origin: { role: "user", trustLevel: "user_asserted" },
    }]);

    const registered = makeApi(cfg);
    const beforePrompt = registered.hooks.find(h => h.name === "before_prompt_build");
    const event = { runId: "run-a", sessionId: "session-a", prompt: "agent crons allowed" };
    const ctx = { workspaceKey: "workspace-a", agentId: "agent-a" };
    const first = await beforePrompt.handler(event, ctx);
    const second = await beforePrompt.handler(event, ctx);
    assert.match(first.prependContext, /<plur1bus-recall/);
    assert.equal(second, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CorpusSupplement resolves exactly one existing neo workspace without corpusDefaultWorkspaceKey", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-plugin-"));
  try {
    const cfg = baseConfig(tmp, { neo: { enabled: true } });
    const store = createNeoStore(join(cfg.baseDbPath, "_neo"), "workspace-a");
    store.appendCandidates([{
      id: "m1",
      workspaceKey: "workspace-a",
      statement: "PLUR1BUS CorpusSupplement should find this workspace.",
      category: "project_fact",
      status: "promoted",
      salience: 0.9,
      recency: 1,
      origin: { role: "user", trustLevel: "user_asserted" },
    }]);

    const registered = makeApi(cfg);
    const results = await registered.corpusSupplements[0].search({ query: "CorpusSupplement workspace", maxResults: 3 });
    assert.equal(results[0].id, "m1");
    assert.equal(results[0].corpus, "plur1bus");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

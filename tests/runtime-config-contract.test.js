import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin, * as pluginModule from "../index.js";
import { stableDirectoryCapabilitiesSupported } from "../lib/directory-capability.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";

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

// realpathSync: macOS tmpdir is a symlink (/var -> /private/var) while production
// code resolves real paths, so temp base dirs must be canonical for comparisons.
function makeTempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// Explicit named namespace routing needs fd-backed directory capabilities,
// which this platform may lack (e.g. darwin); those cases run only where supported.
const namedRoutingSkip = stableDirectoryCapabilitiesSupported()
  ? false
  : "explicit named namespace routing requires stable directory capabilities";

function makeApi(pluginConfig) {
  const calls = {
    resolvePath: 0,
    registerCommand: 0,
    registerTool: 0,
    registerService: 0,
    on: 0,
  };
  const logs = [];
  const handlers = new Map();
  return {
    pluginConfig,
    logger: {
      info(...args) { logs.push(["info", ...args]); },
      warn(...args) { logs.push(["warn", ...args]); },
      error(...args) { logs.push(["error", ...args]); },
      debug(...args) { logs.push(["debug", ...args]); },
    },
    resolvePath(value) {
      calls.resolvePath += 1;
      return value;
    },
    registerCommand() { calls.registerCommand += 1; },
    registerTool(factory) { calls.registerTool += 1; this.toolFactory = factory; },
    registerService() { calls.registerService += 1; },
    on(event, handler) {
      calls.on += 1;
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    calls,
    logs,
    handlers,
  };
}

function minimalConfig(baseDbPath, override = {}) {
  return {
    baseDbPath,
    embedding: { provider: "local-transformers", local: { dimensions: 384 } },
    autoCapture: false,
    autoRecall: false,
    neo: { enabled: false },
    obsidianBridge: { enabled: false },
    gc: { enabled: false },
    ...override,
  };
}

describe("runtime config contract", () => {
  async function capturePublicStoreAndRecallPaths(t, pluginConfig, expectedPath, options = {}) {
    const workspaceDir = makeTempDir("plur1bus-runtime-route-ws-");
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const seen = { store: [], init: [] };
    const originalEmbed = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    const originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    const originalSimilar = pluginModule.MemoryDB.prototype.findSimilar;
    const originalStore = pluginModule.MemoryDB.prototype.store;
    const originalInit = pluginModule.MemoryDB.prototype.init;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => Array(384).fill(0.1);
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async () => Array(384).fill(0.1);
    pluginModule.MemoryDB.prototype.findSimilar = async () => [];
    pluginModule.MemoryDB.prototype.store = async function storeCapture() { seen.store.push(this.dbPath); };
    pluginModule.MemoryDB.prototype.init = async function initCapture() {
      seen.init.push(this.dbPath);
      if (options.initErrorSuffix && this.dbPath.endsWith(options.initErrorSuffix)) {
        throw new Error("legacy init sentinel failure");
      }
      if (options.missingSuffix && this.dbPath.endsWith(options.missingSuffix)) {
        this.table = null;
        return false;
      }
      this.table = {
        countRows: async () => 0,
        vectorSearch() { return { limit() { return this; }, toArray: async () => [] }; },
        query() { return { where() { return this; }, limit() { return this; }, toArray: async () => [] }; },
      };
      return true;
    };
    t.after(() => {
      LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbed;
      LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
      pluginModule.MemoryDB.prototype.findSimilar = originalSimilar;
      pluginModule.MemoryDB.prototype.store = originalStore;
      pluginModule.MemoryDB.prototype.init = originalInit;
    });

    const api = makeApi(pluginConfig);
    plugin.register(api, { importRouting: async () => routingCapability });
    const tools = api.toolFactory({
      agentId: "route-agent",
      workspaceDir,
      workspaceKey: "runtime-route",
      userId: "owner",
    });
    const store = tools.find(({ name }) => name === "memory_store");
    const recall = tools.find(({ name }) => name === "memory_recall");
    const stored = await store.execute("store-route", { text: "runtime route capture", category: "fact" });
    assert.equal(stored.details?.action, "stored", JSON.stringify(stored));
    const recallResult = await recall.execute("recall-route", { query: "runtime route capture" });
    assert.deepEqual(seen.store, [expectedPath]);
    assert.ok(seen.init.includes(expectedPath), JSON.stringify(seen));
    return { recallResult, seen };
  }

  it("uses the exact custom flat base for public store and recall when namespaces are absent", async (t) => {
    const baseDbPath = makeTempDir("plur1bus-runtime-flat-");
    t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
    await capturePublicStoreAndRecallPaths(
      t,
      minimalConfig(baseDbPath, { merging: { enabled: false } }),
      join(baseDbPath, "route-agent"),
    );
  });

  it("routes an explicit named root through its active writer", { skip: namedRoutingSkip }, async (t) => {
    const baseDbPath = makeTempDir("plur1bus-runtime-root-");
    t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
    await capturePublicStoreAndRecallPaths(t, minimalConfig(baseDbPath, {
      merging: { enabled: false },
      namespaces: { activeWriteNamespace: "ns-write" },
    }), join(baseDbPath, "ns-write", "route-agent"));
  });

  it("preserves an explicit active namespace leaf without duplicating it", { skip: namedRoutingSkip }, async (t) => {
    const root = makeTempDir("plur1bus-runtime-leaf-");
    const baseDbPath = join(root, "ns-write");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    await capturePublicStoreAndRecallPaths(t, minimalConfig(baseDbPath, {
      merging: { enabled: false },
      namespaces: { activeWriteNamespace: "ns-write" },
    }), join(baseDbPath, "route-agent"));
  });

  it("creates and uses a missing explicit named root through public store and recall", { skip: namedRoutingSkip }, async (t) => {
    const parent = makeTempDir("plur1bus-runtime-missing-root-parent-");
    const baseDbPath = join(parent, "missing-root");
    const agentPath = join(baseDbPath, "ns-write", "route-agent");
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    assert.equal(existsSync(baseDbPath), false);

    const originalEmbed = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    const originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => [0.1, 0.2, 0.3];
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async () => [0.1, 0.2, 0.3];
    t.after(() => {
      LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbed;
      LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
    });

    const api = makeApi(minimalConfig(baseDbPath, {
      embedding: { provider: "local-transformers", local: { dimensions: 3 } },
      merging: { enabled: false },
      namespaces: { activeWriteNamespace: "ns-write" },
    }));
    plugin.register(api, { importRouting: async () => routingCapability });
    const tools = api.toolFactory({
      agentId: "route-agent", workspaceDir: parent, workspaceKey: "missing-root", userId: "owner",
    });
    const store = tools.find(({ name }) => name === "memory_store");
    const recall = tools.find(({ name }) => name === "memory_recall");
    const storeResult = await store.execute("missing-root-store", {
      text: "missing named root route fixture", category: "fact",
    });
    assert.equal(storeResult.details?.action, "stored", JSON.stringify(storeResult));
    const recallResult = await recall.execute("missing-root-recall", { query: "missing named root route fixture" });
    assert.equal(existsSync(agentPath), true);
    assert.doesNotMatch(recallResult.content[0].text, /failed/i);
    for (const stop of api.handlers.get("gateway_stop") || []) await stop();
  });

  async function runBeforePromptLegacyInit(t, initLegacy) {
    const baseDbPath = makeTempDir("plur1bus-runtime-hook-legacy-");
    t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
    const originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    const originalInit = pluginModule.MemoryDB.prototype.init;
    let activeTableUses = 0;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async () => Array(384).fill(0.1);
    pluginModule.MemoryDB.prototype.init = async function hookInitCapture() {
      if (this.dbPath.endsWith(join("legacy", "hook-agent"))) return initLegacy.call(this);
      this.table = {
        countRows: async () => { activeTableUses += 1; return 0; },
        vectorSearch() {
          activeTableUses += 1;
          return { where() { return this; }, limit() { return this; }, toArray: async () => [] };
        },
        query() {
          activeTableUses += 1;
          return { where() { return this; }, select() { return this; }, limit() { return this; }, toArray: async () => [] };
        },
      };
      return true;
    };
    t.after(() => {
      LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
      pluginModule.MemoryDB.prototype.init = originalInit;
    });

    const api = makeApi(minimalConfig(baseDbPath, {
      autoRecall: true,
      merging: { enabled: false },
      runtime: { recallTimeoutMs: 5000 },
      continuityEngine: { enabled: false },
      conversationReactivationRecall: { enabled: false },
      namespaces: {
        activeWriteNamespace: "active",
        activeRecallNamespaces: ["active"],
        legacyReadOnlyNamespaces: ["legacy"],
        crossNamespaceRecall: true,
      },
    }));
    plugin.register(api, { importRouting: async () => routingCapability });
    const hook = api.handlers.get("before_prompt_build")?.at(-1);
    assert.equal(typeof hook, "function");
    const result = await hook(
      { prompt: "causal legacy hook recall", messages: [{ role: "user", content: "causal legacy hook recall" }] },
      { agentId: "hook-agent", workspaceDir: null, sessionKey: `hook-${Math.random()}` },
    );
    return { result, activeTableUses, logs: api.logs, baseDbPath };
  }

  it("before_prompt_build skips an absent legacy DB and completes active recall", { skip: namedRoutingSkip }, async (t) => {
    const state = await runBeforePromptLegacyInit(t, async function missingLegacy() {
      this.table = null;
      return false;
    });
    assert.ok(state.activeTableUses > 0, "active recall pipeline must still run");
    assert.doesNotMatch(JSON.stringify(state.logs), /hook legacy init failure|recall failed/i);
    assert.ok(state.result && Object.hasOwn(state.result, "prependContext"));
    assert.equal(existsSync(join(state.baseDbPath, "legacy")), false, "read-only legacy route must stay absent");
  });

  it("before_prompt_build aborts without active partial recall when legacy init throws", { skip: namedRoutingSkip }, async (t) => {
    const state = await runBeforePromptLegacyInit(t, async function failingLegacy() {
      this.table = null;
      throw new Error("hook legacy init failure");
    });
    assert.equal(state.activeTableUses, 0, "no active namespace pipeline may run after init failure");
    assert.equal(state.result, undefined);
    assert.match(JSON.stringify(state.logs), /recall failed.*hook legacy init failure/i);
    assert.equal(existsSync(join(state.baseDbPath, "legacy")), false, "failed read-only legacy route must stay absent");
  });

  it("skips an absent read-only legacy DB during public recall", { skip: namedRoutingSkip }, async (t) => {
    const baseDbPath = makeTempDir("plur1bus-runtime-legacy-missing-");
    t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
    const { recallResult, seen } = await capturePublicStoreAndRecallPaths(t, minimalConfig(baseDbPath, {
      merging: { enabled: false },
      namespaces: {
        activeWriteNamespace: "active",
        activeRecallNamespaces: ["active"],
        legacyReadOnlyNamespaces: ["legacy"],
        crossNamespaceRecall: true,
      },
    }), join(baseDbPath, "active", "route-agent"), {
      missingSuffix: join("legacy", "route-agent"),
    });
    assert.ok(seen.init.some((path) => path.endsWith(join("legacy", "route-agent"))));
    assert.match(recallResult.content[0].text, /no relevant memories/i);
  });

  it("fails the whole public recall when a legacy DB init throws", { skip: namedRoutingSkip }, async (t) => {
    const baseDbPath = makeTempDir("plur1bus-runtime-legacy-error-");
    t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
    const { recallResult } = await capturePublicStoreAndRecallPaths(t, minimalConfig(baseDbPath, {
      merging: { enabled: false },
      namespaces: {
        activeWriteNamespace: "active",
        activeRecallNamespaces: ["active"],
        legacyReadOnlyNamespaces: ["legacy"],
        crossNamespaceRecall: true,
      },
    }), join(baseDbPath, "active", "route-agent"), {
      initErrorSuffix: join("legacy", "route-agent"),
    });
    assert.match(recallResult.content[0].text, /memory recall failed.*legacy init sentinel failure/i);
  });

  it("rejects an explicit base ending in a configured non-writer at the exact namespaces path", () => {
    const root = makeTempDir("plur1bus-runtime-nonwriter-");
    const api = makeApi(minimalConfig(join(root, "ns-read"), {
      namespaces: {
        activeWriteNamespace: "ns-write",
        activeRecallNamespaces: ["ns-write", "ns-read"],
      },
    }));
    try {
      assert.throws(() => plugin.register(api, { importRouting: async () => routingCapability }), (error) => {
        assert.equal(error?.configPath, "plugins.entries.memory-lancedb-namespaced.config.namespaces");
        assert.match(error.message, /non-writer|ambiguous/i);
        return true;
      });
      assert.equal(api.calls.registerTool, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid namespace config before the first API or filesystem action", () => {
    const parent = makeTempDir("plur1bus-runtime-invalid-ns-");
    const baseDbPath = join(parent, "must-not-exist");
    const api = makeApi(minimalConfig(baseDbPath, {
      namespaces: { activeWriteNamespace: "../escape" },
    }));
    try {
      assert.throws(() => plugin.register(api, { importRouting: async () => routingCapability }), (error) => {
        assert.equal(error?.configPath, "plugins.entries.memory-lancedb-namespaced.config.namespaces.activeWriteNamespace");
        return true;
      });
      assert.equal(api.calls.resolvePath, 0);
      assert.equal(existsSync(baseDbPath), false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects an invalid timezone before the first API call or filesystem setup", () => {
    const parent = makeTempDir("plur1bus-config-contract-");
    const baseDbPath = join(parent, "must-not-exist");
    const api = makeApi(minimalConfig(baseDbPath, {
      afterthought: { timezone: "Not/AZone" },
    }));
    try {
      assert.throws(
        () => plugin.register(api, { importRouting: async () => routingCapability }),
        (error) => {
          assert.equal(error?.code, "INVALID_PLUGIN_CONFIG");
          assert.equal(
            error?.configPath,
            "plugins.entries.memory-lancedb-namespaced.config.afterthought.timezone",
          );
          assert.match(error.message, /plugins\.entries\.memory-lancedb-namespaced\.config\.afterthought\.timezone/);
          return true;
        },
      );
      assert.deepEqual(api.calls, {
        resolvePath: 0,
        registerCommand: 0,
        registerTool: 0,
        registerService: 0,
        on: 0,
      });
      assert.equal(existsSync(baseDbPath), false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  for (const timezone of ["UTC", "Europe/Berlin", undefined, null, ""]) {
    it(`accepts ${JSON.stringify(timezone)} timezone compatibility input`, () => {
      const baseDbPath = makeTempDir("plur1bus-config-contract-valid-");
      const afterthought = timezone === undefined ? {} : { timezone };
      const api = makeApi(minimalConfig(baseDbPath, { afterthought }));
      try {
        assert.doesNotThrow(() => plugin.register(api, { importRouting: async () => routingCapability }));
        assert.ok(api.calls.resolvePath > 0);
        assert.ok(api.calls.registerCommand > 0);
      } finally {
        rmSync(baseDbPath, { recursive: true, force: true });
      }
    });
  }

  it("keeps enabled model-less core LLM features active without registration-time calls", () => {
    const baseDbPath = makeTempDir("plur1bus-config-contract-native-");
    let llmCalls = 0;
    const api = makeApi(minimalConfig(baseDbPath, {
      merging: { enabled: true },
      schicht15: { enabled: true },
      skillMiner: { enabled: true },
      criticalPush: { enabled: true },
      emotion: { tier: "t3", t3: { enabled: true } },
    }));
    api.runtime = {
      llm: {
        async complete() {
          llmCalls += 1;
          return { text: "unused", provider: "fake", model: "fake", agentId: "default", usage: {} };
        },
      },
    };
    try {
      assert.doesNotThrow(() => plugin.register(api, { importRouting: async () => routingCapability }));
      assert.equal(llmCalls, 0);
      assert.doesNotMatch(JSON.stringify(api.logs), /model is empty; disabling/i);
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
    }
  });

  it("describes Neo LLM availability in route terms instead of requiring merging.model", () => {
    const baseDbPath = makeTempDir("plur1bus-config-contract-neo-route-");
    const api = makeApi(minimalConfig(baseDbPath, {
      neo: { enabled: true },
      merging: { enabled: false },
    }));
    try {
      assert.doesNotThrow(() => plugin.register(api, { importRouting: async () => routingCapability }));
      const logs = JSON.stringify(api.logs);
      assert.match(logs, /merging\.enabled and an available LLM route/i);
      assert.doesNotMatch(logs, /config\.merging\.model|set merging\.model/i);
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
    }
  });

  it("treats an unresolved feature-local chat credential as unavailable without aborting registration", () => {
    const baseDbPath = makeTempDir("plur1bus-config-contract-credential-");
    const missingEnv = "PLUR1BUS_TEST_MISSING_CHAT_CREDENTIAL_90210";
    const previous = process.env[missingEnv];
    delete process.env[missingEnv];
    const api = makeApi(minimalConfig(baseDbPath, {
      merging: {
        enabled: true,
        model: "vendor/explicit-model",
        baseUrl: "https://credential-endpoint.invalid/v1",
        apiKey: `\${${missingEnv}}`,
      },
    }));
    try {
      assert.doesNotThrow(() => plugin.register(api, { importRouting: async () => routingCapability }));
      const logs = JSON.stringify(api.logs);
      assert.match(logs, /direct-credential-unavailable/);
      assert.doesNotMatch(logs, new RegExp(missingEnv));
      assert.doesNotMatch(logs, /credential-endpoint/);
    } finally {
      if (previous === undefined) delete process.env[missingEnv];
      else process.env[missingEnv] = previous;
      rmSync(baseDbPath, { recursive: true, force: true });
    }
  });
});

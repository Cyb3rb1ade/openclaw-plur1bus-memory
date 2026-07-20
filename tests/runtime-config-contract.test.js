import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin, * as pluginModule from "../index.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";

function makeApi(pluginConfig) {
  const calls = {
    resolvePath: 0,
    registerCommand: 0,
    registerTool: 0,
    registerService: 0,
    on: 0,
  };
  const logs = [];
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
    on() { calls.on += 1; },
    calls,
    logs,
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
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-runtime-route-ws-"));
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
    plugin.register(api);
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
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-runtime-flat-"));
    t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
    await capturePublicStoreAndRecallPaths(
      t,
      minimalConfig(baseDbPath, { merging: { enabled: false } }),
      join(baseDbPath, "route-agent"),
    );
  });

  it("routes an explicit named root through its active writer", async (t) => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-runtime-root-"));
    t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
    await capturePublicStoreAndRecallPaths(t, minimalConfig(baseDbPath, {
      merging: { enabled: false },
      namespaces: { activeWriteNamespace: "ns-write" },
    }), join(baseDbPath, "ns-write", "route-agent"));
  });

  it("preserves an explicit active namespace leaf without duplicating it", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-runtime-leaf-"));
    const baseDbPath = join(root, "ns-write");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    await capturePublicStoreAndRecallPaths(t, minimalConfig(baseDbPath, {
      merging: { enabled: false },
      namespaces: { activeWriteNamespace: "ns-write" },
    }), join(baseDbPath, "route-agent"));
  });

  it("skips an absent read-only legacy DB during public recall", async (t) => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-runtime-legacy-missing-"));
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

  it("fails the whole public recall when a legacy DB init throws", async (t) => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-runtime-legacy-error-"));
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
    const root = mkdtempSync(join(tmpdir(), "plur1bus-runtime-nonwriter-"));
    const api = makeApi(minimalConfig(join(root, "ns-read"), {
      namespaces: {
        activeWriteNamespace: "ns-write",
        activeRecallNamespaces: ["ns-write", "ns-read"],
      },
    }));
    try {
      assert.throws(() => plugin.register(api), (error) => {
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
    const parent = mkdtempSync(join(tmpdir(), "plur1bus-runtime-invalid-ns-"));
    const baseDbPath = join(parent, "must-not-exist");
    const api = makeApi(minimalConfig(baseDbPath, {
      namespaces: { activeWriteNamespace: "../escape" },
    }));
    try {
      assert.throws(() => plugin.register(api), (error) => {
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
    const parent = mkdtempSync(join(tmpdir(), "plur1bus-config-contract-"));
    const baseDbPath = join(parent, "must-not-exist");
    const api = makeApi(minimalConfig(baseDbPath, {
      afterthought: { timezone: "Not/AZone" },
    }));
    try {
      assert.throws(
        () => plugin.register(api),
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
      const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-config-contract-valid-"));
      const afterthought = timezone === undefined ? {} : { timezone };
      const api = makeApi(minimalConfig(baseDbPath, { afterthought }));
      try {
        assert.doesNotThrow(() => plugin.register(api));
        assert.ok(api.calls.resolvePath > 0);
        assert.ok(api.calls.registerCommand > 0);
      } finally {
        rmSync(baseDbPath, { recursive: true, force: true });
      }
    });
  }

  it("keeps enabled model-less core LLM features active without registration-time calls", () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-config-contract-native-"));
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
      assert.doesNotThrow(() => plugin.register(api));
      assert.equal(llmCalls, 0);
      assert.doesNotMatch(JSON.stringify(api.logs), /model is empty; disabling/i);
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
    }
  });

  it("describes Neo LLM availability in route terms instead of requiring merging.model", () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-config-contract-neo-route-"));
    const api = makeApi(minimalConfig(baseDbPath, {
      neo: { enabled: true },
      merging: { enabled: false },
    }));
    try {
      assert.doesNotThrow(() => plugin.register(api));
      const logs = JSON.stringify(api.logs);
      assert.match(logs, /merging\.enabled and an available LLM route/i);
      assert.doesNotMatch(logs, /config\.merging\.model|set merging\.model/i);
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
    }
  });

  it("treats an unresolved feature-local chat credential as unavailable without aborting registration", () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-config-contract-credential-"));
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
      assert.doesNotThrow(() => plugin.register(api));
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

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "../index.js";

function makeApi(pluginConfig) {
  const calls = {
    resolvePath: 0,
    registerCommand: 0,
    registerTool: 0,
    registerService: 0,
    on: 0,
  };
  const noop = () => {};
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
    registerTool() { calls.registerTool += 1; },
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

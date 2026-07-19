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
  return {
    pluginConfig,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    resolvePath(value) {
      calls.resolvePath += 1;
      return value;
    },
    registerCommand() { calls.registerCommand += 1; },
    registerTool() { calls.registerTool += 1; },
    registerService() { calls.registerService += 1; },
    on() { calls.on += 1; },
    calls,
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
});

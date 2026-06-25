import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "../index.js";
import { writePlur1busStartNotice } from "../lib/setup/feature-profiles.js";

function makeApi(baseDbPath, configOverrides = {}) {
  const commands = [];
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: 384 } },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: true },
      obsidianBridge: { enabled: false },
      gc: { enabled: false },
      ...configOverrides,
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    resolvePath: (p) => p,
    registerCommand(command) {
      commands.push(command);
    },
    registerTool: noop,
    registerService: noop,
    on: noop,
    _commands: commands,
  };
}

describe("/plur1bus start", () => {
  it("registers the slash alias and renders the Full Experience start flow", async () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-start-db-"));
    const openclawHome = mkdtempSync(join(tmpdir(), "plur1bus-start-home-"));
    const oldHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = openclawHome;
    try {
      writePlur1busStartNotice(openclawHome);
      const api = makeApi(baseDbPath);
      plugin.register(api);

      const command = api._commands.find((item) => item.name === "plur1bus_start");
      assert.ok(command, "plur1bus_start command should be registered");

      const result = await command.handler({ args: "", workspaceDir: baseDbPath, agentId: "agent-a" });
      assert.match(result.text, /PLUR1BUS — Make your agent yours/);
      assert.match(result.text, /Active: \d+\s+Disabled: \d+\s+New\/missing: \d+/);
      assert.match(result.text, /Temporal Continuity Context/);
      assert.match(result.text, /Obsidian:/);
      assert.match(result.text, /Reviews:/);
      assert.match(result.text, /Use \/plur1bus enable\|disable <feature>\./);
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
      rmSync(openclawHome, { recursive: true, force: true });
      if (oldHome === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = oldHome;
    }
  });

  it("keeps PLUR1BUS control commands registered when neo is disabled", () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-start-db-"));
    try {
      const api = makeApi(baseDbPath, { neo: { enabled: false } });
      plugin.register(api);

      const names = new Set(api._commands.map((item) => item.name));
      assert.ok(names.has("plur1bus_start"), "plur1bus_start should remain available");
      assert.ok(names.has("enable"), "enable should remain available");
      assert.ok(names.has("disable"), "disable should remain available");
      assert.ok(names.has("memory"), "memory should remain available");
      assert.ok(names.has("forget"), "forget should remain available");
      assert.ok(names.has("correct"), "correct should remain available");
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
    }
  });
});

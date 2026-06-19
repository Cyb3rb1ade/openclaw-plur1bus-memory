import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "../index.js";
import { writePlur1busStartNotice } from "../lib/setup/feature-profiles.js";

function makeApi(baseDbPath) {
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
      assert.match(result.text, /PLUR1BUS Full Experience Status/);
      assert.match(result.text, /Temporal Continuity Context/);
      assert.match(result.text, /Safety Gates:/);
      assert.match(result.text, /vaultPath:/);
      assert.match(result.text, /Installation status: complete/);
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
      rmSync(openclawHome, { recursive: true, force: true });
      if (oldHome === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = oldHome;
    }
  });
});

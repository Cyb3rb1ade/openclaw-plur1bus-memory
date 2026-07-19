import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("registers the slash alias and renders the read-only onboarding status", async () => {
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

  it("lists setup profiles without mutating openclaw.json", async () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-setup-list-db-"));
    const openclawHome = mkdtempSync(join(tmpdir(), "plur1bus-setup-list-home-"));
    const configPath = join(openclawHome, "openclaw.json");
    const original = '{"untouched":true}\n';
    const oldConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    writeFileSync(configPath, original);
    try {
      const api = makeApi(baseDbPath, { security: { allowedUserIds: ["owner"] } });
      plugin.register(api);
      const command = api._commands.find((item) => item.name === "plur1bus");
      const result = await command.handler({
        args: "setup",
        workspaceDir: baseDbPath,
        agentId: "agent-a",
        userId: "owner",
        chatId: "private-chat",
        chatType: "private",
      });

      assert.match(result.text, /recommended/);
      assert.match(result.text, /safe/);
      assert.equal(readFileSync(configPath, "utf8"), original);
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
      rmSync(openclawHome, { recursive: true, force: true });
      if (oldConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
      else process.env.OPENCLAW_CONFIG_PATH = oldConfigPath;
    }
  });

  it("applies Safe and Recommended only through explicit setup selections", async () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-setup-profile-db-"));
    const openclawHome = mkdtempSync(join(tmpdir(), "plur1bus-setup-profile-home-"));
    const configPath = join(openclawHome, "openclaw.json");
    const oldConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    const original = {
      untouched: { rollback: true },
      plugins: {
        entries: {
          "memory-lancedb-namespaced": {
            enabled: false,
            rollback: { previousBackend: "memory-lancedb" },
            config: {
              baseDbPath: "/custom/memory",
              embedding: { provider: "local-transformers", local: { dimensions: 384 } },
              reranker: { enabled: false, timeoutMs: 9999 },
            },
          },
        },
      },
    };
    try {
      const api = makeApi(baseDbPath, { security: { allowedUserIds: ["owner"] } });
      plugin.register(api);
      const command = api._commands.find((item) => item.name === "plur1bus");
      const context = {
        workspaceDir: baseDbPath,
        agentId: "agent-a",
        userId: "owner",
        chatId: "private-chat",
        chatType: "private",
      };

      for (const profile of ["safe", "recommended"]) {
        writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`);
        const result = await command.handler({ ...context, args: `setup ${profile}` });
        assert.match(result.text, new RegExp(`profile "${profile}" confirmed`, "i"));

        const written = JSON.parse(readFileSync(configPath, "utf8"));
        const entry = written.plugins.entries["memory-lancedb-namespaced"];
        assert.equal(entry.enabled, true);
        assert.equal(entry.config.setupProfile, profile);
        assert.equal(entry.config.reranker.enabled, false);
        assert.equal(entry.config.reranker.timeoutMs, 9999);
        assert.equal(entry.config.baseDbPath, "/custom/memory");
        assert.deepEqual(entry.rollback, original.plugins.entries["memory-lancedb-namespaced"].rollback);
        assert.deepEqual(written.untouched, original.untouched);
        if (profile === "safe") {
          assert.equal(entry.config.dailyConsolidation.enabled, false);
          assert.equal(entry.config.obsidianBridge.enabled, false);
        } else {
          assert.equal(entry.config.dailyConsolidation.enabled, true);
          assert.equal(entry.config.merging.autoApply, false);
          assert.equal(entry.config.obsidianBridge.dryRun, true);
          assert.equal(entry.config.obsidianBridge.requireVaultPathConfirmation, true);
        }
      }
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
      rmSync(openclawHome, { recursive: true, force: true });
      if (oldConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
      else process.env.OPENCLAW_CONFIG_PATH = oldConfigPath;
    }
  });
});

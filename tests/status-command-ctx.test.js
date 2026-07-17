/**
 * tests/status-command-ctx.test.js — Regression: /status darf nicht mit
 * "ctx is not defined" scheitern (Command-Handler kennen nur commandCtx,
 * kein Hook-ctx; Incident Bernd 2026-07-01).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.js";

const AGENT_ID = "status-test-agent";
const VECTOR_DIM = 8;

function makeMockApi(baseDbPath) {
  const noop = () => {};
  const commands = new Map();
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      emotion: { t3: { enabled: false } },
      obsidianBridge: { enabled: false },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      gc: { enabled: false },
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    resolvePath: (p) => p,
    registerCommand(command) {
      commands.set(command.name, command);
    },
    _commands: commands,
    registerTool: noop,
    on: noop,
    registerService: noop,
  };
}

describe("/status Command", () => {
  let basePath;
  let workspaceDir;
  let openclawHome;
  let originalOpenClawHome;

  before(() => {
    basePath = mkdtempSync(join(tmpdir(), "plur1bus-status-cmd-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-status-ws-"));
    originalOpenClawHome = process.env.OPENCLAW_HOME;
    openclawHome = mkdtempSync(join(tmpdir(), "openclaw-status-test-"));
    process.env.OPENCLAW_HOME = openclawHome;
    mkdirSync(join(openclawHome, ".openclaw", "memory", "_archive"), { recursive: true });
  });

  after(() => {
    try { rmSync(basePath, { recursive: true, force: true }); } catch {}
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch {}
    try { rmSync(openclawHome, { recursive: true, force: true }); } catch {}
    if (originalOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = originalOpenClawHome;
  });

  it("liefert Status statt 'ctx is not defined'", async () => {
    const api = makeMockApi(basePath);
    plugin.register(api);
    const statusCommand = api._commands.get("state");
    assert.ok(statusCommand, "state-Command sollte registriert sein");
    const result = await statusCommand.handler({
      agentId: AGENT_ID,
      workspaceDir,
      channel: "telegram",
      args: "",
    });
    assert.ok(result?.text, "Sollte Text liefern");
    assert.ok(!result.text.includes("is not defined"), `ReferenceError im Output: ${result.text}`);
    assert.ok(!result.text.toLowerCase().includes("failed"), `Status failed: ${result.text}`);
    assert.match(result.text, /LLM Result Cache/);
    assert.match(result.text, /Hit rate: 0\.0% \(0\/0\)/);
  });
});

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "../index.js";

function makeApi(baseDbPath, configOverrides = {}) {
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: 384 } },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      obsidianBridge: { enabled: false },
      gc: { enabled: false },
      ...configOverrides,
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    resolvePath: (p) => p,
    registerCommand: noop,
    registerTool(factory) { this._toolFactory = factory; },
    registerService: noop,
    on: noop,
  };
}

describe("model-facing destructive tool auth", () => {
  let baseDbPath;
  let workspaceDir;

  before(() => {
    baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-tool-auth-db-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-tool-auth-ws-"));
  });

  after(() => {
    rmSync(baseDbPath, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("blocks memory_forget and knowledge_update unless explicitly enabled", async () => {
    const api = makeApi(baseDbPath);
    plugin.register(api);
    const tools = api._toolFactory({ agentId: "tool-agent", workspaceDir });
    const forgetTool = tools.find((tool) => tool.name === "memory_forget");
    const knowledgeTool = tools.find((tool) => tool.name === "knowledge_update");

    const forgetResult = await forgetTool.execute("call-1", { memoryId: "11111111-1111-1111-1111-111111111111" });
    const knowledgeResult = await knowledgeTool.execute("call-2", { note: "test" });

    assert.match(forgetResult.content[0].text, /allowModelDestructiveMemoryOps=true/);
    assert.match(knowledgeResult.content[0].text, /allowModelDestructiveMemoryOps=true/);
  });

  it("allows memory_forget to proceed when explicitly enabled", async () => {
    const api = makeApi(baseDbPath, { security: { allowModelDestructiveMemoryOps: true } });
    plugin.register(api);
    const tools = api._toolFactory({ agentId: "tool-agent", workspaceDir });
    const forgetTool = tools.find((tool) => tool.name === "memory_forget");

    const result = await forgetTool.execute("call-3", { memoryId: "11111111-1111-1111-1111-111111111111" });
    assert.doesNotMatch(result.content[0].text, /allowModelDestructiveMemoryOps=true/);
  });
});

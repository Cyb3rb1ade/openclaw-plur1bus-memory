import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.js";

const EXPECTED_TOOL_NAMES = [
  "knowledge_update",
  "memory_forget",
  "memory_recall",
  "memory_search",
  "memory_store",
];

function makeMockApi(baseDbPath) {
  const noop = () => {};
  const registrations = [];
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: 384 } },
      obsidianBridge: { enabled: false },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      gc: { enabled: false },
      emotion: { t3: { enabled: false } },
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    resolvePath: (p) => p,
    registerCommand: noop,
    registerService: noop,
    on: noop,
    registerTool(tool, options) {
      registrations.push({ tool, options });
    },
    _registrations: registrations,
  };
}

describe("tool registration metadata", () => {
  it("declares PLUR1BUS factory tool names for OpenClaw allowlist discovery", () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-tool-meta-"));
    try {
      const api = makeMockApi(baseDbPath);
      plugin.register(api);

      const registration = api._registrations.find((entry) => typeof entry.tool === "function");
      assert.ok(registration, "expected PLUR1BUS to register a context-bound tool factory");
      assert.deepEqual(
        [...(registration.options?.names || [])].sort(),
        EXPECTED_TOOL_NAMES,
      );
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
    }
  });
});

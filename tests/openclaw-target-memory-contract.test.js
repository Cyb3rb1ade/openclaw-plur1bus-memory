import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function createApi() {
  const memoryCapabilities = [];
  const embeddingProviders = [];
  return {
    pluginConfig: {
      baseDbPath: "/tmp/plur1bus-openclaw-target-memory-contract",
      embedding: { provider: "local-transformers", local: { dimensions: 384 } },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      merging: { enabled: false },
      skillMiner: { enabled: false },
      obsidianBridge: { enabled: false },
      featureCronSetup: { auto: false },
      gc: { enabled: false },
    },
    config: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    runtime: {
      llm: null,
      agent: { async resolveAgentWorkspaceDir(_config, agentId) { return `/tmp/${agentId}`; } },
    },
    resolvePath: (value) => value,
    registerMemoryCapability(capability) { memoryCapabilities.push(capability); },
    registerEmbeddingProvider(adapter) { embeddingProviders.push(adapter); },
    registerCommand() {},
    registerTool() {},
    registerService() {},
    registerGatewayMethod() {},
    registerCli() {},
    on() {},
    _memoryCapabilities: memoryCapabilities,
    _embeddingProviders: embeddingProviders,
  };
}

describe("OpenClaw target release exclusive memory contract", () => {
  it("declares PLUR1BUS as the selected memory kind with only the generic embedding contract", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url)));
    assert.equal(manifest.kind, "memory");
    assert.deepEqual(manifest.contracts.embeddingProviders, [
      "plur1bus-openai",
      "plur1bus-openai-compatible",
      "plur1bus-e5-small",
    ]);
    assert.equal(Object.hasOwn(manifest.contracts, "memoryEmbeddingProviders"), false);
    assert.equal(
      manifest.configSchema.properties.dreaming.properties.enabled.default,
      false,
      "PLUR1BUS must default OpenClaw's memory-core dreaming sidecar off to avoid duplicate dreaming",
    );
    // The Memory page renders its sleep plan from doctor.memory.status, and the
    // host builds that from the slot owner's dreaming section: one shared cron
    // expression for all three phases plus a timezone. Without these keys the
    // schema rejects them (additionalProperties: false) and the page falls back
    // to its built-in "0 3 * * *", which is nobody's actual schedule.
    const dreamingSchema = manifest.configSchema.properties.dreaming.properties;
    assert.equal(dreamingSchema.frequency?.type, "string");
    assert.equal(dreamingSchema.timezone?.type, "string");
    assert.equal(
      Object.hasOwn(dreamingSchema.frequency, "default"),
      false,
      "an unset frequency must stay unset so the host default stands, not a value we invented",
    );
  });

  it("registers one deterministic memory capability and the declared embedding adapters", async () => {
    const pluginModule = await import(`../index.js?openclaw-target-memory-contract=${Date.now()}`);
    const api = createApi();
    pluginModule.default.register(api, {
      importRouting: async () => ({
        parseAgentSessionKey() { return null; },
        parseThreadSessionSuffix(value) { return { baseSessionKey: value, threadId: "" }; },
        normalizeOptionalAccountId(value) { return value || undefined; },
        normalizeMessageChannel(value) { return value || undefined; },
      }),
      skillWorkshop: null,
    });

    assert.equal(pluginModule.default.kind, "memory");
    assert.equal(api._memoryCapabilities.length, 1);
    assert.equal(api._memoryCapabilities[0].deterministicRecallToolName, "memory_recall");
    assert.equal(api._memoryCapabilities[0].supportsPrivateTranscriptRecall, false);
    // The bundled memory wiki enumerates our workspaces through this seam.
    // Without it its bridge import reports zero workspaces, not just zero
    // artifacts, because it never asks the filesystem itself.
    assert.equal(
      typeof api._memoryCapabilities[0].publicArtifacts?.listArtifacts,
      "function",
    );
    assert.deepEqual(api._embeddingProviders.map((adapter) => adapter.id), [
      "plur1bus-openai",
      "plur1bus-openai-compatible",
      "plur1bus-e5-small",
    ]);
  });
});

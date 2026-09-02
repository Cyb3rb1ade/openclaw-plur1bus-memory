import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import plugin from "../index.js";
import { runtimeIfUsable, shouldCoordinateLocalModelGeneration } from "../lib/runtime-shutdown.js";

/**
 * OpenClaw 2026.8.x registers plugins twice: once in a restricted mode to learn
 * their CLI surface, and once for real. In the restricted modes it substitutes
 * api.runtime with a Proxy that throws on *every* property access, so
 * `api.runtime?.x` is not safe -- optional chaining guards against null, not
 * against a throwing getter.
 *
 * A single unguarded probe aborted the whole registration, which took all four
 * PLUR1BUS CLI commands with it: `openclaw plur1bus-feature-cron` answered
 * "OpenClaw does not know the command". These tests pin the contract.
 *
 * Mirrors openclaw/dist/plugin-runtime-artifact-selection: createUnavailableRuntime
 * and buildPluginApi (every capability a noop; only registerCli is wired).
 */
const RESTRICTED_MODES = ["cli-metadata", "setup-only"];

const NOOP_CAPABILITIES = [
  "registerTool", "registerHook", "registerHttpRoute", "registerHostedMediaResolver",
  "registerWidgetPresenter", "registerMcpServerConnectionResolver", "registerChannel",
  "registerGatewayMethod", "registerSessionCatalog", "registerReload", "registerNodeHostCommand",
  "registerNodeInvokePolicy", "registerSecurityAuditCollector", "registerService",
  "registerGatewayDiscoveryService", "registerCliBackend", "registerTextTransforms",
  "registerConfigMigration", "registerMigrationProvider", "registerAutoEnableProbe",
  "registerProvider", "registerWorkerProvider", "registerModelCatalogProvider",
  "registerEmbeddingProvider", "registerSpeechProvider", "registerRealtimeTranscriptionProvider",
  "registerRealtimeVoiceProvider", "registerMediaUnderstandingProvider",
  "registerTranscriptSourceProvider", "registerImageGenerationProvider",
  "registerVideoGenerationProvider", "registerMusicGenerationProvider", "registerWebFetchProvider",
  "registerWebSearchProvider", "registerInteractiveHandler", "onConversationBindingResolved",
  "registerCommand", "registerContextEngine", "registerCompactionProvider", "registerAgentHarness",
  "registerCodexAppServerExtensionFactory", "registerAgentToolResultMiddleware",
  "registerSessionExtension", "registerTrustedToolPolicy", "registerToolMetadata",
  "registerControlUiDescriptor", "registerBoardWidgetContentKind", "registerRuntimeLifecycle",
  "registerAgentEventSubscription", "setRunContext", "getRunContext", "clearRunContext",
  "registerSessionSchedulerJob", "registerSessionAction", "registerDetachedTaskRuntime",
  "registerMemoryCapability", "registerMemoryPromptSupplement", "registerMemoryPromptPreparation",
  "registerMemoryCorpusSupplement", "on",
];

const EXPECTED_CLI_COMMANDS = [
  "plur1bus-feature-cron",
  "plur1bus-obsidian",
  "plur1bus-reembedding",
  "plur1bus-workspace",
];

function createUnavailableRuntime(registrationMode) {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property === "symbol") return undefined;
      throw new Error(
        `Plugin "memory-lancedb-namespaced" runtime is intentionally unavailable during "${registrationMode}" registration.`,
      );
    },
  });
}

function buildRestrictedApi(registrationMode, declared) {
  const api = {
    id: "memory-lancedb-namespaced",
    name: "memory-lancedb-namespaced",
    version: "7.5.0",
    registrationMode,
    config: {},
    pluginConfig: {},
    runtime: createUnavailableRuntime(registrationMode),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    resolvePath: (input) => input,
    registerCli: (_builder, opts) => {
      for (const descriptor of opts?.descriptors ?? []) declared.push(descriptor.name);
    },
  };
  for (const name of NOOP_CAPABILITIES) api[name] = () => {};
  return api;
}

describe("registration under a restricted OpenClaw runtime", () => {
  for (const mode of RESTRICTED_MODES) {
    it(`survives "${mode}" registration and still declares every CLI command`, () => {
      const declared = [];
      plugin.register(buildRestrictedApi(mode, declared));
      assert.deepEqual(declared.sort(), EXPECTED_CLI_COMMANDS);
    });
  }

  it("hides a runtime that must not be touched and passes a usable one through", () => {
    const runtime = { config: { current: () => ({}) } };
    assert.equal(runtimeIfUsable({ registrationMode: "full", runtime }), runtime);
    // No declared mode at all is treated as usable: older hosts never set it.
    assert.equal(runtimeIfUsable({ runtime }), runtime);
    // "discovery" is a real fourth mode and it carries a usable runtime. The
    // decision must follow the runtime itself, not a list of mode names, or a
    // mode the host adds later gets its live runtime hidden for no reason.
    assert.equal(runtimeIfUsable({ registrationMode: "discovery", runtime }), runtime);
    assert.equal(runtimeIfUsable({ registrationMode: "full" }), undefined);
    for (const mode of RESTRICTED_MODES) {
      assert.equal(
        runtimeIfUsable({ registrationMode: mode, runtime: createUnavailableRuntime(mode) }),
        undefined,
      );
    }
  });

  it("keeps model-generation ownership with a usable runtime only in full mode", () => {
    const runtime = { config: { current: () => ({}) } };
    const base = { runtime, registerRuntimeLifecycle: () => {} };
    assert.equal(shouldCoordinateLocalModelGeneration({ ...base, registrationMode: "full" }), true);
    assert.equal(shouldCoordinateLocalModelGeneration({ ...base, registrationMode: "discovery" }), false);
    assert.equal(shouldCoordinateLocalModelGeneration(base), true);
  });

  it("decides model-generation ownership without probing an unusable runtime", () => {
    for (const mode of RESTRICTED_MODES) {
      const api = {
        registrationMode: mode,
        runtime: createUnavailableRuntime(mode),
        registerRuntimeLifecycle: () => {},
      };
      assert.equal(shouldCoordinateLocalModelGeneration(api), false);
    }
  });
});

describe("manifest CLI declaration", () => {
  it("declares exactly the commands register() hands to OpenClaw", async () => {
    // OpenClaw's guidance names two remedies: declare the root commands in the
    // manifest, or defer runtime access. We do both -- the manifest lets the
    // host own the command name without loading the plugin, and a manifest that
    // drifts from the descriptors fails the same way, one stage later.
    const manifest = JSON.parse(
      await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    );
    const declared = [];
    plugin.register(buildRestrictedApi("cli-metadata", declared));

    assert.deepEqual(
      manifest.cliCommands.map((entry) => entry.name).sort(),
      declared.sort(),
      "manifest cliCommands and registerCli descriptors must not drift apart",
    );
    for (const entry of manifest.cliCommands) {
      assert.equal(typeof entry.description, "string");
      assert.ok(entry.description.length > 0, `${entry.name} needs a description`);
      assert.equal(entry.hasSubcommands, false);
    }
  });
});

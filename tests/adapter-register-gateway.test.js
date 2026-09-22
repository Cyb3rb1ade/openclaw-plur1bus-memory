/**
 * tests/adapter-register-gateway.test.js — PR-03i.
 *
 * The gateway_stop budget is the one that loses LanceDB writes when it is
 * wrong: the host default for gateway_stop is 5 000 ms and the plugin
 * deliberately overrides it to 30 000 ms (lib/runtime-shutdown.js:308,
 * host-contract §a.1). A move must not drop that override.
 *
 * The brief sketched one `registerGatewayLifecycle(ctx)` holding all three
 * hook pairs. Consolidating them into a single call site would reorder the
 * gateway_start/gateway_stop handler lists (register-commands.js registers
 * its control-health pair between the Obsidian bridge pair and the Neo
 * service pair today), which is an observable change. Each range therefore
 * keeps its own exported function and its original call position; the three
 * assertions below are the brief's, retargeted.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  registerGatewayShutdownServices,
  registerNeoServiceLifecycle,
  registerNeoWorkerWarmUp,
  registerObsidianBridgeLifecycle,
} from "../adapter/openclaw/register-gateway.js";
import { createStubHost } from "../lib/host-services.js";

function makeApi() {
  const registrations = [];
  return {
    registrations,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, handler, options) { registrations.push({ name, handler, options }); return { dispose() {} }; },
    registerService(service) { registrations.push({ name: "service", service }); },
  };
}

describe("registerNeoServiceLifecycle", () => {
  it("registers the Neo service pair with the 30 000 ms budget", () => {
    const api = makeApi();
    registerNeoServiceLifecycle({
      api,
      host: createStubHost(),
      neoEnabled: true,
      neoRoot: "/tmp/neo",
      neoWorkerRuntime: null,
    });
    const stops = api.registrations.filter((r) => r.name === "gateway_stop");
    assert.ok(stops.length >= 1, "at least the Neo service stop must be registered");
    assert.ok(
      stops.some((r) => r.options?.timeoutMs === 30_000),
      "the 30 000 ms gateway_stop override must survive: the host default is 5 000 ms and LanceDB writes are lost under it",
    );
  });

  it("falls back to registerService when the host has no hook surface", () => {
    const api = makeApi();
    delete api.on;
    registerNeoServiceLifecycle({
      api,
      host: createStubHost(),
      neoEnabled: true,
      neoRoot: "/tmp/neo",
      neoWorkerRuntime: null,
    });
    assert.ok(api.registrations.some((r) => r.name === "service" && r.service?.id === "plur1bus-neo-maintenance"));
  });

  it("registers nothing when Neo is disabled", () => {
    const api = makeApi();
    registerNeoServiceLifecycle({ api, host: createStubHost(), neoEnabled: false, neoRoot: null, neoWorkerRuntime: null });
    assert.equal(api.registrations.length, 0);
  });
});

describe("registerNeoWorkerWarmUp", () => {
  it("warms the Neo worker on gateway_start within 5 000 ms", () => {
    const api = makeApi();
    let warmed = false;
    registerNeoWorkerWarmUp({
      api,
      host: createStubHost(),
      neoWorkerRuntime: { warmUp() { warmed = true; return true; } },
    });
    const start = api.registrations.find((r) => r.name === "gateway_start" && r.options?.timeoutMs === 5_000);
    assert.ok(start, "the warm-up registration keeps its 5 000 ms budget");
    start.handler();
    assert.equal(warmed, false, "warm-up is deferred on an unref'd timer, not run inline");
  });

  it("registers nothing without a worker runtime", () => {
    const api = makeApi();
    registerNeoWorkerWarmUp({ api, host: createStubHost(), neoWorkerRuntime: null });
    assert.equal(api.registrations.length, 0);
  });
});

describe("registerObsidianBridgeLifecycle", () => {
  it("prefers registerService for the Obsidian bridge and falls back to the hook pair", () => {
    const bridgeService = { id: "bridge", start() {}, stop() {} };

    const withService = makeApi();
    registerObsidianBridgeLifecycle({
      api: withService,
      host: createStubHost(),
      bridgeService,
      obsidianBridgeCfg: { watch: true },
    });
    assert.ok(withService.registrations.some((r) => r.name === "service" && r.service === bridgeService));

    const withoutService = makeApi();
    delete withoutService.registerService;
    registerObsidianBridgeLifecycle({
      api: withoutService,
      host: createStubHost(),
      bridgeService,
      obsidianBridgeCfg: { watch: true },
    });
    const pairs = withoutService.registrations.filter((r) => r.options?.timeoutMs === 30_000);
    assert.equal(pairs.length, 2, "without registerService the bridge falls back to gateway_start/stop");
    assert.deepEqual(pairs.map((r) => r.name), ["gateway_start", "gateway_stop"]);
  });

  it("registers no lifecycle when watch is off", () => {
    const api = makeApi();
    registerObsidianBridgeLifecycle({
      api,
      host: createStubHost(),
      bridgeService: { id: "bridge", start() {}, stop() {} },
      obsidianBridgeCfg: { watch: false, dryRun: false },
    });
    assert.equal(api.registrations.length, 0);
  });
});

describe("registerGatewayShutdownServices", () => {
  it("registers the gateway_stop owner before the four after-lifecycle services", () => {
    const api = makeApi();
    api.registerCli = undefined;
    registerGatewayShutdownServices({
      api,
      clearInitializedTurnRoutes: () => {},
      coordinatesLocalModelGeneration: false,
      embeddings: null,
      legacyMigrationShutdown: { abort() {} },
      llmResultCache: null,
      localModelGeneration: null,
      memoryDbAdapter: null,
      modelPreparationCoordinator: null,
      pool: { shutdown: async () => {} },
      reembeddingCoordinator: null,
      reembeddingSwitchRecovery: null,
      reranker: null,
      scopedEmbeddingServer: null,
      sharedMemoryPool: null,
    });
    const stops = api.registrations.filter((r) => r.name === "gateway_stop");
    assert.equal(stops.length, 1, "lifecycle ownership registers exactly one gateway_stop handler");
    assert.equal(
      stops[0].options?.timeoutMs,
      30_000,
      "the shutdown owner keeps the 30 000 ms budget; the 5 000 ms host default loses LanceDB writes",
    );
  });
});

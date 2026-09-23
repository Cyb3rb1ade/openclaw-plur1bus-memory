/**
 * tests/adapter-register-cron.test.js — PR-03i.
 *
 * The two feature-cron registrations keep their own call sites in
 * `register()`: the `before_agent_reply` guard is registered before the
 * chat-command surface (tests/critical-review-command.test.js reads the *last*
 * `before_agent_reply` handler), and the deferred bootstrap keeps its
 * `gateway_start` slot between the Obsidian bridge pair and the Neo service
 * pair. The budgets below are the contract: 30 000 ms while the native cron
 * capability is missing (the bootstrap then runs immediately and must be
 * allowed to finish), 5 000 ms once it is ready (the work is deferred by
 * 90 s on an unref'd timer).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  registerDeferredFeatureCronBootstrap,
  registerUnsafeDirectCronGuard,
} from "../adapter/openclaw/register-cron.js";
import { createStubHost } from "../lib/host-services.js";

function makeApi() {
  const registrations = [];
  return {
    registrations,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, handler, options) { registrations.push({ name, handler, options }); return { dispose() {} }; },
  };
}

describe("registerUnsafeDirectCronGuard", () => {
  it("registers the before_agent_reply guard only while native dispatch is missing", () => {
    const api = makeApi();
    registerUnsafeDirectCronGuard({
      api,
      cronDirectDispatchReady: false,
      guardUnsafeDirectCronTurn: () => ({ blocked: true }),
    });
    assert.deepEqual(api.registrations.map((r) => r.name), ["before_agent_reply"]);

    const ready = makeApi();
    registerUnsafeDirectCronGuard({
      api: ready,
      cronDirectDispatchReady: true,
      guardUnsafeDirectCronTurn: () => ({ blocked: true }),
    });
    assert.equal(ready.registrations.length, 0);
  });

  it("threads hostReady into the guard", () => {
    const api = makeApi();
    const seen = [];
    registerUnsafeDirectCronGuard({
      api,
      cronDirectDispatchReady: false,
      guardUnsafeDirectCronTurn: (event, context, options) => { seen.push({ event, context, options }); },
    });
    api.registrations[0].handler({ e: 1 }, { c: 2 });
    assert.deepEqual(seen, [{ event: { e: 1 }, context: { c: 2 }, options: { hostReady: false } }]);
  });
});

describe("registerDeferredFeatureCronBootstrap", () => {
  it("keeps the 30 000 ms budget while native dispatch is missing", () => {
    const api = makeApi();
    registerDeferredFeatureCronBootstrap({
      api,
      baseDbPath: "/tmp/plur1bus-cron-test",
      cfg: {},
      cronDirectDispatchReady: false,
      host: createStubHost(),
      reconcileUnsafeDirectCronsWithService: async () => {},
      runDeferredFeatureCronBootstrap: async () => {},
    });
    const start = api.registrations.find((r) => r.name === "gateway_start");
    assert.ok(start, "the deferred bootstrap registers on gateway_start");
    assert.equal(start.options?.timeoutMs, 30_000);
  });

  it("drops to the 5 000 ms budget once native dispatch is ready", () => {
    const api = makeApi();
    registerDeferredFeatureCronBootstrap({
      api,
      baseDbPath: "/tmp/plur1bus-cron-test",
      cfg: {},
      cronDirectDispatchReady: true,
      host: createStubHost(),
      reconcileUnsafeDirectCronsWithService: async () => {},
      runDeferredFeatureCronBootstrap: async () => {},
    });
    assert.equal(api.registrations[0].options?.timeoutMs, 5_000);
  });

  it("stays registered when auto setup is off but native dispatch is missing", () => {
    const off = makeApi();
    registerDeferredFeatureCronBootstrap({
      api: off,
      baseDbPath: "/tmp/plur1bus-cron-test",
      cfg: { featureCronSetup: { auto: false } },
      cronDirectDispatchReady: true,
      host: createStubHost(),
      reconcileUnsafeDirectCronsWithService: async () => {},
      runDeferredFeatureCronBootstrap: async () => {},
    });
    assert.equal(off.registrations.length, 0);

    const unsafe = makeApi();
    registerDeferredFeatureCronBootstrap({
      api: unsafe,
      baseDbPath: "/tmp/plur1bus-cron-test",
      cfg: { featureCronSetup: { auto: false } },
      cronDirectDispatchReady: false,
      host: createStubHost(),
      reconcileUnsafeDirectCronsWithService: async () => {},
      runDeferredFeatureCronBootstrap: async () => {},
    });
    assert.equal(unsafe.registrations.length, 1);
  });
});

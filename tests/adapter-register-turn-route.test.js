/**
 * tests/adapter-register-turn-route.test.js — PR-03b.
 *
 * The turn-route observer is the only proof of channel identity the OpenClaw
 * adapter has (host-contract §c.1), and its registration options are part of
 * the contract: lowest possible priority, and only the agent/acp dispatch
 * kinds.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerTurnRouteHooks } from "../adapter/openclaw/register-turn-route.js";
import { createStubHost } from "../lib/host-services.js";

function makeApi() {
  const registrations = [];
  return {
    registrations,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, handler, options) {
      registrations.push({ name, handler, options });
      return { dispose() {} };
    },
  };
}

describe("registerTurnRouteHooks", () => {
  it("registers reply_dispatch at minimum priority for agent and acp only", () => {
    const api = makeApi();
    registerTurnRouteHooks({
      api,
      host: createStubHost(),
      autoRecall: true,
      getMemoryTurnRoutes: async () => null,
      turnRouteState: {},
    });
    const dispatch = api.registrations.find((r) => r.name === "reply_dispatch");
    assert.ok(dispatch, "reply_dispatch must be registered");
    assert.equal(dispatch.options.priority, Number.MIN_SAFE_INTEGER);
    assert.deepEqual(dispatch.options.eligibleDispatchKinds, ["agent", "acp"]);
  });

  it("observes a dispatch and returns undefined", async () => {
    const api = makeApi();
    const observed = [];
    const turnRoutes = { observeReplyDispatch: (event) => observed.push(event), lastObserve: () => "registered" };
    registerTurnRouteHooks({
      api,
      host: createStubHost(),
      autoRecall: true,
      getMemoryTurnRoutes: async () => turnRoutes,
      turnRouteState: {},
    });
    const dispatch = api.registrations.find((r) => r.name === "reply_dispatch");
    const result = await dispatch.handler({ sessionKey: "agent:a:s", runId: "r" }, { dispatchKind: "agent" });
    assert.equal(result, undefined);
    assert.equal(observed.length, 1);
  });

  it("clears the run on agent_end only once the routes have initialised", async () => {
    const api = makeApi();
    const cleared = [];
    const turnRouteState = {};
    registerTurnRouteHooks({
      api,
      host: createStubHost(),
      autoRecall: true,
      getMemoryTurnRoutes: async () => null,
      turnRouteState,
    });
    const end = api.registrations.find((r) => r.name === "agent_end");
    assert.equal(await end.handler({ runId: "r1" }, {}), undefined, "no init promise means no work");
    turnRouteState.initPromise = Promise.resolve({ clearRun: (id) => cleared.push(id) });
    await end.handler({}, { runId: "r2" });
    assert.deepEqual(cleared, ["r2"]);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getProcessSingleton, resetProcessSingleton } from "../lib/process-singleton.js";
import { getSharedMemoryTurnRouteRegistry, SHARED_TURN_ROUTES_KEY } from "../lib/memory-request-context.js";
import { getSharedDeferredDynamicsQueue, SHARED_DYNAMICS_QUEUE_KEY } from "../lib/deferred-dynamics-queue.js";
import { getSharedNeoWorkerRuntime, SHARED_NEO_WORKER_KEY } from "../lib/neo-worker-runtime.js";

// 7.12.36: Zustand, der Plugin-Instanzen ueberleben muss.
const routingCapability = Object.freeze({
  parseAgentSessionKey(value) { const m = /^agent:([^:]+):(.+)$/.exec(value); return m ? { agentId: m[1], rest: m[2] } : null; },
  parseThreadSessionSuffix(value) { return { baseSessionKey: value, threadId: "" }; },
  normalizeOptionalAccountId(value) { return value || undefined; },
  normalizeMessageChannel(value) { return value || undefined; },
  isIncognitoSessionKey() { return false; },
});

describe("process singletons", () => {
  it("returns the same object for the same key and can be reset", () => {
    resetProcessSingleton("plur1bus.test.singleton");
    const a = getProcessSingleton("plur1bus.test.singleton", () => ({ id: 1 }));
    const b = getProcessSingleton("plur1bus.test.singleton", () => ({ id: 2 }));
    assert.equal(a, b);
    assert.equal(b.id, 1);
    assert.equal(resetProcessSingleton("plur1bus.test.singleton"), true);
    assert.equal(getProcessSingleton("plur1bus.test.singleton", () => ({ id: 3 })).id, 3);
    resetProcessSingleton("plur1bus.test.singleton");
  });

  it("shares the turn route registry across plugin instances: a ticket observed by one is claimable by another", () => {
    resetProcessSingleton(SHARED_TURN_ROUTES_KEY);
    const gatewayInstance = getSharedMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    const runInstance = getSharedMemoryTurnRouteRegistry({ routingCapability, logger: { warn() {} } });
    assert.equal(gatewayInstance, runInstance);
    const SESSION_KEY = "agent:main:telegram:default:direct:55736530";
    gatewayInstance.observeReplyDispatch({
      sessionKey: SESSION_KEY, originatingChannel: "telegram", originatingTo: "55736530", originatingAccountId: "default",
      ctx: { AgentId: "main", SessionKey: SESSION_KEY, AccountId: "default", SenderId: "55736530", Provider: "telegram", ChatId: "55736530", OriginatingTo: "55736530", CommandBody: "hallo" },
    });
    assert.equal(runInstance.pendingCount(), 1);
    const claimed = runInstance.claimForPrompt({ runId: "run-1", sessionKey: SESSION_KEY, sessionId: "s" }, "account-session", () => true);
    assert.ok(claimed);
    assert.equal(runInstance.explain(SESSION_KEY), "observe:registered:session|claim:claimed");
    resetProcessSingleton(SHARED_TURN_ROUTES_KEY);
  });

  it("shares the dynamics queue and the worker runtime, replacing a closed runtime", async () => {
    resetProcessSingleton(SHARED_DYNAMICS_QUEUE_KEY);
    const q1 = getSharedDeferredDynamicsQueue({ fallbackDelayMs: 60_000 });
    const q2 = getSharedDeferredDynamicsQueue({ fallbackDelayMs: 0 });
    assert.equal(q1, q2);
    q1.close();
    resetProcessSingleton(SHARED_DYNAMICS_QUEUE_KEY);

    resetProcessSingleton(SHARED_NEO_WORKER_KEY);
    const w1 = getSharedNeoWorkerRuntime({});
    assert.equal(getSharedNeoWorkerRuntime({}), w1);
    await w1.close();
    assert.equal(w1.isClosed(), true);
    const w2 = getSharedNeoWorkerRuntime({});
    assert.notEqual(w2, w1, "a closed runtime is replaced");
    await w2.close();
    resetProcessSingleton(SHARED_NEO_WORKER_KEY);
  });
});

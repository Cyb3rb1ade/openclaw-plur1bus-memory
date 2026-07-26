import assert from "node:assert/strict";
import test from "node:test";

import {
  LLM_ROUTE_KINDS,
  completeFeatureLlm,
  isLlmRouteAvailable,
  resolveFeatureLlmRoute,
} from "../lib/llm-router.js";

function createLogger() {
  const calls = [];
  return {
    calls,
    warn(...args) {
      calls.push(args);
    },
  };
}

function createTimerHarness() {
  const scheduled = [];
  const cleared = [];
  return {
    scheduled,
    cleared,
    setTimer(callback, timeoutMs) {
      const handle = { callback, timeoutMs };
      scheduled.push(handle);
      return handle;
    },
    clearTimer(handle) {
      cleared.push(handle);
    },
  };
}

function createInspectableCallerSignal() {
  const listeners = new Set();
  let addCount = 0;
  let removeCount = 0;
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(event, listener) {
      assert.equal(event, "abort");
      addCount += 1;
      listeners.add(listener);
    },
    removeEventListener(event, listener) {
      assert.equal(event, "abort");
      removeCount += 1;
      listeners.delete(listener);
    },
  };

  return {
    signal,
    abort(reason) {
      signal.aborted = true;
      signal.reason = reason;
      for (const listener of [...listeners]) listener();
    },
    listenerCount() {
      return listeners.size;
    },
    addCount() {
      return addCount;
    },
    removeCount() {
      return removeCount;
    },
  };
}

test("resolves an absent feature model to the native OpenClaw default", () => {
  let nativeCalls = 0;
  const runtimeLlm = {
    async complete() {
      nativeCalls += 1;
    },
  };
  const logger = createLogger();
  const resultCache = { getOrCompute() {} };

  const route = resolveFeatureLlmRoute({}, {
    feature: "capture-summary",
    runtimeLlm,
    logger,
    resultCache,
  });

  assert.equal(route.kind, LLM_ROUTE_KINDS.OPENCLAW_DEFAULT);
  assert.equal(route.feature, "capture-summary");
  assert.equal(route.runtimeLlm, runtimeLlm);
  assert.equal(route.logger, logger);
  assert.equal(route.resultCache, resultCache);
  assert.equal(Object.hasOwn(route, "model"), false);
  assert.equal(Object.hasOwn(route, "baseUrl"), false);
  assert.equal(Object.hasOwn(route, "apiKey"), false);
  assert.equal(Object.hasOwn(route, "headers"), false);
  assert.equal(Object.isFrozen(route), true);
  assert.equal(isLlmRouteAvailable(route), true);
  assert.equal(nativeCalls, 0);
  assert.deepEqual(logger.calls, []);
});

test("resolves a feature-local model without direct transport to a native override", () => {
  const runtimeLlm = { async complete() {} };
  const route = resolveFeatureLlmRoute({
    model: "  anthropic/claude-sonnet-4-6  ",
    disableThinking: true,
    timeoutMs: 4_321,
  }, {
    feature: "merging",
    runtimeLlm,
    logger: createLogger(),
  });

  assert.equal(route.kind, LLM_ROUTE_KINDS.OPENCLAW_OVERRIDE);
  assert.equal(route.model, "anthropic/claude-sonnet-4-6");
  assert.equal(route.disableThinking, true);
  assert.equal(route.timeoutMs, 4_321);
  assert.equal(Object.hasOwn(route, "baseUrl"), false);
  assert.equal(Object.hasOwn(route, "apiKey"), false);
  assert.equal(Object.hasOwn(route, "headers"), false);
  assert.equal(isLlmRouteAvailable(route), true);
});

test("resolves a complete feature-local direct override and snapshots its headers", () => {
  const headers = {
    Authorization: "Bearer second-secret",
    "X-Tenant": "tenant-a",
  };
  const runtimeLlm = { async complete() {} };
  const resultCache = { getOrCompute() {} };
  const route = resolveFeatureLlmRoute({
    model: " vendor/model-a ",
    baseUrl: " https://llm.example/v1 ",
    apiKey: " secret-value ",
    headers,
    disableThinking: true,
    timeoutMs: 9_876,
  }, {
    feature: "skill-miner",
    runtimeLlm,
    logger: createLogger(),
    resultCache,
  });

  assert.equal(route.kind, LLM_ROUTE_KINDS.DIRECT_OVERRIDE);
  assert.equal(route.model, "vendor/model-a");
  assert.equal(route.baseUrl, "https://llm.example/v1");
  assert.equal(route.apiKey, "secret-value");
  assert.deepEqual(route.headers, {
    Authorization: "Bearer second-secret",
    "X-Tenant": "tenant-a",
  });
  assert.notEqual(route.headers, headers);
  assert.equal(Object.isFrozen(route.headers), true);
  assert.equal(route.resultCache, resultCache);

  headers.Authorization = "Bearer later-mutation";
  headers["X-New"] = "new-value";
  assert.deepEqual(route.headers, {
    Authorization: "Bearer second-secret",
    "X-Tenant": "tenant-a",
  });
  assert.throws(() => {
    route.headers.Authorization = "Bearer descriptor-mutation";
  }, TypeError);
});

test("fails closed on direct transport without a feature-local model", () => {
  let nativeCalls = 0;
  const runtimeLlm = {
    async complete() {
      nativeCalls += 1;
    },
  };
  const logger = createLogger();
  const route = resolveFeatureLlmRoute({
    baseUrl: "https://llm.example/v1",
    apiKey: "partial-secret-value",
    headers: { Authorization: "Bearer partial-header-secret" },
  }, {
    feature: "critical-push",
    runtimeLlm,
    logger,
  });

  assert.equal(route.kind, LLM_ROUTE_KINDS.UNAVAILABLE);
  assert.equal(route.reason, "ambiguous-partial-override");
  assert.equal(isLlmRouteAvailable(route), false);
  assert.equal(nativeCalls, 0);
  assert.equal(Object.hasOwn(route, "model"), false);
  assert.equal(Object.hasOwn(route, "baseUrl"), false);
  assert.equal(Object.hasOwn(route, "apiKey"), false);
  assert.equal(Object.hasOwn(route, "headers"), false);
  assert.equal(logger.calls.length, 1);

  const serializedLog = JSON.stringify(logger.calls);
  assert.match(serializedLog, /ambiguous-partial-override/);
  assert.match(serializedLog, /critical-push/);
  assert.doesNotMatch(serializedLog, /llm\.example/);
  assert.doesNotMatch(serializedLog, /partial-secret-value/);
  assert.doesNotMatch(serializedLog, /partial-header-secret/);
});

test("treats blank strings and an empty headers object as absent values", () => {
  const runtimeLlm = { async complete() {} };
  const route = resolveFeatureLlmRoute({
    model: "   ",
    baseUrl: "\t",
    apiKey: "\n",
    headers: {},
  }, {
    feature: "afterthought",
    runtimeLlm,
    logger: createLogger(),
  });

  assert.equal(route.kind, LLM_ROUTE_KINDS.OPENCLAW_DEFAULT);
  assert.equal(Object.hasOwn(route, "model"), false);
  assert.equal(Object.hasOwn(route, "baseUrl"), false);
  assert.equal(Object.hasOwn(route, "apiKey"), false);
  assert.equal(Object.hasOwn(route, "headers"), false);
});

test("ignores nested config from a different feature", () => {
  const route = resolveFeatureLlmRoute({
    merging: {
      model: "foreign/model",
      apiKey: "foreign-secret",
    },
  }, {
    feature: "wiki",
    runtimeLlm: { async complete() {} },
    logger: createLogger(),
  });

  assert.equal(route.kind, LLM_ROUTE_KINDS.OPENCLAW_DEFAULT);
  assert.equal(Object.hasOwn(route, "model"), false);
});

test("defers missing native runtime availability until dispatch", async () => {
  const logger = createLogger();
  const timer = createTimerHarness();
  const route = resolveFeatureLlmRoute({}, {
    feature: "dream-narrative",
    runtimeLlm: { complete: null },
    logger,
  });

  assert.equal(route.kind, LLM_ROUTE_KINDS.OPENCLAW_DEFAULT);
  assert.equal(Object.hasOwn(route, "model"), false);
  assert.equal(isLlmRouteAvailable(route), true);
  assert.deepEqual(logger.calls, []);

  const promptSecret = "runtime-missing-prompt-secret-601";
  const result = await completeFeatureLlm([
    { role: "user", content: promptSecret },
  ], route, { agentId: "agent-a", purpose: "dream-narrative" }, timer);

  assert.deepEqual(result, {
    status: "unavailable",
    text: null,
    route: LLM_ROUTE_KINDS.UNAVAILABLE,
    reason: "openclaw-runtime-unavailable",
  });
  assert.equal(timer.scheduled.length, 0);
  assert.equal(logger.calls.length, 1);
  const serializedLog = JSON.stringify(logger.calls);
  assert.match(serializedLog, /openclaw-runtime-unavailable/);
  assert.doesNotMatch(serializedLog, new RegExp(promptSecret));
});

test("prefers the ambiguous-partial-override failure over runtime availability", () => {
  const route = resolveFeatureLlmRoute({
    headers: { Authorization: "Bearer orphaned-secret" },
  }, {
    feature: "emotion-classification",
    runtimeLlm: null,
    logger: createLogger(),
  });

  assert.equal(route.kind, LLM_ROUTE_KINDS.UNAVAILABLE);
  assert.equal(route.reason, "ambiguous-partial-override");
});

test("fails closed when a configured direct credential could not be resolved", async () => {
  let nativeCalls = 0;
  let directCalls = 0;
  const logger = createLogger();
  const route = resolveFeatureLlmRoute({
    model: "vendor/model-a",
    baseUrl: "https://credential-endpoint.example/v1",
  }, {
    feature: "skill-miner",
    runtimeLlm: {
      async complete() {
        nativeCalls += 1;
      },
    },
    logger,
    credentialUnavailable: true,
  });

  assert.equal(route.kind, LLM_ROUTE_KINDS.UNAVAILABLE);
  assert.equal(route.reason, "direct-credential-unavailable");
  assert.equal(Object.hasOwn(route, "model"), false);
  assert.equal(Object.hasOwn(route, "baseUrl"), false);
  const result = await completeFeatureLlm([], route, {}, {
    async directCall() {
      directCalls += 1;
    },
  });
  assert.equal(nativeCalls, 0);
  assert.equal(directCalls, 0);
  assert.deepEqual(result, {
    status: "unavailable",
    text: null,
    route: LLM_ROUTE_KINDS.UNAVAILABLE,
    reason: "direct-credential-unavailable",
  });

  const serializedLog = JSON.stringify(logger.calls);
  assert.match(serializedLog, /direct-credential-unavailable/);
  assert.match(serializedLog, /skill-miner/);
  assert.doesNotMatch(serializedLog, /vendor\/model-a/);
  assert.doesNotMatch(serializedLog, /credential-endpoint/);
});

test("isLlmRouteAvailable rejects absent and unavailable descriptors", () => {
  assert.equal(isLlmRouteAvailable(null), false);
  assert.equal(isLlmRouteAvailable(undefined), false);
  assert.equal(isLlmRouteAvailable({ kind: LLM_ROUTE_KINDS.UNAVAILABLE }), false);
});

test("native default dispatch omits model and direct-only options", async () => {
  const messages = [{ role: "user", content: "private prompt" }];
  const timer = createTimerHarness();
  const resultCache = {
    calls: 0,
    getOrCompute() {
      this.calls += 1;
    },
  };
  let receivedParams;
  const runtimeLlm = {
    async complete(params) {
      receivedParams = params;
      return {
        text: "  host answer  ",
        provider: "anthropic",
        model: "claude-agent-a",
        agentId: "agent-a",
        usage: { inputTokens: 12, outputTokens: 4 },
      };
    },
  };
  const route = resolveFeatureLlmRoute({}, {
    feature: "capture-summary",
    runtimeLlm,
    logger: createLogger(),
    resultCache,
  });

  const result = await completeFeatureLlm(messages, route, {
    agentId: "agent-a",
    purpose: "capture-summary",
    maxTokens: 240,
    temperature: 0.25,
    jsonMode: true,
    disableThinking: true,
    timeoutMs: 777,
    resultCacheContext: { scopeId: "agent-a", purpose: "capture-summary" },
  }, timer);

  assert.equal(receivedParams.messages, messages);
  // agentId stays out of the host call — see the dedicated regression test at
  // the end of this file.
  assert.equal(Object.hasOwn(receivedParams, "agentId"), false);
  assert.equal(receivedParams.purpose, "capture-summary");
  assert.equal(receivedParams.maxTokens, 240);
  assert.equal(receivedParams.temperature, 0.25);
  assert.equal(receivedParams.signal instanceof AbortSignal, true);
  assert.equal(Object.hasOwn(receivedParams, "model"), false);
  assert.equal(Object.hasOwn(receivedParams, "baseUrl"), false);
  assert.equal(Object.hasOwn(receivedParams, "apiKey"), false);
  assert.equal(Object.hasOwn(receivedParams, "headers"), false);
  assert.equal(Object.hasOwn(receivedParams, "jsonMode"), false);
  assert.equal(Object.hasOwn(receivedParams, "disableThinking"), false);
  assert.equal(Object.hasOwn(receivedParams, "resultCache"), false);
  assert.equal(resultCache.calls, 0);
  assert.deepEqual(result, {
    status: "ok",
    text: "host answer",
    route: LLM_ROUTE_KINDS.OPENCLAW_DEFAULT,
    provider: "anthropic",
    model: "claude-agent-a",
    agentId: "agent-a",
    usage: { inputTokens: 12, outputTokens: 4 },
  });
  assert.equal(timer.scheduled.length, 1);
  assert.equal(timer.scheduled[0].timeoutMs, 777);
  assert.deepEqual(timer.cleared, [timer.scheduled[0]]);
});

test("one native-default route reports the host-resolved agent per call", async () => {
  // The host owns agent resolution for plugin LLM calls and rejects any
  // caller-supplied agentId, so each call reports back whichever agent and
  // model the host actually used.
  const timer = createTimerHarness();
  const seenParams = [];
  let hostAgent = "host-resolved-a";
  const runtimeLlm = {
    async complete(params) {
      seenParams.push(params);
      return {
        text: `answer for ${hostAgent}`,
        provider: "fake-host",
        model: `model-for-${hostAgent}`,
        agentId: hostAgent,
      };
    },
  };
  const route = resolveFeatureLlmRoute({}, {
    feature: "recall-query-summary",
    runtimeLlm,
    logger: createLogger(),
  });

  const first = await completeFeatureLlm([], route, {
    agentId: "agent-a",
    purpose: "recall-query-summary",
  }, timer);
  hostAgent = "host-resolved-b";
  const second = await completeFeatureLlm([], route, {
    agentId: "agent-b",
    purpose: "recall-query-summary",
  }, timer);

  for (const params of seenParams) {
    assert.equal(Object.hasOwn(params, "agentId"), false);
  }
  assert.equal(first.model, "model-for-host-resolved-a");
  assert.equal(first.agentId, "host-resolved-a");
  assert.equal(second.model, "model-for-host-resolved-b");
  assert.equal(second.agentId, "host-resolved-b");
  assert.equal(timer.scheduled.length, 2);
  assert.equal(timer.cleared.length, 2);
});

test("native explicit dispatch sends exactly the feature-local model", async () => {
  const timer = createTimerHarness();
  let receivedParams;
  const runtimeLlm = {
    async complete(params) {
      receivedParams = params;
      return { text: "explicit answer", provider: "anthropic", model: params.model };
    },
  };
  const route = resolveFeatureLlmRoute({ model: "anthropic/explicit-model" }, {
    feature: "merging",
    runtimeLlm,
    logger: createLogger(),
  });

  const result = await completeFeatureLlm([], route, {
    agentId: "agent-a",
    purpose: "merge-decision",
  }, timer);

  assert.equal(receivedParams.model, "anthropic/explicit-model");
  assert.equal(result.status, "ok");
  assert.equal(result.route, LLM_ROUTE_KINDS.OPENCLAW_OVERRIDE);
  assert.equal(result.model, "anthropic/explicit-model");
});

test("call-local native capability overrides the registered route runtime", async () => {
  let registeredCalls = 0;
  let sessionCalls = 0;
  let receivedParams;
  const route = resolveFeatureLlmRoute({}, {
    feature: "wiki",
    runtimeLlm: {
      async complete() {
        registeredCalls += 1;
        return { text: "wrong runtime" };
      },
    },
    logger: createLogger(),
  });
  const sessionRuntimeLlm = {
    async complete(params) {
      sessionCalls += 1;
      receivedParams = params;
      return {
        text: "session answer",
        provider: "session-provider",
        model: "session-model",
      };
    },
  };
  const timer = createTimerHarness();

  const result = await completeFeatureLlm([], route, {
    runtimeLlm: sessionRuntimeLlm,
    purpose: "wiki",
    maxTokens: 99,
    temperature: 0.4,
    jsonMode: true,
    disableThinking: true,
    resultCacheContext: { scopeId: "agent-session", purpose: "wiki" },
  }, timer);

  assert.equal(registeredCalls, 0);
  assert.equal(sessionCalls, 1);
  assert.equal(Object.hasOwn(receivedParams, "agentId"), false);
  assert.equal(receivedParams.purpose, "wiki");
  assert.equal(receivedParams.maxTokens, 99);
  assert.equal(receivedParams.temperature, 0.4);
  assert.equal(Object.hasOwn(receivedParams, "runtimeLlm"), false);
  assert.equal(Object.hasOwn(receivedParams, "model"), false);
  assert.equal(Object.hasOwn(receivedParams, "jsonMode"), false);
  assert.equal(Object.hasOwn(receivedParams, "disableThinking"), false);
  assert.equal(Object.hasOwn(receivedParams, "resultCacheContext"), false);
  assert.equal(result.text, "session answer");
  assert.equal(result.provider, "session-provider");
  assert.equal(result.model, "session-model");
});

test("call-local native capability executes a route resolved without registration runtime", async () => {
  const logger = createLogger();
  let receivedParams;
  const route = resolveFeatureLlmRoute({ model: "anthropic/session-explicit" }, {
    feature: "merging",
    runtimeLlm: null,
    logger,
  });
  assert.equal(route.kind, LLM_ROUTE_KINDS.OPENCLAW_OVERRIDE);
  assert.equal(route.model, "anthropic/session-explicit");
  assert.deepEqual(logger.calls, []);

  const timer = createTimerHarness();
  const result = await completeFeatureLlm([], route, {
    runtimeLlm: {
      async complete(params) {
        receivedParams = params;
        return {
          text: "session explicit answer",
          provider: "session-provider",
          model: params.model,
        };
      },
    },
    purpose: "merge-decision",
  }, timer);

  assert.equal(receivedParams.model, "anthropic/session-explicit");
  assert.equal(Object.hasOwn(receivedParams, "agentId"), false);
  assert.equal(result.status, "ok");
  assert.equal(result.route, LLM_ROUTE_KINDS.OPENCLAW_OVERRIDE);
  assert.equal(result.text, "session explicit answer");
});

test("direct explicit dispatch uses only the direct adapter and retains exact-cache context", async () => {
  let nativeCalls = 0;
  const runtimeLlm = {
    async complete() {
      nativeCalls += 1;
    },
  };
  const resultCache = { getOrCompute() {} };
  const route = resolveFeatureLlmRoute({
    model: "vendor/model-a",
    baseUrl: "https://llm.example/v1",
    apiKey: "direct-secret",
    headers: { Authorization: "Bearer header-secret" },
    disableThinking: true,
    timeoutMs: 5_000,
  }, {
    feature: "skill-miner",
    runtimeLlm,
    logger: createLogger(),
    resultCache,
  });
  const calls = [];
  const directCall = async (...args) => {
    calls.push(args);
    return "  direct answer  ";
  };
  const messages = [{ role: "user", content: "extract a skill" }];
  const resultCacheContext = { scopeId: "agent-a", purpose: "skill-extraction" };
  const callerSignal = new AbortController().signal;

  const result = await completeFeatureLlm(messages, route, {
    agentId: "agent-a",
    purpose: "skill-extraction",
    maxTokens: 333,
    temperature: 0.1,
    jsonMode: true,
    disableThinking: false,
    timeoutMs: 2_500,
    signal: callerSignal,
    resultCacheContext,
  }, { directCall });

  assert.equal(nativeCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], messages);
  assert.deepEqual(calls[0][1], {
    model: "vendor/model-a",
    baseUrl: "https://llm.example/v1",
    apiKey: "direct-secret",
    headers: { Authorization: "Bearer header-secret" },
    maxTokens: 333,
    temperature: 0.1,
    jsonMode: true,
    disableThinking: false,
    timeoutMs: 2_500,
    signal: callerSignal,
    resultCache,
    resultCacheContext,
  });
  assert.deepEqual(calls[0][2], { resultCache });
  assert.deepEqual(result, {
    status: "ok",
    text: "direct answer",
    route: LLM_ROUTE_KINDS.DIRECT_OVERRIDE,
    provider: undefined,
    model: "vendor/model-a",
    agentId: "agent-a",
    usage: undefined,
  });
});

test("unavailable dispatch calls neither transport and returns its fixed reason", async () => {
  let nativeCalls = 0;
  let directCalls = 0;
  const route = resolveFeatureLlmRoute({ baseUrl: "https://llm.example/v1" }, {
    feature: "critical-push",
    runtimeLlm: {
      async complete() {
        nativeCalls += 1;
      },
    },
    logger: createLogger(),
  });

  const result = await completeFeatureLlm([], route, {}, {
    async directCall() {
      directCalls += 1;
    },
  });

  assert.equal(nativeCalls, 0);
  assert.equal(directCalls, 0);
  assert.deepEqual(result, {
    status: "unavailable",
    text: null,
    route: LLM_ROUTE_KINDS.UNAVAILABLE,
    reason: "ambiguous-partial-override",
  });
});

test("native rejection returns the original error without logging its message or prompt", async () => {
  const logger = createLogger();
  const timer = createTimerHarness();
  const promptSecret = "prompt-secret-native-417";
  const upstreamSecret = "upstream-secret-native-932";
  const originalError = new Error(`provider exposed ${upstreamSecret}`);
  originalError.name = `SecretError-${upstreamSecret}`;
  const route = resolveFeatureLlmRoute({}, {
    feature: "capture-summary",
    runtimeLlm: {
      async complete() {
        throw originalError;
      },
    },
    logger,
  });

  const result = await completeFeatureLlm([
    { role: "user", content: promptSecret },
  ], route, { agentId: "agent-a", purpose: "capture-summary" }, timer);

  assert.equal(result.status, "failed");
  assert.equal(result.text, null);
  assert.equal(result.route, LLM_ROUTE_KINDS.OPENCLAW_DEFAULT);
  assert.equal(result.error, originalError);
  assert.equal(logger.calls.length, 1);
  const serializedLog = JSON.stringify(logger.calls);
  assert.match(serializedLog, /transport-failed/);
  assert.match(serializedLog, /"errorClass":"Error"/);
  assert.doesNotMatch(serializedLog, new RegExp(promptSecret));
  assert.doesNotMatch(serializedLog, new RegExp(upstreamSecret));
  assert.doesNotMatch(serializedLog, /provider exposed/);
});

test("direct rejection returns the original error without logging config or prompt secrets", async () => {
  const logger = createLogger();
  const promptSecret = "prompt-secret-direct-183";
  const apiSecret = "api-secret-direct-274";
  const headerSecret = "header-secret-direct-365";
  const upstreamSecret = "upstream-secret-direct-456";
  const originalError = new TypeError(`provider exposed ${upstreamSecret}`);
  const route = resolveFeatureLlmRoute({
    model: "vendor/model-a",
    apiKey: apiSecret,
    headers: { Authorization: `Bearer ${headerSecret}` },
  }, {
    feature: "skill-miner",
    runtimeLlm: { async complete() {} },
    logger,
  });

  const result = await completeFeatureLlm([
    { role: "user", content: promptSecret },
  ], route, { agentId: "agent-a", purpose: "skill-extraction" }, {
    async directCall() {
      throw originalError;
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.route, LLM_ROUTE_KINDS.DIRECT_OVERRIDE);
  assert.equal(result.error, originalError);
  const serializedLog = JSON.stringify(logger.calls);
  assert.match(serializedLog, /transport-failed/);
  assert.match(serializedLog, /"errorClass":"TypeError"/);
  for (const secret of [promptSecret, apiSecret, headerSecret, upstreamSecret]) {
    assert.doesNotMatch(serializedLog, new RegExp(secret));
  }
  assert.doesNotMatch(serializedLog, /provider exposed/);
});

test("native timeout aborts the request and clears its timer", async () => {
  const logger = createLogger();
  const timer = createTimerHarness();
  let receivedSignal;
  const route = resolveFeatureLlmRoute({}, {
    feature: "dream-narrative",
    runtimeLlm: {
      async complete(params) {
        receivedSignal = params.signal;
        return await new Promise((resolve, reject) => {
          params.signal.addEventListener("abort", () => reject(params.signal.reason), {
            once: true,
          });
        });
      },
    },
    logger,
  });

  const pending = completeFeatureLlm([], route, {
    agentId: "agent-a",
    purpose: "dream-narrative",
    timeoutMs: 42,
  }, timer);
  assert.equal(timer.scheduled.length, 1);
  timer.scheduled[0].callback();
  const result = await pending;

  assert.equal(receivedSignal.aborted, true);
  assert.equal(result.status, "failed");
  assert.equal(result.error, receivedSignal.reason);
  assert.equal(result.error.name, "TimeoutError");
  assert.deepEqual(timer.cleared, [timer.scheduled[0]]);
});

test("native timeout settles even when the runtime ignores abort", async () => {
  let receivedSignal;
  const route = resolveFeatureLlmRoute({}, {
    feature: "recall-query",
    runtimeLlm: {
      async complete(params) {
        receivedSignal = params.signal;
        return new Promise(() => {});
      },
    },
    logger: createLogger(),
  });

  const pending = completeFeatureLlm([], route, {
    agentId: "agent-a",
    purpose: "recall-query",
    timeoutMs: 15,
  });
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve("still-pending"), 60)),
  ]);

  assert.notEqual(outcome, "still-pending", "timeout must release the caller slot");
  assert.equal(receivedSignal.aborted, true);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, receivedSignal.reason);
  assert.equal(outcome.error.name, "TimeoutError");
});

test("a pre-aborted caller starts neither native nor direct transport", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  let nativeCalls = 0;
  let directCalls = 0;
  const nativeRoute = resolveFeatureLlmRoute({}, {
    feature: "capture-summary",
    runtimeLlm: {
      async complete() {
        nativeCalls += 1;
        return "late native";
      },
    },
    logger: createLogger(),
  });
  const directRoute = resolveFeatureLlmRoute({
    model: "vendor/model-a",
    apiKey: "direct-secret",
  }, {
    feature: "capture-summary",
    logger: createLogger(),
  });

  const nativeResult = await completeFeatureLlm([], nativeRoute, {
    signal: controller.signal,
  });
  const directResult = await completeFeatureLlm([], directRoute, {
    signal: controller.signal,
  }, {
    async directCall() {
      directCalls += 1;
      return "late direct";
    },
  });

  assert.equal(nativeCalls, 0);
  assert.equal(directCalls, 0);
  assert.equal(nativeResult.status, "failed");
  assert.equal(directResult.status, "failed");
  assert.equal(nativeResult.error.name, "AbortError");
  assert.equal(directResult.error.name, "AbortError");
});

test("caller cancellation aborts native dispatch and removes its listener after settlement", async () => {
  const logger = createLogger();
  const timer = createTimerHarness();
  const caller = createInspectableCallerSignal();
  const cancellationSecret = "caller-secret-reason-572";
  const originalError = new Error(`cancelled because ${cancellationSecret}`);
  let receivedSignal;
  const route = resolveFeatureLlmRoute({}, {
    feature: "afterthought",
    runtimeLlm: {
      async complete(params) {
        receivedSignal = params.signal;
        return await new Promise((resolve, reject) => {
          params.signal.addEventListener("abort", () => reject(params.signal.reason), {
            once: true,
          });
        });
      },
    },
    logger,
  });

  const pending = completeFeatureLlm([], route, {
    agentId: "agent-a",
    purpose: "afterthought",
    timeoutMs: 999,
    signal: caller.signal,
  }, timer);
  assert.equal(caller.listenerCount(), 1);
  caller.abort(originalError);
  const result = await pending;

  assert.equal(receivedSignal.aborted, true);
  assert.equal(receivedSignal.reason, originalError);
  assert.equal(result.error, originalError);
  assert.equal(caller.listenerCount(), 0);
  assert.equal(caller.addCount(), 1);
  assert.equal(caller.removeCount(), 1);
  assert.deepEqual(timer.cleared, [timer.scheduled[0]]);
  assert.doesNotMatch(JSON.stringify(logger.calls), new RegExp(cancellationSecret));
});

test("native success removes the caller abort listener and timer", async () => {
  const caller = createInspectableCallerSignal();
  const timer = createTimerHarness();
  const route = resolveFeatureLlmRoute({}, {
    feature: "wiki",
    runtimeLlm: {
      async complete() {
        return { text: "wiki answer" };
      },
    },
    logger: createLogger(),
  });

  const result = await completeFeatureLlm([], route, {
    signal: caller.signal,
    timeoutMs: 123,
  }, timer);

  assert.equal(result.status, "ok");
  assert.equal(caller.listenerCount(), 0);
  assert.equal(caller.addCount(), 1);
  assert.equal(caller.removeCount(), 1);
  assert.deepEqual(timer.cleared, [timer.scheduled[0]]);
});

test("native routes never forward agentId to the OpenClaw runtime", async () => {
  // Regression (2026-07-26): the host builds plugin LLM runtimes with
  // authority.allowAgentIdOverride === false, and hook-scoped handles carry no
  // bound agent. Sending agentId made resolveAgentId() throw "Plugin LLM
  // completion cannot override the target agent.", which killed every
  // openclaw-default call — emotionT3, persona-voice, dream-narrative,
  // episode-extraction and conversation-insights all fell back silently.
  const timer = createTimerHarness();
  let receivedParams;
  const runtimeLlm = {
    async complete(params) {
      receivedParams = params;
      if (Object.hasOwn(params, "agentId")) {
        throw new Error("Plugin LLM completion cannot override the target agent.");
      }
      return { text: "host answer" };
    },
  };
  const route = resolveFeatureLlmRoute({}, {
    feature: "emotionT3",
    runtimeLlm,
    logger: createLogger(),
  });

  const result = await completeFeatureLlm([], route, {
    agentId: "bernhardine",
    purpose: "emotion-classification",
  }, timer);

  assert.equal(Object.hasOwn(receivedParams, "agentId"), false);
  assert.equal(receivedParams.purpose, "emotion-classification");
  assert.equal(result.status, "ok");
  assert.equal(result.text, "host answer");
});

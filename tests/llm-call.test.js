import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callLlm } from "../lib/llm-call.js";
import {
  LLM_RESULT_CACHE_PURPOSES,
  createLlmResultCache,
  withLlmResultCacheContext,
} from "../lib/llm-result-cache.js";

function makeResponse({ text, reasoningContent, usage }) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "m",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text ?? null,
        ...(reasoningContent === undefined ? {} : { reasoning_content: reasoningContent }),
      },
      finish_reason: "stop",
    }],
    ...(usage === undefined ? {} : { usage }),
  };
}

function makeFakeOpenAI(calls, queuedResponses) {
  return class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (body) => {
            calls.push(body);
            const next = queuedResponses.shift();
            if (next instanceof Error) throw next;
            return makeResponse(next || {});
          },
        },
      };
    }
  };
}

test("callLlm forwards temperature and caches only explicit allowlisted context", async () => {
  const cache = createLlmResultCache();
  const calls = [];
  const OpenAI = makeFakeOpenAI(calls, [
    {
      text: "first",
      usage: {
        prompt_tokens: 20,
        completion_tokens: 6,
        total_tokens: 26,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    },
    { text: "second" },
  ]);
  const cfg = withLlmResultCacheContext({
    model: "m",
    apiKey: "k",
    baseUrl: "https://example/v1",
    maxTokens: 50,
    temperature: 0,
  }, "agent-a", LLM_RESULT_CACHE_PURPOSES.CAPTURE_SUMMARY);
  const messages = [{ role: "user", content: "same" }];

  assert.equal(await callLlm(messages, cfg, { OpenAI, resultCache: cache }), "first");
  assert.equal(calls[0].temperature, 0);
  assert.equal(await callLlm(messages, cfg, { OpenAI, resultCache: cache }), "first");
  assert.equal(calls.length, 1);
  assert.equal(cache.getMetrics("agent-a").avoidedInputTokens, 20);
});

test("callLlm normalizes both provider usage shapes including cached input tokens", async () => {
  const cache = createLlmResultCache();
  const calls = [];
  const OpenAI = makeFakeOpenAI(calls, [
    {
      text: "legacy",
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    },
    {
      text: "modern",
      usage: {
        input_tokens: 13,
        output_tokens: 5,
        total_tokens: 18,
        input_tokens_details: { cached_tokens: 4 },
      },
    },
  ]);
  const legacyCfg = withLlmResultCacheContext(
    { model: "m" },
    "agent-a",
    LLM_RESULT_CACHE_PURPOSES.CAPTURE_SUMMARY,
  );
  const modernCfg = withLlmResultCacheContext(
    { model: "m" },
    "agent-a",
    LLM_RESULT_CACHE_PURPOSES.MERGE_DECISION,
  );
  const legacyMessages = [{ role: "user", content: "legacy usage" }];
  const modernMessages = [{ role: "user", content: "modern usage" }];

  assert.equal(await callLlm(legacyMessages, legacyCfg, { OpenAI, resultCache: cache }), "legacy");
  assert.equal(await callLlm(legacyMessages, legacyCfg, { OpenAI, resultCache: cache }), "legacy");
  assert.equal(await callLlm(modernMessages, modernCfg, { OpenAI, resultCache: cache }), "modern");
  assert.equal(await callLlm(modernMessages, modernCfg, { OpenAI, resultCache: cache }), "modern");

  const metrics = cache.getMetrics("agent-a");
  assert.equal(calls.length, 2);
  assert.equal(metrics.avoidedInputTokens, 24);
  assert.equal(metrics.avoidedOutputTokens, 12);
  assert.equal(metrics.upstreamProviderCachedInputTokens, 7);
});

test("weather purpose is always live and never served from cache", async () => {
  const cache = createLlmResultCache();
  const calls = [];
  const OpenAI = makeFakeOpenAI(calls, [{ text: "rain" }, { text: "sun" }]);
  const weatherCfg = withLlmResultCacheContext({ model: "m", temperature: 0 }, "agent-a", "weather");
  const messages = [{ role: "user", content: "wie wird das Wetter morgen?" }];

  assert.equal(await callLlm(messages, weatherCfg, { OpenAI, resultCache: cache }), "rain");
  assert.equal(await callLlm(messages, weatherCfg, { OpenAI, resultCache: cache }), "sun");
  assert.equal(calls.length, 2);
});

test("ordinary calls without cache context always reach upstream", async () => {
  const cache = createLlmResultCache();
  const calls = [];
  const OpenAI = makeFakeOpenAI(calls, [{ text: "one" }, { text: "two" }]);
  const messages = [{ role: "user", content: "hello" }];

  assert.equal(await callLlm(messages, { model: "m" }, { OpenAI, resultCache: cache }), "one");
  assert.equal(await callLlm(messages, { model: "m" }, { OpenAI, resultCache: cache }), "two");
  assert.equal(calls.length, 2);
});

test("callLlm omits non-finite temperature from the provider body", async () => {
  const calls = [];
  const OpenAI = makeFakeOpenAI(calls, [{ text: "live" }]);

  assert.equal(await callLlm(
    [{ role: "user", content: "hello" }],
    { model: "m", temperature: Number.POSITIVE_INFINITY },
    { OpenAI },
  ), "live");
  assert.equal(Object.hasOwn(calls[0], "temperature"), false);
});

test("callLlm forwards cancellation to the direct provider request", async () => {
  const requests = [];
  class SignalAwareOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (body, options) => {
            requests.push({ body, options });
            return makeResponse({ text: "live" });
          },
        },
      };
    }
  }
  const signal = new AbortController().signal;

  assert.equal(await callLlm(
    [{ role: "user", content: "hello" }],
    { model: "m", signal },
    { OpenAI: SignalAwareOpenAI },
  ), "live");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.signal, signal);
});

test("provider errors are not cached and cache persistence errors fail open", async (t) => {
  const cache = createLlmResultCache();
  const calls = [];
  const OpenAI = makeFakeOpenAI(calls, [new Error("provider down"), { text: "recovered" }]);
  const cfg = withLlmResultCacheContext(
    { model: "m" },
    "agent-a",
    LLM_RESULT_CACHE_PURPOSES.CAPTURE_SUMMARY,
  );
  const messages = [{ role: "user", content: "retry me" }];

  await assert.rejects(
    () => callLlm(messages, cfg, { OpenAI, resultCache: cache }),
    /provider down/,
  );
  assert.equal(await callLlm(messages, cfg, { OpenAI, resultCache: cache }), "recovered");
  assert.equal(await callLlm(messages, cfg, { OpenAI, resultCache: cache }), "recovered");
  assert.equal(calls.length, 2);

  const dir = mkdtempSync(join(tmpdir(), "plur1bus-llm-call-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const warnings = [];
  const persistenceCache = createLlmResultCache({
    persist: true,
    baseDbPath: dir,
    logger: { warn: (...args) => warnings.push(args) },
    loadSqlite: async () => ({
      DatabaseSync: class {
        exec() {}
        close() {}
      },
    }),
    chmodFile: () => { throw new Error("chmod denied"); },
  });
  t.after(() => persistenceCache.close());
  const persistenceCalls = [];
  const PersistenceOpenAI = makeFakeOpenAI(persistenceCalls, [{ text: "live despite cache failure" }]);
  const persistenceCfg = withLlmResultCacheContext(
    { model: "m" },
    "agent-b",
    LLM_RESULT_CACHE_PURPOSES.CAPTURE_SUMMARY,
  );

  assert.equal(await callLlm(
    [{ role: "user", content: "persist me" }],
    persistenceCfg,
    { OpenAI: PersistenceOpenAI, resultCache: persistenceCache },
  ), "live despite cache failure");
  assert.equal(persistenceCalls.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /llm-result-cache.*chmod denied/);
});

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_LLM_RESULT_CACHE_TTL_MS,
  LLM_RESULT_CACHE_PURPOSES,
  createLlmResultCache,
  normalizeLlmResultCacheMaxBytes,
  normalizeLlmResultCacheMaxEntries,
  normalizeLlmResultCacheTtlMs,
  withLlmCallContext,
  withLlmResultCacheContext,
} from "../lib/llm-result-cache.js";

const request = (overrides = {}) => ({
  scopeId: "agent-a",
  purpose: LLM_RESULT_CACHE_PURPOSES.CAPTURE_SUMMARY,
  endpoint: "https://llm.example/v1",
  credential: "secret-a",
  model: "model-a",
  messages: [{ role: "user", content: "Exact text" }],
  maxTokens: 300,
  temperature: 0,
  jsonMode: false,
  disableThinking: true,
  headers: { "X-Tenant": "one" },
  ...overrides,
});

const result = (text, inputTokens = 10, outputTokens = 4) => ({
  text,
  usage: { inputTokens, outputTokens, providerCachedInputTokens: 2 },
});

async function hasNodeSqlite() {
  try {
    await import("node:sqlite");
    return true;
  } catch (error) {
    if (error?.code === "ERR_UNKNOWN_BUILTIN_MODULE") return false;
    throw error;
  }
}

function sqliteFootprint(dbPath) {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
    .reduce((total, path) => total + (existsSync(path) ? statSync(path).size : 0), 0);
}

test("TTL defaults and clamps to a finite 60s..7d range", () => {
  assert.equal(normalizeLlmResultCacheTtlMs(undefined), DEFAULT_LLM_RESULT_CACHE_TTL_MS);
  assert.equal(normalizeLlmResultCacheTtlMs(Number.POSITIVE_INFINITY), DEFAULT_LLM_RESULT_CACHE_TTL_MS);
  assert.equal(normalizeLlmResultCacheTtlMs(1), 60_000);
  assert.equal(normalizeLlmResultCacheTtlMs(99 * 86_400_000), 7 * 86_400_000);
});

test("maxEntries and maxBytes normalize to finite 0..upper-bound ranges", () => {
  assert.equal(normalizeLlmResultCacheMaxEntries(undefined), 256);
  assert.equal(normalizeLlmResultCacheMaxEntries("nope"), 256);
  assert.equal(normalizeLlmResultCacheMaxEntries(-3), 0);
  assert.equal(normalizeLlmResultCacheMaxEntries(512), 512);
  assert.equal(normalizeLlmResultCacheMaxEntries(256_000_000), 10_000);
  assert.equal(normalizeLlmResultCacheMaxBytes(undefined), 67_108_864);
  assert.equal(normalizeLlmResultCacheMaxBytes("nope"), 67_108_864);
  assert.equal(normalizeLlmResultCacheMaxBytes(-3), 0);
  assert.equal(normalizeLlmResultCacheMaxBytes(1024), 1024);
  assert.equal(normalizeLlmResultCacheMaxBytes(256 * 1024 ** 3), 1_073_741_824);
});

test("clamped maxEntries/maxBytes log a warning, in-range values stay silent", () => {
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args) };
  createLlmResultCache({ maxEntries: 256_000_000, maxBytes: 256 * 1024 ** 3, logger });
  assert.equal(warnings.length, 2);
  assert.match(String(warnings[0][0]), /llmResultCacheMaxEntries/);
  assert.match(String(warnings[1][0]), /llmResultCacheMaxBytes/);

  const quiet = [];
  createLlmResultCache({
    maxEntries: 512,
    maxBytes: 1024,
    logger: { warn: (...args) => quiet.push(args) },
  });
  assert.equal(quiet.length, 0);
});

test("call context preserves config and adds native routing metadata without cache context", () => {
  const runtimeLlm = { async complete() {} };
  const signal = new AbortController().signal;
  const llmCfg = {
    model: "model-a",
    temperature: 0,
    callContext: { agentId: "unchanged-source" },
  };

  const contextual = withLlmCallContext(llmCfg, "agent-a", "wiki", {
    runtimeLlm,
    signal,
  });

  assert.deepEqual(contextual, {
    model: "model-a",
    temperature: 0,
    callContext: {
      runtimeLlm,
      agentId: "agent-a",
      purpose: "wiki",
      signal,
    },
  });
  assert.equal(Object.hasOwn(contextual, "resultCacheContext"), false);
  assert.notEqual(contextual, llmCfg);
  assert.notEqual(contextual.callContext, llmCfg.callContext);
  assert.deepEqual(llmCfg, {
    model: "model-a",
    temperature: 0,
    callContext: { agentId: "unchanged-source" },
  });
});

test("cache context preserves config and annotates matching call and cache contexts", () => {
  const llmCfg = { model: "model-a", temperature: 0 };
  assert.deepEqual(
    withLlmResultCacheContext(llmCfg, "agent-a", LLM_RESULT_CACHE_PURPOSES.CAPTURE_SUMMARY),
    {
      model: "model-a",
      temperature: 0,
      resultCacheContext: {
        scopeId: "agent-a",
        purpose: LLM_RESULT_CACHE_PURPOSES.CAPTURE_SUMMARY,
      },
      callContext: {
        agentId: "agent-a",
        purpose: LLM_RESULT_CACHE_PURPOSES.CAPTURE_SUMMARY,
      },
    },
  );
  assert.deepEqual(llmCfg, { model: "model-a", temperature: 0 });
});

test("eligible identical requests hit memory without extending absolute TTL", async () => {
  let now = 1_000_000;
  let calls = 0;
  const cache = createLlmResultCache({ ttlMs: 60_000, now: () => now });
  const compute = async () => result(`answer-${++calls}`);
  assert.equal((await cache.getOrCompute(request(), compute)).text, "answer-1");
  now += 40_000;
  assert.equal((await cache.getOrCompute(request(), compute)).text, "answer-1");
  now += 20_001;
  assert.equal((await cache.getOrCompute(request(), compute)).text, "answer-2");
  assert.equal(calls, 2);
});

test("agent, purpose, endpoint, credential, model, messages and generation options partition exact keys", async () => {
  const variants = [
    { scopeId: "agent-b" },
    { purpose: LLM_RESULT_CACHE_PURPOSES.MERGE_DECISION },
    { endpoint: "https://other.example/v1" },
    { credential: "secret-b" },
    { model: "model-b" },
    { messages: [{ role: "user", content: "exact text" }] },
    { maxTokens: 301 },
    { temperature: 0.1 },
    { jsonMode: true },
    { disableThinking: false },
    { headers: { "X-Tenant": "two" } },
  ];
  let calls = 0;
  const cache = createLlmResultCache();
  await cache.getOrCompute(request(), async () => result(`answer-${++calls}`));
  for (const change of variants) {
    await cache.getOrCompute(request(change), async () => result(`answer-${++calls}`));
  }
  assert.equal(calls, variants.length + 1);
});

test("stable object-key ordering matches but whitespace and case remain exact", async () => {
  let calls = 0;
  const cache = createLlmResultCache();
  const compute = async () => result(`answer-${++calls}`);
  await cache.getOrCompute(request({ headers: { B: "2", A: "1" } }), compute);
  await cache.getOrCompute(request({ headers: { A: "1", B: "2" } }), compute);
  await cache.getOrCompute(request({ messages: [{ role: "user", content: "Exact  text" }] }), compute);
  await cache.getOrCompute(request({ messages: [{ role: "user", content: "EXACT text" }] }), compute);
  assert.equal(calls, 3);
});

test("missing and unknown purposes bypass the cache", async () => {
  let calls = 0;
  const cache = createLlmResultCache();
  const compute = async () => result(`live-${++calls}`);
  await cache.getOrCompute(request({ purpose: undefined }), compute);
  await cache.getOrCompute(request({ purpose: "weather" }), compute);
  await cache.getOrCompute(request({ purpose: "weather" }), compute);
  assert.equal(calls, 3);
});

test("invalid fulfilled results are returned but not cached in memory", async (t) => {
  const cases = [
    { name: "null text", value: result(null) },
    { name: "empty text", value: result("") },
    { name: "whitespace-only text", value: result(" \n\t") },
    {
      name: "malformed JSON-mode text",
      value: result('{"broken":'),
      requestOverrides: { jsonMode: true },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let calls = 0;
      const cache = createLlmResultCache();
      const cacheRequest = request(testCase.requestOverrides);
      const compute = async () => {
        calls += 1;
        return testCase.value;
      };

      assert.deepEqual(await cache.getOrCompute(cacheRequest, compute), testCase.value);
      assert.deepEqual(await cache.getOrCompute(cacheRequest, compute), testCase.value);
      assert.equal(calls, 2);
    });
  }
});

test("non-empty valid JSON-mode results remain cacheable", async () => {
  let calls = 0;
  const cache = createLlmResultCache();
  const jsonResult = result('{"ok":true}');
  const compute = async () => {
    calls += 1;
    return jsonResult;
  };

  assert.deepEqual(await cache.getOrCompute(request({ jsonMode: true }), compute), jsonResult);
  assert.deepEqual(await cache.getOrCompute(request({ jsonMode: true }), compute), jsonResult);
  assert.equal(calls, 1);
});

test("identical concurrent requests coalesce and rejected calls are not cached", async () => {
  let release;
  let calls = 0;
  const cache = createLlmResultCache();
  const pending = new Promise((resolve) => { release = resolve; });
  const compute = async () => { calls += 1; await pending; return result("shared"); };
  const first = cache.getOrCompute(request(), compute);
  const second = cache.getOrCompute(request(), compute);
  release();
  assert.deepEqual(await Promise.all([first, second]), [result("shared"), result("shared")]);
  assert.equal(calls, 1);

  const failing = createLlmResultCache();
  let failures = 0;
  await assert.rejects(() => failing.getOrCompute(request(), async () => { failures += 1; throw new Error("boom"); }));
  await assert.rejects(() => failing.getOrCompute(request(), async () => { failures += 1; throw new Error("boom"); }));
  assert.equal(failures, 2);
});

test("successful coalesced waiters each record avoided token usage", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = createLlmResultCache({ metrics: true });
  const sharedResult = result("shared", 11, 7);
  const compute = async () => {
    await gate;
    return sharedResult;
  };

  const upstream = cache.getOrCompute(request(), compute);
  const waiterOne = cache.getOrCompute(request(), compute);
  const waiterTwo = cache.getOrCompute(request(), compute);
  release();
  assert.deepEqual(await Promise.all([upstream, waiterOne, waiterTwo]), [
    sharedResult,
    sharedResult,
    sharedResult,
  ]);

  const cacheMetrics = cache.getMetrics("agent-a");
  assert.equal(cacheMetrics.coalesced, 2);
  assert.equal(cacheMetrics.hits, 0);
  assert.equal(cacheMetrics.avoidedInputTokens, 22);
  assert.equal(cacheMetrics.avoidedOutputTokens, 14);
  assert.equal(cacheMetrics.hitsMissingUsage, 0);
});

test("coalesced waiters preserve partial usage and count missing usage per waiter", async (t) => {
  const cases = [
    {
      name: "partial usage",
      value: { text: "partial", usage: { inputTokens: 6 } },
      expectedInput: 12,
      expectedOutput: 0,
    },
    {
      name: "missing usage",
      value: { text: "missing" },
      expectedInput: 0,
      expectedOutput: 0,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const cache = createLlmResultCache({ metrics: true });
      const compute = async () => {
        await gate;
        return testCase.value;
      };

      const upstream = cache.getOrCompute(request(), compute);
      const waiterOne = cache.getOrCompute(request(), compute);
      const waiterTwo = cache.getOrCompute(request(), compute);
      release();
      await Promise.all([upstream, waiterOne, waiterTwo]);

      const cacheMetrics = cache.getMetrics("agent-a");
      assert.equal(cacheMetrics.coalesced, 2);
      assert.equal(cacheMetrics.avoidedInputTokens, testCase.expectedInput);
      assert.equal(cacheMetrics.avoidedOutputTokens, testCase.expectedOutput);
      assert.equal(cacheMetrics.hitsMissingUsage, 2);
    });
  }
});

test("rejected coalesced calls record no avoided usage", async () => {
  let rejectUpstream;
  const gate = new Promise((resolve, reject) => { rejectUpstream = reject; });
  const cache = createLlmResultCache({ metrics: true });
  const compute = async () => gate;

  const upstream = cache.getOrCompute(request(), compute);
  const waiterOne = cache.getOrCompute(request(), compute);
  const waiterTwo = cache.getOrCompute(request(), compute);
  rejectUpstream(new Error("boom"));
  const settled = await Promise.allSettled([upstream, waiterOne, waiterTwo]);
  assert.equal(settled.every((entry) => entry.status === "rejected"), true);

  const cacheMetrics = cache.getMetrics("agent-a");
  assert.equal(cacheMetrics.coalesced, 2);
  assert.equal(cacheMetrics.avoidedInputTokens, 0);
  assert.equal(cacheMetrics.avoidedOutputTokens, 0);
  assert.equal(cacheMetrics.hitsMissingUsage, 0);
});

test("LRU capacity evicts the least recently used entry", async () => {
  let calls = 0;
  const cache = createLlmResultCache({ maxEntries: 2 });
  const compute = async () => result(`answer-${++calls}`);
  const a = request({ messages: [{ role: "user", content: "a" }] });
  const b = request({ messages: [{ role: "user", content: "b" }] });
  const c = request({ messages: [{ role: "user", content: "c" }] });
  await cache.getOrCompute(a, compute);
  await cache.getOrCompute(b, compute);
  await cache.getOrCompute(a, compute);
  await cache.getOrCompute(c, compute);
  await cache.getOrCompute(b, compute);
  assert.equal(calls, 4);
});

test("per-agent metrics count hits and avoided input/output tokens", async () => {
  const cache = createLlmResultCache({ metrics: true });
  await cache.getOrCompute(request(), async () => result("answer", 12, 5));
  await cache.getOrCompute(request(), async () => result("unused"));
  const cacheMetrics = cache.getMetrics("agent-a");
  assert.equal(cacheMetrics.requests, 2);
  assert.equal(cacheMetrics.memoryHits, 1);
  assert.equal(cacheMetrics.misses, 1);
  assert.equal(cacheMetrics.upstreamCalls, 1);
  assert.equal(cacheMetrics.avoidedInputTokens, 12);
  assert.equal(cacheMetrics.avoidedOutputTokens, 5);
  assert.equal(cacheMetrics.upstreamProviderCachedInputTokens, 2);
});

test("partial hit usage counts each available token field and marks missing usage", async () => {
  const cache = createLlmResultCache({ metrics: true });
  await cache.getOrCompute(request(), async () => result("answer", 12, null));
  await cache.getOrCompute(request(), async () => result("unused"));
  const cacheMetrics = cache.getMetrics("agent-a");
  assert.equal(cacheMetrics.avoidedInputTokens, 12);
  assert.equal(cacheMetrics.avoidedOutputTokens, 0);
  assert.equal(cacheMetrics.hitsMissingUsage, 1);
});

test("persistent cache survives instances without storing prompt or API key", async (t) => {
  if (!(await hasNodeSqlite())) return t.skip("node:sqlite unavailable");
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const first = createLlmResultCache({ persist: true, baseDbPath: dir });
  await first.getOrCompute(request({
    messages: [{ role: "user", content: "PRIVATE-PROMPT-123" }],
    credential: "API-SECRET-456",
  }), async () => result(`answer-${++calls}`));
  await first.close();
  const second = createLlmResultCache({ persist: true, baseDbPath: dir });
  assert.equal((await second.getOrCompute(request({
    messages: [{ role: "user", content: "PRIVATE-PROMPT-123" }],
    credential: "API-SECRET-456",
  }), async () => result(`answer-${++calls}`))).text, "answer-1");
  assert.equal(calls, 1);
  await second.close();
  const dbPath = join(dir, "llm-result-cache-v1", "agent-a.db");
  const bytes = readFileSync(dbPath);
  assert.equal(bytes.includes(Buffer.from("PRIVATE-PROMPT-123")), false);
  assert.equal(bytes.includes(Buffer.from("API-SECRET-456")), false);
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);
});

test("persistent cache initializes an absent configured base and isolates agents", async (t) => {
  if (!(await hasNodeSqlite())) return t.skip("node:sqlite unavailable");
  const trustedParent = mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-parent-"));
  const baseDbPath = join(trustedParent, "absent-cache-base");
  const warnings = [];
  let first;
  let reopened;
  t.after(async () => {
    await first?.close();
    await reopened?.close();
    rmSync(trustedParent, { recursive: true, force: true });
  });

  assert.equal(existsSync(baseDbPath), false);
  let agentACalls = 0;
  first = createLlmResultCache({
    persist: true,
    baseDbPath,
    logger: { warn: (...args) => warnings.push(args) },
  });
  const agentARequest = request({
    scopeId: "agent-a",
    messages: [{ role: "user", content: "fresh-base-isolation" }],
  });
  assert.equal((await first.getOrCompute(
    agentARequest,
    async () => result(`agent-a-${++agentACalls}`),
  )).text, "agent-a-1");
  const firstMetrics = first.getMetrics("agent-a");
  assert.equal(
    firstMetrics.persistWrites,
    1,
    `fresh-base persistence failed: ${JSON.stringify({ firstMetrics, warnings })}`,
  );
  assert.equal(firstMetrics.persistActive, true);
  const agentADbPath = join(baseDbPath, "llm-result-cache-v1", "agent-a.db");
  assert.equal(existsSync(agentADbPath), true);
  assert.equal(statSync(agentADbPath).mode & 0o777, 0o600);
  await first.close();

  reopened = createLlmResultCache({ persist: true, baseDbPath });
  assert.equal((await reopened.getOrCompute(
    agentARequest,
    async () => result(`agent-a-${++agentACalls}`),
  )).text, "agent-a-1");
  assert.equal(agentACalls, 1);
  assert.equal(reopened.getMetrics("agent-a").persistHits, 1);

  let agentBCalls = 0;
  const agentBRequest = { ...agentARequest, scopeId: "agent-b" };
  assert.equal((await reopened.getOrCompute(
    agentBRequest,
    async () => result(`agent-b-${++agentBCalls}`),
  )).text, "agent-b-1");
  assert.equal(agentBCalls, 1);
  assert.equal(reopened.getMetrics("agent-b").persistHits, 0);
  assert.equal(reopened.getMetrics("agent-b").persistWrites, 1);
  const agentBDbPath = join(baseDbPath, "llm-result-cache-v1", "agent-b.db");
  assert.equal(existsSync(agentBDbPath), true);
  assert.equal(statSync(agentBDbPath).mode & 0o777, 0o600);
});

test("persistent TTL is absolute across instances", async (t) => {
  if (!(await hasNodeSqlite())) return t.skip("node:sqlite unavailable");
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 5_000;
  let calls = 0;
  const first = createLlmResultCache({
    persist: true,
    baseDbPath: dir,
    ttlMs: 60_000,
    now: () => now,
  });
  await first.getOrCompute(request(), async () => result(`answer-${++calls}`));
  await first.close();
  now += 60_001;
  const second = createLlmResultCache({
    persist: true,
    baseDbPath: dir,
    ttlMs: 60_000,
    now: () => now,
  });
  assert.equal((await second.getOrCompute(
    request(),
    async () => result(`answer-${++calls}`),
  )).text, "answer-2");
  await second.close();
});

test("invalid fulfilled results are absent after reopening persistent cache", async (t) => {
  if (!(await hasNodeSqlite())) return t.skip("node:sqlite unavailable");
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases = [
    { name: "null", value: result(null) },
    { name: "empty", value: result("") },
    { name: "whitespace", value: result(" \n\t") },
    { name: "malformed-json", value: result('{"broken":'), jsonMode: true },
  ];
  let calls = 0;
  const first = createLlmResultCache({ persist: true, baseDbPath: dir });

  for (const testCase of cases) {
    const cacheRequest = request({
      jsonMode: testCase.jsonMode === true,
      messages: [{ role: "user", content: testCase.name }],
    });
    assert.deepEqual(await first.getOrCompute(cacheRequest, async () => {
      calls += 1;
      return testCase.value;
    }), testCase.value);
  }
  await first.close();

  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = join(dir, "llm-result-cache-v1", "agent-a.db");
  const database = new DatabaseSync(dbPath);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM llm_results").get().count, 0);
  database.close();

  const second = createLlmResultCache({ persist: true, baseDbPath: dir });
  for (const testCase of cases) {
    const cacheRequest = request({
      jsonMode: testCase.jsonMode === true,
      messages: [{ role: "user", content: testCase.name }],
    });
    const freshValue = testCase.jsonMode
      ? result('{"fresh":true}')
      : result(`fresh-${testCase.name}`);
    assert.deepEqual(await second.getOrCompute(cacheRequest, async () => {
      calls += 1;
      return freshValue;
    }), freshValue);
  }
  assert.equal(calls, cases.length * 2);
  await second.close();
});

test("invalid agent paths fail open without creating persistence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const cache = createLlmResultCache({ persist: true, baseDbPath: dir });
  const unsafe = request({ scopeId: "../escape" });
  await cache.getOrCompute(unsafe, async () => result(`answer-${++calls}`));
  await cache.getOrCompute(unsafe, async () => result(`answer-${++calls}`));
  assert.equal(calls, 1);
  assert.equal(cache.getMetrics("../escape").persistActive, false);
  await cache.close();
});

test("permission hardening failure disables persistence for the scope", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const cache = createLlmResultCache({
    persist: true,
    baseDbPath: dir,
    chmodFile: () => { throw new Error("chmod denied"); },
  });
  await cache.getOrCompute(request(), async () => result(`answer-${++calls}`));
  assert.equal(cache.getMetrics("agent-a").persistActive, false);
  await cache.close();
});

test("hard byte limit skips persistence without breaking the memory cache", async (t) => {
  if (!(await hasNodeSqlite())) return t.skip("node:sqlite unavailable");
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const cache = createLlmResultCache({
    persist: true,
    baseDbPath: dir,
    maxBytes: 1,
    metrics: true,
  });
  const compute = async () => result(`answer-${++calls}`);
  assert.equal((await cache.getOrCompute(request(), compute)).text, "answer-1");
  assert.equal((await cache.getOrCompute(request(), compute)).text, "answer-1");
  assert.equal(calls, 1);
  assert.equal(cache.getMetrics("agent-a").persistWriteSkipped, 1);
  await cache.close();
  await cache.close();

  const reopened = createLlmResultCache({
    persist: true,
    baseDbPath: dir,
    maxBytes: 1,
    metrics: true,
  });
  assert.equal((await reopened.getOrCompute(request(), compute)).text, "answer-2");
  assert.equal(calls, 2);
  await reopened.close();
});

test("SQLite cleanup caps expired-row deletion work per persistent write", async (t) => {
  if (!(await hasNodeSqlite())) return t.skip("node:sqlite unavailable");
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "llm-result-cache-v1", "agent-a.db");
  let now = 1_000;
  const cache = createLlmResultCache({
    persist: true,
    baseDbPath: dir,
    maxBytes: 10_000_000,
    ttlMs: 60_000,
    now: () => now,
  });
  for (let index = 0; index < 300; index += 1) {
    const label = `expired-${index}`;
    await cache.getOrCompute(
      request({ messages: [{ role: "user", content: label }] }),
      async () => result(`${label}:${"e".repeat(100)}`),
    );
  }

  now += 60_001;
  await cache.getOrCompute(
    request({ messages: [{ role: "user", content: "cleanup-trigger" }] }),
    async () => result("fresh"),
  );

  const { DatabaseSync } = await import("node:sqlite");
  const duringRun = new DatabaseSync(dbPath);
  const countBeforeClose = duringRun
    .prepare("SELECT COUNT(*) AS count FROM llm_results").get().count;
  duringRun.close();
  assert.equal(countBeforeClose, 45, "one write should delete at most 256 of 300 expired rows");

  await cache.close();
  const database = new DatabaseSync(dbPath);
  const rowCount = database.prepare("SELECT COUNT(*) AS count FROM llm_results").get().count;
  database.close();
  assert.equal(rowCount, 1, "close should sweep the remaining expired rows");
});

test("opening persistence sweeps expired rows beyond the per-write cap", async (t) => {
  if (!(await hasNodeSqlite())) return t.skip("node:sqlite unavailable");
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const versionDir = join(dir, "llm-result-cache-v1");
  mkdirSync(versionDir, { recursive: true });
  const dbPath = join(versionDir, "agent-a.db");

  const { DatabaseSync } = await import("node:sqlite");
  const seed = new DatabaseSync(dbPath);
  seed.exec(`
    CREATE TABLE llm_results (
      key_hash TEXT PRIMARY KEY,
      purpose TEXT NOT NULL,
      model TEXT NOT NULL,
      response_text TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      provider_cached_input_tokens INTEGER,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      byte_size INTEGER NOT NULL
    );
  `);
  const insert = seed.prepare(`
    INSERT INTO llm_results
      (key_hash, purpose, model, response_text, input_tokens, output_tokens,
       provider_cached_input_tokens, created_at, accessed_at, expires_at, byte_size)
    VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, 1, 1, 100)
  `);
  for (let index = 0; index < 300; index += 1) {
    insert.run(`expired-${index}`, "capture-summary", "model-a", "stale");
  }
  seed.close();

  const cache = createLlmResultCache({ persist: true, baseDbPath: dir });
  await cache.getOrCompute(request(), async () => result("fresh"));
  await cache.close();

  const verify = new DatabaseSync(dbPath);
  const rowCount = verify.prepare("SELECT COUNT(*) AS count FROM llm_results").get().count;
  verify.close();
  assert.equal(rowCount, 1, "open should sweep all 300 expired rows, leaving only the fresh entry");
});

test("soft-limit cleanup evicts multiple oldest SQLite rows but keeps the newest", async (t) => {
  if (!(await hasNodeSqlite())) return t.skip("node:sqlite unavailable");
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "llm-result-cache-v1", "agent-a.db");
  let now = 1_000;
  const seed = createLlmResultCache({
    persist: true,
    baseDbPath: dir,
    maxBytes: 10_000_000,
    now: () => now,
  });
  for (let index = 0; index < 20; index += 1) {
    now += 1;
    const label = `old-${String(index).padStart(2, "0")}`;
    await seed.getOrCompute(
      request({ messages: [{ role: "user", content: label }] }),
      async () => result(`${label}:${"x".repeat(20_000)}`),
    );
  }
  await seed.close();

  const hardLimit = statSync(dbPath).size + 50_000;
  now += 1;
  const limited = createLlmResultCache({
    persist: true,
    baseDbPath: dir,
    maxBytes: hardLimit,
    now: () => now,
  });
  await limited.getOrCompute(
    request({ messages: [{ role: "user", content: "newest" }] }),
    async () => result(`newest:${"y".repeat(20_000)}`),
  );
  await limited.close();

  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(dbPath);
  const rows = database.prepare(
    "SELECT response_text FROM llm_results ORDER BY created_at ASC",
  ).all();
  database.close();
  assert.ok(rows.length > 0, "cleanup must not erase every cache row");
  assert.ok(rows.length <= 18, "cleanup should evict multiple rows toward the soft target");
  assert.equal(rows.some((row) => row.response_text.startsWith("old-00:")), false);
  assert.equal(rows.some((row) => row.response_text.startsWith("newest:")), true);
});

test("WAL-heavy hard-limit cleanup reclaims space and persists the new result", async (t) => {
  if (!(await hasNodeSqlite())) return t.skip("node:sqlite unavailable");
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "llm-result-cache-v1", "agent-a.db");
  let now = 10_000;
  const seed = createLlmResultCache({
    persist: true,
    baseDbPath: dir,
    maxBytes: 10_000_000,
    now: () => now,
  });
  for (let index = 0; index < 12; index += 1) {
    now += 1;
    const label = `wal-seed-${index}`;
    await seed.getOrCompute(
      request({ messages: [{ role: "user", content: label }] }),
      async () => result(`${label}:${"w".repeat(30_000)}`),
    );
  }

  const walPath = `${dbPath}-wal`;
  const walBytesBefore = statSync(walPath).size;
  const footprintBefore = sqliteFootprint(dbPath);
  assert.ok(walBytesBefore > statSync(dbPath).size, "test setup must be WAL-heavy");
  const hardLimit = Math.floor(footprintBefore * 0.75);
  assert.ok(footprintBefore >= hardLimit, "test setup must begin at the hard limit");

  now += 1;
  const limited = createLlmResultCache({
    persist: true,
    baseDbPath: dir,
    maxBytes: hardLimit,
    metrics: true,
    now: () => now,
  });
  await limited.getOrCompute(
    request({ messages: [{ role: "user", content: "hard-limit-recovery" }] }),
    async () => result(`recovered:${"z".repeat(10_000)}`),
  );

  const limitedMetrics = limited.getMetrics("agent-a");
  assert.equal(limitedMetrics.persistWriteSkipped, 0);
  assert.equal(limitedMetrics.persistWrites, 1);
  assert.ok(statSync(walPath).size < walBytesBefore, "cleanup should truncate the heavy WAL");
  assert.ok(sqliteFootprint(dbPath) < footprintBefore, "cleanup should reclaim physical space");
  await limited.close();
  await seed.close();

  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(dbPath);
  const recovered = database.prepare(
    "SELECT COUNT(*) AS count FROM llm_results WHERE response_text LIKE 'recovered:%'",
  ).get();
  database.close();
  assert.equal(recovered.count, 1);
});

test("persistent cache directory is created with owner-only permissions", async (t) => {
  if (!(await hasNodeSqlite())) return t.skip("node:sqlite unavailable");
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = createLlmResultCache({ persist: true, baseDbPath: dir });
  await cache.getOrCompute(request(), async () => result("answer"));
  await cache.close();
  assert.equal(statSync(join(dir, "llm-result-cache-v1")).mode & 0o777, 0o700);
});

test("close drains in-flight persist writes before closing handles", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let releaseLoader;
  let signalLoaderStarted;
  const loaderStarted = new Promise((resolve) => { signalLoaderStarted = () => resolve(true); });
  const loaderGate = new Promise((resolve) => { releaseLoader = resolve; });
  const runStatements = [];
  let openedHandles = 0;
  let closedHandles = 0;
  const sqliteModule = {
    DatabaseSync: class {
      constructor() {
        openedHandles += 1;
      }

      exec() {}

      prepare(sql) {
        return {
          get: () => (sql.includes("sqlite_schema") ? { count: 1 } : undefined),
          run: () => {
            runStatements.push(sql);
            return { changes: 0 };
          },
        };
      }

      close() {
        closedHandles += 1;
      }
    },
  };
  const loadSqlite = async () => {
    signalLoaderStarted();
    await loaderGate;
    return sqliteModule;
  };
  const cache = createLlmResultCache({
    persist: true,
    baseDbPath: dir,
    loadSqlite,
    chmodFile: () => {},
    metrics: true,
  });

  const order = [];
  const initial = cache.getOrCompute(request(), async () => result("answer"))
    .then((value) => {
      order.push("compute");
      return value;
    });
  await loaderStarted;

  const closing = cache.close().then(() => {
    order.push("close");
  });
  releaseLoader();
  const [value] = await Promise.all([initial, closing]);

  assert.equal(value.text, "answer");
  assert.deepEqual(order, ["compute", "close"], "close must wait for the in-flight write");
  assert.equal(cache.getMetrics("agent-a").persistWrites, 1);
  assert.equal(
    runStatements.some((sql) => sql.includes("INSERT INTO llm_results")),
    true,
  );
  assert.equal(openedHandles, 1);
  assert.equal(closedHandles, 1);
});

test("close waits for pending opens and permanently disables persistence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let releaseLoader;
  let signalLoaderStarted;
  let loaderCalls = 0;
  let openedHandles = 0;
  let closedHandles = 0;
  let upstreamCalls = 0;
  const loaderStarted = new Promise((resolve) => { signalLoaderStarted = () => resolve(true); });
  const loaderGate = new Promise((resolve) => { releaseLoader = resolve; });
  const sqliteModule = {
    DatabaseSync: class {
      constructor() {
        openedHandles += 1;
      }

      exec() {}

      prepare() {
        return {
          get: () => undefined,
          run: () => undefined,
        };
      }

      close() {
        closedHandles += 1;
      }
    },
  };
  const loadSqlite = async () => {
    loaderCalls += 1;
    signalLoaderStarted();
    await loaderGate;
    return sqliteModule;
  };
  const cache = createLlmResultCache({
    persist: true,
    baseDbPath: dir,
    loadSqlite,
    chmodFile: () => {},
  });

  const initial = cache.getOrCompute(
    request({ messages: [{ role: "user", content: "shutdown-race" }] }),
    async () => result(`answer-${++upstreamCalls}`),
  );
  let loaderStartTimer;
  const loaderStartTimeout = new Promise((resolve) => {
    loaderStartTimer = setTimeout(() => resolve(false), 100);
  });
  const loaderWasUsed = await Promise.race([loaderStarted, loaderStartTimeout]);
  clearTimeout(loaderStartTimer);
  if (!loaderWasUsed) {
    releaseLoader();
    await initial;
    await cache.close();
    assert.equal(loaderWasUsed, true, "expected createLlmResultCache to use the injected SQLite loader");
    return;
  }

  let closeResolved = false;
  const observeClose = async () => {
    await cache.close();
    closeResolved = true;
  };
  const closing = observeClose();
  await Promise.resolve();
  const resolvedBeforeRelease = closeResolved;
  releaseLoader();
  await Promise.all([initial, closing]);

  assert.equal(resolvedBeforeRelease, false);
  assert.equal(cache.getMetrics("agent-a").persistActive, false);
  assert.equal(openedHandles, closedHandles);
  assert.equal(loaderCalls, 1);

  assert.equal((await cache.getOrCompute(
    request({ messages: [{ role: "user", content: "after-close" }] }),
    async () => result(`answer-${++upstreamCalls}`),
  )).text, "answer-2");
  assert.equal(upstreamCalls, 2);
  assert.equal(loaderCalls, 1);
  await cache.close();
  assert.equal(openedHandles, closedHandles);
});

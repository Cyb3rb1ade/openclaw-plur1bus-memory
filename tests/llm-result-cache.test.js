import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_LLM_RESULT_CACHE_TTL_MS,
  LLM_RESULT_CACHE_PURPOSES,
  createLlmResultCache,
  normalizeLlmResultCacheTtlMs,
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

test("TTL defaults and clamps to a finite 60s..7d range", () => {
  assert.equal(normalizeLlmResultCacheTtlMs(undefined), DEFAULT_LLM_RESULT_CACHE_TTL_MS);
  assert.equal(normalizeLlmResultCacheTtlMs(Number.POSITIVE_INFINITY), DEFAULT_LLM_RESULT_CACHE_TTL_MS);
  assert.equal(normalizeLlmResultCacheTtlMs(1), 60_000);
  assert.equal(normalizeLlmResultCacheTtlMs(99 * 86_400_000), 7 * 86_400_000);
});

test("cache context preserves config and annotates scope and purpose", () => {
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

test("hard byte limit skips persistent writes and close is idempotent", async (t) => {
  if (!(await hasNodeSqlite())) return t.skip("node:sqlite unavailable");
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = createLlmResultCache({
    persist: true,
    baseDbPath: dir,
    maxBytes: 1,
    metrics: true,
  });
  await cache.getOrCompute(request(), async () => result("answer"));
  assert.equal(cache.getMetrics("agent-a").persistWriteSkipped, 1);
  await cache.close();
  await cache.close();
});

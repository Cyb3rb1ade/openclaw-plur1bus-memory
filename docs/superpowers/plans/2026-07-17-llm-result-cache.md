# LLM Result Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an exact, agent-scoped, TTL-bounded result cache for explicitly allowlisted PLUR1BUS-internal LLM transforms so repeated deterministic work avoids input and output tokens without ever caching ordinary chat, weather, live-data, tool, web, or creative responses.

**Architecture:** A new `lib/llm-result-cache.js` owns exact request hashing, in-memory LRU+absolute TTL, request coalescing, optional prompt-free SQLite persistence, and per-agent token metrics. `lib/llm-call.js` remains the provider-neutral OpenAI-compatible adapter and consults the cache only when the caller supplies an explicit allowlisted `{ scopeId, purpose }` context; missing and unknown purposes bypass it. Existing deterministic PLUR1BUS transforms opt in at their call sites while user-facing/live/creative callers remain unchanged.

**Tech Stack:** Node.js ESM, `node:crypto`, `node:fs`, optional built-in `node:sqlite`, OpenAI-compatible chat completions, Node test runner (`node:test`), existing `safeAgentId`, `resolveInside`, `safeWarn`, and `safeDebug` helpers; no new dependency.

## Global Constraints

- The ordinary OpenClaw chat-response path is outside this cache; the plugin has no response-replacement hook and must not add one.
- Weather (including prompts such as `wie wird das Wetter morgen?`), news, prices, schedules, web/search/tool results, `/wiki` synthesis, and any other live-data response must never be served from this cache.
- Dream narrative/echo, afterthought, persona voice, critical-push urgency decisions, and unknown/new LLM purposes bypass the cache unless a later separately reviewed change explicitly allowlists them.
- Eligibility is an explicit purpose allowlist, never keyword or semantic heuristics. A missing or unknown purpose always calls the upstream provider.
- Cache matches are exact and provider-neutral: key version, purpose, agent scope, endpoint, credential fingerprint, model, full messages, `maxTokens`, `temperature`, `jsonMode`, `disableThinking`, and header fingerprint all participate.
- Stable key serialization sorts object keys but preserves string text, whitespace, and case exactly; no fuzzy or semantic matching is allowed.
- The raw API key, headers, full prompt, and messages are never persisted. SQLite stores only the SHA-256 key hash, purpose, model, response text, usage, and timestamps.
- Defaults are `llmResultCacheEnabled: true`, `llmResultCacheTtlMs: 86400000`, `llmResultCacheMaxEntries: 256`, `llmResultCachePersist: false`, `llmResultCacheMaxBytes: 67108864`, and `llmResultCacheMetrics: true`.
- TTL is absolute: hits do not extend expiry. Invalid TTL values fall back to 24 hours; valid values are clamped to 60 seconds minimum and 7 days maximum, so an infinite cache is impossible.
- Persistent paths use `{baseDbPath}/llm-result-cache-v1/{agentId}.db`; `safeAgentId()` and `resolveInside()` are mandatory before filesystem access.
- SQLite uses WAL, `busy_timeout=5000`, `auto_vacuum=INCREMENTAL`, atomic UPSERT, cleanup toward 90% of `llmResultCacheMaxBytes`, and a hard persist-write skip at the byte limit.
- The SQLite database file is mode `0600`. If permission hardening fails, persistence is disabled for that scope and the cache remains fail-open in memory.
- Upstream failures are never cached. Identical concurrent eligible requests share one in-flight promise.
- The public LLM adapter contract remains `Promise<string|null>` and forwards the actual `temperature` request parameter.
- Metrics are process-local and per agent: requests, memory hits, persistent hits, misses, coalesced requests, upstream calls, persistent writes/skips, avoided input/output tokens, upstream provider-cached input tokens, and hits missing usage. Do not estimate currency savings.
- Every new or changed export has focused JSDoc. Every catch in new code rethrows, returns an error result, or logs through `safeWarn`/`safeDebug`; no silent catches.
- Tests are unit-level and DB-free except optional temp-directory `node:sqlite` tests. Run the full suite with `node --test tests/*.test.js` before completion.

---

### Task 1: Exact cache engine with TTL, coalescing, metrics, and optional SQLite

**Files:**
- Create: `lib/llm-result-cache.js`
- Create: `tests/llm-result-cache.test.js`

**Interfaces:**
- Consumes: `safeAgentId(id)`, `resolveInside(baseDir, ...parts)`, `safeWarn(logger, component, error, context)`, and `safeDebug(logger, component, error, context)`.
- Produces: `LLM_RESULT_CACHE_PURPOSES`, `DEFAULT_LLM_RESULT_CACHE_TTL_MS`, `normalizeLlmResultCacheTtlMs(value)`, `withLlmResultCacheContext(llmCfg, scopeId, purpose)`, and `createLlmResultCache(options)`.
- `createLlmResultCache(options)` returns `{ getOrCompute(request, compute), getMetrics(scopeId), close() }`.
- `getOrCompute(request, compute)` returns `Promise<{ text: string|null, usage: { inputTokens:number|null, outputTokens:number|null, providerCachedInputTokens:number|null } }>`; `compute` has the same return type.

- [ ] **Step 1: Write failing tests for exact in-memory behavior and safety boundaries**

Create `tests/llm-result-cache.test.js` with deterministic fake time and helpers. The tests must assert all of the following behaviors, using real values rather than snapshot-only assertions:

```js
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

test("TTL defaults and clamps to a finite 60s..7d range", () => {
  assert.equal(normalizeLlmResultCacheTtlMs(undefined), DEFAULT_LLM_RESULT_CACHE_TTL_MS);
  assert.equal(normalizeLlmResultCacheTtlMs(Number.POSITIVE_INFINITY), DEFAULT_LLM_RESULT_CACHE_TTL_MS);
  assert.equal(normalizeLlmResultCacheTtlMs(1), 60_000);
  assert.equal(normalizeLlmResultCacheTtlMs(99 * 86_400_000), 7 * 86_400_000);
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
  assert.deepEqual(cache.getMetrics("agent-a"), assert.matching({
    requests: 2,
    memoryHits: 1,
    misses: 1,
    upstreamCalls: 1,
    avoidedInputTokens: 12,
    avoidedOutputTokens: 5,
    upstreamProviderCachedInputTokens: 2,
  }));
});
```

- [ ] **Step 2: Run the in-memory tests to verify RED**

Run: `node --test tests/llm-result-cache.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/llm-result-cache.js`.

- [ ] **Step 3: Implement exact hashing, allowlist, absolute TTL, LRU, coalescing, and metrics**

Create `lib/llm-result-cache.js` with these exact public constants and purpose strings:

```js
export const DEFAULT_LLM_RESULT_CACHE_TTL_MS = 86_400_000;
export const LLM_RESULT_CACHE_PURPOSES = Object.freeze({
  CAPTURE_SUMMARY: "capture-summary",
  RECALL_QUERY_SUMMARY: "recall-query-summary",
  MERGE_DECISION: "merge-decision",
  CONFLICT_RESOLUTION: "conflict-resolution",
  EMOTION_CLASSIFICATION: "emotion-classification",
  EPISODE_ANALYSIS: "episode-analysis",
  CONVERSATION_INSIGHTS: "conversation-insights",
  SKILL_EXTRACTION: "skill-extraction",
  REM_PATTERN_ANALYSIS: "rem-pattern-analysis",
  KNOWLEDGE_UPDATE: "knowledge-update",
});

const ALLOWED_PURPOSES = new Set(Object.values(LLM_RESULT_CACHE_PURPOSES));
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 7 * 86_400_000;
const CACHE_VERSION = "llm-result-cache-v1";

export function normalizeLlmResultCacheTtlMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LLM_RESULT_CACHE_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(parsed)));
}

export function withLlmResultCacheContext(llmCfg, scopeId, purpose) {
  return { ...llmCfg, resultCacheContext: { scopeId, purpose } };
}
```

Implement recursive stable serialization by sorting plain-object keys and preserving all strings exactly. Hash credential and headers separately with SHA-256 before building the canonical request object; hash that final serialization again for the only cache key. Never retain the canonical serialization after hashing.

Use `Map` insertion order for LRU. Each entry is `{ value, expiresAt }`; on a hit, delete/reinsert the entry without changing `expiresAt`. The in-flight map is keyed by the same SHA-256 key and must be cleared in `finally`. Cache only successful compute results; `null` text is a successful result and may be cached, but thrown/rejected computations are not.

`getMetrics(scopeId)` must always return a fresh object with all counters, `hits`, `hitRate`, `enabled`, `persistConfigured`, and `persistActive`; when metrics are disabled, caching still works and counters remain zero. On cache hits, add the stored usage to avoided input/output counters; if either token count is absent, increment `hitsMissingUsage`. On upstream results, accumulate `providerCachedInputTokens` into `upstreamProviderCachedInputTokens`.

- [ ] **Step 4: Run the in-memory tests to verify GREEN**

Run: `node --test tests/llm-result-cache.test.js`

Expected: all non-SQLite tests PASS with pristine output.

- [ ] **Step 5: Add failing SQLite persistence, privacy, size-limit, permission, and close tests**

Append tests guarded by a `hasNodeSqlite()` dynamic-import check. Each test uses `mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-"))` and `t.after(() => rmSync(dir, { recursive: true, force: true }))`. Assert:

```js
test("persistent cache survives instances without storing prompt or API key", async (t) => {
  if (!(await hasNodeSqlite())) return t.skip("node:sqlite unavailable");
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const first = createLlmResultCache({ persist: true, baseDbPath: dir });
  await first.getOrCompute(request({ messages: [{ role: "user", content: "PRIVATE-PROMPT-123" }], credential: "API-SECRET-456" }), async () => result(`answer-${++calls}`));
  await first.close();
  const second = createLlmResultCache({ persist: true, baseDbPath: dir });
  assert.equal((await second.getOrCompute(request({ messages: [{ role: "user", content: "PRIVATE-PROMPT-123" }], credential: "API-SECRET-456" }), async () => result(`answer-${++calls}`))).text, "answer-1");
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
  const first = createLlmResultCache({ persist: true, baseDbPath: dir, ttlMs: 60_000, now: () => now });
  await first.getOrCompute(request(), async () => result(`answer-${++calls}`));
  await first.close();
  now += 60_001;
  const second = createLlmResultCache({ persist: true, baseDbPath: dir, ttlMs: 60_000, now: () => now });
  assert.equal((await second.getOrCompute(request(), async () => result(`answer-${++calls}`))).text, "answer-2");
  await second.close();
});

test("invalid agent paths fail open without creating persistence", async () => {
  let calls = 0;
  const cache = createLlmResultCache({ persist: true, baseDbPath: mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-")) });
  const unsafe = request({ scopeId: "../escape" });
  await cache.getOrCompute(unsafe, async () => result(`answer-${++calls}`));
  await cache.getOrCompute(unsafe, async () => result(`answer-${++calls}`));
  assert.equal(calls, 1);
  assert.equal(cache.getMetrics("../escape").persistActive, false);
  await cache.close();
});

test("permission hardening failure disables persistence for the scope", async () => {
  let calls = 0;
  const cache = createLlmResultCache({
    persist: true,
    baseDbPath: mkdtempSync(join(tmpdir(), "plur1bus-llm-cache-")),
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
  const cache = createLlmResultCache({ persist: true, baseDbPath: dir, maxBytes: 1, metrics: true });
  await cache.getOrCompute(request(), async () => result("answer"));
  assert.equal(cache.getMetrics("agent-a").persistWriteSkipped, 1);
  await cache.close();
  await cache.close();
});
```

- [ ] **Step 6: Run SQLite tests to verify RED**

Run: `node --test tests/llm-result-cache.test.js`

Expected: the persistence assertions FAIL because the cache has no SQLite layer yet.

- [ ] **Step 7: Implement prompt-free SQLite persistence and lifecycle**

Use a lazy `await import("node:sqlite")`. For each validated scope, resolve the path only as:

```js
const agentId = safeAgentId(scopeId);
const dbPath = resolveInside(baseDbPath, "llm-result-cache-v1", `${agentId}.db`);
mkdirSync(dirname(dbPath), { recursive: true });
const database = new sqliteModule.DatabaseSync(dbPath);
database.exec("PRAGMA journal_mode=WAL;");
database.exec("PRAGMA busy_timeout=5000;");
database.exec("PRAGMA auto_vacuum=INCREMENTAL;");
chmodFile(dbPath, 0o600);
```

Create only this data table and indexes; do not add prompt/debug columns:

```sql
CREATE TABLE IF NOT EXISTS llm_results (
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
CREATE INDEX IF NOT EXISTS idx_llm_results_expires ON llm_results(expires_at);
CREATE INDEX IF NOT EXISTS idx_llm_results_accessed ON llm_results(accessed_at);
```

Read by `key_hash`; delete expired rows; update only `accessed_at` on a hit, never `expires_at`. UPSERT all response and usage fields atomically. Compute `byte_size` from UTF-8 response bytes plus a small fixed metadata allowance, without storing request content. Database size includes the main file plus `-wal` and `-shm`. Before writes, delete expired rows; if current size is at or above `maxBytes`, increment `persistWriteSkipped` and skip. After writes above `0.9 * maxBytes`, evict oldest rows by `accessed_at, created_at`, call `PRAGMA incremental_vacuum`, and stop once at/below the target or no rows remain.

Any SQLite/path/permission operation failure must call `safeWarn` or `safeDebug`, mark that DB path/scope failed, close any newly opened handle, and continue with memory caching. `close()` closes every open `DatabaseSync`, logs close errors, clears handles, and is idempotent.

- [ ] **Step 8: Run focused tests and commit**

Run: `node --test tests/llm-result-cache.test.js`

Expected: all tests PASS with pristine output (or only the explicit `node:sqlite unavailable` skips on unsupported Node).

```bash
git add lib/llm-result-cache.js tests/llm-result-cache.test.js
git commit -m "feat: add exact LLM result cache engine"
```

### Task 2: Cache-aware provider adapter and weather/main-chat bypass regressions

**Files:**
- Modify: `lib/llm-call.js`
- Modify: `tests/llm-call.test.js`

**Interfaces:**
- Consumes: Task 1 `createLlmResultCache()` object through `options.resultCache`, plus `llmCfg.resultCacheContext` created by `withLlmResultCacheContext()`.
- Produces: unchanged `callLlm(messages, llmCfg, options): Promise<string|null>` with new injected option `options.resultCache`; upstream usage is normalized internally before entering the cache.

- [ ] **Step 1: Write failing adapter tests**

Extend `tests/llm-call.test.js` with a fake OpenAI class that records bodies and returns queued `{ choices, usage }` responses. Add tests that assert:

```js
test("callLlm forwards temperature and caches only explicit allowlisted context", async () => {
  const cache = createLlmResultCache();
  const calls = [];
  const OpenAI = makeFakeOpenAI(calls, [
    { text: "first", usage: { prompt_tokens: 20, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 3 } } },
    { text: "second" },
  ]);
  const cfg = withLlmResultCacheContext({ model: "m", apiKey: "k", baseUrl: "https://example/v1", maxTokens: 50, temperature: 0 }, "agent-a", LLM_RESULT_CACHE_PURPOSES.CAPTURE_SUMMARY);
  assert.equal(await callLlm([{ role: "user", content: "same" }], cfg, { OpenAI, resultCache: cache }), "first");
  assert.equal(await callLlm([{ role: "user", content: "same" }], cfg, { OpenAI, resultCache: cache }), "first");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].temperature, 0);
  assert.equal(cache.getMetrics("agent-a").avoidedInputTokens, 20);
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
  assert.equal(await callLlm([{ role: "user", content: "hello" }], { model: "m" }, { OpenAI, resultCache: cache }), "one");
  assert.equal(await callLlm([{ role: "user", content: "hello" }], { model: "m" }, { OpenAI, resultCache: cache }), "two");
  assert.equal(calls.length, 2);
});

test("provider and cache errors preserve adapter fail behavior and are not cached", async () => {
  // First upstream call rejects; second identical eligible call reaches upstream again and succeeds.
  // A cache-internal persistence failure is logged/fail-open and still returns provider text.
});
```

Also assert both OpenAI usage shapes are normalized: `prompt_tokens`/`completion_tokens` and `input_tokens`/`output_tokens`, including nested cached-token details.

- [ ] **Step 2: Run adapter tests to verify RED**

Run: `node --test tests/llm-call.test.js`

Expected: FAIL because `temperature` is absent and `callLlm` does not consult `options.resultCache`.

- [ ] **Step 3: Implement cache-aware upstream computation without changing return type**

Refactor the provider request into a local `compute()` that returns `{ text, usage }`. Preserve the existing content-first, `reasoning_content`-fallback behavior. Build the exact request passed to Task 1 as:

```js
const cacheRequest = {
  scopeId: llmCfg.resultCacheContext?.scopeId,
  purpose: llmCfg.resultCacheContext?.purpose,
  endpoint: llmCfg.baseUrl || "https://api.openai.com/v1",
  credential: llmCfg.apiKey || "",
  model: llmCfg.model || "",
  messages,
  maxTokens: llmCfg.maxTokens || 300,
  temperature: llmCfg.temperature,
  jsonMode: llmCfg.jsonMode === true,
  disableThinking: llmCfg.disableThinking === true,
  headers: llmCfg.headers || {},
};
```

Only include `body.temperature` when `Number.isFinite(llmCfg.temperature)`. Normalize usage with null for missing counts and return only `cachedResult.text` to callers. Passing an unknown/missing purpose to `getOrCompute` is safe because Task 1 bypasses it, but do not invent a purpose in the adapter.

Update the `callLlm` JSDoc with `options.resultCache` while retaining `Promise<string|null>`.

- [ ] **Step 4: Run focused tests and commit**

Run: `node --test tests/llm-call.test.js tests/llm-result-cache.test.js`

Expected: all tests PASS with pristine output.

```bash
git add lib/llm-call.js tests/llm-call.test.js
git commit -m "feat: cache explicit internal LLM calls"
```

### Task 3: Explicit allowlist integration for deterministic PLUR1BUS transforms

**Files:**
- Modify: `index.js`
- Modify: `lib/dreaming/light-dream.js`
- Modify: `lib/dreaming/rem-dream.js`
- Modify: `lib/episodes.js`
- Modify: `lib/emotion.js`
- Modify: `lib/emotion-engine.js`
- Modify: `lib/tier3-llm.js`
- Modify: `lib/jobs/daily-consolidation.js`
- Modify: `lib/jobs/memory-compaction.js`
- Modify: `lib/jobs/conflict-resolver.js`
- Modify: `lib/jobs/skill-miner.js`
- Modify: `lib/jobs/skill-miner/llm-extractor.js`
- Create: `tests/llm-result-cache-integration.test.js`
- Modify focused existing tests only where a changed function signature requires it.

**Interfaces:**
- Consumes: `LLM_RESULT_CACHE_PURPOSES`, `createLlmResultCache`, and `withLlmResultCacheContext` from Task 1; `callLlm(..., { resultCache })` behavior from Task 2.
- Produces: deterministic call sites attach exact `{ scopeId, purpose }`; excluded call sites remain context-free and therefore bypass the cache.

- [ ] **Step 1: Write failing opt-in/bypass integration tests**

Create `tests/llm-result-cache-integration.test.js`. Use spy `callLlm(messages, cfg)` functions and existing exported job/dream/episode helpers to assert the actual `cfg.resultCacheContext` values. Cover at least:

```js
assert.deepEqual(captureCfg.resultCacheContext, { scopeId: "agent-a", purpose: "capture-summary" });
assert.deepEqual(recallCfg.resultCacheContext, { scopeId: "agent-a", purpose: "recall-query-summary" });
assert.deepEqual(compactionCfg.resultCacheContext, { scopeId: "agent-a", purpose: "merge-decision" });
assert.deepEqual(conflictCfg.resultCacheContext, { scopeId: "agent-a", purpose: "conflict-resolution" });
assert.deepEqual(skillCfg.resultCacheContext, { scopeId: "agent-a", purpose: "skill-extraction" });
assert.deepEqual(lightDreamCfg.resultCacheContext, { scopeId: "agent-a", purpose: "conversation-insights" });
assert.deepEqual(remCfg.resultCacheContext, { scopeId: "agent-a", purpose: "rem-pattern-analysis" });
assert.deepEqual(episodeCfg.resultCacheContext, { scopeId: "agent-a", purpose: "episode-analysis" });
assert.deepEqual(emotionCfg.resultCacheContext, { scopeId: "agent-a", purpose: "emotion-classification" });
```

Add source-boundary assertions that `/wiki`, `dream-narrative`, `dream-echo`, `afterthought`, `persona-voice`, critical classifier/push, and ordinary overlay/user-response calls do not import or attach `LLM_RESULT_CACHE_PURPOSES`. The test should read only those named files and assert no `resultCacheContext` token exists in them; this is a regression boundary, not the primary behavioral test.

- [ ] **Step 2: Run integration tests to verify RED**

Run: `node --test tests/llm-result-cache-integration.test.js`

Expected: FAIL because deterministic callers do not yet attach explicit contexts.

- [ ] **Step 3: Instantiate one configured cache and pass it only through internal LLM configs**

In `index.js`, import the Task 1 exports and instantiate inside `register(api)` after `baseDbPath` and `cfg.runtime` are available:

```js
const llmResultCache = createLlmResultCache({
  enabled: cfg.runtime?.llmResultCacheEnabled !== false,
  ttlMs: cfg.runtime?.llmResultCacheTtlMs,
  maxEntries: cfg.runtime?.llmResultCacheMaxEntries ?? 256,
  persist: cfg.runtime?.llmResultCachePersist === true,
  maxBytes: cfg.runtime?.llmResultCacheMaxBytes ?? 67_108_864,
  metrics: cfg.runtime?.llmResultCacheMetrics !== false,
  baseDbPath,
  logger: api.logger,
});
```

Attach the instance to `mergingLlmCfg`, `schicht15LlmCfg`, and `skillMinerLlmCfg` as the internal property `resultCache: llmResultCache`. Update the global adapter wrapper to pass `llmCfg?.resultCache` as `options.resultCache`; because request bodies are explicitly assembled, this property never reaches providers.

- [ ] **Step 4: Opt in deterministic direct helpers with agent scope and temperature zero**

Use only this pattern at eligible calls:

```js
callLlm(messages, withLlmResultCacheContext(
  { ...llmCfg, temperature: 0 },
  agentId,
  LLM_RESULT_CACHE_PURPOSES.CAPTURE_SUMMARY,
));
```

Apply the exact purpose mapping below:

- `summarizeForCapture` → `CAPTURE_SUMMARY`; add `agentId` to its parameters and production call.
- `makeQuerySummarizer` → `RECALL_QUERY_SUMMARY`; add `agentId` to the factory and create it per command/hook agent instead of sharing an unscoped instance.
- both `index.js` merge checks and memory-compaction merge checks → `MERGE_DECISION`.
- conflict resolver → `CONFLICT_RESOLUTION`.
- skill extractor → `SKILL_EXTRACTION`.
- `extractKeyInsights` in light dreaming → `CONVERSATION_INSIGHTS` using the `lightDream` agent derived from `turns[0]?.agentId || "default"`.
- `summarizeClusterWithLlm` in REM dreaming → `REM_PATTERN_ANALYSIS` using `runRemDream`'s `agentId`.
- `enrichEpisodeNarratively` → `EPISODE_ANALYSIS` using `opts.agentId || episode.agentId || "default"`.
- Emotion Tier 3 through the central `callLlm` provider → `EMOTION_CLASSIFICATION` using the real calling `agentId`.
- both `updateKnowledgeMd` calls → `KNOWLEDGE_UPDATE` using the function's existing `agentId`.

Pass `agentId` from `runConsolidation(db, agent, opts)` into memory compaction and conflict resolver. Pass the existing `agent` argument from `runSkillMiner` into `extractSkillFromEvidence`. Keep JSDoc in sync for every changed export/signature.

Carry emotion scope without a shared/default fallback by making the context explicit through the existing stack:

```js
// lib/emotion.js
export async function inferEmotionalValenceAsync(text, source = "user", forceTier = null, context = {}) {
  const score = await engine.analyze(text, source, effectiveForceTier, context);
}

// lib/emotion-engine.js
async analyze(text, source = "user", forceTier = null, context = {})
async _tier3Only(text, source, context = {})
async _defaultRouting(text, source, context = {})
async _maybeT3(text, source, fallback, context = {})

// lib/tier3-llm.js
async classify(text, source = "user", tier1Result = null, context = {}) {
  responseText = (await this._callLlm(messages, context)) || "";
}
```

Update every branch inside `EmotionEngine` that reaches `_tier3Only`, `_defaultRouting`, `_maybeT3`, or `Tier3LLMClassifier.classify` to forward the same context. In `index.js`, define the Tier-3 callback as `(messages, context) => callLlm(messages, withLlmResultCacheContext({ ...mergingLlmCfg, model: emotionT3Model, maxTokens: 300, temperature: 0, disableThinking: true }, context.agentId, LLM_RESULT_CACHE_PURPOSES.EMOTION_CLASSIFICATION))`; if `context.agentId` is absent, call the provider without a result-cache context. Pass `{ agentId }` at all four existing `inferEmotionalValenceAsync` production calls. Direct Tier-3 API-client mode remains uncached because it does not use the central adapter.

- [ ] **Step 5: Keep live and creative paths explicitly outside**

Do not modify LLM configuration passed to `runWikiCommand`, critical classifier/push, `dream-narrative`, `dream-echo`, `afterthought`, persona voice, overlay generation, or any ordinary model/user response path. Their calls remain context-free, and Task 2's missing-purpose rule makes them upstream-only.

- [ ] **Step 6: Run focused integration and affected module tests**

Run:

```bash
node --test \
  tests/llm-result-cache-integration.test.js \
  tests/llm-call.test.js \
  tests/smoke-merging-approval.test.js \
  tests/smoke-conflict-resolver.test.js \
  tests/skill-miner-trust-boundary.test.js \
  tests/dream-memory-recall.test.js \
  tests/emotion-input-safety.test.js \
  tests/tier3-llm-fallback.test.js \
  tests/episodes-bounds.test.js
```

Expected: all selected tests PASS with pristine output.

- [ ] **Step 7: Commit**

```bash
git add index.js lib/dreaming/light-dream.js lib/dreaming/rem-dream.js lib/episodes.js lib/emotion.js lib/emotion-engine.js lib/tier3-llm.js lib/jobs/daily-consolidation.js lib/jobs/memory-compaction.js lib/jobs/conflict-resolver.js lib/jobs/skill-miner.js lib/jobs/skill-miner/llm-extractor.js tests/llm-result-cache-integration.test.js tests/*.test.js
git commit -m "feat: cache deterministic PLUR1BUS transforms"
```

### Task 4: Runtime config, status metrics, lifecycle, deployment integrity, and documentation

**Files:**
- Modify: `openclaw.plugin.json`
- Modify: `index.js`
- Modify: `lib/setup/feature-profiles.js`
- Modify: `lib/telegram-commands/status-data.js`
- Modify: `lib/telegram-commands/status.js`
- Modify: `scripts/lib/deploy-integrity.mjs`
- Modify: `README.md`
- Modify: `tests/config-audit.test.js`
- Modify: `tests/smoke-feature-profiles.test.js`
- Modify: `tests/status.test.js`
- Modify or create the focused deploy-integrity test discovered via `rg -n "deploy-integrity" tests scripts`.

**Interfaces:**
- Consumes: Task 1 `getMetrics(agentId)` and `close()`; Task 3 register-local `llmResultCache` instance.
- Produces: validated runtime settings, Full Experience default-on profile entry, `/state`/PLUR1BUS status cache metrics, shutdown cleanup, deploy inclusion, and operator documentation.

- [ ] **Step 1: Write failing configuration, profile, status, lifecycle, and deploy tests**

Add schema assertions for these exact runtime properties and defaults:

```js
{
  llmResultCacheEnabled: { type: "boolean", default: true },
  llmResultCacheTtlMs: { type: "number", default: 86_400_000 },
  llmResultCacheMaxEntries: { type: "number", default: 256 },
  llmResultCachePersist: { type: "boolean", default: false },
  llmResultCacheMaxBytes: { type: "number", default: 67_108_864 },
  llmResultCacheMetrics: { type: "boolean", default: true },
}
```

Assert `CORE_FEATURES` contains `{ key: "llmResultCache", label: "LLM Result Cache", path: ["runtime", "llmResultCacheEnabled"], defaultValue: true }` and Full Experience fills a missing setting without overwriting explicit `false`.

Add a status renderer test using:

```js
const llmResultCache = {
  requests: 10,
  hits: 4,
  hitRate: 0.4,
  memoryHits: 3,
  persistHits: 1,
  avoidedInputTokens: 1200,
  avoidedOutputTokens: 300,
  persistConfigured: true,
  persistActive: true,
};
const rendered = renderStatus(collectStatusData({ openclawConfig, llmResultCache }), { lang: "en" });
assert.match(rendered, /LLM Result Cache/);
assert.match(rendered, /Hit rate: 40\.0% \(4\/10\)/);
assert.match(rendered, /Avoided tokens: input=1,200, output=300/);
assert.match(rendered, /Persistence: active/);
```

Add a register/gateway-stop test with an injected or mocked cache whose `close()` call count becomes exactly 1. Add a deploy-integrity assertion that `lib/llm-result-cache.js` is in `DEPLOY_FILES` or in the generated deployment closure.

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
node --test tests/config-audit.test.js tests/smoke-feature-profiles.test.js tests/status.test.js
```

Also run the exact deploy and gateway-stop test files identified in Step 1.

Expected: FAIL for missing schema keys, feature profile, rendered cache section, shutdown close, and deploy file.

- [ ] **Step 3: Add schema and Full Experience defaults**

Add the six properties to `openclaw.plugin.json` under `runtime.properties` with `additionalProperties: false` preserved. Add this entry beside the embedding cache in `CORE_FEATURES`:

```js
{ key: "llmResultCache", label: "LLM Result Cache", path: ["runtime", "llmResultCacheEnabled"], defaultValue: true },
```

- [ ] **Step 4: Expose per-agent metrics in status and close on shutdown**

In `collectStatusData`, add `llmResultCache: opts.llmResultCache || null` to the returned data. In `renderStatus`, render the section only when the object is present:

```text
🪙 LLM Result Cache
  Hit rate: 40.0% (4/10)
  Hits: memory=3, persistent=1
  Avoided tokens: input=1,200, output=300
  Persistence: active
```

Use `toLocaleString("en-US")` for token counts and render persistence as `active`, `configured but inactive`, or `off`. Do not render a dollar amount.

In the command handler, pass `llmResultCache.getMetrics(agentId)` into `collectStatusData`. In `gateway_stop`, call `await llmResultCache.close()` in its own logged `try/catch`, alongside but independent from DB/pool/metric shutdown.

- [ ] **Step 5: Add deploy integrity and operator documentation**

Add `lib/llm-result-cache.js` to `DEPLOY_FILES` beside `lib/llm-call.js`/`lib/embedding-cache.js`.

Add a concise README section documenting:

- exact agent-scoped results only;
- default 24-hour absolute TTL and 256 in-memory entries;
- optional prompt-free SQLite persistence, off by default;
- explicit non-goals/bypass list including the exact weather example `wie wird das Wetter morgen?`;
- all six config keys;
- status metrics report avoided input/output tokens, not money.

- [ ] **Step 6: Run focused tests, then full suite**

Run the focused config/status/profile/deploy/lifecycle tests first.

Expected: all focused tests PASS with pristine output.

Run: `node --test tests/*.test.js`

Expected: full suite PASS, zero failures. Record exact pass/fail/skip totals and any warnings in the implementation report.

- [ ] **Step 7: Commit**

```bash
git add openclaw.plugin.json index.js lib/setup/feature-profiles.js lib/telegram-commands/status-data.js lib/telegram-commands/status.js scripts/lib/deploy-integrity.mjs README.md tests/*.test.js
git commit -m "feat: configure and report LLM result cache"
```

/**
 * tests/embedding-cache.test.js
 *
 * TDD for LRU+TTL embedding cache.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddingCache } from "../lib/embedding-cache.js";
import { normalizeEmbeddingConfig } from "../lib/providers/config-normalize.js";
import { OpenAIEmbeddingProvider } from "../lib/providers/embedding-openai.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";

// node:sqlite is only stable (no flag) from Node 22.12+; 22.5–22.11 require --experimental-sqlite
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const hasSqlite = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 12);
const describeSqlite = hasSqlite ? describe : describe.skip;

describe("createEmbeddingCache", () => {
  it("returns a cache instance with default options", () => {
    const cache = createEmbeddingCache();
    assert.strictEqual(cache.size, 0);
    assert.strictEqual(typeof cache.get, "function");
    assert.strictEqual(typeof cache.set, "function");
    assert.strictEqual(typeof cache.clear, "function");
  });

  it("returns a cache instance with custom options", () => {
    const cache = createEmbeddingCache({ maxEntries: 100, ttlMs: 60000 });
    assert.strictEqual(cache.size, 0);
  });
});

describe("cache.get / cache.set", () => {
  it("returns vector on cache hit (same agent, same query, same model)", () => {
    const cache = createEmbeddingCache();
    const vector = [0.1, 0.2, 0.3];
    cache.set("agent-1", "hello world", "text-embedding-3-small@1", vector);
    const result = cache.get("agent-1", "hello world", "text-embedding-3-small@1");
    assert.deepStrictEqual(result, { vector });
  });

  it("returns undefined on cache miss (different agent)", () => {
    const cache = createEmbeddingCache();
    const vector = [0.1, 0.2, 0.3];
    cache.set("agent-1", "hello world", "text-embedding-3-small@1", vector);
    const result = cache.get("agent-2", "hello world", "text-embedding-3-small@1");
    assert.strictEqual(result, undefined);
  });

  it("returns undefined on cache miss (different model)", () => {
    const cache = createEmbeddingCache();
    const vector = [0.1, 0.2, 0.3];
    cache.set("agent-1", "hello world", "text-embedding-3-small@1", vector);
    const result = cache.get("agent-1", "hello world", "text-embedding-3-large@1");
    assert.strictEqual(result, undefined);
  });
});

describe("cache TTL", () => {
  it("returns undefined after TTL expires", async () => {
    const cache = createEmbeddingCache({ ttlMs: 50 });
    const vector = [0.1, 0.2, 0.3];
    cache.set("agent-1", "hello world", "text-embedding-3-small@1", vector);
    
    // Before TTL
    assert.deepStrictEqual(cache.get("agent-1", "hello world", "text-embedding-3-small@1"), { vector });
    
    // Wait for TTL to expire
    await new Promise(resolve => setTimeout(resolve, 60));
    
    // After TTL
    assert.strictEqual(cache.get("agent-1", "hello world", "text-embedding-3-small@1"), undefined);
  });
});

describe("cache LRU eviction", () => {
  it("evicts the oldest entry when maxEntries is exceeded", () => {
    const cache = createEmbeddingCache({ maxEntries: 2 });
    cache.set("agent-1", "query a", "model@1", [0.1]);
    cache.set("agent-1", "query b", "model@1", [0.2]);
    cache.set("agent-1", "query c", "model@1", [0.3]);

    assert.strictEqual(cache.size, 2);
    assert.strictEqual(cache.get("agent-1", "query a", "model@1"), undefined);
    assert.deepStrictEqual(cache.get("agent-1", "query b", "model@1"), { vector: [0.2] });
    assert.deepStrictEqual(cache.get("agent-1", "query c", "model@1"), { vector: [0.3] });
  });

  it("updates LRU order on get (accessed entry becomes newest)", () => {
    const cache = createEmbeddingCache({ maxEntries: 2 });
    cache.set("agent-1", "query a", "model@1", [0.1]);
    cache.set("agent-1", "query b", "model@1", [0.2]);

    // Access query a to make it newest
    cache.get("agent-1", "query a", "model@1");

    // Now add query c — query b should be evicted (oldest)
    cache.set("agent-1", "query c", "model@1", [0.3]);

    assert.strictEqual(cache.size, 2);
    assert.deepStrictEqual(cache.get("agent-1", "query a", "model@1"), { vector: [0.1] });
    assert.strictEqual(cache.get("agent-1", "query b", "model@1"), undefined);
    assert.deepStrictEqual(cache.get("agent-1", "query c", "model@1"), { vector: [0.3] });
  });
});

describe("cache.clear", () => {
  it("removes all entries", () => {
    const cache = createEmbeddingCache();
    cache.set("agent-1", "query a", "model@1", [0.1]);
    cache.set("agent-2", "query b", "model@2", [0.2]);
    assert.strictEqual(cache.size, 2);

    cache.clear();
    assert.strictEqual(cache.size, 0);
    assert.strictEqual(cache.get("agent-1", "query a", "model@1"), undefined);
    assert.strictEqual(cache.get("agent-2", "query b", "model@2"), undefined);
  });
});

describe("cache.size", () => {
  it("counts only non-expired entries when accessed", async () => {
    const cache = createEmbeddingCache({ ttlMs: 50 });
    cache.set("agent-1", "query a", "model@1", [0.1]);
    assert.strictEqual(cache.size, 1);

    await new Promise(resolve => setTimeout(resolve, 60));
    assert.strictEqual(cache.size, 0);
  });
});


describe("embedding-cache defaults", () => {
  it("uses lowered default maxEntries of 128", () => {
    const cache = createEmbeddingCache();
    for (let i = 0; i < 130; i++) {
      cache.set("agent-1", `query ${i}`, "model@1", [i]);
    }
    assert.strictEqual(cache.size, 128);
    assert.strictEqual(cache.get("agent-1", "query 0", "model@1"), undefined);
    assert.deepStrictEqual(cache.get("agent-1", "query 129", "model@1"), { vector: [129] });
  });

  it("uses lowered default ttlMs of 300000", async () => {
    const cache = createEmbeddingCache();
    cache.set("agent-1", "hello", "model@1", [1]);
    assert.deepStrictEqual(cache.get("agent-1", "hello", "model@1"), { vector: [1] });
    // The entry should still be alive well before the new 5-minute TTL.
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepStrictEqual(cache.get("agent-1", "hello", "model@1"), { vector: [1] });
  });
});

describe("embedding-cache key isolation", () => {
  it("hashes the full normalized text, so long differing queries do not collide", () => {
    const cache = createEmbeddingCache();
    const prefix = "x".repeat(256);
    const queryA = prefix + "a";
    const queryB = prefix + "b";
    cache.set("agent-1", queryA, "model@1", [42]);
    assert.deepStrictEqual(cache.get("agent-1", queryA, "model@1"), { vector: [42] });
    assert.strictEqual(
      cache.get("agent-1", queryB, "model@1"),
      undefined,
      "queries differing after the 256th char should not share a key"
    );
  });
});

describe("embedding-cache config passthrough", () => {
  it("passes embeddingCache* options through normalizeEmbeddingConfig", () => {
    const cfg = normalizeEmbeddingConfig({
      provider: "openai",
      apiKey: "test",
      embeddingCacheEnabled: true,
      embeddingCacheMaxEntries: 256,
      embeddingCacheTtlMs: 60000,
    });
    assert.strictEqual(cfg.embeddingCacheEnabled, true);
    assert.strictEqual(cfg.cacheMaxEntries, 256);
    assert.strictEqual(cfg.cacheTtlMs, 60000);
  });

  it("falls back to legacy cacheMaxEntries / cacheTtlMs field names", () => {
    const cfg = normalizeEmbeddingConfig({
      provider: "openai",
      apiKey: "test",
      cacheMaxEntries: 64,
      cacheTtlMs: 120000,
    });
    assert.strictEqual(cfg.cacheMaxEntries, 64);
    assert.strictEqual(cfg.cacheTtlMs, 120000);
  });

  it("OpenAIEmbeddingProvider respects explicit embeddingCacheEnabled=false", () => {
    const provider = new OpenAIEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      embeddingCacheEnabled: false,
    });
    assert.strictEqual(provider._cache, null);
  });

  it("LocalTransformersEmbeddingProvider caches repeated passage embeddings", async () => {
    const provider = new LocalTransformersEmbeddingProvider({
      model: "mock-local",
      dimensions: 2,
      cacheMaxEntries: 8,
    });
    let calls = 0;
    provider._getPipeline = async () => async (input) => {
      calls++;
      return [input.length, calls];
    };

    const first = await provider.embed("Hello", { agentId: "agent-a" });
    const second = await provider.embed(" hello ", { agentId: "agent-a" });

    assert.deepStrictEqual(second, first);
    assert.strictEqual(calls, 1);
  });

  it("LocalTransformersEmbeddingProvider keeps query and passage cache keys separate", async () => {
    const provider = new LocalTransformersEmbeddingProvider({
      model: "mock-local",
      dimensions: 2,
      cacheMaxEntries: 8,
    });
    let calls = 0;
    provider._getPipeline = async () => async (input) => {
      calls++;
      return [input.startsWith("query: ") ? 1 : 2, calls];
    };

    const passage = await provider.embedPassage("same", { agentId: "agent-a" });
    const query = await provider.embedQuery("same", { agentId: "agent-a" });

    assert.notDeepStrictEqual(query, passage);
    assert.strictEqual(calls, 2);
  });

  it("preserves explicit zero cache limits in local and OpenAI providers", async () => {
    const providers = [
      new LocalTransformersEmbeddingProvider({
        model: "mock-local",
        dimensions: 1,
        cacheMaxEntries: 0,
        cacheTtlMs: 0,
      }),
      new OpenAIEmbeddingProvider({
        model: "mock-openai",
        dimensions: 1,
        cacheMaxEntries: 0,
        cacheTtlMs: 0,
      }),
    ];

    for (const provider of providers) {
      let calls = 0;
      provider._computeBatch = async (texts) => {
        calls += 1;
        return texts.map(() => [calls]);
      };

      await provider.embedBatch(["zero-cache"]);
      await provider.embedBatch(["zero-cache"]);

      assert.strictEqual(calls, 2, `${provider.id} must not replace explicit zero cache limits`);
      assert.strictEqual(provider._cache.size, 0, `${provider.id} memory cache must remain disabled`);
    }
  });
});


describe("embedding-cache v2 getMany", () => {
  function makeTempBase() {
    return mkdtempSync(join(tmpdir(), "plur1bus-emb-cache-"));
  }

  function makeCache(opts = {}) {
    return createEmbeddingCache({
      cacheBasePath: makeTempBase(),
      ...opts,
    });
  }

  it("returns vectors in input order and preserves batch order", async () => {
    const cache = makeCache();
    const texts = ["alpha", "beta", "gamma"];
    const results = await cache.getMany(texts, {}, (missing) =>
      missing.map((t) => [t.length, t.charCodeAt(0)])
    );
    assert.deepStrictEqual(results, [
      [5, 97],
      [4, 98],
      [5, 103],
    ]);
  });

  it("coalesces duplicate keys inside a single batch", async () => {
    const cache = makeCache();
    let calls = 0;
    const results = await cache.getMany(["a", "b", "a", "c", "b"], {}, (missing) => {
      calls++;
      return missing.map((t) => [t.charCodeAt(0)]);
    });
    assert.strictEqual(calls, 1, "computeMissing should be called once for unique missing texts");
    assert.deepStrictEqual(results, [[97], [98], [97], [99], [98]]);
  });

  it("coalesces concurrent requests for identical keys", async () => {
    const cache = makeCache();
    let computeCalls = 0;
    const compute = async (missing) => {
      computeCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return missing.map((t) => [t.length]);
    };

    const [a, b] = await Promise.all([
      cache.getMany(["x", "y"], {}, compute),
      cache.getMany(["x", "y"], {}, compute),
    ]);

    assert.deepStrictEqual(a, [[1], [1]]);
    assert.deepStrictEqual(b, [[1], [1]]);
    assert.strictEqual(computeCalls, 1, "identical concurrent batches should share one compute");
  });

  it("coalesces overlapping concurrent requests and only computes new keys", async () => {
    const cache = makeCache();
    let computeCalls = 0;
    const seen = [];
    const compute = async (missing) => {
      computeCalls++;
      seen.push(...missing);
      await new Promise((r) => setTimeout(r, 10));
      return missing.map((t) => [t.charCodeAt(0)]);
    };

    const [a, b] = await Promise.all([
      cache.getMany(["x", "y"], {}, compute),
      cache.getMany(["y", "z"], {}, compute),
    ]);

    assert.deepStrictEqual(a, [[120], [121]]);
    assert.deepStrictEqual(b, [[121], [122]]);
    // y must be computed only once; z is new so a second compute is expected.
    assert.ok(seen.filter((t) => t === "y").length === 1, "overlapping key y should be computed once");
    assert.strictEqual(computeCalls, 2);
  });

  it("does not cache errors and retries on next request", async () => {
    const cache = makeCache();
    let computeCalls = 0;
    const compute = async (missing) => {
      computeCalls++;
      throw new Error("embedding failed");
    };

    await assert.rejects(cache.getMany(["fail"], {}, compute), /embedding failed/);
    await assert.rejects(cache.getMany(["fail"], {}, compute), /embedding failed/);
    assert.strictEqual(computeCalls, 2, "error should not be cached");
  });

  it("isolates keys by provider, model, dimensions and agent", async () => {
    const cache = makeCache();
    await cache.setMany([{ text: "hello", vector: [1, 2] }], {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      agentId: "agent-a",
    });

    const differentProvider = await cache.getMany(["hello"], {
      provider: "openai-compatible",
      model: "text-embedding-3-small",
      dimensions: 1536,
      agentId: "agent-a",
    });
    assert.strictEqual(differentProvider[0], undefined);

    const differentAgent = await cache.getMany(["hello"], {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      agentId: "agent-b",
    });
    assert.strictEqual(differentAgent[0], undefined);

    const sameKey = await cache.getMany(["hello"], {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      agentId: "agent-a",
    });
    assert.deepStrictEqual(sameKey[0], [1, 2]);
  });
});

describeSqlite("embedding-cache v2 persistence", () => {
  function makeTempBase() {
    return mkdtempSync(join(tmpdir(), "plur1bus-emb-cache-"));
  }

  it("persists vectors to SQLite and reloads after restart", async () => {
    const basePath = makeTempBase();
    const cache1 = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      ttlMs: 60_000,
    });

    const results = await cache1.getMany(["persist me"], { agentId: "a1" }, (missing) =>
      missing.map(() => [0.1, 0.2, 0.3])
    );
    assert.deepStrictEqual(results[0], [0.1, 0.2, 0.3]);

    const metrics1 = cache1.getMetrics();
    assert.strictEqual(metrics1.persistWrites, 1);
    assert.strictEqual(metrics1.persistHits, 0);

    const cache2 = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      ttlMs: 60_000,
    });
    const reloaded = await cache2.getMany(["persist me"], { agentId: "a1" });
    assert.deepStrictEqual(reloaded[0], [0.1, 0.2, 0.3]);

    const metrics2 = cache2.getMetrics();
    assert.strictEqual(metrics2.persistHits, 1);
  });

  it("does not persist plaintext by default", async () => {
    const basePath = makeTempBase();
    const cache = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
    });
    await cache.getMany(["secret text"], { agentId: "a1" }, (missing) =>
      missing.map(() => [1, 2, 3])
    );

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(basePath, "embedding-cache-v2", "a1.db"));
    const row = db.prepare("SELECT debug_text FROM embeddings LIMIT 1").get();
    assert.strictEqual(row.debug_text, null);
    db.close();
  });

  it("persists plaintext when persistDebug is enabled", async () => {
    const basePath = makeTempBase();
    const cache = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      persistDebug: true,
    });
    await cache.getMany(["debug text"], { agentId: "a1" }, (missing) =>
      missing.map(() => [1, 2, 3])
    );

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(basePath, "embedding-cache-v2", "a1.db"));
    const row = db.prepare("SELECT debug_text FROM embeddings LIMIT 1").get();
    assert.strictEqual(row.debug_text, "debug text");
    db.close();
  });

  it("honors TTL eviction from SQLite", async () => {
    const basePath = makeTempBase();
    const cache = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      ttlMs: 50,
    });
    await cache.getMany(["short-lived"], { agentId: "a1" }, (missing) =>
      missing.map(() => [9, 9])
    );

    await new Promise((r) => setTimeout(r, 80));

    const cache2 = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      ttlMs: 50,
    });
    const reloaded = await cache2.getMany(["short-lived"], { agentId: "a1" });
    assert.strictEqual(reloaded[0], undefined);
  });

  it("closes persistent SQLite handles and can reopen them", async () => {
    const basePath = makeTempBase();
    const cache = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      ttlMs: 60_000,
    });

    await cache.setMany([{ text: "close me", vector: [1, 2, 3] }], { agentId: "a1" });

    assert.strictEqual(typeof cache.close, "function");
    cache.close();
    cache.close();

    const reloaded = await cache.getMany(["close me"], { agentId: "a1" });
    assert.deepStrictEqual(reloaded[0], [1, 2, 3]);

    cache.close();
  });

  it("preserves absolute persistent expiry when promoting a hit to memory", async (t) => {
    const basePath = makeTempBase();
    t.after(() => rmSync(basePath, { recursive: true, force: true }));
    const dbPath = join(basePath, "embedding-cache-v2", "a1.db");
    const first = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      ttlMs: 60_000,
    });
    await first.setMany([{ text: "absolute-ttl", vector: [42] }], { agentId: "a1" });
    first.close();

    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(dbPath);
    database.prepare("UPDATE embeddings SET expires_at = ?").run(Date.now() + 300);
    database.close();

    const second = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      ttlMs: 60_000,
      metrics: true,
    });
    assert.deepStrictEqual(await second.getMany(["absolute-ttl"], { agentId: "a1" }), [[42]]);
    assert.strictEqual(second.getMetrics().persistHits, 1, "control must load from persistence");

    await new Promise((resolve) => setTimeout(resolve, 350));
    const expired = await second.getMany(["absolute-ttl"], { agentId: "a1" });
    assert.strictEqual(expired.length, 1);
    assert.strictEqual(
      expired[0],
      undefined,
      "memory promotion must not extend the persistent absolute expiry",
    );
    second.close();
  });

  it("recovers the same cache instance after a transient SQLite path failure", async (t) => {
    const basePath = makeTempBase();
    t.after(() => rmSync(basePath, { recursive: true, force: true }));
    const blocker = join(basePath, "embedding-cache-v2");
    const warnings = [];
    writeFileSync(blocker, "temporary blocker");
    const cache = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      metrics: true,
      logger: { warn: (...args) => warnings.push(args), debug() {} },
    });

    await cache.setMany([{ text: "initial-failure", vector: [1] }], { agentId: "a1" });
    assert.strictEqual(cache.getMetrics().persistWrites, 0);
    assert.ok(warnings.length >= 1, "the transient initialization failure must be logged");

    renameSync(blocker, `${blocker}.moved`);
    mkdirSync(blocker);
    await cache.setMany([{ text: "same-instance-retry", vector: [2] }], { agentId: "a1" });

    assert.strictEqual(cache.getMetrics().persistWrites, 1);
    assert.strictEqual(existsSync(join(blocker, "a1.db")), true);
    cache.close();
  });

  it("backs off repeated SQLite initialization failures without permanent poisoning", async (t) => {
    const basePath = makeTempBase();
    t.after(() => rmSync(basePath, { recursive: true, force: true }));
    const blocker = join(basePath, "embedding-cache-v2");
    const warnings = [];
    writeFileSync(blocker, "persistent blocker");
    const cache = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      logger: { warn: (...args) => warnings.push(args), debug() {} },
    });

    await cache.setMany([{ text: "failure-1", vector: [1] }], { agentId: "a1" });
    await cache.setMany([{ text: "failure-2", vector: [2] }], { agentId: "a1" });
    const warningsAfterRetry = warnings.length;
    await cache.setMany([{ text: "backoff-suppressed", vector: [3] }], { agentId: "a1" });
    assert.strictEqual(warnings.length, warningsAfterRetry, "retry backoff must suppress a hot failure loop");

    await new Promise((resolve) => setTimeout(resolve, 150));
    await cache.setMany([{ text: "failure-after-backoff", vector: [4] }], { agentId: "a1" });
    assert.ok(warnings.length > warningsAfterRetry, "bounded backoff must eventually retry");
    cache.close();
  });
});

describeSqlite("embedding-cache v2 size limits", () => {
  function makeTempBase() {
    return mkdtempSync(join(tmpdir(), "plur1bus-emb-cache-"));
  }

  it("skips persist writes when the hard byte limit is reached", async () => {
    const basePath = makeTempBase();
    const cache = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      ttlMs: 60_000,
      maxBytes: 1,
    });

    await cache.getMany(["too big"], { agentId: "a1" }, (missing) =>
      missing.map(() => [1, 2, 3, 4, 5])
    );

    const metrics = cache.getMetrics();
    assert.strictEqual(metrics.persistWriteSkipped, 1);
    assert.strictEqual(metrics.persistWrites, 0);
  });

  it("keeps in-memory cache working when persist writes are skipped", async () => {
    const basePath = makeTempBase();
    const cache = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      ttlMs: 60_000,
      maxBytes: 1,
    });

    const results = await cache.getMany(["in-mem only"], { agentId: "a1" }, (missing) =>
      missing.map(() => [7, 8, 9])
    );
    assert.deepStrictEqual(results[0], [7, 8, 9]);

    const hit = await cache.getMany(["in-mem only"], { agentId: "a1" });
    assert.deepStrictEqual(hit[0], [7, 8, 9]);
  });

  it("uses separate DB files for agent vs shared scope", async () => {
    const basePath = makeTempBase();
    const agentCache = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      scope: "agent",
    });
    const sharedCache = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      scope: "shared",
    });

    await agentCache.getMany(["scoped"], { agentId: "a1" }, (missing) => missing.map(() => [1]));
    await sharedCache.getMany(["scoped"], {}, (missing) => missing.map(() => [2]));

    const { DatabaseSync } = await import("node:sqlite");
    const agentDb = new DatabaseSync(join(basePath, "embedding-cache-v2", "a1.db"));
    const sharedDb = new DatabaseSync(join(basePath, "embedding-cache-v2", "shared.db"));

    const agentRow = agentDb.prepare("SELECT vector FROM embeddings LIMIT 1").get();
    const sharedRow = sharedDb.prepare("SELECT vector FROM embeddings LIMIT 1").get();

    assert.deepStrictEqual(JSON.parse(Buffer.from(agentRow.vector).toString()), [1]);
    assert.deepStrictEqual(JSON.parse(Buffer.from(sharedRow.vector).toString()), [2]);

    agentDb.close();
    sharedDb.close();
  });

  it("uses separate DB files for separate agent scopes in one cache instance", async () => {
    const basePath = makeTempBase();
    const cache = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      scope: "agent",
      provider: "test",
      model: "scope-test",
      dimensions: 2,
    });

    await cache.setMany([{ text: "alpha", vector: [1, 1] }], { agentId: "agent-a" });
    await cache.setMany([{ text: "beta", vector: [2, 2] }], { agentId: "agent-b" });

    const files = readdirSync(join(basePath, "embedding-cache-v2"))
      .filter((name) => name.endsWith(".db"))
      .sort();
    assert.deepStrictEqual(files, ["agent-a.db", "agent-b.db"]);

    const reload = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      scope: "agent",
      provider: "test",
      model: "scope-test",
      dimensions: 2,
    });
    assert.deepStrictEqual(await reload.getMany(["alpha"], { agentId: "agent-a" }), [[1, 1]]);
    assert.deepStrictEqual(await reload.getMany(["beta"], { agentId: "agent-b" }), [[2, 2]]);
  });

  it("counts WAL sidecar bytes when enforcing the hard byte limit", async () => {
    const basePath = makeTempBase();
    const seedCache = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      ttlMs: 60_000,
      maxBytes: 1_000_000,
    });

    await seedCache.getMany(["seed"], { agentId: "a1" }, () => [Array.from({ length: 512 }, (_, i) => i)]);

    const dbPath = join(basePath, "embedding-cache-v2", "a1.db");
    const walPath = `${dbPath}-wal`;
    assert.ok(existsSync(walPath), "WAL sidecar should be present while the cache DB is open");
    const dbBytes = statSync(dbPath).size;
    const walBytes = statSync(walPath).size;
    assert.ok(walBytes > 0, "WAL sidecar should contribute non-zero bytes");

    const limitedCache = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      ttlMs: 60_000,
      maxBytes: dbBytes + Math.floor(walBytes / 2),
    });
    await limitedCache.getMany(["over-limit"], { agentId: "a1" }, () => [[9, 9, 9]]);

    const metrics = limitedCache.getMetrics();
    assert.strictEqual(metrics.persistWrites, 0, "persist write must stop when db+wal exceeds maxBytes");
    assert.strictEqual(metrics.persistWriteSkipped, 1);
  });

  it("accounts for incoming serialized bytes and keeps an existing row when an entry is oversized", async (t) => {
    const basePath = makeTempBase();
    t.after(() => rmSync(basePath, { recursive: true, force: true }));
    const dbPath = join(basePath, "embedding-cache-v2", "a1.db");
    const cache = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      metrics: true,
      maxBytes: 50_000_000,
    });
    await cache.setMany([{ text: "seed", vector: [1] }], { agentId: "a1" });
    const beforeBytes = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
      .filter(existsSync)
      .reduce((total, path) => total + statSync(path).size, 0);
    const hardLimit = beforeBytes + 100_000;
    const oversized = Array.from({ length: 180_000 }, (_, index) => index % 10_000);

    await cache.setMany(
      [{ text: "oversized", vector: oversized }],
      { agentId: "a1", maxBytes: hardLimit },
    );

    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(dbPath);
    const rows = database.prepare("SELECT vector FROM embeddings").all();
    database.close();
    assert.strictEqual(rows.length, 1, "oversized rejection must not erase the existing cache row");
    assert.deepStrictEqual(JSON.parse(Buffer.from(rows[0].vector).toString("utf8")), [1]);
    assert.deepStrictEqual(cache.getMetrics(), {
      requests: 0,
      hits: 0,
      memoryHits: 0,
      persistHits: 0,
      misses: 0,
      coalesced: 0,
      persistWrites: 1,
      persistWriteSkipped: 1,
      errors: 0,
      hitRate: 0,
    });
    cache.close();
  });

  it("reclaims SQLite space in LRU batches and retains the newly written row", async (t) => {
    const basePath = makeTempBase();
    t.after(() => rmSync(basePath, { recursive: true, force: true }));
    const dbPath = join(basePath, "embedding-cache-v2", "a1.db");
    const seed = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      persistDebug: true,
      maxBytes: 50_000_000,
    });
    for (let index = 0; index < 20; index += 1) {
      await seed.setMany([{
        text: `old-${String(index).padStart(2, "0")}`,
        vector: Array.from({ length: 10_000 }, () => index),
      }], { agentId: "a1" });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    seed.close();
    const footprintBefore = statSync(dbPath).size;
    const hardLimit = Math.floor(footprintBefore * 0.8);

    const limited = createEmbeddingCache({
      cacheBasePath: basePath,
      persist: true,
      persistDebug: true,
      metrics: true,
      maxBytes: hardLimit,
    });
    await limited.setMany([{ text: "newest", vector: [999] }], { agentId: "a1" });
    const metrics = limited.getMetrics();
    limited.close();

    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(dbPath);
    const rows = database.prepare(
      "SELECT debug_text FROM embeddings ORDER BY accessed_at ASC, created_at ASC",
    ).all();
    database.close();
    assert.strictEqual(metrics.persistWrites, 1, "reclaimed capacity must retain the new write");
    assert.strictEqual(metrics.persistWriteSkipped, 0);
    assert.ok(rows.length > 0 && rows.length < 21, "cleanup should evict a bounded LRU subset");
    assert.strictEqual(rows.some((row) => row.debug_text === "old-00"), false);
    assert.strictEqual(rows.some((row) => row.debug_text === "newest"), true);
    assert.ok(statSync(dbPath).size <= hardLimit, "checkpoint/vacuum must restore the hard bound");
  });
});

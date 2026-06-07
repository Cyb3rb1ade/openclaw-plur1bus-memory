/**
 * tests/embedding-cache.test.js
 *
 * TDD for LRU+TTL embedding cache.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { createEmbeddingCache } from "../lib/embedding-cache.js";

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

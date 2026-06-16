import { describe, it } from "node:test";
import assert from "node:assert";
import { makeBoundedCache } from "../lib/bounded-cache.js";

describe("bounded-cache async eviction", () => {
  it("awaits an async onEvict during eviction", async () => {
    const evicted = [];
    let resolveEvict;
    const cache = makeBoundedCache(2, async (key, value) => {
      await new Promise((resolve) => { resolveEvict = resolve; });
      evicted.push({ key, value });
    });

    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // triggers eviction of oldest (a)

    assert.strictEqual(cache.has("a"), false);
    assert.strictEqual(evicted.length, 0, "async eviction should not have resolved yet");

    resolveEvict();
    await cache.awaitPendingEvictions();

    assert.strictEqual(evicted.length, 1);
    assert.deepStrictEqual(evicted[0], { key: "a", value: 1 });
  });

  it("does not create unhandled rejections when async onEvict rejects", async () => {
    const cache = makeBoundedCache(1, async () => {
      throw new Error("shutdown failed");
    });

    cache.set("a", 1);
    cache.set("b", 2); // eviction of a rejects internally

    // Pending evictions are guarded: awaitPendingEvictions resolves and the
    // rejection does not leak as an unhandled promise rejection.
    await cache.awaitPendingEvictions();
    assert.strictEqual(cache.has("a"), false);
  });

  it("still evicts synchronously even with async onEvict", async () => {
    const evicted = [];
    const cache = makeBoundedCache(1, async (key, value) => {
      evicted.push({ key, value });
    });

    cache.set("a", 1);
    cache.set("b", 2);

    assert.strictEqual(cache.has("a"), false);
    assert.strictEqual(cache.has("b"), true);
    await cache.awaitPendingEvictions();
    assert.strictEqual(evicted.length, 1);
  });

  it("does not evict entries with active refs", () => {
    const evicted = [];
    const cache = makeBoundedCache(1, (key, value) => {
      evicted.push({ key, value });
    });

    cache.acquire("a");
    cache.set("a", 1);
    cache.set("b", 2); // a is in use → soft limit exceeded, no eviction

    assert.strictEqual(cache.has("a"), true);
    assert.strictEqual(cache.has("b"), true);
    assert.strictEqual(evicted.length, 0);
  });
});

/**
 * tests/bounded-cache.test.js
 *
 * TDD for maxIdleMs eviction on top of bounded-cache behavior.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { makeBoundedCache } from "../lib/bounded-cache.js";

describe("bounded-cache idle eviction", () => {
  it("evicts an idle entry on get after maxIdleMs", async () => {
    const cache = makeBoundedCache(10, undefined, 50);
    cache.set("a", 1);
    assert.strictEqual(cache.get("a"), 1);

    await new Promise(resolve => setTimeout(resolve, 80));
    assert.strictEqual(cache.get("a"), undefined);
    assert.strictEqual(cache.has("a"), false);
  });

  it("does not idle-evict entries with active refs", async () => {
    const cache = makeBoundedCache(10, undefined, 50);
    cache.acquire("a");
    cache.set("a", 1);

    await new Promise(resolve => setTimeout(resolve, 80));
    // A hit updates lastUsedAt and returns the value; refs remain active.
    assert.strictEqual(cache.get("a"), 1);
    assert.strictEqual(cache.has("a"), true);

    cache.release("a");
    // After release and another idle window, the entry can be evicted.
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.strictEqual(cache.get("a"), undefined);
    assert.strictEqual(cache.has("a"), false);
  });

  it("still performs LRU eviction when maxIdleMs is set", () => {
    const evicted = [];
    const cache = makeBoundedCache(2, (key, value) => evicted.push({ key, value }), 60000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    assert.strictEqual(cache.has("a"), false);
    assert.strictEqual(cache.has("c"), true);
    assert.strictEqual(evicted.length, 1);
    assert.deepStrictEqual(evicted[0], { key: "a", value: 1 });
  });

  it("awaits async onEvict for idle eviction", async () => {
    const evicted = [];
    let resolveEvict;
    const cache = makeBoundedCache(10, async (key, value) => {
      await new Promise((resolve) => { resolveEvict = resolve; });
      evicted.push({ key, value });
    }, 50);

    cache.set("a", 1);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.strictEqual(cache.get("a"), undefined);
    assert.strictEqual(evicted.length, 0, "async eviction should not have resolved yet");

    resolveEvict();
    await cache.awaitPendingEvictions();
    assert.strictEqual(evicted.length, 1);
    assert.deepStrictEqual(evicted[0], { key: "a", value: 1 });
  });
});

import { describe, it } from "node:test";
import assert from "node:assert";
import { makeBoundedCache } from "../lib/bounded-cache.js";

describe("bounded-cache async shutdown", () => {
  it("awaits async onEvict during eviction", async () => {
    const closed = [];
    const cache = makeBoundedCache(2, async (key, db) => {
      await new Promise((r) => setTimeout(r, 5));
      db.closed = true;
      closed.push(key);
    });

    cache.set("a", { name: "a" });
    cache.set("b", { name: "b" });
    cache.set("c", { name: "c" }); // evicts 'a'

    await cache.awaitPendingEvictions();
    assert.deepStrictEqual(closed, ["a"]);
  });

  it("does not surface unhandled rejections from async onEvict", async () => {
    const cache = makeBoundedCache(1, async () => {
      await new Promise((_, reject) => setTimeout(reject, 1, new Error("shutdown boom")));
    });

    cache.set("a", {});
    cache.set("b", {}); // evicts 'a', async onEvict rejects

    // Must not throw unhandled — awaitPendingEvictions should settle gracefully.
    await cache.awaitPendingEvictions();
  });

  it("still evicts synchronously and respects ref counts", () => {
    const evicted = [];
    const cache = makeBoundedCache(2, (key) => evicted.push(key));
    cache.set("a", 1);
    cache.set("b", 2);
    cache.acquire("a");
    cache.set("c", 3);
    assert.deepStrictEqual(evicted, ["b"]);
    cache.release("a");
  });

  it("awaitPendingEvictions is a no-op when there are no async evictions", async () => {
    const cache = makeBoundedCache(2, () => {});
    cache.set("a", 1);
    await cache.awaitPendingEvictions();
    assert.strictEqual(cache.get("a"), 1);
  });
});

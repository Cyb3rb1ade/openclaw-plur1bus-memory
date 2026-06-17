import { describe, it } from "node:test";
import assert from "node:assert";
import { makeBoundedQueue } from "../lib/bounded-operation-queue.js";

describe("bounded-operation-queue", () => {
  it("accepts items while under maxDepth", () => {
    const q = makeBoundedQueue({ maxDepth: 3 });
    assert.deepStrictEqual(q.push({ id: 1 }), { accepted: true, evicted: false, dropped: false });
    assert.deepStrictEqual(q.push({ id: 2 }), { accepted: true, evicted: false, dropped: false });
    assert.strictEqual(q.length, 2);
  });

  it("evicts oldest low-priority background job when full", () => {
    const evicted = [];
    const q = makeBoundedQueue({
      maxDepth: 2,
      onEvict: (item) => evicted.push(item),
    });
    q.push({ id: 1, background: true, priority: "low" });
    q.push({ id: 2, background: true, priority: "low" });
    const result = q.push({ id: 3, background: true, priority: "low" });
    assert.strictEqual(result.accepted, true);
    assert.strictEqual(result.evicted, true);
    assert.strictEqual(evicted.length, 1);
    assert.strictEqual(evicted[0].id, 1);
    assert.deepStrictEqual(q.queue.map((i) => i.id), [2, 3]);
  });

  it("does not evict explicit jobs when full", () => {
    const evicted = [];
    const q = makeBoundedQueue({
      maxDepth: 2,
      onEvict: (item) => evicted.push(item),
    });
    q.push({ id: 1, background: false, priority: "normal" });
    q.push({ id: 2, background: false, priority: "normal" });
    const result = q.push({ id: 3, background: false, priority: "normal" });
    assert.strictEqual(result.accepted, true);
    assert.strictEqual(result.evicted, false);
    assert.strictEqual(evicted.length, 0);
    assert.strictEqual(q.length, 3);
  });

  it("drops new low-priority background jobs when full of non-evictable work", () => {
    const q = makeBoundedQueue({ maxDepth: 2 });
    q.push({ id: 1, background: false, priority: "normal" });
    q.push({ id: 2, background: false, priority: "high" });
    const result = q.push({ id: 3, background: true, priority: "low" });
    assert.strictEqual(result.accepted, false);
    assert.strictEqual(result.dropped, true);
    assert.strictEqual(q.length, 2);
  });

  it("calls onEvict with queueDepth metadata", () => {
    let meta;
    const q = makeBoundedQueue({
      maxDepth: 1,
      onEvict: (_, m) => { meta = m; },
    });
    q.push({ id: 1, background: true, priority: "low" });
    q.push({ id: 2, background: true, priority: "low" });
    assert.ok(meta);
    assert.strictEqual(typeof meta.queueDepth, "number");
  });
});

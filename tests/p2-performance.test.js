/**
 * P2 Performance Regression Tests
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBoundedCache } from "../lib/bounded-cache.js";
import { atomicJsonUpdate } from "../lib/atomic-json.js";

describe("makeBoundedCache", () => {
  it("stores and retrieves values", () => {
    const cache = makeBoundedCache(2);
    cache.set("a", 1);
    assert.strictEqual(cache.get("a"), 1);
  });

  it("evicts oldest unused entry when over limit", () => {
    const cache = makeBoundedCache(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    assert.strictEqual(cache.get("a"), undefined);
    assert.strictEqual(cache.get("b"), 2);
    assert.strictEqual(cache.get("c"), 3);
  });

  it("does not evict active entries", () => {
    const cache = makeBoundedCache(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.acquire("a");
    cache.set("c", 3);
    assert.strictEqual(cache.get("a"), 1);
    cache.release("a");
  });

  it("cleans up refs on release to zero", () => {
    const cache = makeBoundedCache(2);
    cache.acquire("a");
    cache.release("a");
    cache.set("b", 2);
    cache.set("c", 3);
    assert.strictEqual(cache.get("a"), undefined);
  });
});

describe("atomicJsonUpdate", () => {
  it("does not use synchronous filesystem calls", () => {
    const source = readFileSync(join(process.cwd(), "lib", "atomic-json.js"), "utf8");
    assert.doesNotMatch(source, /\b(existsSync|readFileSync|writeFileSync|renameSync)\b/);
  });

  it("writes atomically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-test-"));
    const path = join(dir, "state.json");
    await atomicJsonUpdate(path, (data) => ({ ...data, count: 1 }));
    const result = JSON.parse(readFileSync(path, "utf8"));
    assert.strictEqual(result.count, 1);
  });

  it("queues parallel updates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-test-"));
    const path = join(dir, "state.json");
    await Promise.all([
      atomicJsonUpdate(path, (data) => ({ ...data, a: 1 })),
      atomicJsonUpdate(path, (data) => ({ ...data, b: 2 })),
      atomicJsonUpdate(path, (data) => ({ ...data, c: 3 })),
    ]);
    const result = JSON.parse(readFileSync(path, "utf8"));
    assert.strictEqual(result.a, 1);
    assert.strictEqual(result.b, 2);
    assert.strictEqual(result.c, 3);
  });

  it("continues queue after error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-test-"));
    const path = join(dir, "state.json");
    const p1 = atomicJsonUpdate(path, () => { throw new Error("fail"); });
    const p2 = atomicJsonUpdate(path, (data) => ({ ...data, ok: true }));
    await assert.rejects(p1, /fail/);
    const result = await p2;
    assert.strictEqual(result.ok, true);
  });
});

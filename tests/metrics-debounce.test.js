/**
 * tests/metrics-debounce.test.js
 *
 * P2F: Hot-Path Metrics Debounce
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { createMetricsDebouncer } from "../lib/metrics-debounce.js";

describe("metrics-debounce", () => {
  it("accumulates multiple metrics without immediate flush", async () => {
    const flushed = [];
    const debouncer = createMetricsDebouncer({
      flushFn: async (dir, metrics) => flushed.push({ dir, metrics }),
      debounceMs: 1000,
    });

    debouncer.accumulate("/ws1", { latencyMs: 10 });
    debouncer.accumulate("/ws1", { latencyMs: 20 });
    debouncer.accumulate("/ws1", { results: 5 });

    // Should not flush immediately
    assert.strictEqual(flushed.length, 0);

    await debouncer.flush();
    assert.strictEqual(flushed.length, 1);
    assert.strictEqual(flushed[0].dir, "/ws1");
    assert.strictEqual(flushed[0].metrics.latencyMs, 20); // last value wins
    assert.strictEqual(flushed[0].metrics.results, 5);
  });

  it("flushes automatically after debounceMs", async () => {
    const flushed = [];
    const debouncer = createMetricsDebouncer({
      flushFn: async (dir, metrics) => flushed.push({ dir, metrics }),
      debounceMs: 50,
    });

    debouncer.accumulate("/ws1", { latencyMs: 10 });
    assert.strictEqual(flushed.length, 0);

    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(flushed.length, 1);
    assert.strictEqual(flushed[0].metrics.latencyMs, 10);
  });

  it("does not block on flush error", async () => {
    const debouncer = createMetricsDebouncer({
      flushFn: async () => { throw new Error("disk full"); },
      debounceMs: 10,
      onError: (err) => { /* swallowed in test */ },
    });

    debouncer.accumulate("/ws1", { latencyMs: 10 });
    // flush should not throw even though flushFn fails
    await debouncer.flush();
    // If we get here, flush did not throw
    assert.ok(true);
  });

  it("calls onError when flush fails", async () => {
    const errors = [];
    const debouncer = createMetricsDebouncer({
      flushFn: async () => { throw new Error("disk full"); },
      debounceMs: 10,
      onError: (err) => errors.push(err.message),
    });

    debouncer.accumulate("/ws1", { latencyMs: 10 });
    await debouncer.flush();
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0], "disk full");
  });

  it("separates workspaces", async () => {
    const flushed = [];
    const debouncer = createMetricsDebouncer({
      flushFn: async (dir, metrics) => flushed.push({ dir, metrics }),
      debounceMs: 10,
    });

    debouncer.accumulate("/ws1", { latencyMs: 10 });
    debouncer.accumulate("/ws2", { latencyMs: 20 });

    await debouncer.flush();
    assert.strictEqual(flushed.length, 2);
    const dirs = flushed.map((f) => f.dir).sort();
    assert.deepStrictEqual(dirs, ["/ws1", "/ws2"]);
  });

  it("does not double-flush on explicit flush + timer", async () => {
    const flushed = [];
    const debouncer = createMetricsDebouncer({
      flushFn: async (dir, metrics) => flushed.push({ dir, metrics }),
      debounceMs: 50,
    });

    debouncer.accumulate("/ws1", { latencyMs: 10 });
    await debouncer.flush(); // explicit

    // Wait for timer to fire too
    await new Promise((r) => setTimeout(r, 80));

    assert.strictEqual(flushed.length, 1);
  });
});

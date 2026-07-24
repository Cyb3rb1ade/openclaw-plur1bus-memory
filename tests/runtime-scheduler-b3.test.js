import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createBackgroundMemoryScheduler } from "../lib/runtime-scheduler.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function schedulerWith(config = {}) {
  return createBackgroundMemoryScheduler({
    config: { pressureGateEnabled: false, ...config },
    logger: { info() {}, warn() {}, debug() {} },
  });
}

async function timedFallback(scheduler, cacheKey, timeoutMs = 5) {
  return scheduler.runRecall(
    { cacheKey, timeoutMs },
    async () => {
      await sleep(timeoutMs + 20);
      return undefined;
    },
  );
}

describe("runtime scheduler B3 timeout admission and recall cache", () => {
  it("answers a timed-out capture promptly but retains the same-agent slot until callback settlement", async (t) => {
    const scheduler = schedulerWith({
      captureTimeoutMs: 20,
      maxConcurrentCapturePerAgent: 1,
    });
    const firstGate = deferred();
    const secondGate = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const starts = [];
    let active = 0;
    let maxActive = 0;

    const run = (name, gate, started) => scheduler.enqueueCapture(
      "agent-a",
      { timeoutMs: name === "first" ? 20 : 500 },
      async () => {
        starts.push(name);
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.resolve();
        try {
          await gate.promise;
        } finally {
          active -= 1;
        }
      },
    );

    const first = run("first", firstGate, firstStarted);
    await firstStarted.promise;
    const second = run("second", secondGate, secondStarted);
    t.after(() => {
      firstGate.resolve();
      secondGate.resolve();
    });

    const firstResult = await first;
    assert.equal(firstResult.timedOut, true, "the public result should retain fast timeout semantics");
    assert.equal(active, 1, "the ignored-abort callback is still running after the public timeout");
    await sleep(30);

    assert.deepEqual(starts, ["first"], "the second same-agent callback must remain queued");
    assert.equal(maxActive, 1, "configured capture concurrency must include timed-out callbacks that have not settled");
    assert.equal(scheduler.status().capture.queuedTotal, 1);

    firstGate.resolve();
    await secondStarted.promise;
    assert.equal(maxActive, 1, "FIFO handoff may occur only after the first callback settles");
    secondGate.resolve();

    const secondResult = await second;
    assert.equal(secondResult.ok, true, "normal successful capture remains available after the timed-out predecessor");
    assert.equal(scheduler.status().capture.active, 0);
  });

  it("bounds and sweeps the real high-cardinality agent/session/prompt recall key shape", async () => {
    const scheduler = schedulerWith({
      recallCacheMaxEntries: 3,
      recallCacheTtlMs: 5,
    });

    for (let index = 0; index < 200; index += 1) {
      const cacheKey = `agent-a:session-a:unique conversational prompt ${index}`;
      const result = await scheduler.runRecall({ cacheKey }, async () => ({ prependContext: `memory-${index}` }));
      assert.equal(result.ok, true);
    }

    assert.equal(scheduler.status().recall.cacheSize, 3, "unique prompt keys must respect the hard LRU bound");
    await sleep(10);
    await scheduler.runRecall(
      { cacheKey: "agent-a:session-a:unique conversational prompt after expiry" },
      async () => ({ prependContext: "fresh" }),
    );
    assert.equal(scheduler.status().recall.cacheSize, 1, "insertion/status should opportunistically remove unrelated expired keys");
  });

  it("keeps legitimate timeout hits while using LRU promotion without extending absolute TTL", async () => {
    const scheduler = schedulerWith({
      recallCacheMaxEntries: 2,
      recallCacheTtlMs: 80,
    });
    const keyA = "agent-a:session-a:prompt-a";
    const keyB = "agent-a:session-a:prompt-b";
    const keyC = "agent-a:session-a:prompt-c";

    await scheduler.runRecall({ cacheKey: keyA }, async () => "value-a");
    await scheduler.runRecall({ cacheKey: keyB }, async () => "value-b");

    const firstHit = await timedFallback(scheduler, keyA);
    assert.deepEqual(
      firstHit,
      { ok: true, value: "value-a", timedOut: true, fromCache: true, background: false },
      "a live cached recall remains the fast timeout fallback",
    );
    await sleep(30);

    await scheduler.runRecall({ cacheKey: keyC }, async () => "value-c");
    const evicted = await timedFallback(scheduler, keyB);
    assert.equal(evicted.ok, false, "the non-promoted LRU entry should be evicted first");
    assert.equal(evicted.timedOut, true);
    await sleep(30);

    await sleep(30);
    const expired = await timedFallback(scheduler, keyA);
    assert.equal(expired.ok, false, "cache access must not extend the original absolute expiry");
    assert.equal(expired.timedOut, true);
  });
});

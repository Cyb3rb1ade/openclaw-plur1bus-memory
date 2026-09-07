import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBackgroundMemoryScheduler } from "../lib/runtime-scheduler.js";

function makeLogger() {
  const lines = [];
  return { lines, info() {}, warn(msg) { lines.push(String(msg)); }, error() {}, debug() {} };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("recall scheduler — timeout of a job that never got a slot", () => {
  it("reports slot state, removes the job from the queue and never runs it", async () => {
    const logger = makeLogger();
    const scheduler = createBackgroundMemoryScheduler({
      config: { maxConcurrentRecall: 1, recallTimeoutMs: 60, eventLoopLagSnapshot: false, pressureGateEnabled: false },
      logger,
    });

    // Der einzige Slot wird von einem Job belegt, der das Abort-Signal ignoriert.
    let releaseFirst;
    const firstDone = new Promise((resolve) => { releaseFirst = resolve; });
    const first = scheduler.runRecall({ timeoutMs: 1000 }, () => firstDone);

    // Der zweite Job wartet auf den Slot und laeuft in sein eigenes Timeout.
    let secondRan = false;
    const second = await scheduler.runRecall({ timeoutMs: 60 }, async () => { secondRan = true; return "late"; });

    assert.equal(second.ok, false);
    assert.equal(second.timedOut, true);
    const line = logger.lines.find((l) => l.includes("recall worker timed out"));
    assert.ok(line, "timeout line missing");
    assert.match(line, /started=no/);
    assert.match(line, /activeCount=1/);
    assert.match(line, /maxConcurrent=1/);
    assert.match(line, /queueWaitMs=\d+/);
    assert.match(line, /queueDepth=0/);

    // Slot freigeben: der verworfene Job darf jetzt NICHT mehr anlaufen.
    releaseFirst("first");
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
    await sleep(20);
    assert.equal(secondRan, false);
    assert.equal(scheduler.status().recall.timedOut, 1);
  });

  it("marks a job that started but overran as started=yes", async () => {
    const logger = makeLogger();
    const scheduler = createBackgroundMemoryScheduler({
      config: { maxConcurrentRecall: 2, recallTimeoutMs: 40, eventLoopLagSnapshot: false, pressureGateEnabled: false },
      logger,
    });
    const result = await scheduler.runRecall({ timeoutMs: 40 }, () => new Promise(() => {}));
    assert.equal(result.timedOut, true);
    const line = logger.lines.find((l) => l.includes("recall worker timed out"));
    assert.match(line, /started=yes/);
    assert.match(line, /activeCount=1/);
  });
});

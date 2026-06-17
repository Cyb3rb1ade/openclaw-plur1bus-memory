import { describe, it } from "node:test";
import assert from "node:assert";
import { createBackgroundMemoryScheduler } from "../lib/runtime-scheduler.js";

const GiB = 1024 * 1024 * 1024;

function makeLogger() {
  const logs = [];
  const logger = {
    warn: (msg) => logs.push({ level: "warn", msg }),
    info: (msg) => logs.push({ level: "info", msg }),
  };
  return { logger, logs };
}

describe("runtime-scheduler pressure gate + bounded queue", () => {
  it("skips background recall under critical pressure", async () => {
    const { logger, logs } = makeLogger();
    const scheduler = createBackgroundMemoryScheduler({
      config: { rssWarningBytes: 1, rssCriticalBytes: 1 },
      logger,
    });
    const result = await scheduler.runRecall({ background: true, priority: "low" }, async () => "value");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.skipped, true);
    assert.ok(result.reason);
    assert.strictEqual(result.pressure.level, "critical");
    assert.ok(logs.some((l) => l.level === "warn" && l.msg.includes("recall skipped under pressure")));
  });

  it("allows explicit recall under critical pressure", async () => {
    const { logger } = makeLogger();
    const scheduler = createBackgroundMemoryScheduler({
      config: { rssWarningBytes: 1, rssCriticalBytes: 1 },
      logger,
    });
    const result = await scheduler.runRecall({ background: false, priority: "normal" }, async () => "explicit-value");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.value, "explicit-value");
    assert.strictEqual(result.skipped, undefined);
  });

  it("drops oldest low-priority background recall job when queue is full", async () => {
    const { logger, logs } = makeLogger();
    const scheduler = createBackgroundMemoryScheduler({
      config: { maxQueueDepthRecall: 1, recallTimeoutMs: 5000 },
      logger,
    });

    // Block the single recall slot briefly so additional jobs sit in the queue.
    scheduler.runRecall(
      { background: false, priority: "high", timeoutMs: 50 },
      async (signal) => { await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); },
    );

    // Fill the bounded queue with one low-priority background job.
    const first = scheduler.runRecall({ background: true, priority: "low" }, async () => "first");

    // This second low-priority background job must evict the oldest one.
    const second = scheduler.runRecall({ background: true, priority: "low" }, async () => "second");

    const firstResult = await first;
    assert.strictEqual(firstResult.ok, false);
    assert.strictEqual(firstResult.skipped, true);
    assert.strictEqual(firstResult.reason, "queue-depth-evicted");
    assert.strictEqual(firstResult.operation, "recall");
    assert.strictEqual(typeof firstResult.durationMs, "number");
    assert.strictEqual(firstResult.timeoutMs, 5000);

    const secondResult = await second;
    assert.strictEqual(secondResult.ok, true);
    assert.strictEqual(secondResult.value, "second");

    assert.ok(logs.some((l) => l.level === "warn" && l.msg.includes("recall queue evicted")));
  });

  it("does not silently drop explicit recall jobs when queue is full", async () => {
    const { logger, logs } = makeLogger();
    const scheduler = createBackgroundMemoryScheduler({
      config: { maxQueueDepthRecall: 1, recallTimeoutMs: 5000 },
      logger,
    });

    // Block the single recall slot briefly.
    scheduler.runRecall(
      { background: false, priority: "high", timeoutMs: 50 },
      async (signal) => { await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); },
    );

    // Fill the bounded queue with an explicit normal job.
    const first = scheduler.runRecall({ background: false, priority: "normal" }, async () => "first");

    // A second explicit job must be accepted (soft cap), not evicted or dropped.
    const second = scheduler.runRecall({ background: false, priority: "normal" }, async () => "second");

    // Assertions can be checked as soon as the jobs are queued; no need to wait
    // for the short-lived blocker to time out.
    assert.ok(!logs.some((l) => l.level === "warn" && l.msg.includes("evicted")));
    assert.ok(!logs.some((l) => l.level === "warn" && l.msg.includes("dropped")));

    const firstResult = await first;
    const secondResult = await second;
    assert.strictEqual(firstResult.skipped, undefined);
    assert.strictEqual(secondResult.skipped, undefined);
  });

  it("exposes pressure and queue depth in status()", async () => {
    const { logger } = makeLogger();
    const scheduler = createBackgroundMemoryScheduler({
      config: { rssWarningBytes: 1, rssCriticalBytes: 1 },
      logger,
    });
    await scheduler.runRecall({ background: true, priority: "low" }, async () => "v");
    const s = scheduler.status();
    assert.ok(s.pressure);
    assert.ok(["ok", "warning", "critical"].includes(s.pressure.level));
    assert.strictEqual(typeof s.pressure.rssBytes, "number");
    assert.strictEqual(typeof s.recall.queued, "number");
    assert.strictEqual(typeof s.capture.queuedTotal, "number");
    assert.strictEqual(typeof s.capture.queuedAgents, "number");
    assert.strictEqual(typeof s.recall.skipped, "number");
    assert.strictEqual(typeof s.capture.skipped, "number");
  });

  it("skips low-priority recall at warning pressure but allows normal", async () => {
    const { logger, logs } = makeLogger();
    // Current RSS is almost certainly > 1 byte and < MAX_SAFE_INTEGER bytes,
    // so warning=1 and critical=MAX_SAFE_INTEGER yields warning.
    const scheduler = createBackgroundMemoryScheduler({
      config: { rssWarningBytes: 1, rssCriticalBytes: Number.MAX_SAFE_INTEGER },
      logger,
    });
    const low = await scheduler.runRecall({ background: false, priority: "low" }, async () => "low");
    const normal = await scheduler.runRecall({ background: false, priority: "normal" }, async () => "normal");
    assert.strictEqual(low.skipped, true);
    assert.strictEqual(normal.ok, true);
    assert.strictEqual(normal.value, "normal");
  });

  it("drops oldest low-priority background capture job when queue is full", async () => {
    const { logger, logs } = makeLogger();
    const scheduler = createBackgroundMemoryScheduler({
      config: { maxQueueDepthCapturePerAgent: 1, captureTimeoutMs: 5000 },
      logger,
    });

    // Block the single capture slot for agent "a" briefly.
    scheduler.enqueueCapture(
      "a",
      { background: false, priority: "high", timeoutMs: 50 },
      async (signal) => { await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); },
    );

    const first = scheduler.enqueueCapture("a", { background: true, priority: "low" }, async () => "first");
    const second = scheduler.enqueueCapture("a", { background: true, priority: "low" }, async () => "second");

    const firstResult = await first;
    assert.strictEqual(firstResult.ok, false);
    assert.strictEqual(firstResult.skipped, true);
    assert.strictEqual(firstResult.reason, "queue-depth-evicted");
    assert.strictEqual(firstResult.operation, "capture");

    const secondResult = await second;
    assert.strictEqual(secondResult.ok, true);

    assert.ok(logs.some((l) => l.level === "warn" && l.msg.includes("capture queue evicted")));
  });
});

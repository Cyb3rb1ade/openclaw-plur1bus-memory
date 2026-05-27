import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBackgroundMemoryScheduler,
  isBackgroundTurn,
  normalizeRuntimeConfig,
} from "../lib/runtime-scheduler.js";

test("runtime config keeps conservative defaults for full memory work", () => {
  const cfg = normalizeRuntimeConfig({});
  assert.equal(cfg.recallTimeoutMs, 45_000);
  assert.equal(cfg.captureTimeoutMs, 60_000);
  assert.equal(cfg.maxConcurrentRecall, 2);
  assert.equal(cfg.maxConcurrentCapturePerAgent, 1);
  assert.equal(cfg.backgroundPriority, "low");
});

test("background turn detection covers cron and heartbeat without disabling memory work", () => {
  assert.equal(isBackgroundTurn({ prompt: "[cron:job-a] run review" }, {}), true);
  assert.equal(isBackgroundTurn({}, { sessionKey: "agent:main:cron:job-a" }), true);
  assert.equal(isBackgroundTurn({}, { sessionKey: "agent:main:main:heartbeat" }), true);
  assert.equal(isBackgroundTurn({ origin: "internal" }, {}), true);
  assert.equal(isBackgroundTurn({ prompt: "normal user request" }, { sessionKey: "agent:main:main" }), false);
});

test("background recall still runs the full scheduled callback", async () => {
  let ran = false;
  const scheduler = createBackgroundMemoryScheduler({
    config: { recallTimeoutMs: 1000, maxConcurrentRecall: 1 },
    logger: { warn() {} },
  });
  const result = await scheduler.runRecall({
    background: true,
    cacheKey: "agent:cron:query",
    priority: "low",
  }, async () => {
    ran = true;
    return { prependContext: "reranked recall context" };
  });
  assert.equal(ran, true);
  assert.equal(result.ok, true);
  assert.equal(result.value.prependContext, "reranked recall context");
  assert.equal(scheduler.status().recall.lastBackgroundRecallAt !== null, true);
});

test("recall timeout falls back to the last successful cached result", async () => {
  const warnings = [];
  const scheduler = createBackgroundMemoryScheduler({
    config: { recallTimeoutMs: 20, recallCacheTtlMs: 10_000, maxConcurrentRecall: 1 },
    logger: { warn(message) { warnings.push(String(message)); } },
  });
  const meta = { background: true, cacheKey: "agent:heartbeat:query", priority: "low" };
  const first = await scheduler.runRecall(meta, async () => ({ prependContext: "fresh" }));
  assert.equal(first.ok, true);
  const second = await scheduler.runRecall(meta, async () => {
    await new Promise(resolve => setTimeout(resolve, 80));
    return { prependContext: "late" };
  });
  assert.equal(second.ok, true);
  assert.equal(second.timedOut, true);
  assert.equal(second.fromCache, true);
  assert.equal(second.value.prependContext, "fresh");
  assert.ok(warnings.some(message => message.includes("recall worker timed out")));
});

test("capture queue serializes work per agent", async () => {
  const order = [];
  const scheduler = createBackgroundMemoryScheduler({
    config: { captureTimeoutMs: 1000 },
    logger: { warn() {} },
  });
  const first = scheduler.enqueueCapture("main", { background: true }, async () => {
    order.push("first-start");
    await new Promise(resolve => setTimeout(resolve, 20));
    order.push("first-end");
  });
  const second = scheduler.enqueueCapture("main", { background: true }, async () => {
    order.push("second-start");
    order.push("second-end");
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
  assert.equal(scheduler.status().capture.lastBackgroundCaptureAt !== null, true);
});

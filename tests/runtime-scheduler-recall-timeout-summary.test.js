import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBackgroundMemoryScheduler } from "../lib/runtime-scheduler.js";
import { createRecallPhaseTimer } from "../lib/recall-phase-timer.js";

function makeLogger() {
  const logs = [];
  return {
    logger: {
      warn: (msg) => logs.push({ level: "warn", msg }),
      info: () => {},
    },
    logs,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runtime-scheduler recall timeout summary", () => {
  it("logs phase, elapsedMs, completed phases, queue depth and event-loop lag on timeout", async () => {
    const { logger, logs } = makeLogger();
    const scheduler = createBackgroundMemoryScheduler({
      config: { recallTimeoutMs: 25, eventLoopLagResolutionMs: 10 },
      logger,
    });
    const phaseTimer = createRecallPhaseTimer({
      softBudgetMs: 15,
      hardTimeoutMs: 25,
      logger,
    });

    const result = await scheduler.runRecall(
      { background: true, priority: "low", phaseTimer },
      async (signal, timer) => {
        timer.start("rerank");
        await sleep(100);
        timer.end("rerank");
        return "never";
      }
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.timedOut, true);

    const timeoutLog = logs.find((l) => l.level === "warn" && l.msg.includes("recall worker timed out"));
    assert.ok(timeoutLog, "expected timeout log");
    const msg = timeoutLog.msg;
    assert.ok(msg.includes("phase=rerank"), `expected phase in log: ${msg}`);
    assert.ok(/elapsedMs=\d+/.test(msg), `expected elapsedMs in log: ${msg}`);
    assert.ok(msg.includes("completed="), `expected completed in log: ${msg}`);
    assert.ok(/queueDepth=\d+/.test(msg), `expected queueDepth in log: ${msg}`);
    assert.ok(/eventLoopLagP99Ms=[\d.]+|eventLoopLagP99Ms=na/.test(msg), `expected eventLoopLagP99Ms in log: ${msg}`);
  });

  it("falls back to a default phase timer when none is supplied", async () => {
    const { logger, logs } = makeLogger();
    const scheduler = createBackgroundMemoryScheduler({
      config: { recallTimeoutMs: 20 },
      logger,
    });

    const result = await scheduler.runRecall(
      { background: true, priority: "low" },
      async () => { await sleep(100); return "never"; }
    );

    assert.strictEqual(result.timedOut, true);
    const timeoutLog = logs.find((l) => l.level === "warn" && l.msg.includes("recall worker timed out"));
    assert.ok(timeoutLog);
    assert.ok(timeoutLog.msg.includes("phase=none"));
  });
});

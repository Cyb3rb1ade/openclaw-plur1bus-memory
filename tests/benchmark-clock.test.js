import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

import { measureCpuMilliseconds } from "./helpers/benchmark-clock.js";

test("CPU benchmark time excludes a scheduler-equivalent blocking pause", () => {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  const wallStartedAt = performance.now();
  const measuredMs = measureCpuMilliseconds(() => {
    Atomics.wait(waitArray, 0, 0, 40);
  });
  const wallMs = performance.now() - wallStartedAt;

  assert.ok(wallMs >= 30, `control wait was unexpectedly short: ${wallMs.toFixed(3)}ms`);
  assert.ok(
    measuredMs < wallMs / 2,
    `CPU measurement counted a non-CPU pause: measured=${measuredMs.toFixed(3)}ms wall=${wallMs.toFixed(3)}ms`,
  );
});

test("CPU benchmark time excludes concurrent worker and GC-style helper work", {
  skip: typeof process.threadCpuUsage !== "function"
    ? "per-thread CPU accounting requires Node 22.19 or newer"
    : false,
}, async () => {
  const worker = new Worker(
    `
      const { parentPort } = require("node:worker_threads");
      parentPort.postMessage("ready");
      while (true) Math.sqrt(Math.random());
    `,
    { eval: true },
  );
  await once(worker, "message");

  try {
    const waitArray = new Int32Array(new SharedArrayBuffer(4));
    const wallStartedAt = performance.now();
    const measuredMs = measureCpuMilliseconds(() => {
      Atomics.wait(waitArray, 0, 0, 80);
    });
    const wallMs = performance.now() - wallStartedAt;

    assert.ok(wallMs >= 60, `control wait was unexpectedly short: ${wallMs.toFixed(3)}ms`);
    assert.ok(
      measuredMs < wallMs / 2,
      `CPU measurement counted worker-thread work: measured=${measuredMs.toFixed(3)}ms wall=${wallMs.toFixed(3)}ms`,
    );
  } finally {
    await worker.terminate();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";

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

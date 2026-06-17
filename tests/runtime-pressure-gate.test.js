import { describe, it } from "node:test";
import assert from "node:assert";
import { checkRuntimePressure, normalizePressureThresholds, DEFAULT_PRESSURE_THRESHOLDS } from "../lib/runtime-pressure-gate.js";

const GiB = 1024 * 1024 * 1024;

describe("runtime-pressure-gate", () => {
  it("returns ok when RSS is below warning threshold", () => {
    const result = checkRuntimePressure({ rssWarningBytes: 10 * GiB, rssCriticalBytes: 20 * GiB });
    assert.strictEqual(result.level, "ok");
    assert.ok(result.rssBytes > 0);
    assert.ok(result.heapUsedBytes > 0);
    assert.strictEqual(result.thresholdBytes, 10 * GiB);
    assert.ok(result.reason.includes("below warning"));
  });

  it("returns warning when RSS is between warning and critical", () => {
    // Force warning by setting thresholds just below current RSS.
    const result = checkRuntimePressure({ rssWarningBytes: 1, rssCriticalBytes: Number.MAX_SAFE_INTEGER });
    assert.strictEqual(result.level, "warning");
    assert.ok(result.rssBytes >= result.thresholdBytes);
    assert.ok(result.reason.includes("warning"));
  });

  it("returns critical when RSS is above critical threshold", () => {
    const result = checkRuntimePressure({ rssWarningBytes: 1, rssCriticalBytes: 1 });
    assert.strictEqual(result.level, "critical");
    assert.ok(result.rssBytes >= result.thresholdBytes);
    assert.ok(result.reason.includes("critical"));
  });

  it("uses default 3.0 GiB warning and 4.5 GiB critical", () => {
    const result = checkRuntimePressure();
    assert.deepStrictEqual(normalizePressureThresholds(), {
      rssWarningBytes: 3 * GiB,
      rssCriticalBytes: 4.5 * GiB,
    });
    assert.strictEqual(DEFAULT_PRESSURE_THRESHOLDS.rssWarningBytes, 3 * GiB);
    assert.strictEqual(DEFAULT_PRESSURE_THRESHOLDS.rssCriticalBytes, 4.5 * GiB);
    assert.ok(["ok", "warning", "critical"].includes(result.level));
  });

  it("includes heapUsed in the reason", () => {
    const result = checkRuntimePressure({ rssWarningBytes: 1, rssCriticalBytes: 1 });
    assert.ok(result.reason.includes("heapUsed"));
  });
});

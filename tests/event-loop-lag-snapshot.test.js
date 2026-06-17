import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEventLoopLagSnapshot } from "../lib/event-loop-lag-snapshot.js";

describe("event-loop-lag-snapshot", () => {
  it("returns available snapshot with numeric fields", async () => {
    const lag = createEventLoopLagSnapshot({ enabled: true, resolutionMs: 10 });
    // Give the histogram a chance to collect at least one sample.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const snap = lag.snapshot();
    assert.strictEqual(snap.available, true);
    assert.strictEqual(typeof snap.meanMs, "number");
    assert.strictEqual(typeof snap.maxMs, "number");
    assert.strictEqual(typeof snap.p99Ms, "number");
    assert.ok(typeof snap.count === "number" || typeof snap.count === "undefined");
    lag.disable();
  });

  it("returns unavailable when disabled", () => {
    const lag = createEventLoopLagSnapshot({ enabled: false });
    const snap = lag.snapshot();
    assert.strictEqual(snap.available, false);
  });

  it("survives enable/disable toggles", () => {
    const lag = createEventLoopLagSnapshot({ enabled: true });
    lag.disable();
    lag.enable();
    const snap = lag.snapshot();
    assert.strictEqual(typeof snap.available, "boolean");
    lag.disable();
  });
});

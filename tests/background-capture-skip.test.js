import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldSkipAutoCaptureForInternalTurn } from "../lib/runtime-scheduler.js";

describe("shouldSkipAutoCaptureForInternalTurn", () => {
  it("skips cron origin", () => {
    assert.strictEqual(shouldSkipAutoCaptureForInternalTurn({ origin: "cron" }, {}), true);
  });

  it("skips internal origin", () => {
    assert.strictEqual(shouldSkipAutoCaptureForInternalTurn({ origin: "internal" }, {}), true);
  });

  it("skips heartbeat kind", () => {
    assert.strictEqual(shouldSkipAutoCaptureForInternalTurn({ kind: "heartbeat" }, {}), true);
  });

  it("skips background session key", () => {
    assert.strictEqual(
      shouldSkipAutoCaptureForInternalTurn({}, { sessionKey: "agent:main:cron:plur1bus-evening-review" }),
      true,
    );
  });

  it("skips OpenClaw active-memory child sessions", () => {
    assert.strictEqual(
      shouldSkipAutoCaptureForInternalTurn({}, {
        sessionKey: "agent:bernhardine:telegram:bernhardine:direct:1211667028:active-memory:ffe3629431db",
      }),
      true,
    );
  });

  it("skips dreaming origin", () => {
    assert.strictEqual(shouldSkipAutoCaptureForInternalTurn({ origin: "dreaming" }, {}), true);
  });

  it("does NOT skip normal user turns", () => {
    assert.strictEqual(
      shouldSkipAutoCaptureForInternalTurn({ prompt: "remember that I prefer dark mode", origin: "user" }, { sessionKey: "agent:main:main" }),
      false,
    );
  });

  it("does NOT carve out explicit memory commands for background turns", () => {
    assert.strictEqual(
      shouldSkipAutoCaptureForInternalTurn({ prompt: "memory_store this fact", origin: "cron" }, {}),
      true,
    );
  });
});

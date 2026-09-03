import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

  it("skips the exact OpenClaw Beta-1 cron trigger carried only by hook context", () => {
    assert.strictEqual(
      shouldSkipAutoCaptureForInternalTurn(
        { prompt: "run scheduled internal maintenance" },
        { trigger: "cron" },
      ),
      true,
    );
  });

  it("skips an OpenClaw internal manual trigger carried only by the event", () => {
    assert.strictEqual(
      shouldSkipAutoCaptureForInternalTurn(
        { prompt: "resume an internal host task", trigger: "manual" },
        {},
      ),
      true,
    );
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

  it("gates internal turns before the NEO worker or any durable capture path", () => {
    const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    const autoCaptureStart = source.indexOf("if (autoCapture) {");
    const handlerStart = source.indexOf('api.on("agent_end"', autoCaptureStart);
    const skipAt = source.indexOf("shouldSkipAutoCaptureForInternalTurn(event, ctx)", handlerStart);
    const neoAt = source.indexOf("neoWorkerRuntime.runNeoAgentEnd", handlerStart);
    assert.ok(autoCaptureStart >= 0 && handlerStart >= 0 && skipAt >= 0 && neoAt >= 0);
    assert.ok(skipAt < neoAt, "the internal-turn gate must run before NEO capture");
  });
});

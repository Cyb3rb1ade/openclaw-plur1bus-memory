import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldSkipAutoRecallForInternalTurn } from "../lib/runtime-scheduler.js";

describe("shouldSkipAutoRecallForInternalTurn", () => {
  it("skips cron origin", () => {
    assert.strictEqual(shouldSkipAutoRecallForInternalTurn({ origin: "cron" }, {}), true);
  });

  it("skips internal origin", () => {
    assert.strictEqual(shouldSkipAutoRecallForInternalTurn({ origin: "internal" }, {}), true);
  });

  it("skips heartbeat kind", () => {
    assert.strictEqual(shouldSkipAutoRecallForInternalTurn({ kind: "heartbeat" }, {}), true);
  });

  it("skips background kind", () => {
    assert.strictEqual(shouldSkipAutoRecallForInternalTurn({ kind: "background" }, {}), true);
  });

  it("skips cron session key", () => {
    assert.strictEqual(shouldSkipAutoRecallForInternalTurn({}, { sessionKey: "agent:main:cron:job-a" }), true);
  });

  it("skips heartbeat session key", () => {
    assert.strictEqual(shouldSkipAutoRecallForInternalTurn({}, { sessionKey: "agent:main:main:heartbeat" }), true);
  });

  it("skips cron prompt marker", () => {
    assert.strictEqual(shouldSkipAutoRecallForInternalTurn({ prompt: "[cron:job-a] run review" }, {}), true);
  });

  it("skips heartbeat_ok prompt", () => {
    assert.strictEqual(shouldSkipAutoRecallForInternalTurn({ prompt: "heartbeat_ok" }, {}), true);
  });

  it("skips dreaming magic marker", () => {
    assert.strictEqual(
      shouldSkipAutoRecallForInternalTurn({ prompt: "__openclaw_memory_core_short_term_promotion_dream__" }, {}),
      true,
    );
  });

  it("skips light sleep magic marker", () => {
    assert.strictEqual(
      shouldSkipAutoRecallForInternalTurn({ prompt: "__openclaw_memory_core_light_sleep__" }, {}),
      true,
    );
  });

  it("skips rem sleep magic marker", () => {
    assert.strictEqual(
      shouldSkipAutoRecallForInternalTurn({ prompt: "__openclaw_memory_core_rem_sleep__" }, {}),
      true,
    );
  });

  it("skips dreaming origin", () => {
    assert.strictEqual(shouldSkipAutoRecallForInternalTurn({ origin: "dreaming" }, {}), true);
  });

  it("skips promotion origin", () => {
    assert.strictEqual(shouldSkipAutoRecallForInternalTurn({ origin: "promotion" }, {}), true);
  });

  it("skips background origin", () => {
    assert.strictEqual(shouldSkipAutoRecallForInternalTurn({ origin: "background" }, {}), true);
  });

  it("skips dreaming in session key", () => {
    assert.strictEqual(shouldSkipAutoRecallForInternalTurn({}, { sessionKey: "agent:dreaming:night" }), true);
  });

  it("does NOT skip normal user turns", () => {
    assert.strictEqual(
      shouldSkipAutoRecallForInternalTurn({ prompt: "normal user request", origin: "user" }, { sessionKey: "agent:main:main" }),
      false,
    );
  });

  it("is case-insensitive for magic markers", () => {
    assert.strictEqual(
      shouldSkipAutoRecallForInternalTurn({ prompt: "__OpenClaw_Memory_Core_Light_Sleep__" }, {}),
      true,
    );
  });

  // Regression: gewöhnliche englische Wörter dürfen kein Skip auslösen.
  it("does NOT skip prompt with common word 'background' from user", () => {
    assert.strictEqual(
      shouldSkipAutoRecallForInternalTurn({ prompt: "my background is in computer science", origin: "user" }, {}),
      false,
    );
  });

  it("does NOT skip prompt with common word 'promotion' from user", () => {
    assert.strictEqual(
      shouldSkipAutoRecallForInternalTurn({ prompt: "SEO promotion strategies for my website", origin: "user" }, {}),
      false,
    );
  });

  it("does NOT skip prompt with common word 'dreaming' from user", () => {
    assert.strictEqual(
      shouldSkipAutoRecallForInternalTurn({ prompt: "I was dreaming about a new project idea", origin: "user" }, {}),
      false,
    );
  });

  // Carve-out: explizite Memory-Kommandos müssen AutoRecall immer erreichen.
  it("does NOT skip /recall command even with cron origin", () => {
    assert.strictEqual(
      shouldSkipAutoRecallForInternalTurn({ prompt: "/recall last week", origin: "cron" }, {}),
      false,
    );
  });

  it("does NOT skip memory_store command even in background context", () => {
    assert.strictEqual(
      shouldSkipAutoRecallForInternalTurn({ prompt: "memory_store this fact", kind: "background" }, {}),
      false,
    );
  });

  it("does NOT skip memory_recall command even with dreaming session key", () => {
    assert.strictEqual(
      shouldSkipAutoRecallForInternalTurn({ prompt: "memory_recall project context" }, { sessionKey: "agent:dreaming:night" }),
      false,
    );
  });
});

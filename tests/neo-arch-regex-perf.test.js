import { describe, it } from "node:test";
import assert from "node:assert";
import { isInjectedContextText } from "../lib/neo-arch.js";

describe("neo-arch regex performance regression", () => {
  it("matches known injected-context markers", () => {
    const cases = [
      "<plur1bus-recall>foo</plur1bus-recall>",
      "RECALL SAFETY RULES",
      "plur1bus internal classify-recent",
      "[cron: heartbeat]",
      "heartbeat_ok",
      'capturedBy": "agent_end_capture',
      'embeddingStatus": "pending',
      '"chat_id": "telegram:123"',
      '"message_id": "456"',
      '"sender_id": "u"',
    ];
    for (const c of cases) {
      assert.strictEqual(isInjectedContextText(c), true, `expected injected: ${c.slice(0, 80)}`);
    }
  });

  it("does not flag ordinary text", () => {
    const cases = [
      "Hello world",
      "The quick brown fox jumps over the lazy dog.",
      "User asked about the project deadline.",
      JSON.stringify({ content: "normal memory", role: "user" }),
    ];
    for (const c of cases) {
      assert.strictEqual(isInjectedContextText(c), false, `expected not injected: ${c.slice(0, 80)}`);
    }
  });

  it("handles long normal text within a time budget", () => {
    const text = "x".repeat(20000);
    const runs = 1000;
    const start = performance.now();
    for (let i = 0; i < runs; i++) isInjectedContextText(text);
    const ms = performance.now() - start;
    // Budget: 1 ms per 10k-char check on average (very conservative).
    assert.ok(ms / runs < 1.0, `long normal text too slow: ${(ms / runs).toFixed(3)} ms/op`);
  });

  it("handles long injected text within a time budget", () => {
    const text = "x".repeat(10000) + "<plur1bus-recall>" + "x".repeat(10000);
    const runs = 1000;
    const start = performance.now();
    for (let i = 0; i < runs; i++) isInjectedContextText(text);
    const ms = performance.now() - start;
    assert.ok(ms / runs < 1.0, `long injected text too slow: ${(ms / runs).toFixed(3)} ms/op`);
  });

  it("does not catastrophic-backtrack on adversarial punctuation soup", () => {
    // Many angle brackets, quotes and slashes — old alternation regex could
    // super-linearly scan this.
    const text = "<" + "x</".repeat(5000) + ">";
    const start = performance.now();
    const result = isInjectedContextText(text);
    const ms = performance.now() - start;
    assert.strictEqual(result, false);
    assert.ok(ms < 100, `adversarial text took ${ms.toFixed(1)} ms`);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert";
import { isInjectedContextText } from "../lib/neo-arch.js";

describe("neo-arch isInjectedContextText regex performance", () => {
  it("matches all known injected-context markers (semantics preserved)", () => {
    const cases = [
      "<plur1bus-recall>foo</plur1bus-recall>",
      "</plur1bus-recall>",
      "<relevant-memories>foo</relevant-memories>",
      "</relevant-memories>",
      "<knowledge-update-reminder>foo</knowledge-update-reminder>",
      "</knowledge-update-reminder>",
      "<adaptive-learning>foo</adaptive-learning>",
      "</adaptive-learning>",
      "RECALL SAFETY RULES",
      'capturedBy" : "agent_end_capture',
      'embeddingStatus" : "pending',
      "plur1bus internal classify-recent",
      "critical-memory-classifier",
      "TTS-STATUS",
      "[cron: daily]",
      "heartbeat_ok",
      "Reference UTC: 2026-06-16",
      "Current time: 08:00",
      "You are a memory search agent",
      "memory search agent. Another model",
      "bounded search query",
      "Use only the available memory tools",
      "Conversation info (untrusted metadata)",
      '"chat_id" : "telegram:123"',
      '"message_id" : "123"',
      '"sender_id" : "456"',
    ];
    for (const text of cases) {
      assert.strictEqual(isInjectedContextText(text), true, `expected true for: ${text.slice(0, 80)}`);
    }
  });

  it("returns false for regular user text", () => {
    assert.strictEqual(isInjectedContextText("regular user text"), false);
    assert.strictEqual(isInjectedContextText("What is the weather today?"), false);
    assert.strictEqual(isInjectedContextText("Can you help me refactor this function?"), false);
  });

  it("handles short injected markers quickly", () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      isInjectedContextText("<plur1bus-recall>foo</plur1bus-recall>");
    }
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 10, `short marker loop took ${elapsed.toFixed(2)}ms`);
  });

  it("handles long inputs within a time budget (no catastrophic backtracking)", () => {
    const marker = "RECALL SAFETY RULES";
    const longText = "x ".repeat(5000) + marker + " y ".repeat(4000);
    const iterations = 10000;

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      isInjectedContextText(longText);
    }
    const elapsed = performance.now() - start;

    assert.ok(
      elapsed < 200,
      `long input loop took ${elapsed.toFixed(2)}ms (budget 200ms)`
    );
    assert.ok(
      elapsed / iterations < 0.05,
      `per-call average ${(elapsed / iterations).toFixed(3)}ms is too high`
    );
  });

  it("handles adversarial partial-match text within a time budget", () => {
    // Adversarial: many characters that could trigger partial matches in a
    // complex alternation regex (e.g. lots of '<' and '"' without completing
    // any marker). A catastrophic-backtracking regex would hang here.
    const adversarial = Array.from({ length: 2000 }, (_, i) => {
      if (i % 7 === 0) return '<"chat_id"    ';
      if (i % 5 === 0) return '"message_id"';
      if (i % 3 === 0) return "</";
      return "abc ";
    }).join("");

    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      isInjectedContextText(adversarial);
    }
    const elapsed = performance.now() - start;

    assert.ok(
      elapsed < 100,
      `adversarial input loop took ${elapsed.toFixed(2)}ms (budget 100ms)`
    );
  });
});

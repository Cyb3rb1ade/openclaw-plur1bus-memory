import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyReplyOutcome,
  completePendingReplyOutcomes,
  recordAgentReplyForOutcome,
  recordPendingReplyOutcome,
  readReplyOutcomeLog,
} from "../lib/reply-outcome-tracking.js";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "reply-outcome-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("reply-outcome-tracking", () => {
  it("classifies corrections as negative outcome signals", () => {
    const c = classifyReplyOutcome("Nein, das stimmt nicht, eigentlich war es Branch main.", "Was war der Branch?");
    assert.strictEqual(c.outcome, "corrected");
    assert.strictEqual(c.feedback, "negative");
    assert.ok(c.confidence >= 0.8);
  });

  it("records pending recall and completes it from the next user reply", async () => {
    const pending = recordPendingReplyOutcome(dir, {
      agentId: "bernd",
      sessionKey: "s1",
      workspaceKey: "w1",
      userPrompt: "Was fehlt beim Reply Outcome Tracking?",
      memoryIds: ["m1", "canonical:Knowledge", "m2", "m1"],
      now: 1000,
    });
    assert.deepStrictEqual(pending.memoryIds, ["m1", "m2"]);

    recordAgentReplyForOutcome(dir, {
      agentId: "bernd",
      sessionKey: "s1",
      assistantText: "Der Zweck ist Feedback fuer Memory-Dynamics.",
      now: 1200,
    });

    const completed = await completePendingReplyOutcomes(dir, {
      agentId: "bernd",
      sessionKey: "s1",
      workspaceKey: "w1",
      replyText: "Genau, dann implementiere das.",
      now: 2000,
    });

    assert.strictEqual(completed.length, 1);
    assert.strictEqual(completed[0].feedback, "positive");
    assert.strictEqual(completed[0].outcome, "confirmed_or_continued");
    assert.deepStrictEqual(completed[0].memoryIds, ["m1", "m2"]);

    const outcomeLog = readReplyOutcomeLog(dir);
    assert.strictEqual(outcomeLog.length, 1);

    const feedbackLines = readFileSync(join(dir, ".adaptive-learning", "feedback-log.jsonl"), "utf8")
      .trim()
      .split(/\n/)
      .map((l) => JSON.parse(l));
    assert.strictEqual(feedbackLines.length, 2);
    assert.ok(feedbackLines.every((e) => e.feedback === "positive"));
    assert.ok(feedbackLines.every((e) => e.scoreComponents.source === "reply-outcome"));
  });
});

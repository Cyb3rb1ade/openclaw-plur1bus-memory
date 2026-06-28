import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyReplyOutcome,
  completePendingReplyOutcomes,
  lastMessageText,
  recordAgentReplyForOutcome,
  recordPendingReplyOutcome,
  readReplyOutcomeLog,
  sessionKeyFrom,
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

  it("does not record a pending outcome for canonical-only memory ids", () => {
    const pending = recordPendingReplyOutcome(dir, {
      agentId: "bernd",
      sessionKey: "s1",
      userPrompt: "Only canonical memories",
      memoryIds: ["canonical:Knowledge", "canonical:Rules"],
      now: 1000,
    });
    assert.strictEqual(pending, null);
  });

  it("records assistant text on the pending outcome", () => {
    recordPendingReplyOutcome(dir, {
      agentId: "bernd",
      sessionKey: "s1",
      userPrompt: "What is the status?",
      memoryIds: ["m1"],
      now: 1000,
    });
    const updated = recordAgentReplyForOutcome(dir, {
      agentId: "bernd",
      sessionKey: "s1",
      assistantText: "The status is green.",
      now: 1200,
    });
    assert.ok(updated);
    assert.strictEqual(updated.assistantText, "The status is green.");
  });

  it("classifies a rejecting reply as negative outcome", async () => {
    recordPendingReplyOutcome(dir, {
      agentId: "bernd",
      sessionKey: "s1",
      userPrompt: "Use the old approach?",
      memoryIds: ["m1", "m2"],
      now: 1000,
    });
    const completed = await completePendingReplyOutcomes(dir, {
      agentId: "bernd",
      sessionKey: "s1",
      replyText: "Nein, das stimmt nicht, darum ging es nicht.",
      now: 2000,
    });
    assert.strictEqual(completed.length, 1);
    assert.strictEqual(completed[0].feedback, "negative");
    assert.ok(completed[0].reasons.includes("explicit_rejection"));

    const feedbackLines = readFileSync(join(dir, ".adaptive-learning", "feedback-log.jsonl"), "utf8")
      .trim()
      .split(/\n/)
      .map((l) => JSON.parse(l));
    assert.strictEqual(feedbackLines.length, 2);
    assert.ok(feedbackLines.every((e) => e.feedback === "negative"));
  });

  it("classifies a confirming reply as positive outcome", async () => {
    recordPendingReplyOutcome(dir, {
      agentId: "bernd",
      sessionKey: "s1",
      userPrompt: "Should I implement it?",
      memoryIds: ["m1"],
      now: 1000,
    });
    const completed = await completePendingReplyOutcomes(dir, {
      agentId: "bernd",
      sessionKey: "s1",
      replyText: "Genau, dann implementiere das.",
      now: 2000,
    });
    assert.strictEqual(completed.length, 1);
    assert.strictEqual(completed[0].feedback, "positive");
    assert.strictEqual(completed[0].outcome, "confirmed_or_continued");
  });

  it("does not crash when workspaceDir is missing or messages are empty", async () => {
    assert.strictEqual(recordPendingReplyOutcome(null, { userPrompt: "x", memoryIds: ["m1"] }), null);
    assert.strictEqual(recordAgentReplyForOutcome(null, { assistantText: "x" }), null);
    assert.deepStrictEqual(await completePendingReplyOutcomes(null, { replyText: "x" }), []);
    assert.strictEqual(lastMessageText([], ["assistant"]), "");
    assert.strictEqual(sessionKeyFrom({}, {}), "default");
  });

  it("is idempotent: the same user prompt must not complete its own pending outcome", async () => {
    const prompt = "What is the plan for the migration?";
    recordPendingReplyOutcome(dir, {
      agentId: "bernd",
      sessionKey: "s1",
      userPrompt: prompt,
      memoryIds: ["m1"],
      now: 1000,
    });

    const first = await completePendingReplyOutcomes(dir, {
      agentId: "bernd",
      sessionKey: "s1",
      replyText: prompt,
      now: 2000,
    });
    assert.strictEqual(first.length, 0);

    const second = await completePendingReplyOutcomes(dir, {
      agentId: "bernd",
      sessionKey: "s1",
      replyText: "I am not ready to decide yet.",
      now: 3000,
    });
    assert.strictEqual(second.length, 1);
    assert.strictEqual(second[0].feedback, "neutral");
  });

  it("caps reply outcome and feedback logs to bounded tail windows", async () => {
    for (let i = 0; i < 4; i++) {
      recordPendingReplyOutcome(dir, {
        agentId: "bernd",
        sessionKey: `s${i}`,
        userPrompt: `Should I ship change ${i}?`,
        memoryIds: [`m${i}a`, `m${i}b`],
        now: 1000 + i,
      });

      await completePendingReplyOutcomes(dir, {
        agentId: "bernd",
        sessionKey: `s${i}`,
        replyText: "Genau, weiter.",
        now: 2000 + i,
        maxOutcomeLogEntries: 2,
        maxFeedbackLogEntries: 3,
      });
    }

    const outcomeLog = readReplyOutcomeLog(dir);
    assert.strictEqual(outcomeLog.length, 2);
    assert.deepStrictEqual(
      outcomeLog.map((e) => e.sessionKey).sort(),
      ["s2", "s3"],
    );

    const feedbackLines = readFileSync(join(dir, ".adaptive-learning", "feedback-log.jsonl"), "utf8")
      .trim()
      .split(/\n/)
      .map((l) => JSON.parse(l));
    assert.strictEqual(feedbackLines.length, 3);
    assert.deepStrictEqual(
      feedbackLines.map((e) => e.memoryId),
      ["m2b", "m3a", "m3b"],
    );
  });
});

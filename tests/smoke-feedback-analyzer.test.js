import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFeedbackAnalyzer } from "../lib/jobs/feedback-analyzer.js";

describe("Feedback Analyzer smoke", () => {
  it("generates empty report for workspace with no feedback", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-fb-analyzer-"));
    const result = await runFeedbackAnalyzer(workspaceDir);
    assert.ok(result.generatedAt, "should have generatedAt timestamp");
    assert.strictEqual(result.totalEntries, 0, "should have 0 entries");
    assert.strictEqual(result.positiveCount, 0);
    assert.strictEqual(result.negativeCount, 0);
    assert.strictEqual(result.neutralCount, 0);
    assert.deepStrictEqual(result.timeRange, { from: 0, to: 0 });
  });
});

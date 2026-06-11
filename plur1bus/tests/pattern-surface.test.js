// tests/pattern-surface.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computePatternScore, findBestPattern, formatPatternBlock } from "../lib/pattern-surface.js";
import { ContinuityGate } from "../lib/continuity-gate.js";

describe("computePatternScore — Szymkiewicz-Simpson overlap scoring", () => {
  it("large pattern (100 members, 2 overlap) scores lower than small pattern (5 members, 2 overlap)", () => {
    // Both have 2 overlapping members and confidence 0.9, created now (weeksSince ≈ 0)
    const largePattern = {
      id: "pat-large",
      memberIds: Array.from({ length: 100 }, (_, i) => `mem-large-${i}`),
      confidence: 0.9,
      createdAt: new Date().toISOString(),
    };

    const smallPattern = {
      id: "pat-small",
      memberIds: Array.from({ length: 5 }, (_, i) => `mem-small-${i}`),
      confidence: 0.9,
      createdAt: new Date().toISOString(),
    };

    // candidateIds has 2 overlaps with each + padding to make it longer
    const candidateIds = [
      "mem-large-0", "mem-large-1", // overlap with large
      "mem-small-0", "mem-small-1", // overlap with small
      "mem-other-1", "mem-other-2", "mem-other-3", "mem-other-4", "mem-other-5", // padding
    ];

    const scoreLarge = computePatternScore(largePattern, candidateIds, 0);
    const scoreSmall = computePatternScore(smallPattern, candidateIds, 0);

    // Large: overlapCoeff = 2 / min(100, 9) = 2/9 ≈ 0.222
    // Small: overlapCoeff = 2 / min(5, 9) = 2/5 = 0.4
    // Both × 0.9 (confidence) × 1.0 (recency)
    // largeSCore ≈ 0.222 × 0.9 = 0.1998
    // smallScore ≈ 0.4 × 0.9 = 0.36
    assert.ok(scoreLarge < scoreSmall, `large score ${scoreLarge} should be < small score ${scoreSmall}`);
  });

  it("overlap < 2 returns 0", () => {
    const pattern = {
      id: "pat-1",
      memberIds: ["mem-a", "mem-b", "mem-c"],
      confidence: 0.9,
    };

    const candidateIds = ["mem-a", "mem-x", "mem-y"]; // only 1 overlap

    const score = computePatternScore(pattern, candidateIds, 0);
    assert.strictEqual(score, 0);
  });

  it("recency decay at 12 weeks is approximately e^(-1) ≈ 0.368 times original", () => {
    const pattern = {
      id: "pat-decay",
      memberIds: ["mem-a", "mem-b", "mem-c"],
      confidence: 1.0, // use 1.0 to isolate recency effect
    };

    const candidateIds = ["mem-a", "mem-b", "mem-x"]; // 2 overlaps

    // Score at week 0
    const scoreNow = computePatternScore(pattern, candidateIds, 0);
    // Score at week 12
    const score12weeks = computePatternScore(pattern, candidateIds, 12);

    const ratio = score12weeks / scoreNow;
    const expected = Math.exp(-1); // ≈ 0.368

    // Allow 1% tolerance
    assert.ok(
      Math.abs(ratio - expected) < expected * 0.01,
      `ratio ${ratio} should be within 1% of ${expected}`
    );
  });

  it("memberIds defaults to empty array if undefined", () => {
    const pattern = {
      id: "pat-noMembers",
      // no memberIds field
      confidence: 0.9,
    };

    const candidateIds = ["mem-a", "mem-b"];

    const score = computePatternScore(pattern, candidateIds, 0);
    assert.strictEqual(score, 0); // no overlap
  });

  it("confidence defaults to 0.5 if undefined", () => {
    const pattern = {
      id: "pat-noConf",
      memberIds: ["mem-a", "mem-b", "mem-c"],
      // no confidence field
    };

    const candidateIds = ["mem-a", "mem-b", "mem-x"];

    const score = computePatternScore(pattern, candidateIds, 0);
    // overlapCoeff = 2/3, confidence = 0.5, recency = 1.0
    const expected = (2 / 3) * 0.5 * 1.0;
    assert.strictEqual(score, expected);
  });
});

describe("findBestPattern — gate-aware pattern selection", () => {
  it("returns null if no patterns score above 0.70", async () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = {
      associativeSurfacedCount: 0,
      patternSurfacedCount: 0,
      surfacedIds: new Set(),
    };

    const patterns = [
      {
        id: "pat-1",
        memberIds: ["mem-a", "mem-b"],
        confidence: 0.5,
        createdAt: new Date().toISOString(),
      },
      {
        id: "pat-2",
        memberIds: ["mem-x", "mem-y"],
        confidence: 0.5,
        createdAt: new Date().toISOString(),
      },
    ];

    const candidateIds = ["mem-a", "mem-b", "mem-x"]; // 1 overlap with pat-1, 1 with pat-2

    const result = await findBestPattern(candidateIds, patterns, gate, sessionState);
    assert.strictEqual(result, null);
  });

  it("returns highest-scoring pattern with correct triggerIds", async () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = {
      associativeSurfacedCount: 0,
      patternSurfacedCount: 0,
      surfacedIds: new Set(),
    };

    // Pattern with 3 overlaps + high confidence + fresh creation
    // To exceed 0.70 threshold with confidence 0.95:
    // overlapCoeff * 0.95 > 0.70 → overlapCoeff > 0.737
    // If pattern has 3 members and 3 overlaps, candidateIds must have 3+ members
    // overlapCoeff = 3 / min(3, candidateIds.length)
    // With candidateIds.length=4: 3/min(3,4) = 3/3 = 1.0 → score = 1.0 * 0.95 = 0.95 ✓
    const pattern = {
      id: "pat-good",
      memberIds: ["mem-1", "mem-2", "mem-3"],
      confidence: 0.95,
      createdAt: new Date().toISOString(),
    };

    const candidateIds = ["mem-1", "mem-2", "mem-3", "mem-other"];

    const result = await findBestPattern(candidateIds, [pattern], gate, sessionState);

    assert.ok(result !== null, "should find a pattern");
    assert.strictEqual(result.pattern.id, "pat-good");
    assert.ok(result.score > 0.70, `score ${result.score} should exceed threshold`);

    // triggerIds should be only the overlapping ones
    assert.deepStrictEqual(new Set(result.triggerIds), new Set(["mem-1", "mem-2", "mem-3"]));
  });

  it("returns null if gate denies due to rate_limit", async () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = {
      associativeSurfacedCount: 0,
      patternSurfacedCount: 1, // already surfaced one pattern
      surfacedIds: new Set(),
    };

    const pattern = {
      id: "pat-good",
      memberIds: ["mem-1", "mem-2", "mem-3"],
      confidence: 0.95,
      createdAt: new Date().toISOString(),
    };

    const candidateIds = ["mem-1", "mem-2", "mem-other"];

    const result = await findBestPattern(candidateIds, [pattern], gate, sessionState);
    assert.strictEqual(result, null);
  });

  it("verifies counter IS incremented: second call denied after first succeeds", async () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = {
      associativeSurfacedCount: 0,
      patternSurfacedCount: 0,
      surfacedIds: new Set(),
    };

    const pattern1 = {
      id: "pat-first",
      memberIds: ["mem-1", "mem-2", "mem-3"],
      confidence: 0.95,
      createdAt: new Date().toISOString(),
    };

    const pattern2 = {
      id: "pat-second",
      memberIds: ["mem-10", "mem-11", "mem-12"],
      confidence: 0.95,
      createdAt: new Date().toISOString(),
    };

    const candidateIds1 = ["mem-1", "mem-2", "mem-3", "mem-other"];
    const candidateIds2 = ["mem-10", "mem-11", "mem-12", "mem-other"];

    // First call should succeed
    const result1 = await findBestPattern(candidateIds1, [pattern1], gate, sessionState);
    assert.ok(result1 !== null, "first call should find a pattern");
    assert.strictEqual(sessionState.patternSurfacedCount, 1, "counter should be incremented to 1 after first call");

    // Second call with same sessionState should be denied (rate limit hit)
    const result2 = await findBestPattern(candidateIds2, [pattern2], gate, sessionState);
    assert.strictEqual(result2, null, "second call should be denied due to rate limit");
  });

  it("returns null for empty patterns array", async () => {
    const gate = new ContinuityGate();
    const sessionState = {
      associativeSurfacedCount: 0,
      patternSurfacedCount: 0,
      surfacedIds: new Set(),
    };

    const result = await findBestPattern(["mem-a"], [], gate, sessionState);
    assert.strictEqual(result, null);
  });

  it("skips patterns with emotional mismatch", async () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = {
      associativeSurfacedCount: 0,
      patternSurfacedCount: 0,
      currentRegister: "celebration",
      surfacedIds: new Set(),
    };

    // High-scoring but emotionally mismatched
    const pattern1 = {
      id: "pat-grief",
      memberIds: ["mem-1", "mem-2", "mem-3"],
      confidence: 0.95,
      emotionalTrajectory: "grief and loss",
      createdAt: new Date().toISOString(),
    };

    // Lower-scoring but emotionally compatible
    const pattern2 = {
      id: "pat-joy",
      memberIds: ["mem-10", "mem-11"],
      confidence: 0.85,
      emotionalTrajectory: "joy and delight",
      createdAt: new Date().toISOString(),
    };

    const candidateIds = ["mem-1", "mem-2", "mem-10", "mem-11", "mem-other"];

    const result = await findBestPattern(
      candidateIds,
      [pattern1, pattern2],
      gate,
      sessionState
    );

    // Should pick pattern2 (joy) because pattern1 (grief) is emotionally mismatched
    assert.ok(result !== null, "should find a pattern");
    assert.strictEqual(result.pattern.id, "pat-joy");
  });

  it("guards memberIds with default empty array", async () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = {
      associativeSurfacedCount: 0,
      patternSurfacedCount: 0,
      surfacedIds: new Set(),
    };

    const pattern = {
      id: "pat-noMembers",
      // no memberIds
      confidence: 0.95,
      createdAt: new Date().toISOString(),
    };

    const candidateIds = ["mem-a", "mem-b"];

    // Should not throw; memberIds defaults to []
    const result = await findBestPattern(candidateIds, [pattern], gate, sessionState);
    assert.strictEqual(result, null); // no overlap, score = 0
  });

  it("increments patternSurfacedCount after returning a match", async () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = {
      associativeSurfacedCount: 0,
      patternSurfacedCount: 0,
      surfacedIds: new Set(),
    };

    const pattern = {
      id: "pat-good",
      memberIds: ["mem-1", "mem-2", "mem-3"],
      confidence: 0.95,
      createdAt: new Date().toISOString(),
    };

    const candidateIds = ["mem-1", "mem-2", "mem-3", "mem-other"];

    // Verify initial state
    assert.strictEqual(sessionState.patternSurfacedCount, 0);

    // Call findBestPattern
    const result = await findBestPattern(candidateIds, [pattern], gate, sessionState);

    // Verify a match was found
    assert.ok(result !== null, "should find a pattern");

    // Verify patternSurfacedCount was incremented
    assert.strictEqual(sessionState.patternSurfacedCount, 1, "patternSurfacedCount should be incremented to 1");

    // Verify the pattern ID was added to surfacedIds
    assert.ok(sessionState.surfacedIds.has("pat-good"), "pattern id should be in surfacedIds");
  });
});

describe("formatPatternBlock — XML formatting with humility", () => {
  it("includes trigger-memory-ids attribute", () => {
    const pattern = {
      id: "pat-1",
      patternName: "test pattern",
      description: "test description",
      confidence: 0.85,
      createdAt: new Date().toISOString(),
    };

    const triggerIds = ["mem-1", "mem-2"];
    const output = formatPatternBlock(pattern, triggerIds, 0.85);

    assert.ok(output.includes('trigger-memory-ids="mem-1,mem-2"'));
  });

  it("includes humility phrase", () => {
    const pattern = {
      id: "pat-1",
      patternName: "my pattern",
      description: "my description",
      createdAt: new Date().toISOString(),
    };

    const output = formatPatternBlock(pattern, [], 0.75);

    // Must contain one of these phrases
    const humilityPhrases = ["may connect", "partial", "I've noticed", "appeared across", "vague"];
    const hasHumility = humilityPhrases.some(phrase => output.includes(phrase));
    assert.ok(hasHumility, `output should contain a humility phrase; got: ${output}`);
  });

  it("is wrapped in memory-continuity tag", () => {
    const pattern = {
      id: "pat-1",
      patternName: "test",
      createdAt: new Date().toISOString(),
    };

    const output = formatPatternBlock(pattern, [], 0.8);

    assert.ok(output.includes("<memory-continuity"));
    assert.ok(output.includes("</memory-continuity>"));
  });

  it("does NOT contain relevant-memories tag", () => {
    const pattern = {
      id: "pat-1",
      patternName: "test",
      createdAt: new Date().toISOString(),
    };

    const output = formatPatternBlock(pattern, [], 0.8);

    assert.ok(!output.includes("<relevant-memories>"));
    assert.ok(!output.includes("</relevant-memories>"));
  });

  it("strips angle brackets from patternName (sanitization)", () => {
    const pattern = {
      id: "pat-1",
      patternName: "<script>test</script>",
      description: "safe",
      createdAt: new Date().toISOString(),
    };

    const output = formatPatternBlock(pattern, [], 0.8);

    assert.ok(!output.includes("<script>"));
    assert.ok(!output.includes("</script>"));
    assert.ok(output.includes("scripttest/script")); // angle brackets stripped
  });

  it("strips quotes from patternName (sanitization)", () => {
    const pattern = {
      id: "pat-1",
      patternName: 'bad"quote\'s',
      createdAt: new Date().toISOString(),
    };

    const output = formatPatternBlock(pattern, [], 0.8);

    // Both single and double quotes should be stripped
    assert.ok(!output.includes('bad"quote'));
    assert.ok(!output.includes("badquote's"));
    // Should contain the pattern with quotes removed
    assert.ok(output.includes("badquotes"));
  });

  it("includes confidence as fixed 2 decimals", () => {
    const pattern = {
      id: "pat-1",
      patternName: "test",
      createdAt: new Date().toISOString(),
    };

    const output = formatPatternBlock(pattern, [], 0.8347);

    assert.ok(output.includes('confidence="0.83"'));
  });

  it("computes weeks-ago as integer from createdAt", () => {
    const now = new Date();
    const fourWeeksAgo = new Date(now.getTime() - 4 * 7 * 24 * 3600 * 1000);

    const pattern = {
      id: "pat-1",
      patternName: "test",
      createdAt: fourWeeksAgo.toISOString(),
    };

    const output = formatPatternBlock(pattern, [], 0.8);

    assert.ok(output.includes('weeks-ago="4"'));
  });

  it("computes weeks-ago from weekOf if createdAt missing", () => {
    const now = new Date();
    const twoWeeksAgo = new Date(now.getTime() - 2 * 7 * 24 * 3600 * 1000);

    const pattern = {
      id: "pat-1",
      patternName: "test",
      // no createdAt
      weekOf: twoWeeksAgo.toISOString(),
    };

    const output = formatPatternBlock(pattern, [], 0.8);

    assert.ok(output.includes('weeks-ago="2"'));
  });

  it("rounds weeks-ago to nearest integer", () => {
    const now = new Date();
    // 4.6 weeks ago
    const weeksAgo = 4.6;
    const timeAgo = new Date(now.getTime() - weeksAgo * 7 * 24 * 3600 * 1000);

    const pattern = {
      id: "pat-1",
      patternName: "test",
      createdAt: timeAgo.toISOString(),
    };

    const output = formatPatternBlock(pattern, [], 0.8);

    // 4.6 rounds to 5
    assert.ok(output.includes('weeks-ago="5"'));
  });

  it("includes source attribute set to rem-pattern", () => {
    const pattern = {
      id: "pat-1",
      patternName: "test",
      createdAt: new Date().toISOString(),
    };

    const output = formatPatternBlock(pattern, [], 0.8);

    assert.ok(output.includes('source="rem-pattern"'));
  });

  it("handles missing patternName gracefully", () => {
    const pattern = {
      id: "pat-1",
      // no patternName
      description: "some description",
      createdAt: new Date().toISOString(),
    };

    const output = formatPatternBlock(pattern, [], 0.8);

    // Should not throw, should still have humility text
    assert.ok(output.includes("appeared across"));
  });

  it("handles missing description gracefully", () => {
    const pattern = {
      id: "pat-1",
      patternName: "test pattern",
      // no description
      createdAt: new Date().toISOString(),
    };

    const output = formatPatternBlock(pattern, [], 0.8);

    // Should not throw, should still have humility text
    assert.ok(output.includes("may connect"));
  });

  it("example from spec: realistic pattern block", () => {
    const pattern = {
      id: "pat-example",
      patternName: "recurring tension between completeness and simplicity",
      description: "Over several weeks, I noticed a pattern in how we approach problem-solving.",
      confidence: 0.72,
      createdAt: new Date(Date.now() - 6 * 7 * 24 * 3600 * 1000).toISOString(),
    };

    const triggerIds = ["abc123", "def456"];
    const score = 0.72;

    const output = formatPatternBlock(pattern, triggerIds, score);

    assert.ok(output.includes('source="rem-pattern"'));
    assert.ok(output.includes('confidence="0.72"'));
    assert.ok(output.includes('weeks-ago="6"'));
    assert.ok(output.includes('trigger-memory-ids="abc123,def456"'));
    assert.ok(output.includes("may connect"));
    assert.ok(output.includes("recurring tension between completeness and simplicity"));
  });
});

describe("Integration: computePatternScore + findBestPattern + formatPatternBlock", () => {
  it("full pipeline: score pattern, pass gate, format output", async () => {
    const now = new Date().toISOString();
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = {
      associativeSurfacedCount: 0,
      patternSurfacedCount: 0,
      surfacedIds: new Set(),
      currentRegister: "thoughtful",
    };

    const pattern = {
      id: "pat-integration",
      patternName: "memory consolidation cycles",
      description: "Patterns emerge after sleep cycles.",
      memberIds: ["m1", "m2", "m3", "m4", "m5"],
      confidence: 0.88,
      emotionalTrajectory: "thoughtful reflection",
      createdAt: now,
    };

    // Need score > 0.70: with confidence=0.88, need overlapCoeff > 0.795
    // With 4 overlaps: overlapCoeff = 4 / min(5, candidateIds.length)
    // If candidateIds.length = 5: 4/5 = 0.8 → score = 0.8 * 0.88 = 0.704 ✓
    const candidateIds = ["m1", "m2", "m3", "m4", "m-other1"];

    const result = await findBestPattern(candidateIds, [pattern], gate, sessionState);

    assert.ok(result !== null);
    assert.strictEqual(result.pattern.id, "pat-integration");
    assert.ok(result.score > 0.70);

    // Format the result
    const xml = formatPatternBlock(result.pattern, result.triggerIds, result.score);

    assert.ok(xml.includes("memory-continuity"));
    assert.ok(xml.includes("trigger-memory-ids="));
    assert.ok(xml.includes("appeared across"));
  });
});

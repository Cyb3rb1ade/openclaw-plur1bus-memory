// tests/continuity-gate.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContinuityGate } from "../lib/continuity-gate.js";

describe("ContinuityGate — associative memories", () => {
  it("denies associative when score is below threshold", () => {
    const gate = new ContinuityGate({ assocThreshold: 0.75 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("associative", 0.70, sessionState);
    assert.strictEqual(result.allow, false);
    assert.strictEqual(result.reason, "score_below_threshold");
  });

  it("allows associative when score meets threshold on first call", () => {
    const gate = new ContinuityGate({ assocThreshold: 0.75 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("associative", 0.80, sessionState);
    assert.strictEqual(result.allow, true);
    assert.strictEqual(result.reason, "ok");
  });

  it("denies associative on second call (rate limit)", () => {
    const gate = new ContinuityGate({ assocThreshold: 0.75 });
    const sessionState = { associativeSurfacedCount: 1, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("associative", 0.80, sessionState);
    assert.strictEqual(result.allow, false);
    assert.strictEqual(result.reason, "rate_limit");
  });

  it("denies associative when id is in vectorTopIds", () => {
    const gate = new ContinuityGate({ assocThreshold: 0.75 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("associative", 0.80, sessionState, {
      id: "mem-123",
      vectorTopIds: ["mem-100", "mem-123", "mem-200"],
    });
    assert.strictEqual(result.allow, false);
    assert.strictEqual(result.reason, "already_in_vector_recall");
  });

  it("allows associative when id is NOT in vectorTopIds", () => {
    const gate = new ContinuityGate({ assocThreshold: 0.75 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("associative", 0.80, sessionState, {
      id: "mem-999",
      vectorTopIds: ["mem-100", "mem-123", "mem-200"],
    });
    assert.strictEqual(result.allow, true);
    assert.strictEqual(result.reason, "ok");
  });

  it("denies associative when depth > 2", () => {
    const gate = new ContinuityGate({ assocThreshold: 0.75 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("associative", 0.80, sessionState, { depth: 3 });
    assert.strictEqual(result.allow, false);
    assert.strictEqual(result.reason, "depth_too_deep");
  });

  it("allows associative when depth = 2", () => {
    const gate = new ContinuityGate({ assocThreshold: 0.75 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("associative", 0.80, sessionState, { depth: 2 });
    assert.strictEqual(result.allow, true);
    assert.strictEqual(result.reason, "ok");
  });

  it("allows associative when depth = 1", () => {
    const gate = new ContinuityGate({ assocThreshold: 0.75 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("associative", 0.80, sessionState, { depth: 1 });
    assert.strictEqual(result.allow, true);
    assert.strictEqual(result.reason, "ok");
  });

  it("allows associative when depth is not provided", () => {
    const gate = new ContinuityGate({ assocThreshold: 0.75 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("associative", 0.80, sessionState, {});
    assert.strictEqual(result.allow, true);
    assert.strictEqual(result.reason, "ok");
  });
});

describe("ContinuityGate — pattern surfacing", () => {
  it("denies pattern when score is below threshold", () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("pattern", 0.69, sessionState);
    assert.strictEqual(result.allow, false);
    assert.strictEqual(result.reason, "score_below_threshold");
  });

  it("allows pattern when score meets threshold on first call", () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("pattern", 0.75, sessionState);
    assert.strictEqual(result.allow, true);
    assert.strictEqual(result.reason, "ok");
  });

  it("denies pattern on second call (rate limit)", () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 1, surfacedIds: new Set() };
    const result = gate.shouldSurface("pattern", 0.75, sessionState);
    assert.strictEqual(result.allow, false);
    assert.strictEqual(result.reason, "rate_limit");
  });

  it("denies pattern when trajectory has grief and register is celebration", () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("pattern", 0.75, sessionState, {
      emotionalTrajectory: "grief and loss",
      currentRegister: "celebration mode",
    });
    assert.strictEqual(result.allow, false);
    assert.strictEqual(result.reason, "emotional_mismatch");
  });

  it("denies pattern when trajectory has conflict and register is joy", () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("pattern", 0.75, sessionState, {
      emotionalTrajectory: "conflict and tension",
      currentRegister: "joy",
    });
    assert.strictEqual(result.allow, false);
    assert.strictEqual(result.reason, "emotional_mismatch");
  });

  it("allows pattern when trajectory and register have matching positive valence", () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("pattern", 0.75, sessionState, {
      emotionalTrajectory: "triumph and joy",
      currentRegister: "celebration mode",
    });
    assert.strictEqual(result.allow, true);
    assert.strictEqual(result.reason, "ok");
  });

  it("allows pattern when trajectory and register have matching negative valence", () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("pattern", 0.75, sessionState, {
      emotionalTrajectory: "grief and loss",
      currentRegister: "somber reflection",
    });
    assert.strictEqual(result.allow, true);
    assert.strictEqual(result.reason, "ok");
  });

  it("allows pattern when trajectory is positive and register is neutral", () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("pattern", 0.75, sessionState, {
      emotionalTrajectory: "joy and delight",
      currentRegister: "neutral mode",
    });
    assert.strictEqual(result.allow, true);
    assert.strictEqual(result.reason, "ok");
  });

  it("allows pattern when only trajectory is provided (no register)", () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("pattern", 0.75, sessionState, {
      emotionalTrajectory: "grief",
    });
    assert.strictEqual(result.allow, true);
    assert.strictEqual(result.reason, "ok");
  });

  it("allows pattern when only register is provided (no trajectory)", () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("pattern", 0.75, sessionState, {
      currentRegister: "celebration",
    });
    assert.strictEqual(result.allow, true);
    assert.strictEqual(result.reason, "ok");
  });
});

describe("ContinuityGate — record()", () => {
  it("increments associativeSurfacedCount", () => {
    const gate = new ContinuityGate();
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    gate.record(sessionState, "associative");
    assert.strictEqual(sessionState.associativeSurfacedCount, 1);
  });

  it("increments associativeSurfacedCount multiple times", () => {
    const gate = new ContinuityGate();
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    gate.record(sessionState, "associative");
    gate.record(sessionState, "associative");
    assert.strictEqual(sessionState.associativeSurfacedCount, 2);
  });

  it("increments patternSurfacedCount", () => {
    const gate = new ContinuityGate();
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    gate.record(sessionState, "pattern");
    assert.strictEqual(sessionState.patternSurfacedCount, 1);
  });

  it("increments patternSurfacedCount multiple times", () => {
    const gate = new ContinuityGate();
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    gate.record(sessionState, "pattern");
    gate.record(sessionState, "pattern");
    assert.strictEqual(sessionState.patternSurfacedCount, 2);
  });

  it("adds id to surfacedIds when provided for associative", () => {
    const gate = new ContinuityGate();
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    gate.record(sessionState, "associative", "mem-123");
    assert.ok(sessionState.surfacedIds.has("mem-123"));
  });

  it("adds id to surfacedIds when provided for pattern", () => {
    const gate = new ContinuityGate();
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    gate.record(sessionState, "pattern", "pat-456");
    assert.ok(sessionState.surfacedIds.has("pat-456"));
  });

  it("adds multiple ids to surfacedIds", () => {
    const gate = new ContinuityGate();
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    gate.record(sessionState, "associative", "mem-1");
    gate.record(sessionState, "pattern", "pat-2");
    gate.record(sessionState, "associative", "mem-3");
    assert.strictEqual(sessionState.surfacedIds.size, 3);
    assert.ok(sessionState.surfacedIds.has("mem-1"));
    assert.ok(sessionState.surfacedIds.has("pat-2"));
    assert.ok(sessionState.surfacedIds.has("mem-3"));
  });

  it("creates surfacedIds Set if not present", () => {
    const gate = new ContinuityGate();
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0 };
    gate.record(sessionState, "associative", "mem-123");
    assert.ok(sessionState.surfacedIds instanceof Set);
    assert.ok(sessionState.surfacedIds.has("mem-123"));
  });

  it("ignores null id", () => {
    const gate = new ContinuityGate();
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    gate.record(sessionState, "associative", null);
    assert.strictEqual(sessionState.surfacedIds.size, 0);
  });

  it("ignores undefined id", () => {
    const gate = new ContinuityGate();
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    gate.record(sessionState, "associative", undefined);
    assert.strictEqual(sessionState.surfacedIds.size, 0);
  });

  it("handles missing counters in sessionState (initializes to 0)", () => {
    const gate = new ContinuityGate();
    const sessionState = { surfacedIds: new Set() };
    gate.record(sessionState, "associative");
    assert.strictEqual(sessionState.associativeSurfacedCount, 1);
  });
});

describe("ContinuityGate — custom thresholds", () => {
  it("uses custom assocThreshold", () => {
    const gate = new ContinuityGate({ assocThreshold: 0.50 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("associative", 0.55, sessionState);
    assert.strictEqual(result.allow, true);
  });

  it("uses custom patternThreshold", () => {
    const gate = new ContinuityGate({ patternThreshold: 0.80 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("pattern", 0.79, sessionState);
    assert.strictEqual(result.allow, false);
    assert.strictEqual(result.reason, "score_below_threshold");
  });

  it("uses both custom thresholds", () => {
    const gate = new ContinuityGate({ assocThreshold: 0.60, patternThreshold: 0.65 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result1 = gate.shouldSurface("associative", 0.61, sessionState);
    const result2 = gate.shouldSurface("pattern", 0.66, sessionState);
    assert.strictEqual(result1.allow, true);
    assert.strictEqual(result2.allow, true);
  });
});

describe("ContinuityGate — edge cases", () => {
  it("handles invalid type gracefully", () => {
    const gate = new ContinuityGate();
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("invalid", 0.80, sessionState);
    assert.strictEqual(result.allow, false);
    assert.strictEqual(result.reason, "invalid_type");
  });

  it("score exactly at threshold is denied (must exceed)", () => {
    const gate = new ContinuityGate({ assocThreshold: 0.75 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("associative", 0.75, sessionState);
    assert.strictEqual(result.allow, false);
    assert.strictEqual(result.reason, "score_below_threshold");
  });

  it("score just above threshold is allowed", () => {
    const gate = new ContinuityGate({ assocThreshold: 0.75 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("associative", 0.7501, sessionState);
    assert.strictEqual(result.allow, true);
    assert.strictEqual(result.reason, "ok");
  });

  it("associative and pattern are independent rate limits", () => {
    const gate = new ContinuityGate();
    const sessionState = { associativeSurfacedCount: 1, patternSurfacedCount: 0, surfacedIds: new Set() };
    const assocResult = gate.shouldSurface("associative", 0.80, sessionState);
    const patternResult = gate.shouldSurface("pattern", 0.75, sessionState);
    assert.strictEqual(assocResult.allow, false);
    assert.strictEqual(patternResult.allow, true);
  });

  it("vectorTopIds empty array still checks correctly", () => {
    const gate = new ContinuityGate({ assocThreshold: 0.75 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("associative", 0.80, sessionState, {
      id: "mem-123",
      vectorTopIds: [],
    });
    assert.strictEqual(result.allow, true);
  });

  it("emotional mismatch is case-insensitive", () => {
    const gate = new ContinuityGate({ patternThreshold: 0.70 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };
    const result = gate.shouldSurface("pattern", 0.75, sessionState, {
      emotionalTrajectory: "GRIEF and loss",
      currentRegister: "CELEBRATION MODE",
    });
    assert.strictEqual(result.allow, false);
    assert.strictEqual(result.reason, "emotional_mismatch");
  });

  it("happy pathway: all checks pass", () => {
    const gate = new ContinuityGate({ assocThreshold: 0.75, patternThreshold: 0.70 });
    const sessionState = { associativeSurfacedCount: 0, patternSurfacedCount: 0, surfacedIds: new Set() };

    const assocResult = gate.shouldSurface("associative", 0.80, sessionState, {
      depth: 2,
      id: "mem-999",
      vectorTopIds: ["mem-1", "mem-2"],
    });
    assert.strictEqual(assocResult.allow, true);

    const patternResult = gate.shouldSurface("pattern", 0.75, sessionState, {
      emotionalTrajectory: "joy",
      currentRegister: "celebration",
    });
    assert.strictEqual(patternResult.allow, true);
  });
});

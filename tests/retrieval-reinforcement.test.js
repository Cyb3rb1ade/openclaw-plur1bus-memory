import { describe, it } from "node:test";
import assert from "node:assert";
import {
  applyRetrievalReinforcement,
  computeDecayedStrength,
  computePromotionCandidate,
} from "../lib/memory-dynamics.js";

describe("applyRetrievalReinforcement", () => {
  const now = Date.now();

  it("repeated recall increases strength measurably", () => {
    const row = {
      memoryStrength: 0.5,
      retrievalCount: 0,
      lastDynamicsAt: now,
      createdAt: now,
      halfLifeDays: 30,
    };

    const first = applyRetrievalReinforcement(row, now);
    const second = applyRetrievalReinforcement({ ...row, ...first }, now);
    const third = applyRetrievalReinforcement({ ...row, ...second }, now);

    assert.strictEqual(first.memoryStrength > row.memoryStrength, true);
    assert.strictEqual(second.memoryStrength > first.memoryStrength, true);
    assert.strictEqual(third.memoryStrength > second.memoryStrength, true);
  });

  it("boost is capped at max 0.99", () => {
    const row = {
      memoryStrength: 0.98,
      retrievalCount: 0,
      lastDynamicsAt: now,
      createdAt: now,
      halfLifeDays: 30,
    };

    const result = applyRetrievalReinforcement(row, now);
    assert.strictEqual(result.memoryStrength <= 0.99, true);
  });

  it("does not exceed 0.99 even with very high base strength", () => {
    const row = {
      memoryStrength: 0.99,
      retrievalCount: 0,
      lastDynamicsAt: now,
      createdAt: now,
      halfLifeDays: 30,
    };

    const result = applyRetrievalReinforcement(row, now);
    assert.strictEqual(result.memoryStrength <= 0.99, true);
  });

  it("core memory remains at 1.0", () => {
    const row = {
      memoryClass: "core",
      neverForget: 1,
      memoryStrength: 1.0,
      retrievalCount: 5,
    };

    const result = applyRetrievalReinforcement(row, now);
    assert.strictEqual(result.memoryStrength, 1.0);
  });
});

describe("computeDecayedStrength", () => {
  it("falls back to 30 day half-life when halfLifeDays is non-numeric", () => {
    const now = Date.now();
    const row = {
      memoryStrength: 1.0,
      halfLifeDays: "not-a-number",
      lastDynamicsAt: now - 30 * 86400000,
      createdAt: now - 30 * 86400000,
    };
    const fallbackRow = { ...row, halfLifeDays: 30 };

    assert.strictEqual(computeDecayedStrength(row, now), computeDecayedStrength(fallbackRow, now));
  });
});

describe("computePromotionCandidate", () => {
  it("transient (fact) is not a promotion candidate", () => {
    const row = {
      retrievalCount: 5,
      importance: 0.8,
      category: "fact",
      memoryClass: "standard",
    };

    const result = computePromotionCandidate(row, 3);
    assert.strictEqual(result.isCandidate, false);
    assert.ok(result.reasons.some((r) => r.includes("category")));
  });

  it("transient (general) is not a promotion candidate", () => {
    const row = {
      retrievalCount: 5,
      importance: 0.8,
      category: "general",
      memoryClass: "standard",
    };

    const result = computePromotionCandidate(row, 3);
    assert.strictEqual(result.isCandidate, false);
    assert.ok(result.reasons.some((r) => r.includes("category")));
  });

  it("project becomes promotion candidate with enough retrievals", () => {
    const row = {
      retrievalCount: 5,
      importance: 0.8,
      category: "project",
      memoryClass: "standard",
    };

    const result = computePromotionCandidate(row, 3);
    assert.strictEqual(result.isCandidate, true);
    assert.ok(result.score > 0);
    assert.ok(result.reasons.length > 0);
  });

  it("person becomes promotion candidate with enough retrievals", () => {
    const row = {
      retrievalCount: 4,
      importance: 0.75,
      category: "person",
      memoryClass: "standard",
    };

    const result = computePromotionCandidate(row, 2);
    assert.strictEqual(result.isCandidate, true);
    assert.ok(result.score > 0);
  });

  it("core memory is not a promotion candidate", () => {
    const row = {
      retrievalCount: 10,
      importance: 0.9,
      category: "project",
      memoryClass: "core",
    };

    const result = computePromotionCandidate(row, 5);
    assert.strictEqual(result.isCandidate, false);
    assert.ok(result.reasons.some((r) => r.includes("core")));
  });

  it("fails when retrievalCount < 3", () => {
    const row = {
      retrievalCount: 2,
      importance: 0.8,
      category: "project",
      memoryClass: "standard",
    };

    const result = computePromotionCandidate(row, 3);
    assert.strictEqual(result.isCandidate, false);
    assert.ok(result.reasons.some((r) => r.includes("retrieval")));
  });

  it("fails when importance < 0.7", () => {
    const row = {
      retrievalCount: 5,
      importance: 0.6,
      category: "project",
      memoryClass: "standard",
    };

    const result = computePromotionCandidate(row, 3);
    assert.strictEqual(result.isCandidate, false);
    assert.ok(result.reasons.some((r) => r.includes("importance")));
  });

  it("fails when sessionCount < 2", () => {
    const row = {
      retrievalCount: 5,
      importance: 0.8,
      category: "project",
      memoryClass: "standard",
    };

    const result = computePromotionCandidate(row, 1);
    assert.strictEqual(result.isCandidate, false);
    assert.ok(result.reasons.some((r) => r.includes("session")));
  });

  it("score calculation is correct", () => {
    const row = {
      retrievalCount: 5,
      importance: 0.8,
      category: "project",
      memoryClass: "standard",
    };

    const result = computePromotionCandidate(row, 3);
    const expected =
      0.8 * 0.4 + (5 / 10) * 0.3 + (3 / 5) * 0.3;
    assert.strictEqual(result.score, expected);
  });
});

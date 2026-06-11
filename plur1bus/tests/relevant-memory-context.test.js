// tests/relevant-memory-context.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveFadedThreshold,
  formatRelevantMemoriesContext,
} from "../lib/relevant-memory-context.js";

// ── resolveFadedThreshold ──────────────────────────────────────────────────

describe("resolveFadedThreshold", () => {
  it("returns default 0.25 when config is empty", () => {
    assert.strictEqual(resolveFadedThreshold({}), 0.25);
  });

  it("uses degradedRecallStrengthThreshold", () => {
    assert.strictEqual(resolveFadedThreshold({ degradedRecallStrengthThreshold: 0.4 }), 0.4);
  });

  it("falls back to confabulationStrengthThreshold (backward compat)", () => {
    assert.strictEqual(resolveFadedThreshold({ confabulationStrengthThreshold: 0.35 }), 0.35);
  });

  it("degradedRecall takes precedence over confabulation alias", () => {
    assert.strictEqual(
      resolveFadedThreshold({ degradedRecallStrengthThreshold: 0.3, confabulationStrengthThreshold: 0.5 }),
      0.3,
    );
  });

  it("falls back to 0.25 for NaN", () => {
    assert.strictEqual(resolveFadedThreshold({ degradedRecallStrengthThreshold: NaN }), 0.25);
  });

  it("falls back to 0.25 for negative value", () => {
    assert.strictEqual(resolveFadedThreshold({ degradedRecallStrengthThreshold: -1 }), 0.25);
  });

  it("falls back to 0.25 for value > 1", () => {
    assert.strictEqual(resolveFadedThreshold({ degradedRecallStrengthThreshold: 2.0 }), 0.25);
  });

  it("falls back to 0.25 for zero (zero is not a valid threshold)", () => {
    assert.strictEqual(resolveFadedThreshold({ degradedRecallStrengthThreshold: 0 }), 0.25);
  });
});

// ── formatRelevantMemoriesContext ──────────────────────────────────────────

describe("formatRelevantMemoriesContext", () => {
  it("returns empty string for empty array", () => {
    assert.strictEqual(formatRelevantMemoriesContext([]), "");
  });

  it("returns empty string for null/undefined", () => {
    assert.strictEqual(formatRelevantMemoriesContext(null), "");
    assert.strictEqual(formatRelevantMemoriesContext(undefined), "");
  });

  it("always includes untrusted and mode attributes", () => {
    const out = formatRelevantMemoriesContext([
      { id: "1", category: "work", source: "dm", display: "hello", memoryStrength: 1.0 },
    ]);
    assert.ok(out.includes('untrusted="true"'), "missing untrusted attribute");
    assert.ok(out.includes('mode="historical-evidence-only"'), "missing mode attribute");
  });

  it("always includes RECALL SAFETY preamble", () => {
    const out = formatRelevantMemoriesContext([
      { id: "1", category: "work", source: "dm", display: "hello", memoryStrength: 1.0 },
    ]);
    assert.ok(out.includes("RECALL SAFETY:"), "missing RECALL SAFETY preamble");
  });

  it("does NOT add faded attribute when strength is above threshold", () => {
    const out = formatRelevantMemoriesContext(
      [{ id: "1", category: "work", source: "dm", display: "hello", memoryStrength: 0.3 }],
      { fadedThreshold: 0.25 },
    );
    assert.ok(!out.includes('faded="true"'), "should not be faded at 0.3");
    assert.ok(!out.includes('very-faded="true"'), "should not be very-faded at 0.3");
  });

  it("adds faded='true' when strength is below threshold", () => {
    const out = formatRelevantMemoriesContext(
      [{ id: "1", category: "work", source: "dm", display: "hello", memoryStrength: 0.24 }],
      { fadedThreshold: 0.25 },
    );
    assert.ok(out.includes('faded="true"'), "expected faded at 0.24");
    assert.ok(!out.includes('very-faded="true"'), "should not be very-faded at 0.24");
  });

  it("adds very-faded='true' when strength is below threshold/2", () => {
    const out = formatRelevantMemoriesContext(
      [{ id: "1", category: "work", source: "dm", display: "hello", memoryStrength: 0.12 }],
      { fadedThreshold: 0.25 },
    );
    assert.ok(out.includes('very-faded="true"'), "expected very-faded at 0.12");
    assert.ok(!out.includes(' faded="true"'), "should only have very-faded, not faded");
  });

  it("missing memoryStrength defaults to 1.0 (not faded)", () => {
    const out = formatRelevantMemoriesContext(
      [{ id: "1", category: "work", source: "dm", display: "hello" }],
      { fadedThreshold: 0.25 },
    );
    assert.ok(!out.includes('faded="true"'), "no faded for missing strength");
  });

  it("does NOT emit DEGRADED RECALL instruction when no memories are faded", () => {
    const out = formatRelevantMemoriesContext(
      [{ id: "1", category: "work", source: "dm", display: "hello", memoryStrength: 0.9 }],
      { fadedThreshold: 0.25 },
    );
    assert.ok(!out.includes("DEGRADED RECALL"), "no DEGRADED RECALL when nothing is faded");
  });

  it("emits DEGRADED RECALL instruction BEFORE the first memory-record", () => {
    const out = formatRelevantMemoriesContext(
      [{ id: "1", category: "work", source: "dm", display: "hello", memoryStrength: 0.2 }],
      { fadedThreshold: 0.25 },
    );
    assert.ok(out.includes("DEGRADED RECALL"), "should include DEGRADED RECALL instruction");
    const degradedPos = out.indexOf("DEGRADED RECALL");
    const firstRecordPos = out.indexOf("<memory-record");
    assert.ok(degradedPos < firstRecordPos, "DEGRADED RECALL must appear before first memory-record");
  });

  it("custom threshold shifts faded boundary", () => {
    const out = formatRelevantMemoriesContext(
      [{ id: "1", category: "work", source: "dm", display: "hello", memoryStrength: 0.35 }],
      { fadedThreshold: 0.4 },
    );
    assert.ok(out.includes('faded="true"'), "should be faded at 0.35 with threshold 0.4");
  });

  it("includes uncertainty phrasing in German and English", () => {
    const out = formatRelevantMemoriesContext(
      [{ id: "1", category: "work", source: "dm", display: "hello", memoryStrength: 0.1 }],
      { fadedThreshold: 0.25 },
    );
    assert.ok(out.includes("ich glaube mich zu erinnern"), "German phrase missing");
    assert.ok(out.includes("I vaguely remember"), "English phrase missing");
  });
});

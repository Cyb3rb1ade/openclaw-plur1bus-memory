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

// ── Interpretation overlays ─────────────────────────────────────────────────

describe("formatRelevantMemoriesContext — interpretation overlays", () => {
  const baseMemory = { id: "mem1", category: "work", source: "dm", display: "helped with task", memoryStrength: 0.9 };

  it("renders <interpretation-overlay> inside <memory-record> when overlay matches", () => {
    const overlays = [{
      targetMemoryId: "mem1",
      shiftType: "meaning",
      shiftDescription: "May now reflect a recurring pattern rather than a one-off.",
      createdAt: new Date(Date.now() - 8 * 7 * 24 * 3600 * 1000).toISOString(), // 8 weeks ago
      provenance: { triggerMemoryIds: ["mem1", "mem2"] },
    }];
    const out = formatRelevantMemoriesContext([baseMemory], { overlays });
    assert.ok(out.includes("<interpretation-overlay"), "missing interpretation-overlay element");
    assert.ok(out.includes('shift-type="meaning"'), "missing shift-type attribute");
    assert.ok(out.includes("recurring pattern"), "missing overlay content");
    assert.ok(out.includes('weeks-ago="8"'), "missing weeks-ago attribute");
    assert.ok(out.includes('trigger-memory-ids="mem1,mem2"'), "missing trigger-memory-ids");
  });

  it("overlay shiftDescription is sanitized (strips < > chars)", () => {
    const overlays = [{
      targetMemoryId: "mem1",
      shiftType: "context",
      shiftDescription: "Shift <injected> tag here.",
      createdAt: new Date().toISOString(),
      provenance: {},
    }];
    const out = formatRelevantMemoriesContext([baseMemory], { overlays });
    assert.ok(out.includes("Shift"), "base content should be present");
    assert.ok(!out.includes("<injected>"), "raw <injected> should be stripped from shiftDescription");
  });

  it("no overlay rendered when overlays is empty", () => {
    const out = formatRelevantMemoriesContext([baseMemory], { overlays: [] });
    assert.ok(!out.includes("<interpretation-overlay"), "no overlay for empty array");
  });

  it("no overlay rendered when memory id does not match any overlay", () => {
    const overlays = [{ targetMemoryId: "other-id", shiftType: "meaning", shiftDescription: "unrelated", provenance: {} }];
    const out = formatRelevantMemoriesContext([baseMemory], { overlays });
    assert.ok(!out.includes("<interpretation-overlay"), "no overlay when ids don't match");
  });

  it("overlay block is inside the <memory-record> element, not outside", () => {
    const overlays = [{
      targetMemoryId: "mem1",
      shiftType: "meaning",
      shiftDescription: "shifted meaning here",
      createdAt: new Date().toISOString(),
      provenance: {},
    }];
    const out = formatRelevantMemoriesContext([baseMemory], { overlays });
    const recordOpenIdx = out.indexOf("<memory-record");
    const recordCloseIdx = out.indexOf("</memory-record>");
    const overlayIdx = out.indexOf("<interpretation-overlay");
    assert.ok(overlayIdx > recordOpenIdx, "overlay must be after <memory-record open tag");
    assert.ok(overlayIdx < recordCloseIdx, "overlay must be before </memory-record> close tag");
  });

  it("sanitizes provenance trigger ids in interpretation-overlay attribute", () => {
    const overlays = [{
      targetMemoryId: "mem1",
      shiftType: "meaning",
      shiftDescription: "shifted meaning",
      createdAt: new Date().toISOString(),
      provenance: { triggerMemoryIds: ["m1", 'm2" data-x="y'] },
    }];
    const out = formatRelevantMemoriesContext([baseMemory], { overlays });
    assert.ok(!out.includes('trigger-memory-ids="m1,m2"'), "raw double quotes must not survive in attribute");
    assert.ok(!out.includes('data-x="y"'), "attribute injection must not survive");
    assert.ok(out.includes("m2_data-x_y"), "malicious id should be sanitized to underscore form");
  });
});

// ── Pattern continuity block ────────────────────────────────────────────────

describe("formatRelevantMemoriesContext — matchedPattern continuity block", () => {
  const mem = { id: "m1", category: "work", source: "dm", display: "did a thing", memoryStrength: 0.9 };

  it("appends <memory-continuity> block AFTER </relevant-memories> when matchedPattern provided", () => {
    const matchedPattern = {
      pattern: { description: "recurring simplicity preference", confidence: 0.8 },
      score: 0.78,
      triggerIds: ["m1", "m2"],
    };
    const out = formatRelevantMemoriesContext([mem], { matchedPattern });
    assert.ok(out.includes("<memory-continuity"), "missing memory-continuity block");
    const relevantEnd = out.indexOf("</relevant-memories>");
    const continuityStart = out.indexOf("<memory-continuity");
    assert.ok(continuityStart > relevantEnd, "<memory-continuity> must appear after </relevant-memories>");
  });

  it("includes confidence and trigger-memory-ids in <memory-continuity>", () => {
    const matchedPattern = {
      pattern: { description: "tension pattern", confidence: 0.75 },
      score: 0.75,
      triggerIds: ["m1", "m2", "m3"],
    };
    const out = formatRelevantMemoriesContext([mem], { matchedPattern });
    assert.ok(out.includes("m1,m2,m3") || out.includes("trigger-memory-ids"), "missing trigger ids");
    assert.ok(out.includes("0.75"), "missing score/confidence");
  });

  it("no <memory-continuity> when matchedPattern is null", () => {
    const out = formatRelevantMemoriesContext([mem], { matchedPattern: null });
    assert.ok(!out.includes("<memory-continuity"), "no continuity block when matchedPattern is null");
  });

  it("no <memory-continuity> when matchedPattern.pattern is missing", () => {
    const out = formatRelevantMemoriesContext([mem], { matchedPattern: { score: 0.9, triggerIds: ["m1"] } });
    assert.ok(!out.includes("<memory-continuity"), "no continuity block when pattern object is missing");
  });
});

// ── Associative (graph-sourced) attributes ──────────────────────────────────

describe("formatRelevantMemoriesContext — associative source attributes", () => {
  it("graph-sourced item gets source='associative' and depth attribute", () => {
    const mem = { id: "g1", category: "work", source: "dm", graphSource: "graph", depth: 2, display: "graph hit", memoryStrength: 0.9 };
    const out = formatRelevantMemoriesContext([mem]);
    assert.ok(out.includes('source="associative"'), "missing source=associative for graph item");
    assert.ok(out.includes('depth="2"'), "missing depth attribute");
  });

  it("vector-sourced item does NOT get associative attributes", () => {
    const mem = { id: "v1", category: "work", source: "dm", graphSource: "vector", depth: 0, display: "vector hit", memoryStrength: 0.9 };
    const out = formatRelevantMemoriesContext([mem]);
    assert.ok(!out.includes("associative"), "vector item must not be marked associative");
    assert.ok(!out.includes('depth='), "vector item must not have depth attribute");
  });

  it("item without graphSource does NOT get associative attributes", () => {
    const mem = { id: "v2", category: "work", source: "dm", display: "normal hit", memoryStrength: 0.9 };
    const out = formatRelevantMemoriesContext([mem]);
    assert.ok(!out.includes("associative"), "no associative for missing graphSource");
  });

  it("graph-sourced item with depth >= 3 gets faded='true' even if memoryStrength is high", () => {
    const mem = { id: "g3", category: "work", source: "dm", graphSource: "graph", depth: 3, display: "deep hit", memoryStrength: 1.0 };
    const out = formatRelevantMemoriesContext([mem], { fadedThreshold: 0.25 });
    assert.ok(out.includes('faded="true"'), "depth >= 3 must be faded even with high strength");
    assert.ok(out.includes('source="associative"'), "must also have associative label");
  });

  it("graph-sourced item with depth 1 does NOT get faded solely due to depth", () => {
    const mem = { id: "g1b", category: "work", source: "dm", graphSource: "graph", depth: 1, display: "shallow graph", memoryStrength: 1.0 };
    const out = formatRelevantMemoriesContext([mem], { fadedThreshold: 0.25 });
    assert.ok(!out.includes('faded="true"'), "depth 1 must not force faded");
    assert.ok(!out.includes('very-faded="true"'), "depth 1 must not force very-faded");
  });

  it("coerces invalid depth values to safe integers", () => {
    const mem = { id: "g1c", category: "work", source: "dm", graphSource: "graph", depth: "2\" data-x=\"y", display: "bad depth", memoryStrength: 1.0 };
    const out = formatRelevantMemoriesContext([mem]);
    assert.ok(out.includes('depth="2"'), "invalid depth must be coerced to a safe integer");
    assert.ok(!out.includes('data-x="y"'), "attribute injection via depth must not survive");
  });
});

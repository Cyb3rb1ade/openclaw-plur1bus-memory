import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";

describe("formatRelevantMemoriesContext — memory-text contradictions", () => {
  it("marks a superseded memory with superseded-by attribute", () => {
    const out = formatRelevantMemoriesContext([
      { id: "old", category: "fact", source: "dm", display: "We use Postgres.", memoryStrength: 1.0, status: "superseded", supersededBy: "new" },
    ]);
    assert.ok(out.includes('superseded-by="new"'), "expected superseded-by attribute");
    assert.ok(out.includes("[superseded]"), "expected visible superseded marker");
  });

  it("does not mark active memories as superseded", () => {
    const out = formatRelevantMemoriesContext([
      { id: "active", category: "fact", source: "dm", display: "We use MySQL.", memoryStrength: 1.0, status: "active", supersededBy: "" },
    ]);
    assert.ok(!out.includes("superseded-by"), "active memory must not have superseded-by");
  });

  it("renders update-source attribute when present", () => {
    const out = formatRelevantMemoriesContext([
      { id: "m1", category: "fact", source: "dm", display: "x", memoryStrength: 1.0, updateSource: "user_correction" },
    ]);
    assert.ok(out.includes('update-source="user_correction"'), "expected update-source attribute");
  });

  it("marks superseded-in-context status", () => {
    const out = formatRelevantMemoriesContext([
      { id: "loser", category: "fact", source: "dm", display: "Old fact.", memoryStrength: 1.0, status: "superseded-in-context", supersededBy: "winner" },
    ]);
    assert.ok(out.includes('superseded-by="winner"'), "expected superseded-by for superseded-in-context");
    assert.ok(out.includes("[superseded]"), "expected visible marker");
  });

  it("renders version attribute when > 1", () => {
    const out = formatRelevantMemoriesContext([
      { id: "m1", category: "fact", source: "dm", display: "x", memoryStrength: 1.0, versionNumber: 3 },
    ]);
    assert.ok(out.includes('version="3"'), "expected version attribute");
  });

  it("does not render version attribute when 1", () => {
    const out = formatRelevantMemoriesContext([
      { id: "m1", category: "fact", source: "dm", display: "x", memoryStrength: 1.0, versionNumber: 1 },
    ]);
    assert.ok(!out.includes('version="1"'), "expected no version attribute for v1");
  });

  it("omits superseded-by attribute when supersededBy is empty", () => {
    const out = formatRelevantMemoriesContext([
      { id: "old", category: "fact", source: "dm", display: "Old.", memoryStrength: 1.0, status: "superseded", supersededBy: "" },
    ]);
    assert.ok(out.includes('status="superseded"'), "expected status attribute");
    assert.ok(!out.includes("superseded-by"), "expected no superseded-by attribute for empty value");
    assert.ok(out.includes("[superseded]"), "expected visible superseded marker");
  });

  it("omits superseded-by attribute when supersededBy is missing", () => {
    const out = formatRelevantMemoriesContext([
      { id: "old", category: "fact", source: "dm", display: "Old.", memoryStrength: 1.0, status: "superseded" },
    ]);
    assert.ok(out.includes('status="superseded"'), "expected status attribute");
    assert.ok(!out.includes("superseded-by"), "expected no superseded-by attribute when missing");
  });

  it("sanitizes superseded-by value against quote injection", () => {
    const out = formatRelevantMemoriesContext([
      { id: "old", category: "fact", source: "dm", display: "Old.", memoryStrength: 1.0, status: "superseded", supersededBy: 'new" data-x="y' },
    ]);
    assert.ok(out.includes('superseded-by="new_data-x_y"'), "expected sanitized superseded-by value");
    assert.ok(!out.includes('data-x="y"'), "attribute injection must not survive");
  });

  it("sanitizes update-source value against quote injection", () => {
    const out = formatRelevantMemoriesContext([
      { id: "m1", category: "fact", source: "dm", display: "x", memoryStrength: 1.0, updateSource: 'user" data-x="y' },
    ]);
    assert.ok(out.includes('update-source="user_data-x_y"'), "expected sanitized update-source value");
    assert.ok(!out.includes('data-x="y"'), "attribute injection must not survive");
  });

  it("does not render malformed status as superseded", () => {
    const out = formatRelevantMemoriesContext([
      { id: "m1", category: "fact", source: "dm", display: "x", memoryStrength: 1.0, status: 'superseded" data-x="y', supersededBy: "new" },
    ]);
    assert.ok(!out.includes("superseded-by"), "malformed status must not trigger superseded-by");
    assert.ok(!out.includes('status="superseded"'), "malformed status must not render superseded status");
  });

  it("ignores non-finite version numbers", () => {
    const outInfinity = formatRelevantMemoriesContext([
      { id: "m1", category: "fact", source: "dm", display: "x", memoryStrength: 1.0, versionNumber: Infinity },
    ]);
    assert.ok(!outInfinity.includes('version="Infinity"'), "Infinity must not render as version");

    const outNaN = formatRelevantMemoriesContext([
      { id: "m2", category: "fact", source: "dm", display: "x", memoryStrength: 1.0, versionNumber: NaN },
    ]);
    assert.ok(!outNaN.includes("version="), "NaN must not render as version");

    const outNegative = formatRelevantMemoriesContext([
      { id: "m3", category: "fact", source: "dm", display: "x", memoryStrength: 1.0, versionNumber: -5 },
    ]);
    assert.ok(!outNegative.includes("version="), "negative version must not render");
  });

  it("floors decimal version numbers", () => {
    const out = formatRelevantMemoriesContext([
      { id: "m1", category: "fact", source: "dm", display: "x", memoryStrength: 1.0, versionNumber: 3.9 },
    ]);
    assert.ok(out.includes('version="3"'), "expected floored version attribute");
  });
});

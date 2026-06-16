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
});

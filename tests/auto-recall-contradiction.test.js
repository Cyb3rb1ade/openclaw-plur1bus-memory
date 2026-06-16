import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";

describe("auto-recall contradiction end-to-end rendering", () => {
  it("marks the older factual memory as superseded in context when a contradiction is resolved", () => {
    const items = [
      { id: "old", category: "fact", source: "dm", display: "We use Postgres.", memoryStrength: 1.0, versionNumber: 1, status: "active" },
      { id: "new", category: "fact", source: "dm", display: "We use MySQL.", memoryStrength: 1.0, versionNumber: 2, status: "active" },
    ];
    // Simulate the resolution step from index.js: old loses.
    const loser = items.find((m) => m.id === "old");
    loser.supersededBy = "new";
    loser.status = "superseded-in-context";

    const out = formatRelevantMemoriesContext(items);
    assert.ok(out.includes('id="old"'), "old memory should still appear");
    assert.ok(out.includes('superseded-by="new"'), "old memory should be marked superseded-by new");
    assert.ok(out.includes("[superseded] We use Postgres"), "old memory display should be prefixed");
    assert.ok(out.includes('id="new"'), "new memory should appear");
    assert.ok(!out.includes('superseded-by="old"'), "new memory should not be marked superseded");
  });
});

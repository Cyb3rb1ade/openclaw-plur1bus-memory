import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";

describe("overlay humility", () => {
  const baseMemory = { id: "mem1", category: "decision", source: "dm", display: "We chose Postgres.", memoryStrength: 1.0 };

  it("renders stronger humility phrase when overlay is flagged contradictory", () => {
    const overlays = [{
      targetMemoryId: "mem1",
      shiftType: "meaning",
      shiftDescription: "Postgres is now the default.",
      createdAt: new Date().toISOString(),
      confidence: 0.7,
      contradiction: true,
      provenance: { triggerMemoryIds: ["mem1"] },
    }];
    const out = formatRelevantMemoriesContext([baseMemory], { overlays });
    assert.ok(out.includes("conflicts with another interpretation"), "should warn about contradiction");
  });

  it("does not add contradiction phrase for normal overlays", () => {
    const overlays = [{
      targetMemoryId: "mem1",
      shiftType: "meaning",
      shiftDescription: "Postgres is now the default.",
      createdAt: new Date().toISOString(),
      confidence: 0.7,
      provenance: { triggerMemoryIds: ["mem1"] },
    }];
    const out = formatRelevantMemoriesContext([baseMemory], { overlays });
    assert.ok(!out.includes("conflicts with another interpretation"), "should not warn without contradiction");
  });
});

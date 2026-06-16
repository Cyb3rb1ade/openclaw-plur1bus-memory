// tests/relevant-memory-context-evidence-boundary.test.js
//
// P0-Fix H1-08/H1-09: graph-sourced memories must keep their original source,
// must carry graph-source="associative", must be faded at depth >= 1, and may
// expose association-strength. Direct (non-graph) memories must remain unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";

describe("formatRelevantMemoriesContext — evidence boundary (H1-08/H1-09)", () => {
  it("graph-sourced item keeps original source and adds graph-source='associative'", () => {
    const mem = {
      id: "g1",
      category: "work",
      source: "group",
      graphSource: "graph",
      depth: 1,
      display: "associated memory",
      memoryStrength: 1.0,
    };
    const out = formatRelevantMemoriesContext([mem]);
    assert.ok(out.includes('source="group"'), "original source must be preserved");
    assert.ok(out.includes('graph-source="associative"'), "graph-source attribute must be associative");
  });

  it("graph-sourced item with depth >= 1 gets faded='true'", () => {
    const mem = {
      id: "g2",
      category: "work",
      source: "group",
      graphSource: "graph",
      depth: 1,
      display: "shallow graph hit",
      memoryStrength: 1.0,
    };
    const out = formatRelevantMemoriesContext([mem], { fadedThreshold: 0.25 });
    assert.ok(out.includes('faded="true"'), "depth >= 1 graph item must be faded");
  });

  it("graph-sourced item with depth >= 2 still gets faded='true'", () => {
    const mem = {
      id: "g3",
      category: "work",
      source: "cron",
      graphSource: "graph",
      depth: 2,
      display: "deeper graph hit",
      memoryStrength: 1.0,
    };
    const out = formatRelevantMemoriesContext([mem], { fadedThreshold: 0.25 });
    assert.ok(out.includes('faded="true"'), "depth >= 2 graph item must be faded");
    assert.ok(out.includes('source="cron"'), "original source must be preserved at depth 2");
    assert.ok(out.includes('graph-source="associative"'), "graph-source must still be present");
  });

  it("direct (non-graph) item remains unchanged by evidence-boundary logic", () => {
    const mem = {
      id: "d1",
      category: "work",
      source: "group",
      display: "direct vector hit",
      memoryStrength: 1.0,
    };
    const out = formatRelevantMemoriesContext([mem]);
    assert.ok(out.includes('source="group"'), "direct item source unchanged");
    assert.ok(!out.includes("graph-source="), "direct item must not have graph-source");
    assert.ok(!out.includes("association-strength="), "direct item must not have association-strength");
    assert.ok(!out.includes('faded="true"'), "direct item with strength 1.0 must not be faded");
    assert.ok(!out.includes("depth="), "direct item must not have depth attribute");
  });

  it("renders association-strength when associatedScore is present", () => {
    const mem = {
      id: "g4",
      category: "work",
      source: "cron",
      graphSource: "graph",
      depth: 2,
      display: "graph hit with score",
      memoryStrength: 1.0,
      associatedScore: 0.42,
    };
    const out = formatRelevantMemoriesContext([mem]);
    assert.ok(out.includes('association-strength="0.42"'), "associatedScore must render as association-strength");
    assert.ok(out.includes('source="cron"'), "original source preserved");
    assert.ok(out.includes('graph-source="associative"'), "graph-source still present");
  });

  it("renders association-strength from relevanceScore fallback", () => {
    const mem = {
      id: "g5",
      category: "project",
      source: "internal",
      graphSource: "graph",
      depth: 1,
      display: "graph hit with relevanceScore",
      memoryStrength: 1.0,
      relevanceScore: 0.73,
    };
    const out = formatRelevantMemoriesContext([mem]);
    assert.ok(out.includes('association-strength="0.73"'), "relevanceScore must render as association-strength");
  });

  it("renders association-strength from associationStrength fallback", () => {
    const mem = {
      id: "g5b",
      category: "project",
      source: "internal",
      graphSource: "graph",
      depth: 1,
      display: "graph hit with associationStrength",
      memoryStrength: 1.0,
      associationStrength: 0.55,
    };
    const out = formatRelevantMemoriesContext([mem]);
    assert.ok(out.includes('association-strength="0.55"'), "associationStrength must render as association-strength");
  });

  it("association-strength is clamped to [0,1] and fixed to two decimals", () => {
    const mem = {
      id: "g6",
      category: "work",
      source: "group",
      graphSource: "graph",
      depth: 1,
      display: "graph hit with out-of-range score",
      memoryStrength: 1.0,
      associatedScore: 1.234,
    };
    const out = formatRelevantMemoriesContext([mem]);
    assert.ok(out.includes('association-strength="1.00"'), "score must be clamped to 1.00");
  });

  it("invalid associatedScore is ignored", () => {
    const mem = {
      id: "g7",
      category: "work",
      source: "group",
      graphSource: "graph",
      depth: 1,
      display: "graph hit with invalid score",
      memoryStrength: 1.0,
      associatedScore: NaN,
    };
    const out = formatRelevantMemoriesContext([mem]);
    assert.ok(!out.includes("association-strength="), "NaN score must not render");
  });
});

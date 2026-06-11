// tests/spreading-activation-recall.test.js
//
// Task 1 — Verify spreading activation wiring in recall pipeline.
// Tests import directly from lib/memory-graph.js (no mocks).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  traverseGraph,
  mergeAssociativeResults,
  readGraph,
  DEFAULT_TRAVERSAL_CONFIG,
} from "../lib/memory-graph.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeMemory(id, score = 0.8) {
  return { entry: { id }, score };
}

function makeEdge(source, target, strength = 0.9) {
  return { source, target, type: "semantic", strength, directed: false };
}

// ─── mergeAssociativeResults — source field ──────────────────────────────────

describe("mergeAssociativeResults – source field", () => {
  it("preserves source='graph' on graph-only items (not in originalResults)", () => {
    const originals = [makeMemory("mem-a", 0.9)];
    const associative = [{ memoryId: "mem-b", associatedScore: 0.7, depth: 1, path: ["mem-a", "mem-b"] }];

    const merged = mergeAssociativeResults(originals, associative, 10);
    const graphItem = merged.find(r => r.entry?.id === "mem-b");

    assert.ok(graphItem, "graph-only item must appear in merged output");
    assert.strictEqual(graphItem.source, "graph", "graph-only item must have source='graph'");
  });

  it("marks items found in both vectors as source='both'", () => {
    const originals = [makeMemory("mem-a", 0.9)];
    const associative = [{ memoryId: "mem-a", associatedScore: 0.6, depth: 1, path: ["mem-seed", "mem-a"] }];

    const merged = mergeAssociativeResults(originals, associative, 10);
    const bothItem = merged.find(r => r.entry?.id === "mem-a");

    assert.ok(bothItem, "item appearing in both sets must appear in merged output");
    assert.strictEqual(bothItem.source, "both", "item in both must have source='both'");
  });

  it("marks items only in originals as source='vector'", () => {
    const originals = [makeMemory("mem-a", 0.9)];
    const merged = mergeAssociativeResults(originals, [], 10);
    const vectorItem = merged.find(r => r.entry?.id === "mem-a");

    assert.ok(vectorItem, "vector-only item must survive merge");
    assert.strictEqual(vectorItem.source, "vector", "vector-only item must have source='vector'");
  });
});

// ─── mergeAssociativeResults — depth field ───────────────────────────────────

describe("mergeAssociativeResults – depth field", () => {
  it("preserves depth attribute on graph-only items", () => {
    const originals = [makeMemory("seed", 0.9)];
    const associative = [
      { memoryId: "depth1-item", associatedScore: 0.7, depth: 1, path: ["seed", "depth1-item"] },
      { memoryId: "depth2-item", associatedScore: 0.5, depth: 2, path: ["seed", "mid", "depth2-item"] },
    ];

    const merged = mergeAssociativeResults(originals, associative, 10);

    const d1 = merged.find(r => r.entry?.id === "depth1-item");
    const d2 = merged.find(r => r.entry?.id === "depth2-item");

    assert.ok(d1, "depth-1 item must appear");
    assert.strictEqual(d1.depth, 1, "depth-1 item must carry depth=1");
    assert.ok(d2, "depth-2 item must appear");
    assert.strictEqual(d2.depth, 2, "depth-2 item must carry depth=2");
  });

  it("depth is an integer (not undefined/null/string)", () => {
    const originals = [];
    const associative = [
      { memoryId: "deep", associatedScore: 0.4, depth: 3, path: [] },
    ];

    const merged = mergeAssociativeResults(originals, associative, 10);
    const item = merged.find(r => r.entry?.id === "deep");

    assert.ok(item, "deep item must appear");
    assert.strictEqual(typeof item.depth, "number", "depth must be a number");
    assert.strictEqual(Math.floor(item.depth), item.depth, "depth must be an integer");
    assert.ok(Number.isFinite(item.depth), "depth must be finite");
  });
});

// ─── depth ≥ 3 item flows through merge ────────────────────────────────────

describe("mergeAssociativeResults – depth ≥ 3 item present in output", () => {
  it("a depth=3 item is accessible in the merged output with source and depth", () => {
    const originals = [makeMemory("seed", 0.9), makeMemory("mid1", 0.8), makeMemory("mid2", 0.75)];
    const associative = [
      { memoryId: "at-depth-3", associatedScore: 0.35, depth: 3, path: ["seed", "mid1", "mid2", "at-depth-3"] },
    ];

    const merged = mergeAssociativeResults(originals, associative, 20);
    const deep = merged.find(r => r.entry?.id === "at-depth-3");

    assert.ok(deep, "depth-3 item must appear in merged results");
    assert.ok(deep.depth >= 3, `Expected depth ≥ 3, got ${deep.depth}`);
    assert.ok(deep.source, "depth-3 item must have a source field");
    assert.ok(typeof deep.score === "number" && deep.score > 0, "depth-3 item must have a positive score");
  });

  it("traverseGraph produces depth ≥ 3 items given a deep enough graph", () => {
    // Build a linear chain: seed → n1 → n2 → n3 → n4
    // All edges with strength 0.95 so cumulative relevance stays above minCumulativeRelevance
    const edges = [
      makeEdge("seed", "n1", 0.95),
      makeEdge("n1", "n2", 0.95),
      makeEdge("n2", "n3", 0.95),
      makeEdge("n3", "n4", 0.95),
    ];
    const { adjacency } = readGraph(edges);

    const seedMemories = [{ entry: { id: "seed" }, score: 0.9 }];
    const config = {
      ...DEFAULT_TRAVERSAL_CONFIG,
      maxDepth: 4,
      minCumulativeRelevance: 0.05, // low threshold so deep items survive
    };

    const results = traverseGraph(seedMemories, adjacency, config);
    const deepItems = results.filter(r => r.depth >= 3);

    assert.ok(deepItems.length > 0, `Expected ≥1 item with depth ≥ 3, got none (all depths: ${results.map(r => r.depth).join(", ")})`);
    // Verify depth field is present and accessible
    for (const item of deepItems) {
      assert.strictEqual(typeof item.depth, "number", "depth must be a number");
      assert.ok(item.memoryId, "each result must have a memoryId");
    }
  });
});

// ─── associativeEnabled:false skips graph traversal ─────────────────────────

describe("associativeEnabled=false skips graph traversal", () => {
  it("mergeAssociativeResults with empty associativeResults produces no graph items", () => {
    // When the pipeline skips traverseGraph (associativeEnabled=false),
    // it passes an empty associative array to mergeAssociativeResults (or skips it).
    // Either way, the output must have no source='graph' items.
    const originals = [makeMemory("mem-a", 0.9), makeMemory("mem-b", 0.7)];

    // Simulate the pipeline with associativeEnabled=false: no traversal, no associative results
    const associative = []; // what traverseGraph would return if not called
    const merged = mergeAssociativeResults(originals, associative, 12);

    const graphItems = merged.filter(r => r.source === "graph");
    assert.strictEqual(graphItems.length, 0, "With no associative input, no graph items should appear");

    // All items should be vector-sourced
    for (const item of merged) {
      assert.strictEqual(item.source, "vector", "Items from originals only should have source='vector'");
    }
  });

  it("traverseGraph returns empty array given empty adjacency (no-op graph)", () => {
    // If associativeEnabled=false in the pipeline, traverseGraph is not called.
    // This test verifies the guard: if graphEdges is empty, traversal is skipped in the pipeline
    // (line 566: `if (associativeEnabled && graphEdges.length > 0 && boosted.length > 0)`).
    // We test the traversal side: empty adjacency → no results.
    const { adjacency } = readGraph([]);
    const seeds = [makeMemory("seed", 0.9)];
    const results = traverseGraph(seeds, adjacency, DEFAULT_TRAVERSAL_CONFIG);

    assert.strictEqual(results.length, 0, "traverseGraph with empty adjacency must return no results");
  });
});

// ─── maxTotal cap is respected ───────────────────────────────────────────────

describe("mergeAssociativeResults – maxTotal cap", () => {
  it("does not exceed maxTotal in output", () => {
    const originals = Array.from({ length: 10 }, (_, i) => makeMemory(`orig-${i}`, 0.9 - i * 0.05));
    const associative = Array.from({ length: 10 }, (_, i) => ({
      memoryId: `assoc-${i}`,
      associatedScore: 0.5 - i * 0.02,
      depth: 1,
      path: [],
    }));

    const merged = mergeAssociativeResults(originals, associative, 12);
    assert.ok(merged.length <= 12, `Expected at most 12 results, got ${merged.length}`);
  });
});

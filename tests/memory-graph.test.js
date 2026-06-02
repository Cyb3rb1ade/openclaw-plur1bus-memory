import { describe, it } from "node:test";
import assert from "node:assert";
import {
  canonicalEdgeKey,
  createEdge,
  semanticStrength,
  temporalStrength,
  readGraph,
  traverseGraph,
  mergeAssociativeResults,
  shouldPrune,
  createGraphMetrics,
  buildEpisodeAnchorEdges,
} from "../lib/memory-graph.js";

describe("memory-graph", () => {
  it("canonicalEdgeKey sortiert ungerichtete Kanten", () => {
    assert.strictEqual(canonicalEdgeKey("b", "a", "semantic", false), "a:b:semantic");
    assert.strictEqual(canonicalEdgeKey("a", "b", "semantic", false), "a:b:semantic");
  });

  it("canonicalEdgeKey behält Richtung bei gerichtet", () => {
    assert.strictEqual(canonicalEdgeKey("b", "a", "temporal", true), "b:a:temporal");
  });

  it("semanticStrength normalisiert korrekt", () => {
    assert.strictEqual(semanticStrength(0.78), 0);
    assert.ok(semanticStrength(0.865) > 0.4 && semanticStrength(0.865) < 0.5);
    assert.strictEqual(semanticStrength(0.95), 0.9);
    assert.strictEqual(semanticStrength(1.0), 0.9);
  });

  it("temporalStrength decays mit deltaMinutes", () => {
    assert.ok(temporalStrength(0) > temporalStrength(15));
    assert.ok(temporalStrength(15) > temporalStrength(30));
  });

  it("readGraph dedupliziert Edges", () => {
    const edges = [
      createEdge("a", "b", "semantic", 0.5, false),
      createEdge("a", "b", "semantic", 0.8, false),
    ];
    const graph = readGraph(edges);
    assert.strictEqual(graph.edges.length, 1);
    assert.ok(graph.edges[0].strength >= 0.8);
    assert.strictEqual(graph.edges[0].observations, 2);
  });

  it("readGraph baut bidirektionale Adjazenzliste", () => {
    const edges = [createEdge("a", "b", "semantic", 0.8, false)];
    const { adjacency } = readGraph(edges);
    assert.strictEqual(adjacency.get("a").length, 1);
    assert.strictEqual(adjacency.get("b").length, 1);
    assert.strictEqual(adjacency.get("b")[0].target, "a");
  });

  it("readGraph behält Gerichtethei bei gerichteten Kanten", () => {
    const edges = [createEdge("a", "b", "temporal", 0.8, true)];
    const { adjacency } = readGraph(edges);
    assert.strictEqual(adjacency.get("a").length, 1);
    assert.strictEqual(adjacency.get("b").length, 0);
  });

  it("traverseGraph findet assoziierte Memories", () => {
    const edges = [
      createEdge("seed", "a", "semantic", 0.9, false),
      createEdge("a", "b", "semantic", 0.8, false),
      createEdge("b", "c", "semantic", 0.7, false),
    ];
    const { adjacency } = readGraph(edges);
    const seedMemories = [{ entry: { id: "seed" }, score: 1.0 }];
    const results = traverseGraph(seedMemories, adjacency, { maxDepth: 3, maxAssociatedResults: 10 });
    assert.ok(results.length > 0);
    assert.ok(results.some(r => r.memoryId === "a"));
  });

  it("traverseGraph respektiert maxDepth", () => {
    const edges = [
      createEdge("seed", "a", "semantic", 0.9, false),
      createEdge("a", "b", "semantic", 0.9, false),
      createEdge("b", "c", "semantic", 0.9, false),
    ];
    const { adjacency } = readGraph(edges);
    const seedMemories = [{ entry: { id: "seed" }, score: 1.0 }];
    const results = traverseGraph(seedMemories, adjacency, { maxDepth: 1, maxAssociatedResults: 10 });
    assert.ok(results.some(r => r.memoryId === "a"));
    assert.ok(!results.some(r => r.memoryId === "b"));
  });

  it("traverseGraph verhindert Zyklen", () => {
    const edges = [
      createEdge("a", "b", "semantic", 0.9, false),
      createEdge("b", "a", "semantic", 0.9, false),
    ];
    const { adjacency } = readGraph(edges);
    const seedMemories = [{ entry: { id: "a" }, score: 1.0 }];
    const results = traverseGraph(seedMemories, adjacency, { maxDepth: 5, maxAssociatedResults: 10 });
    // Sollte nur b finden, nicht endlos zwischen a und b ping-pongen
    assert.ok(results.some(r => r.memoryId === "b"));
    assert.strictEqual(results.length, 1);
  });

  it("mergeAssociativeResults kombiniert korrekt", () => {
    const original = [{ entry: { id: "a" }, score: 0.8 }];
    const associative = [
      { memoryId: "a", associatedScore: 0.9, depth: 1 },
      { memoryId: "b", associatedScore: 0.7, depth: 1 },
    ];
    const merged = mergeAssociativeResults(original, associative, 10);
    const a = merged.find(m => m.entry.id === "a");
    const b = merged.find(m => m.entry.id === "b");
    assert.ok(a.score > 0.8); // boosted
    assert.strictEqual(b.source, "graph");
    assert.ok(b.score <= 0.7 * 0.85); // gedämpft
  });

  it("shouldPrune erkennt alte schwache Kanten", () => {
    const oldEdge = createEdge("a", "b", "semantic", 0.1, false);
    oldEdge.createdAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    oldEdge.lastReinforcedAt = oldEdge.createdAt;
    assert.strictEqual(shouldPrune(oldEdge), true);
  });

  it("shouldPrune behält episode-Kanten", () => {
    const oldEdge = createEdge("a", "b", "episode", 0.1, false);
    oldEdge.createdAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(shouldPrune(oldEdge), false);
  });

  it("shouldPrune behält starke Kanten", () => {
    const oldEdge = createEdge("a", "b", "semantic", 0.5, false);
    oldEdge.createdAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(shouldPrune(oldEdge), false);
  });

  it("createGraphMetrics trackt edgesByType", () => {
    const metrics = createGraphMetrics();
    metrics.record("semantic", 3);
    metrics.record("temporal", 2);
    assert.strictEqual(metrics.edgesByType.semantic, 3);
    assert.strictEqual(metrics.edgesByType.temporal, 2);
    assert.strictEqual(metrics.edgesCreatedPerSession, 5);
  });

  it("buildEpisodeAnchorEdges erzeugt Episode-Anchors", () => {
    const episodes = [{ id: "ep-1", vividness: 0.8 }];
    const edges = buildEpisodeAnchorEdges(episodes, ["mem-1", "mem-2"]);
    assert.strictEqual(edges.length, 2);
    assert.ok(edges.every(e => e.type === "episode"));
    assert.ok(edges.every(e => e.source.startsWith("episode-") || e.target.startsWith("episode-")));
  });
});

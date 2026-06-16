// tests/semantic-lens-query-relevance.test.js
//
// Fix K1-03: Semantic Lens candidates must share at least 2 significant
// tokens with the base recall results; generic terms are filtered out.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  applySemanticLensToRecall,
  clearSemanticLensIndexCache,
} from "../lib/semantic-lens-index.js";

function sampleIndex() {
  return {
    version: 1,
    generatedAt: "2026-06-14T00:00:00.000Z",
    workspaceId: "main",
    memoryToCommunity: {
      base1: "c1",
      generic1: "c1",
      specific1: "c1",
      mixed1: "c1",
    },
    communities: {
      c1: {
        id: "c1",
        size: 3,
        representativeMemoryIds: ["generic1", "specific1", "mixed1"],
        bridgeMemoryIds: [],
        fadedCandidateMemoryIds: [],
        labels: { category: ["fact"], scope: ["workspace"], agent: ["main"] },
      },
    },
  };
}

const memoryById = new Map([
  ["generic1", { id: "generic1", category: "fact", origin: "dm", summary: "api project test memory" }],
  ["specific1", { id: "specific1", category: "fact", origin: "dm", summary: "redis caching strategy" }],
  ["mixed1", { id: "mixed1", category: "fact", origin: "dm", summary: "api project redis caching" }],
]);

describe("semantic lens query relevance", () => {
  beforeEach(() => clearSemanticLensIndexCache());

  it("drops candidates that only share generic tokens with the base memory", async () => {
    const baseMemories = [
      { entry: { id: "base1", summary: "api project test memory" }, score: 0.9 },
    ];
    const result = await applySemanticLensToRecall(baseMemories, {
      semanticLens: { enabled: true, maxLensMemories: 3, maxCommunities: 1, timeoutMs: 50 },
      index: sampleIndex(),
      memoryById,
    });
    const ids = result.lensMemories.map(r => r.entry.id);
    assert.ok(!ids.includes("generic1"), "generic-only overlap must not select candidate");
  });

  it("selects candidates that share 2+ specific tokens with the base memory", async () => {
    const baseMemories = [
      { entry: { id: "base1", summary: "redis caching architecture" }, score: 0.9 },
    ];
    const result = await applySemanticLensToRecall(baseMemories, {
      semanticLens: { enabled: true, maxLensMemories: 3, maxCommunities: 1, timeoutMs: 50 },
      index: sampleIndex(),
      memoryById,
    });
    const ids = result.lensMemories.map(r => r.entry.id);
    assert.ok(ids.includes("specific1"), "2+ specific tokens must select candidate");
  });

  it("selects mixed candidates when at least 2 significant tokens remain after filtering", async () => {
    const baseMemories = [
      { entry: { id: "base1", summary: "api project redis caching" }, score: 0.9 },
    ];
    const result = await applySemanticLensToRecall(baseMemories, {
      semanticLens: { enabled: true, maxLensMemories: 3, maxCommunities: 1, timeoutMs: 50 },
      index: sampleIndex(),
      memoryById,
    });
    const ids = result.lensMemories.map(r => r.entry.id);
    assert.ok(ids.includes("mixed1"), "redis + caching are significant and overlap");
  });
});

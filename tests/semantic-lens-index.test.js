import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_SEMANTIC_LENS_CONFIG,
  applySemanticLensToRecall,
  clearSemanticLensIndexCache,
  loadSemanticLensIndex,
  resolveSemanticLensConfig,
} from "../lib/semantic-lens-index.js";

function tempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "semantic-lens-"));
  mkdirSync(join(dir, ".plur1bus"), { recursive: true });
  return dir;
}

function writeIndex(workspaceDir, data) {
  const p = join(workspaceDir, ".plur1bus", "semantic-lens-index.json");
  writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
  return p;
}

function sampleIndex() {
  return {
    version: 1,
    generatedAt: "2026-06-14T00:00:00.000Z",
    workspaceId: "main",
    memoryToCommunity: {
      base1: "c1",
      base2: "c2",
      bridge1: "c1",
      bridge2: "c1",
      rep1: "c1",
      faded1: "c1",
      c2bridge: "c2",
      c2rep: "c2",
    },
    communities: {
      c1: {
        id: "c1",
        size: 4,
        representativeMemoryIds: ["rep1", "base1"],
        bridgeMemoryIds: ["bridge1", "bridge2"],
        fadedCandidateMemoryIds: ["faded1"],
        labels: { category: ["fact"], scope: ["workspace"], agent: ["main"] },
      },
      c2: {
        id: "c2",
        size: 2,
        representativeMemoryIds: ["c2rep"],
        bridgeMemoryIds: ["c2bridge"],
        fadedCandidateMemoryIds: [],
        labels: { category: ["decision"], scope: ["workspace"], agent: ["main"] },
      },
    },
  };
}

const memoryById = new Map([
  ["bridge1", { id: "bridge1", category: "fact", origin: "dm", summary: "Bridge one" }],
  ["bridge2", { id: "bridge2", category: "fact", origin: "dm", summary: "Bridge two" }],
  ["rep1", { id: "rep1", category: "fact", origin: "dm", summary: "Representative" }],
  ["faded1", { id: "faded1", category: "fact", origin: "dm", summary: "Faded", memoryStrength: 0.1 }],
  ["c2bridge", { id: "c2bridge", category: "decision", origin: "dm", summary: "Second bridge" }],
  ["c2rep", { id: "c2rep", category: "decision", origin: "dm", summary: "Second representative" }],
]);

describe("semantic lens index", () => {
  beforeEach(() => clearSemanticLensIndexCache());

  it("uses safe disabled defaults", () => {
    assert.deepStrictEqual(resolveSemanticLensConfig({}), DEFAULT_SEMANTIC_LENS_CONFIG);
    assert.equal(resolveSemanticLensConfig({ enabled: true }).enabled, true);
  });

  it("missing index returns null instead of throwing", () => {
    const ws = tempWorkspace();
    assert.equal(loadSemanticLensIndex({ workspaceDir: ws }), null);
  });

  it("invalid JSON falls back without crashing", () => {
    const ws = tempWorkspace();
    const p = join(ws, ".plur1bus", "semantic-lens-index.json");
    writeFileSync(p, "{not-json", "utf8");
    assert.equal(loadSemanticLensIndex({ workspaceDir: ws }), null);
  });

  it("loads and caches a valid index by mtime", () => {
    const ws = tempWorkspace();
    writeIndex(ws, sampleIndex());
    const first = loadSemanticLensIndex({ workspaceDir: ws });
    const second = loadSemanticLensIndex({ workspaceDir: ws });
    assert.equal(first, second);
    assert.equal(first.index.workspaceId, "main");
  });

  it("disabled or missing index keeps normal recall unchanged", async () => {
    const baseMemories = [{ entry: { id: "base1", summary: "Base" }, score: 0.9 }];
    const disabled = await applySemanticLensToRecall(baseMemories, {
      semanticLens: { enabled: false },
      index: sampleIndex(),
      memoryById,
    });
    assert.equal(disabled.memories, baseMemories);
    assert.deepStrictEqual(disabled.lensMemories, []);

    const missing = await applySemanticLensToRecall(baseMemories, {
      semanticLens: { enabled: true },
      index: null,
      memoryById,
    });
    assert.equal(missing.memories, baseMemories);
    assert.equal(missing.reason, "missing_index");
  });

  it("adds bridge and representative memories without replacing base recall", async () => {
    const baseMemories = [{ entry: { id: "base1", summary: "Base" }, score: 0.9 }];
    const result = await applySemanticLensToRecall(baseMemories, {
      semanticLens: { enabled: true, maxLensMemories: 3, maxBridgeMemories: 2, maxFadedMemories: 1, maxCommunities: 2, timeoutMs: 50 },
      index: sampleIndex(),
      memoryById,
    });
    assert.deepStrictEqual(result.memories.slice(0, 1), baseMemories);
    assert.deepStrictEqual(result.lensMemories.map(r => r.entry.id), ["bridge1", "bridge2", "rep1"]);
    assert.equal(result.memories.length, 4);
  });

  it("dedupes lens memories already present in base recall", async () => {
    const baseMemories = [
      { entry: { id: "base1", summary: "Base" }, score: 0.9 },
      { entry: { id: "bridge1", summary: "Already present" }, score: 0.8 },
    ];
    const result = await applySemanticLensToRecall(baseMemories, {
      semanticLens: { enabled: true, maxLensMemories: 3, maxBridgeMemories: 2, maxFadedMemories: 1, maxCommunities: 2, timeoutMs: 50 },
      index: sampleIndex(),
      memoryById,
    });
    assert.equal(result.memories.filter(r => r.entry.id === "bridge1").length, 1);
  });

  it("respects max communities and faded limits", async () => {
    const baseMemories = [
      { entry: { id: "base1", summary: "Base one" }, score: 0.9 },
      { entry: { id: "base2", summary: "Base two" }, score: 0.8 },
    ];
    const result = await applySemanticLensToRecall(baseMemories, {
      semanticLens: { enabled: true, maxLensMemories: 4, maxBridgeMemories: 2, maxFadedMemories: 1, maxCommunities: 1, timeoutMs: 50 },
      index: sampleIndex(),
      memoryById,
    });
    assert.deepStrictEqual(result.communities, ["c1"]);
    assert.ok(result.lensMemories.length <= 4);
    assert.ok(result.lensMemories.filter(r => r.entry.id === "faded1").length <= 1);
  });

  it("times out and falls back to normal recall", async () => {
    const baseMemories = [{ entry: { id: "base1", summary: "Base" }, score: 0.9 }];
    const result = await applySemanticLensToRecall(baseMemories, {
      semanticLens: { enabled: true, timeoutMs: 1 },
      index: sampleIndex(),
      memoryById,
      lookupDelayMs: 20,
    });
    assert.equal(result.memories, baseMemories);
    assert.equal(result.timedOut, true);
  });

  it("does not write memory cards while loading or applying lens", async () => {
    const ws = tempWorkspace();
    const memDir = join(ws, "plur1bus", "memories");
    mkdirSync(memDir, { recursive: true });
    const cardPath = join(memDir, "base1.md");
    writeFileSync(cardPath, "---\nmemory_id: base1\n---\nBody\n", "utf8");
    const before = readFileSync(cardPath, "utf8");
    writeIndex(ws, sampleIndex());
    const indexRecord = loadSemanticLensIndex({ workspaceDir: ws });
    await applySemanticLensToRecall([{ entry: { id: "base1" }, score: 1 }], {
      semanticLens: { enabled: true },
      index: indexRecord.index,
      memoryById,
    });
    assert.equal(readFileSync(cardPath, "utf8"), before);
  });
});

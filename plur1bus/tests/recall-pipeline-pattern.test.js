// tests/recall-pipeline-pattern.test.js
//
// Integration tests for pattern surfacing wiring in runRecallPipeline.
// Mocks neoStore.readPatterns to avoid LanceDB/embedding dependencies.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRecallPipeline } from "../lib/recall-pipeline.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeDbTable(rows) {
  return {
    vectorSearch: () => ({
      limit: () => ({
        toArray: async () => rows,
      }),
    }),
    // Needed by hydrateGraphResults for graph-only items — not exercised here
    query: () => ({
      where: () => ({
        limit: () => ({
          toArray: async () => [],
        }),
      }),
    }),
  };
}

const embeddings = {
  dim: 3,
  embed: async () => [0.1, 0.2, 0.3],
  embedQuery: async () => [0.1, 0.2, 0.3],
};

const logger = { warn: () => {}, info: () => {} };

// Build rows with distinct texts so dedup doesn't suppress them.
// All have _distance: 0.2 → distanceToScore yields ~0.8, well above minScore.
function makeRows(ids) {
  return ids.map((id, i) => ({
    id,
    text: `unique memory text for ${id} item ${i}`,
    _distance: 0.2,
    importance: 0.8,
    status: "active",
  }));
}

// Pattern that overlaps with given IDs; high confidence so score exceeds 0.70 gate
function makePattern(memberIds, opts = {}) {
  return {
    id: opts.id ?? "pat-test",
    patternName: opts.patternName ?? "test pattern",
    memberIds,
    confidence: opts.confidence ?? 0.95,
    createdAt: new Date().toISOString(), // fresh → recency decay ≈ 1.0
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("recall-pipeline pattern surfacing wiring", () => {
  it("matchedPattern is null by default when patternSurfacing is not configured", async () => {
    const rows = makeRows(["m1", "m2", "m3"]);
    const { matchedPattern } = await runRecallPipeline({
      query: "test query",
      dbTable: makeDbTable(rows),
      embeddings,
      topN: 5,
      canonicalEnabled: false,
      dedupEnabled: false,
      logger,
    });
    assert.strictEqual(matchedPattern, null, "matchedPattern should be null when no recallConfig");
  });

  it("matchedPattern is null when patternSurfacing.enabled = false", async () => {
    const rows = makeRows(["m1", "m2", "m3"]);
    // neoStore is provided but patternSurfacing disabled
    const neoStore = {
      readPatterns: () => [makePattern(["m1", "m2", "m3"])],
    };
    const { matchedPattern } = await runRecallPipeline({
      query: "test query",
      dbTable: makeDbTable(rows),
      embeddings,
      topN: 5,
      canonicalEnabled: false,
      dedupEnabled: false,
      logger,
      neoStore,
      recallConfig: { patternSurfacing: { enabled: false } },
    });
    assert.strictEqual(matchedPattern, null, "matchedPattern should be null when disabled=false");
  });

  it("matchedPattern is null when enabled but neoStore not provided", async () => {
    const rows = makeRows(["m1", "m2", "m3"]);
    const { matchedPattern } = await runRecallPipeline({
      query: "test query",
      dbTable: makeDbTable(rows),
      embeddings,
      topN: 5,
      canonicalEnabled: false,
      dedupEnabled: false,
      logger,
      // no neoStore
      recallConfig: { patternSurfacing: { enabled: true } },
    });
    assert.strictEqual(matchedPattern, null, "matchedPattern should be null when neoStore absent");
  });

  it("matchedPattern is null when overlap < 2 (below minimum)", async () => {
    // Pattern only overlaps with 1 of the recalled memories → computePatternScore returns 0
    const rows = makeRows(["m1", "m2", "m3"]);
    const neoStore = {
      // Only m1 overlaps — overlap count = 1 < 2 minimum
      readPatterns: () => [makePattern(["m1", "m-outside-1", "m-outside-2"])],
    };
    const { matchedPattern } = await runRecallPipeline({
      query: "test query",
      dbTable: makeDbTable(rows),
      embeddings,
      topN: 5,
      canonicalEnabled: false,
      dedupEnabled: false,
      logger,
      neoStore,
      recallConfig: { patternSurfacing: { enabled: true } },
    });
    assert.strictEqual(matchedPattern, null, "matchedPattern should be null when overlap < 2");
  });

  it("matchedPattern is non-null when enabled and patterns overlap with recalled memories", async () => {
    // Use 5 distinct memories; pattern overlaps with 4 of them.
    // Score math: overlapCoeff = 4/min(4, 5) = 4/4 = 1.0; * confidence 0.95 * recency ~1.0 = 0.95 > 0.70 gate
    const ids = ["m1", "m2", "m3", "m4", "m5"];
    const rows = makeRows(ids);
    const neoStore = {
      readPatterns: () => [makePattern(["m1", "m2", "m3", "m4"])],
    };
    const { matchedPattern } = await runRecallPipeline({
      query: "test query",
      dbTable: makeDbTable(rows),
      embeddings,
      topN: 10,
      canonicalEnabled: false,
      dedupEnabled: false,
      logger,
      neoStore,
      recallConfig: { patternSurfacing: { enabled: true } },
    });
    assert.ok(matchedPattern !== null, "matchedPattern should be non-null when patterns overlap sufficiently");
    assert.ok(matchedPattern.pattern, "matchedPattern should have a pattern property");
    assert.ok(matchedPattern.score > 0.70, `score ${matchedPattern.score} should exceed gate threshold 0.70`);
    assert.ok(Array.isArray(matchedPattern.triggerIds), "matchedPattern should have triggerIds array");
  });

  it("uses top-15 candidates (not capped at topN)", async () => {
    // Create 20 rows; pattern overlaps with IDs at positions 6-8 (indices 5,6,7 in the ordered list)
    // These would be excluded if only topN=5 were used, but available if 15 are used.
    const ids = Array.from({ length: 20 }, (_, i) => `m${i + 1}`);
    const rows = makeRows(ids);

    // Pattern overlaps with m6, m7, m8 — positions 6, 7, 8 in the ordered list (indices 5-7)
    // With topN=5, candidates would be [m1..m5] — no overlap (< 2 with [m6,m7,m8])
    // With top-15 candidates, [m1..m15] includes m6, m7, m8 — 3 overlaps → score passes gate
    // Pattern: 3 members, all in top-15 but NOT in top-5
    // overlapCoeff = 3/min(3, 15) = 3/3 = 1.0; * 0.95 confidence = 0.95 > 0.70 ✓
    const neoStore = {
      readPatterns: () => [makePattern(["m6", "m7", "m8"])],
    };

    const { matchedPattern } = await runRecallPipeline({
      query: "test query",
      dbTable: makeDbTable(rows),
      embeddings,
      topN: 5,
      canonicalEnabled: false,
      dedupEnabled: false,
      logger,
      neoStore,
      recallConfig: { patternSurfacing: { enabled: true } },
    });

    assert.ok(
      matchedPattern !== null,
      "matchedPattern should be non-null: pattern at positions 6-8 should be reachable via top-15 window"
    );
  });

  it("matchedPattern is null when neoStore.readPatterns returns empty array", async () => {
    const rows = makeRows(["m1", "m2", "m3"]);
    const neoStore = {
      readPatterns: () => [],
    };
    const { matchedPattern } = await runRecallPipeline({
      query: "test query",
      dbTable: makeDbTable(rows),
      embeddings,
      topN: 5,
      canonicalEnabled: false,
      dedupEnabled: false,
      logger,
      neoStore,
      recallConfig: { patternSurfacing: { enabled: true } },
    });
    assert.strictEqual(matchedPattern, null, "matchedPattern should be null when no patterns exist");
  });

  it("does not throw when neoStore.readPatterns throws", async () => {
    const rows = makeRows(["m1", "m2", "m3"]);
    const neoStore = {
      readPatterns: () => { throw new Error("store error"); },
    };
    // Should not throw — error is swallowed, matchedPattern stays null
    const { matchedPattern } = await runRecallPipeline({
      query: "test query",
      dbTable: makeDbTable(rows),
      embeddings,
      topN: 5,
      canonicalEnabled: false,
      dedupEnabled: false,
      logger,
      neoStore,
      recallConfig: { patternSurfacing: { enabled: true } },
    });
    assert.strictEqual(matchedPattern, null, "matchedPattern should be null on neoStore error");
  });

  it("return value always includes matchedPattern key", async () => {
    const rows = makeRows(["m1"]);
    const result = await runRecallPipeline({
      query: "test",
      dbTable: makeDbTable(rows),
      embeddings,
      topN: 5,
      canonicalEnabled: false,
      dedupEnabled: false,
      logger,
    });
    assert.ok("matchedPattern" in result, "result must always include matchedPattern key");
  });
});

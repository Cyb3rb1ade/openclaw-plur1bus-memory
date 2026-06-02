import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getWeekWindow,
  buildRunKey,
  loadCandidateMemories,
  buildSparseNeighborGraph,
  findConnectedComponents,
  validateClusters,
  sampleRepresentativeMemories,
  computePatternKey,
  findBestPatternMatch,
  analyzeTrends,
  writeRemDreamToVault,
} from "../lib/dreaming/rem-dream.js";

describe("rem-dream", () => {
  it("getWeekWindow liefert Montag-Sonntag", () => {
    const { weekOf, startMs, endMs } = getWeekWindow(new Date("2026-06-01T12:00:00Z"), "Europe/Zurich");
    assert.strictEqual(typeof weekOf, "string");
    assert.ok(weekOf.includes("W"));
    assert.ok(startMs < endMs);
    const start = new Date(startMs);
    assert.strictEqual(start.getDay(), 1); // Monday
  });

  it("buildRunKey ist deterministisch", () => {
    const k1 = buildRunKey("wk", "agent", "2026-W23");
    const k2 = buildRunKey("wk", "agent", "2026-W23");
    assert.strictEqual(k1, k2);
    assert.ok(k1.includes("wk"));
    assert.ok(k1.includes("agent"));
    assert.ok(k1.includes("2026-W23"));
  });

  it("loadCandidateMemories filtert nach Woche", async () => {
    const now = Date.now();
    const mockTable = {
      query: () => ({
        limit: () => ({
          toArray: async () => [
            { id: "a", text: "old", sourceTimestamp: now - 14 * 86400000, vector: [1, 0] },
            { id: "b", text: "new", sourceTimestamp: now, vector: [0, 1] },
          ],
        }),
      }),
    };
    const result = await loadCandidateMemories({ table: mockTable }, { weekStartMs: now - 7 * 86400000 });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, "b");
  });

  it("loadCandidateMemories nutzt where wenn verfuegbar", async () => {
    const now = Date.now();
    let whereClause = "";
    const mockTable = {
      query: () => ({
        where: (clause) => {
          whereClause = clause;
          return {
            limit: () => ({
              toArray: async () => [
                { id: "schema", text: "schema", sourceTimestamp: now, status: "superseded", vector: [1, 0] },
                { id: "active", text: "active", sourceTimestamp: now, status: "active", vector: [0, 1] },
              ],
            }),
          };
        },
      }),
    };
    const result = await loadCandidateMemories({ table: mockTable }, { weekStartMs: now - 7 * 86400000 });
    assert.ok(whereClause.includes("status"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, "active");
  });

  it("buildSparseNeighborGraph filtert unter minSimilarity", async () => {
    const memories = [
      { id: "a", vector: [1, 0, 0] },
      { id: "b", vector: [0.9, 0.1, 0] },
      { id: "c", vector: [0.1, 0.9, 0] },
    ];
    const mockTable = {
      vectorSearch: () => ({
        limit: () => ({
          toArray: async () => [
            { id: "b", _distance: 0.15 }, // ~0.85 score
            { id: "c", _distance: 0.5 },  // ~0.5 score
          ],
        }),
      }),
    };
    const edges = await buildSparseNeighborGraph(memories, mockTable, { topK: 2, minSimilarity: 0.82 });
    assert.ok(edges.length > 0);
    assert.ok(edges.every(e => e.strength >= 0.82));
    assert.ok(edges.every(e => e.source !== e.target));
  });

  it("findConnectedComponents findet Cluster", () => {
    const edges = [
      { source: "a", target: "b", strength: 0.9 },
      { source: "b", target: "c", strength: 0.9 },
      { source: "d", target: "e", strength: 0.9 },
    ];
    const clusters = findConnectedComponents(edges);
    assert.strictEqual(clusters.length, 2);
    const sizes = clusters.map(c => c.length).sort((a, b) => a - b);
    assert.deepStrictEqual(sizes, [2, 3]);
  });

  it("validateClusters verwirft zu kleine Cluster", () => {
    const clusters = [["a", "b"], ["c", "d", "e"]];
    const memories = [
      { id: "a", vector: [1, 0], createdAt: "2026-01-01" },
      { id: "b", vector: [0.9, 0.1], createdAt: "2026-01-02" },
      { id: "c", vector: [1, 0], createdAt: "2026-01-03" },
      { id: "d", vector: [0.95, 0.05], createdAt: "2026-01-04" },
      { id: "e", vector: [0.9, 0.1], createdAt: "2026-01-05" },
    ];
    const { clusters: valid, outliers } = validateClusters(clusters, memories, { minClusterSize: 3 });
    assert.strictEqual(valid.length, 1);
    assert.strictEqual(outliers.length, 2);
  });

  it("sampleRepresentativeMemories respektiert maxSamples", () => {
    const memoryMap = new Map();
    for (let i = 0; i < 10; i++) {
      memoryMap.set(String(i), {
        id: String(i),
        text: `memory ${i}`,
        createdAt: `2026-01-${String(i + 1).padStart(2, "0")}`,
        emotionalIntensity: i / 10,
      });
    }
    const samples = sampleRepresentativeMemories(["0", "1", "2", "3", "4"], memoryMap, { maxSamples: 3 });
    assert.ok(samples.length <= 3);
    assert.ok(samples.length >= 2);
  });

  it("computePatternKey ist deterministisch", () => {
    const p1 = { relatedTopics: ["b", "a"], participants: ["x"], category: "test" };
    const p2 = { relatedTopics: ["a", "b"], participants: ["x"], category: "test" };
    assert.strictEqual(computePatternKey(p1), computePatternKey(p2));
    assert.strictEqual(computePatternKey(p1).length, 32);
  });

  it("findBestPatternMatch findet exakten Match", () => {
    const newPattern = { relatedTopics: ["a", "b"], participants: ["x"] };
    const old = [
      { id: "old1", patternKey: computePatternKey({ relatedTopics: ["a", "b"], participants: ["x"], category: "general" }), relatedTopics: ["a", "b"], participants: ["x"] },
      { id: "old2", patternKey: "different", relatedTopics: ["c"], participants: ["y"] },
    ];
    const match = findBestPatternMatch(newPattern, old);
    assert.strictEqual(match?.id, "old1");
  });

  it("analyzeTrends kennzeichnet neue Patterns", () => {
    const newPatterns = [
      { id: "n1", memberCount: 5, relatedTopics: ["a"], participants: [] },
    ];
    const oldPatterns = [
      { id: "o1", memberCount: 3, relatedTopics: ["b"], participants: [] },
    ];
    const trends = analyzeTrends(newPatterns, oldPatterns);
    assert.strictEqual(trends.find(t => t.id === "n1")?.trend, "neu");
    assert.strictEqual(trends.find(t => t.id === "o1")?.trend, "verschwunden");
  });

  it("analyzeTrends erkennt stärker", () => {
    const newPatterns = [
      { id: "n1", memberCount: 10, relatedTopics: ["a"], participants: [] },
    ];
    const oldPatterns = [
      { id: "o1", memberCount: 5, relatedTopics: ["a"], participants: [], patternKey: computePatternKey({ relatedTopics: ["a"], participants: [], category: "general" }) },
    ];
    const trends = analyzeTrends(newPatterns, oldPatterns);
    assert.strictEqual(trends.find(t => t.id === "n1")?.trend, "stärker");
  });

  it("writeRemDreamToVault schreibt Markdown", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rem-dream-test-"));
    try {
      const report = {
        runKey: "rem:test:agent:2026-W23",
        weekOf: "2026-W23",
        patternsFound: 2,
        new: 1,
        stronger: 0,
        weaker: 0,
        disappeared: 1,
        unchanged: 0,
        durationMs: 1000,
      };
      const trends = [
        { id: "p1", patternName: "Test Pattern", description: "A test", trend: "neu", evidenceQuotes: ["quote 1"] },
        { id: "p2", patternName: "Old Pattern", description: "Gone", trend: "verschwunden" },
      ];
      const result = writeRemDreamToVault(report, trends, tmpDir);
      assert.strictEqual(result.written, true);
      assert.ok(result.path.includes("2026-W23"));
      const content = readFileSync(result.path, "utf8");
      assert.ok(content.includes("REM Dream"));
      assert.ok(content.includes("Test Pattern"));
      assert.ok(content.includes("verschwunden"));
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});

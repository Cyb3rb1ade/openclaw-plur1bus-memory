import { describe, it } from "node:test";
import assert from "node:assert";
import { detectConflicts } from "../lib/shared-memory.js";

describe("shared-memory detectConflicts limit", () => {
  it("returns identical results for small inputs", () => {
    const memories = [
      { id: "a", text: "foo bar baz", createdAt: 1 },
      { id: "b", text: "foo bar qux", createdAt: 2 },
      { id: "c", text: "totally different", createdAt: 3 },
      { id: "d", text: "foo bar baz", summary: "x", category: "y", createdAt: 4 },
      { id: "e", text: "foo bar baz", summary: "x", category: "y", createdAt: 5 },
    ];

    const withLimit = detectConflicts(memories, { maxCandidates: 10 });
    const withoutLimit = detectConflicts(memories);

    assert.strictEqual(withLimit.length, withoutLimit.length);
    assert.deepStrictEqual(
      withLimit.map((c) => c.entries.map((e) => e.id).sort().join("-")),
      withoutLimit.map((c) => c.entries.map((e) => e.id).sort().join("-"))
    );
  });

  it("limits pairwise comparisons for large inputs", () => {
    const memories = [];
    for (let i = 0; i < 1000; i++) {
      memories.push({
        id: `m-${i}`,
        text: `shared text base ${i % 10}`,
        createdAt: i,
      });
    }

    const start = performance.now();
    const conflicts = detectConflicts(memories, { maxCandidates: 100 });
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 100, `detectConflicts took ${elapsed.toFixed(2)}ms (budget 100ms)`);
    assert.ok(conflicts.length >= 0);
  });

  it("preferentially keeps the most recent candidates when limiting", () => {
    // Two clusters: older cluster would create many conflicts, newer cluster
    // has one clear conflict. With maxCandidates=3 only the newest 3 are kept.
    const memories = [
      { id: "old-a", text: "old shared text", createdAt: 1 },
      { id: "old-b", text: "old shared text", createdAt: 2 },
      { id: "old-c", text: "old shared text", createdAt: 3 },
      { id: "new-a", text: "new shared text", createdAt: 100 },
      { id: "new-b", text: "new shared text 2", createdAt: 101 },
    ];

    const conflicts = detectConflicts(memories, { maxCandidates: 3 });
    const involvedIds = new Set(conflicts.flatMap((c) => c.entries.map((e) => e.id)));

    for (const id of involvedIds) {
      assert.ok(
        id.startsWith("new-"),
        `expected only recent ids, got ${id}`
      );
    }
  });

  it("is deterministic for the same input", () => {
    const memories = [];
    for (let i = 0; i < 300; i++) {
      memories.push({ id: `m-${i}`, text: `text ${i % 5}`, createdAt: i });
    }

    const a = detectConflicts(memories, { maxCandidates: 50 });
    const b = detectConflicts(memories, { maxCandidates: 50 });

    assert.strictEqual(a.length, b.length);
    assert.deepStrictEqual(
      a.map((c) => c.entries.map((e) => e.id).sort().join("-")),
      b.map((c) => c.entries.map((e) => e.id).sort().join("-"))
    );
  });

  it("ignores invalid maxCandidates and falls back to default", () => {
    const memories = [
      { id: "a", text: "x", createdAt: 1 },
      { id: "b", text: "x", createdAt: 2 },
    ];
    assert.strictEqual(detectConflicts(memories, { maxCandidates: 0 }).length, 0);
    assert.strictEqual(detectConflicts(memories, { maxCandidates: -1 }).length, 0);
    assert.strictEqual(detectConflicts(memories, { maxCandidates: NaN }).length, 0);
  });
});

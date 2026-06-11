import { describe, it } from "node:test";
import assert from "node:assert";
import { applyRetroactiveInterference } from "../lib/retroactive-interference.js";

function makeDb({ searchResults = [], updateFn = () => {} } = {}) {
  return {
    searchCalls: [],
    updateCalls: [],
    async search(vector, limit, minScore) {
      this.searchCalls.push({ vector, limit, minScore });
      return searchResults;
    },
    async update(id, patch) {
      this.updateCalls.push({ id, patch });
      await updateFn(id, patch);
    },
  };
}

function makeEntry(overrides = {}) {
  return {
    id: "new-id",
    vector: [0.1, 0.2, 0.3],
    memoryStrength: 1.0,
    memoryClass: "standard",
    neverForget: 0,
    ...overrides,
  };
}

function makeCandidate(overrides = {}) {
  return {
    entry: {
      id: "old-id",
      memoryStrength: 0.8,
      memoryClass: "standard",
      neverForget: 0,
      ...overrides,
    },
    score: 0.72,
  };
}

describe("smoke-retroactive-interference: applyRetroactiveInterference", () => {
  it("happy path: decays similar memories by multiplier", async () => {
    const db = makeDb({
      searchResults: [makeCandidate({ id: "old-1" }), makeCandidate({ id: "old-2" })],
    });
    const now = Date.now();
    await applyRetroactiveInterference(db, makeEntry(), { threshold: 0.65, multiplier: 0.9, maxAffected: 5 });

    assert.strictEqual(db.updateCalls.length, 2, "should update 2 candidates");
    for (const call of db.updateCalls) {
      assert.ok(call.patch.memoryStrength <= 0.8 * 0.9 + 0.001, "memoryStrength should be reduced");
      assert.ok(call.patch.lastDynamicsAt >= now, "lastDynamicsAt should be updated");
    }
  });

  it("no-op: db.update not called when search returns nothing", async () => {
    const db = makeDb({ searchResults: [] });
    await applyRetroactiveInterference(db, makeEntry(), {});
    assert.strictEqual(db.updateCalls.length, 0, "update must not be called");
  });

  it("core memory excluded: memoryClass=core is skipped", async () => {
    const db = makeDb({
      searchResults: [makeCandidate({ id: "core-mem", memoryClass: "core" })],
    });
    await applyRetroactiveInterference(db, makeEntry(), {});
    assert.strictEqual(db.updateCalls.length, 0, "core memory must not be decayed");
  });

  it("self-exclusion: new memory id is skipped", async () => {
    const newEntry = makeEntry({ id: "self-id" });
    const db = makeDb({
      searchResults: [makeCandidate({ id: "self-id" })],
    });
    await applyRetroactiveInterference(db, newEntry, {});
    assert.strictEqual(db.updateCalls.length, 0, "new memory must not decay itself");
  });

  it("maxAffected limit: only maxAffected candidates are updated", async () => {
    const candidates = Array.from({ length: 7 }, (_, i) =>
      makeCandidate({ id: `old-${i}` })
    );
    const db = makeDb({ searchResults: candidates });
    await applyRetroactiveInterference(db, makeEntry(), { maxAffected: 5 });
    assert.strictEqual(db.updateCalls.length, 5, "exactly maxAffected updates");
  });

  it("guard: missing vector → no-op, db.search not called", async () => {
    const db = makeDb({ searchResults: [] });
    await applyRetroactiveInterference(db, { id: "x" }, {});
    assert.strictEqual(db.searchCalls.length, 0, "db.search must not be called");
    assert.strictEqual(db.updateCalls.length, 0, "db.update must not be called");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  validateUpdatePatch,
  buildUpdateEntry,
  computeIdempotencyKey,
  computeSemanticDrift,
  buildSupersedePatch,
  safeUpdate,
  rewriteGraphEdges,
} from "../lib/safe-update.js";
import {
  getMemoryHistory,
  getMemoryCurrentVersion,
} from "../lib/memory-history.js";

// ─── Mocks ─────────────────────────────────────────────────────────────────

function createMockDb(rows = {}) {
  return {
    getById: async (id) => rows[id] || null,
    update: async (id, patch) => {
      if (rows[id]) {
        Object.assign(rows[id], patch);
      }
    },
    store: async (entry) => {
      rows[entry.id] = entry;
    },
  };
}

function createMockNeoStore(events = [], edges = []) {
  return {
    readReconsolidationEvents: async () => events,
    appendReconsolidationEvents: async (items) => {
      events.push(...items);
    },
    readGraphEdges: async () => edges,
    appendGraphEdges: async (items) => {
      edges.push(...items);
    },
  };
}

function makeRow(overrides = {}) {
  return {
    id: "old-id",
    text: "original text",
    summary: "original summary",
    vector: [1, 0, 0, 0],
    importance: 0.5,
    category: "fact",
    status: "active",
    memoryStrength: 0.8,
    versionNumber: 1,
    previousVersion: "",
    supersededBy: "",
    updateSource: "",
    updateEvidence: "",
    reconsolidationConfidence: 0,
    versionCreatedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

// ─── validateUpdatePatch ───────────────────────────────────────────────────

describe("validateUpdatePatch", () => {
  it("throws without evidence for text changes", () => {
    assert.throws(() => validateUpdatePatch({ text: "new" }, {}), /updateSource/);
  });

  it("throws without evidence for summary changes", () => {
    assert.throws(() => validateUpdatePatch({ summary: "new" }, {}), /updateSource/);
  });

  it("passes for metadata-only changes", () => {
    validateUpdatePatch({ importance: 0.9 }, {});
  });

  it("passes when evidence is provided", () => {
    validateUpdatePatch(
      { text: "new" },
      { updateSource: "user", updateEvidence: "fixed typo" }
    );
  });
});

// ─── computeIdempotencyKey ─────────────────────────────────────────────────

describe("computeIdempotencyKey", () => {
  it("returns stable hash for same inputs", () => {
    const row = makeRow();
    const patch = { text: "new" };
    const evidence = { updateSource: "user", updateEvidence: "fix" };
    const k1 = computeIdempotencyKey(row, patch, evidence);
    const k2 = computeIdempotencyKey(row, patch, evidence);
    assert.strictEqual(k1, k2);
    assert.strictEqual(k1.length, 64);
  });

  it("returns different hash for different patches", () => {
    const row = makeRow();
    const e = { updateSource: "user", updateEvidence: "fix" };
    const k1 = computeIdempotencyKey(row, { text: "a" }, e);
    const k2 = computeIdempotencyKey(row, { text: "b" }, e);
    assert.notStrictEqual(k1, k2);
  });
});

// ─── computeSemanticDrift ──────────────────────────────────────────────────

describe("computeSemanticDrift", () => {
  it("returns 0 for identical vectors", () => {
    const v = [1, 0, 0];
    assert.strictEqual(computeSemanticDrift(v, v), 0);
  });

  it("returns ~1 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    assert.ok(computeSemanticDrift(a, b) > 0.99);
  });

  it("returns ~0.5 for 45-degree vectors", () => {
    const a = [1, 0];
    const b = [0.707, 0.707];
    const drift = computeSemanticDrift(a, b);
    assert.ok(drift > 0.28 && drift < 0.32);
  });
});

// ─── buildUpdateEntry ──────────────────────────────────────────────────────

describe("buildUpdateEntry", () => {
  it("increments versionNumber and links previousVersion", () => {
    const oldRow = makeRow();
    const entry = buildUpdateEntry(
      oldRow,
      { text: "new text" },
      { updateSource: "user", updateEvidence: "fix" }
    );
    assert.strictEqual(entry.versionNumber, 2);
    assert.strictEqual(entry.previousVersion, "old-id");
    assert.strictEqual(entry.status, "active");
    assert.strictEqual(entry.text, "new text");
    assert.strictEqual(entry.memoryStrength, 0.8);
  });

  it("preserves createdAt and sets versionCreatedAt", () => {
    const oldRow = makeRow({ createdAt: 5000 });
    const entry = buildUpdateEntry(oldRow, {}, {});
    assert.strictEqual(entry.createdAt, 5000);
    assert.ok(entry.versionCreatedAt > 0);
  });

  it("copies updateSource and updateEvidence", () => {
    const oldRow = makeRow();
    const entry = buildUpdateEntry(
      oldRow,
      { text: "x" },
      { updateSource: "test", updateEvidence: "because", confidence: 0.95 }
    );
    assert.strictEqual(entry.updateSource, "test");
    assert.strictEqual(entry.updateEvidence, "because");
    assert.strictEqual(entry.reconsolidationConfidence, 0.95);
  });
});

// ─── buildSupersedePatch ───────────────────────────────────────────────────

describe("buildSupersedePatch", () => {
  it("sets status to superseded and links newId", () => {
    const patch = buildSupersedePatch(makeRow(), "new-id");
    assert.strictEqual(patch.status, "superseded");
    assert.strictEqual(patch.supersededBy, "new-id");
    assert.ok(patch.updatedAt > 0);
  });
});

// ─── safeUpdate ────────────────────────────────────────────────────────────

describe("safeUpdate", () => {
  it("throws for non-existent memory", async () => {
    const db = createMockDb();
    await assert.rejects(
      safeUpdate(db, "missing", {}, {}),
      /not found/
    );
  });

  it("throws for non-active memory", async () => {
    const db = createMockDb({ "old-id": makeRow({ status: "superseded" }) });
    await assert.rejects(
      safeUpdate(db, "old-id", { text: "x" }, { updateSource: "u", updateEvidence: "e" }),
      /non-active/
    );
  });

  it("throws without evidence for text changes", async () => {
    const db = createMockDb({ "old-id": makeRow() });
    await assert.rejects(
      safeUpdate(db, "old-id", { text: "x" }, {}),
      /updateSource/
    );
  });

  it("performs inline update for metadata-only changes", async () => {
    const rows = { "old-id": makeRow() };
    const db = createMockDb(rows);
    const result = await safeUpdate(
      db,
      "old-id",
      { importance: 0.9 },
      {}
    );
    assert.strictEqual(result.inline, true);
    assert.strictEqual(result.newId, "old-id");
    assert.strictEqual(rows["old-id"].importance, 0.9);
    assert.ok(rows["old-id"].updatedAt > 0);
  });

  it("performs inline update for vector-only changes", async () => {
    const rows = { "old-id": makeRow() };
    const db = createMockDb(rows);
    const result = await safeUpdate(
      db,
      "old-id",
      { vector: [0, 1, 0, 0] },
      {}
    );
    assert.strictEqual(result.inline, true);
    assert.deepStrictEqual(rows["old-id"].vector, [0, 1, 0, 0]);
  });

  it("creates new version for text changes", async () => {
    const rows = { "old-id": makeRow() };
    const db = createMockDb(rows);
    const result = await safeUpdate(
      db,
      "old-id",
      { text: "new text", vector: [1, 0, 0, 0] },
      { updateSource: "user", updateEvidence: "correction" }
    );
    assert.strictEqual(result.inline, false);
    assert.notStrictEqual(result.newId, "old-id");
    assert.strictEqual(result.versionNumber, 2);
    assert.strictEqual(rows["old-id"].status, "superseded");
    assert.strictEqual(rows["old-id"].supersededBy, result.newId);
    assert.strictEqual(rows[result.newId].text, "new text");
    assert.strictEqual(rows[result.newId].memoryStrength, 0.8);
  });

  it("rejects high semantic drift", async () => {
    const rows = { "old-id": makeRow({ vector: [1, 0, 0, 0] }) };
    const db = createMockDb(rows);
    await assert.rejects(
      safeUpdate(
        db,
        "old-id",
        { text: "completely different", vector: [0, 1, 0, 0] },
        { updateSource: "user", updateEvidence: "rewrite" }
      ),
      /drift/
    );
  });

  it("allows low semantic drift", async () => {
    const rows = { "old-id": makeRow({ vector: [1, 0, 0, 0] }) };
    const db = createMockDb(rows);
    const result = await safeUpdate(
      db,
      "old-id",
      { text: "slightly different", vector: [0.99, 0.01, 0, 0] },
      { updateSource: "user", updateEvidence: "minor fix" }
    );
    assert.strictEqual(result.inline, false);
  });

  it("skips idempotent updates", async () => {
    const rows = { "old-id": makeRow() };
    const db = createMockDb(rows);
    const events = [];
    const neoStore = createMockNeoStore(events);
    const patch = { text: "new", vector: [1, 0, 0, 0] };
    const evidence = { updateSource: "user", updateEvidence: "fix" };

    const r1 = await safeUpdate(db, "old-id", patch, evidence, { neoStore });
    assert.strictEqual(r1.skipped, undefined);

    // Reset rows so second call would succeed if not idempotent
    rows["old-id"] = makeRow();
    delete rows[r1.newId];

    const r2 = await safeUpdate(db, "old-id", patch, evidence, { neoStore });
    assert.strictEqual(r2.skipped, true);
  });
});

// ─── rewriteGraphEdges ─────────────────────────────────────────────────────

describe("rewriteGraphEdges", () => {
  it("rewrites edges with matching source or target", async () => {
    const edges = [
      { source: "old-id", target: "x", type: "semantic" },
      { source: "y", target: "old-id", type: "temporal" },
      { source: "z", target: "z", type: "self" },
    ];
    const neoStore = createMockNeoStore([], edges);
    const result = await rewriteGraphEdges(neoStore, "old-id", "new-id");
    assert.strictEqual(result.rewritten, 2);
    // New edges are appended to the array
    assert.strictEqual(edges[3].source, "new-id");
    assert.strictEqual(edges[3].target, "x");
    assert.strictEqual(edges[4].source, "y");
    assert.strictEqual(edges[4].target, "new-id");
    assert.strictEqual(edges.length, 5);
  });

  it("returns 0 when neoStore is unavailable", async () => {
    const result = await rewriteGraphEdges(null, "old", "new");
    assert.strictEqual(result.rewritten, 0);
  });
});

// ─── getMemoryHistory ──────────────────────────────────────────────────────

describe("getMemoryHistory", () => {
  it("traverses previousVersion backward", async () => {
    const rows = {
      v3: makeRow({ id: "v3", versionNumber: 3, previousVersion: "v2", text: "third" }),
      v2: makeRow({ id: "v2", versionNumber: 2, previousVersion: "v1", text: "second" }),
      v1: makeRow({ id: "v1", versionNumber: 1, previousVersion: "", text: "first" }),
    };
    const db = createMockDb(rows);
    const history = await getMemoryHistory(db, "v3");
    assert.strictEqual(history.length, 3);
    assert.strictEqual(history[0].id, "v3");
    assert.strictEqual(history[1].id, "v2");
    assert.strictEqual(history[2].id, "v1");
  });

  it("stops on missing previousVersion", async () => {
    const rows = {
      v1: makeRow({ id: "v1", previousVersion: "" }),
    };
    const db = createMockDb(rows);
    const history = await getMemoryHistory(db, "v1");
    assert.strictEqual(history.length, 1);
  });

  it("stops on cycles", async () => {
    const rows = {
      a: makeRow({ id: "a", previousVersion: "b" }),
      b: makeRow({ id: "b", previousVersion: "a" }),
    };
    const db = createMockDb(rows);
    const history = await getMemoryHistory(db, "a");
    assert.strictEqual(history.length, 2);
  });

  it("respects maxDepth", async () => {
    const rows = {
      d3: makeRow({ id: "d3", previousVersion: "d2" }),
      d2: makeRow({ id: "d2", previousVersion: "d1" }),
      d1: makeRow({ id: "d1", previousVersion: "" }),
    };
    const db = createMockDb(rows);
    const history = await getMemoryHistory(db, "d3", { maxDepth: 2 });
    assert.strictEqual(history.length, 2);
  });
});

// ─── getMemoryCurrentVersion ───────────────────────────────────────────────

describe("getMemoryCurrentVersion", () => {
  it("follows supersededBy forward to active", async () => {
    const rows = {
      v1: makeRow({ id: "v1", supersededBy: "v2", status: "superseded" }),
      v2: makeRow({ id: "v2", supersededBy: "v3", status: "superseded" }),
      v3: makeRow({ id: "v3", supersededBy: "", status: "active" }),
    };
    const db = createMockDb(rows);
    const current = await getMemoryCurrentVersion(db, "v1");
    assert.strictEqual(current.id, "v3");
  });

  it("returns start if no supersededBy", async () => {
    const rows = {
      v1: makeRow({ id: "v1", supersededBy: "" }),
    };
    const db = createMockDb(rows);
    const current = await getMemoryCurrentVersion(db, "v1");
    assert.strictEqual(current.id, "v1");
  });

  it("stops on cycles", async () => {
    const rows = {
      a: makeRow({ id: "a", supersededBy: "b" }),
      b: makeRow({ id: "b", supersededBy: "a" }),
    };
    const db = createMockDb(rows);
    const current = await getMemoryCurrentVersion(db, "a");
    assert.strictEqual(current.id, "b");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  computeDecayedStrength,
  applyRetrievalReinforcement,
  applyDailyDecay,
  computeFlashbulbScore,
  applyFlashbulbEncoding,
  applyCoreMemoryEncoding,
  applyDynamicsDefaults,
  computeCoreMemoryScore,
  createRetrievalLedgerEntry,
  isCoreMemory,
} from "../lib/memory-dynamics.js";
import {
  processRetrievalLedger,
  applyDailyDecayToAll,
} from "../lib/jobs/memory-dynamics-maintenance.js";

function assertClose(actual, expected, delta = 0.01) {
  assert.ok(Math.abs(actual - expected) <= delta, `${actual} not within ${delta} of ${expected}`);
}

describe("computeDecayedStrength", () => {
  it("returns 1.0 for fresh memory", () => {
    const now = 1000000000000;
    const row = { memoryStrength: 1.0, halfLifeDays: 30, lastDynamicsAt: now, createdAt: now };
    assert.strictEqual(computeDecayedStrength(row, now), 1.0);
  });

  it("decays by about 50% after one half-life", () => {
    const now = 1000000000000;
    const halfLifeMs = 30 * 86400000;
    const row = { memoryStrength: 1.0, halfLifeDays: 30, lastDynamicsAt: now - halfLifeMs };
    assertClose(computeDecayedStrength(row, now), 0.5);
  });

  it("clamps at minimum 0.01", () => {
    const now = 1000000000000;
    const row = { memoryStrength: 0.01, halfLifeDays: 1, lastDynamicsAt: now - 86400000 * 100 };
    assert.strictEqual(computeDecayedStrength(row, now), 0.01);
  });

  it("uses createdAt fallback when lastDynamicsAt is 0", () => {
    const now = 1000000000000;
    const halfLifeMs = 30 * 86400000;
    const row = { memoryStrength: 1.0, halfLifeDays: 30, lastDynamicsAt: 0, lastStrengthenedAt: 0, createdAt: now - halfLifeMs };
    assertClose(computeDecayedStrength(row, now), 0.5);
  });

  it("uses lastStrengthenedAt over createdAt", () => {
    const now = 1000000000000;
    const halfLifeMs = 30 * 86400000;
    const row = { memoryStrength: 1.0, halfLifeDays: 30, lastDynamicsAt: 0, lastStrengthenedAt: now - halfLifeMs, createdAt: now - halfLifeMs * 2 };
    assertClose(computeDecayedStrength(row, now), 0.5);
  });
});

describe("applyRetrievalReinforcement", () => {
  it("increments retrievalCount and updates timestamps", () => {
    const now = 1000000000000;
    const row = { memoryStrength: 1.0, halfLifeDays: 30, lastDynamicsAt: now, retrievalCount: 0, lastRetrievedAt: 0 };
    const patch = applyRetrievalReinforcement(row, now);
    assert.strictEqual(patch.retrievalCount, 1);
    assert.strictEqual(patch.lastRetrievedAt, now);
    assert.strictEqual(patch.lastStrengthenedAt, now);
    assert.strictEqual(patch.lastDynamicsAt, now);
  });

  it("boosts strength with diminishing returns", () => {
    const now = 1000000000000;
    const row = { memoryStrength: 0.5, halfLifeDays: 30, lastDynamicsAt: now, retrievalCount: 0 };
    const patch1 = applyRetrievalReinforcement(row, now);
    assertClose(patch1.memoryStrength, 0.60);

    const row2 = { ...row, retrievalCount: 1, memoryStrength: patch1.memoryStrength };
    const patch2 = applyRetrievalReinforcement(row2, now);
    assert.ok(patch2.memoryStrength > 0.5);
    assert.ok(patch2.memoryStrength - patch1.memoryStrength < patch1.memoryStrength - 0.5);
  });

  it("applies decay before boost", () => {
    const now = 1000000000000;
    const halfLifeMs = 30 * 86400000;
    const row = { memoryStrength: 1.0, halfLifeDays: 30, lastDynamicsAt: now - halfLifeMs, retrievalCount: 0 };
    const patch = applyRetrievalReinforcement(row, now);
    assertClose(patch.memoryStrength, 0.60);
  });
});

describe("applyDailyDecay", () => {
  it("computes fresh decayed strength", () => {
    const now = 1000000000000;
    const halfLifeMs = 30 * 86400000;
    const row = { memoryStrength: 1.0, halfLifeDays: 30, lastDynamicsAt: now - halfLifeMs };
    const patch = applyDailyDecay(row, now);
    assertClose(patch.memoryStrength, 0.5);
    assert.strictEqual(patch.lastDynamicsAt, now);
  });

  it("does not change lastStrengthenedAt", () => {
    const now = 1000000000000;
    const row = { memoryStrength: 1.0, halfLifeDays: 30, lastDynamicsAt: now, lastStrengthenedAt: 999 };
    const patch = applyDailyDecay(row, now);
    assert.strictEqual(patch.lastStrengthenedAt, undefined);
  });
});

describe("computeFlashbulbScore", () => {
  it("computes weighted score correctly", () => {
    const row = { emotionalIntensity: 1.0, importance: 1.0, novelty: 1.0, userCorrection: 1.0 };
    assertClose(computeFlashbulbScore(row), 1.0);
  });

  it("returns 0 for neutral entry", () => {
    const row = { emotionalIntensity: 0, importance: 0, novelty: 0, userCorrection: 0 };
    assert.strictEqual(computeFlashbulbScore(row), 0);
  });

  it("uses defaults for missing fields", () => {
    const row = { emotionalIntensity: 0.7, importance: 0.7 };
    assertClose(computeFlashbulbScore(row), 0.7 * 0.35 + 0.7 * 0.35);
  });
});

describe("applyFlashbulbEncoding", () => {
  it("returns null when score below threshold", () => {
    const now = 1000000000000;
    const row = { emotionalIntensity: 0, importance: 0, novelty: 0, userCorrection: 0 };
    assert.strictEqual(applyFlashbulbEncoding(row, now), null);
  });

  it("returns patch when score meets threshold", () => {
    const now = 1000000000000;
    const row = { emotionalIntensity: 1.0, importance: 1.0, novelty: 1.0, userCorrection: 1.0 };
    const patch = applyFlashbulbEncoding(row, now);
    assert.notStrictEqual(patch, null);
    assert.strictEqual(patch.memoryStrength, 0.95);
    assert.strictEqual(patch.halfLifeDays, 90);
    assert.strictEqual(patch.lastStrengthenedAt, now);
    assert.strictEqual(patch.lastDynamicsAt, now);
  });

  it("uses custom threshold", () => {
    const now = 1000000000000;
    const row = { emotionalIntensity: 0.5, importance: 0.5, novelty: 0.5, userCorrection: 0.5 };
    assert.strictEqual(applyFlashbulbEncoding(row, now, 0.70), null);
    assert.notStrictEqual(applyFlashbulbEncoding(row, now, 0.50), null);
  });
});

describe("core memory encoding", () => {
  it("marks only truly deep memories as core and never-forget", () => {
    const now = 1000000000000;
    const entry = { emotionalIntensity: 1.0, importance: 1.0, novelty: 1.0, userCorrection: 1.0 };
    const out = applyDynamicsDefaults(entry, now);
    assert.strictEqual(out.memoryClass, "core");
    assert.strictEqual(out.neverForget, 1);
    assert.strictEqual(out.memoryStrength, 1.0);
    assert.strictEqual(out.halfLifeDays, 36500);
    assert.strictEqual(out.expiresAt, 0);
    assert.ok(out.coreMemoryScore >= 0.95);
    assert.strictEqual(isCoreMemory(out), true);
  });

  it("can mark deep lived memories as core without requiring a correction", () => {
    const now = 1000000000000;
    const entry = { emotionalIntensity: 1.0, importance: 1.0, novelty: 1.0, userCorrection: 0 };
    const out = applyDynamicsDefaults(entry, now);
    assert.strictEqual(out.memoryClass, "core");
    assert.strictEqual(out.neverForget, 1);
  });

  it("keeps ordinary flashbulb memories out of core class", () => {
    const now = 1000000000000;
    const entry = { emotionalIntensity: 0.9, importance: 0.9, novelty: 0.9, userCorrection: 0 };
    const out = applyDynamicsDefaults(entry, now);
    assert.strictEqual(out.memoryClass, "flashbulb");
    assert.strictEqual(out.neverForget, 0);
    assert.strictEqual(out.memoryStrength, 0.95);
    assert.strictEqual(out.halfLifeDays, 90);
  });

  it("does not decay core memories", () => {
    const now = 1000000000000;
    const halfLifeMs = 30 * 86400000;
    const row = { memoryClass: "core", neverForget: 1, memoryStrength: 1.0, halfLifeDays: 30, lastDynamicsAt: now - halfLifeMs };
    const patch = applyDailyDecay(row, now);
    assert.strictEqual(computeCoreMemoryScore(row), 1);
    assert.strictEqual(patch.memoryStrength, 1.0);
    assert.strictEqual(patch.lastDynamicsAt, now);
  });

  it("does not create core memories from merely important but emotionally flat entries", () => {
    const now = 1000000000000;
    const entry = { emotionalIntensity: 0.2, importance: 1.0, novelty: 1.0, userCorrection: 1.0 };
    const patch = applyCoreMemoryEncoding(entry, now);
    assert.strictEqual(patch, null);
  });
});

describe("applyDynamicsDefaults", () => {
  it("applies flashbulb encoding for high-impact new entry", () => {
    const now = 1000000000000;
    const entry = { emotionalIntensity: 0.9, importance: 0.9, novelty: 0.9, userCorrection: 0 };
    const out = applyDynamicsDefaults(entry, now);
    assert.strictEqual(out.memoryStrength, 0.95);
    assert.strictEqual(out.halfLifeDays, 90);
  });

  it("applies standard defaults for normal new entry", () => {
    const now = 1000000000000;
    const entry = { emotionalIntensity: 0, importance: 0.5, novelty: 0 };
    const out = applyDynamicsDefaults(entry, now);
    assert.strictEqual(out.memoryStrength, 1.0);
    assert.strictEqual(out.halfLifeDays, 30);
    assert.strictEqual(out.retrievalCount, 0);
    assert.strictEqual(out.lastRetrievedAt, 0);
    assert.strictEqual(out.lastStrengthenedAt, 0);
    assert.strictEqual(out.lastDynamicsAt, now);
  });

  it("applies decay for existing entry", () => {
    const now = 1000000000000;
    const halfLifeMs = 30 * 86400000;
    const entry = { memoryStrength: 1.0, halfLifeDays: 30, lastDynamicsAt: now - halfLifeMs };
    const out = applyDynamicsDefaults(entry, now);
    assertClose(out.memoryStrength, 0.5);
    assert.strictEqual(out.lastDynamicsAt, now);
  });

  it("preserves existing values when provided", () => {
    const now = 1000000000000;
    const entry = { memoryStrength: 0.8, halfLifeDays: 60, retrievalCount: 5, lastRetrievedAt: now - 1000 };
    const out = applyDynamicsDefaults(entry, now);
    assert.strictEqual(out.memoryStrength, 0.8);
    assert.strictEqual(out.halfLifeDays, 60);
    assert.strictEqual(out.retrievalCount, 5);
  });
});

describe("createRetrievalLedgerEntry", () => {
  it("creates entry with all non-sensitive fields", () => {
    const now = 1000000000000;
    const entry = createRetrievalLedgerEntry({
      agentId: "agent-1",
      workspaceKey: "ws-1",
      query: "hello world",
      resultsCount: 5,
      selectedIds: ["a", "b"],
      timestamp: now,
    });
    assert.ok(entry.id);
    assert.strictEqual(entry.agentId, "agent-1");
    assert.strictEqual(entry.workspaceKey, "ws-1");
    assert.strictEqual(Object.hasOwn(entry, "query"), false);
    assert.ok(entry.queryHash);
    assert.strictEqual(entry.resultsCount, 5);
    assert.deepStrictEqual(entry.selectedIds, ["a", "b"]);
    assert.strictEqual(entry.timestamp, now);
    assert.strictEqual(Object.hasOwn(entry, "processed"), false);
  });

  it("computes queryHash from query string", () => {
    const entry = createRetrievalLedgerEntry({ query: "test" });
    assert.ok(entry.queryHash);
    assert.strictEqual(entry.queryHash.length, 64);
  });

  it("uses provided queryHash", () => {
    const entry = createRetrievalLedgerEntry({ query: "test", queryHash: "custom-hash" });
    assert.strictEqual(entry.queryHash, "custom-hash");
  });

  it("handles null and undefined fields", () => {
    const entry = createRetrievalLedgerEntry({});
    assert.strictEqual(entry.agentId, null);
    assert.strictEqual(entry.workspaceKey, null);
    assert.strictEqual(entry.queryHash, null);
    assert.strictEqual(entry.resultsCount, 0);
    assert.deepStrictEqual(entry.selectedIds, []);
  });
});

describe("processRetrievalLedger", () => {
  it("filters by agentId and workspaceKey", async () => {
    const ledger = [
      { id: "l1", agentId: "agent-a", workspaceKey: "ws-1", selectedIds: ["m1"], timestamp: 1000 },
      { id: "l2", agentId: "agent-b", workspaceKey: "ws-1", selectedIds: ["m2"], timestamp: 2000 },
      { id: "l3", agentId: "agent-a", workspaceKey: "ws-2", selectedIds: ["m3"], timestamp: 3000 },
    ];
    const updates = [];
    const mockDb = {
      getById: async (id) => ({ id, memoryStrength: 0.8, halfLifeDays: 30, lastDynamicsAt: 500, retrievalCount: 0 }),
      update: async (id, patch) => { updates.push({ id, patch }); },
    };
    const state = {};
    const appends = [];
    const mockNeoStore = {
      readRunState: () => state,
      writeRunState: (next) => Object.assign(state, next),
      readRetrievalLedger: async () => ledger,
      appendRetrievalLedger: async (items) => { appends.push(...items); },
    };

    const result = await processRetrievalLedger(mockDb, mockNeoStore, {
      agentId: "agent-a",
      workspaceKey: "ws-1",
      logger: { warn() {}, error() {}, info() {} },
    });

    assert.strictEqual(result.processed, 1);
    assert.strictEqual(result.watermark, 1000);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].id, "m1");
    assert.deepStrictEqual(appends, []);
    assert.strictEqual(state.memoryDynamics["agent-a:ws-1"].lastRetrievalLedgerProcessedAt, 1000);
  });

  it("does not advance watermark on DB failure", async () => {
    const ledger = [
      { id: "l1", agentId: "agent-a", workspaceKey: "ws-1", selectedIds: ["m1"], timestamp: 1000 },
    ];
    const state = {};
    const mockDb = {
      getById: async () => { throw new Error("DB down"); },
      update: async () => {},
    };
    const mockNeoStore = {
      readRunState: () => state,
      writeRunState: (next) => Object.assign(state, next),
      readRetrievalLedger: async () => ledger,
    };

    const result = await processRetrievalLedger(mockDb, mockNeoStore, {
      agentId: "agent-a",
      logger: { warn() {}, error() {}, info() {} },
    });

    assert.strictEqual(result.processed, 0);
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.watermark, 0);
    assert.strictEqual(state.memoryDynamics, undefined);
  });

  it("advances watermark when memory is missing", async () => {
    const ledger = [
      { id: "l1", agentId: "agent-a", workspaceKey: "ws-1", selectedIds: ["missing-id"], timestamp: 1000 },
    ];
    const state = {};
    const mockDb = {
      getById: async () => null,
      update: async () => {},
    };
    const mockNeoStore = {
      readRunState: () => state,
      writeRunState: (next) => Object.assign(state, next),
      readRetrievalLedger: async () => ledger,
    };

    const result = await processRetrievalLedger(mockDb, mockNeoStore, {
      agentId: "agent-a",
      logger: { warn() {}, error() {}, info() {} },
    });

    assert.strictEqual(result.processed, 1);
    assert.strictEqual(result.watermark, 1000);
  });

  it("skips entries at or before the stored watermark", async () => {
    const ledger = [
      { id: "l1", agentId: "agent-a", workspaceKey: "ws-1", selectedIds: ["m1"], timestamp: 1000 },
      { id: "l2", agentId: "agent-a", workspaceKey: "ws-1", selectedIds: ["m2"], timestamp: 2000 },
    ];
    const updates = [];
    const state = { memoryDynamics: { "agent-a:ws-1": { lastRetrievalLedgerProcessedAt: 1000 } } };
    const mockDb = {
      getById: async (id) => ({ id, memoryStrength: 0.8, halfLifeDays: 30, lastDynamicsAt: 500, retrievalCount: 0 }),
      update: async (id, patch) => { updates.push({ id, patch }); },
    };
    const mockNeoStore = {
      readRunState: () => state,
      writeRunState: (next) => Object.assign(state, next),
      readRetrievalLedger: async () => ledger,
    };

    const result = await processRetrievalLedger(mockDb, mockNeoStore, {
      agentId: "agent-a",
      workspaceKey: "ws-1",
      logger: { warn() {}, error() {}, info() {} },
    });

    assert.strictEqual(result.processed, 1);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].id, "m2");
  });
});

describe("applyDailyDecayToAll", () => {
  it("skips __schema__ and applies decay to rows", async () => {
    const rows = [
      { id: "__schema__", memoryStrength: 1.0, halfLifeDays: 30, lastDynamicsAt: 0 },
      { id: "m1", memoryStrength: 1.0, halfLifeDays: 30, lastDynamicsAt: Date.now() - 86400000 * 30 },
    ];
    const updates = [];
    const mockDb = {
      table: {
        query: () => ({
          limit: () => ({
            toArray: async () => rows,
          }),
        }),
      },
      update: async (id, patch) => { updates.push({ id, patch }); },
    };

    const result = await applyDailyDecayToAll(mockDb, {
      logger: { warn() {}, error() {}, info() {} },
    });

    assert.strictEqual(result.decayed, 1);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].id, "m1");
    assert.ok(updates[0].patch.memoryStrength < 0.51);
  });

  it("skips core memories during daily decay", async () => {
    const rows = [
      { id: "core-1", memoryClass: "core", neverForget: 1, memoryStrength: 1.0, halfLifeDays: 30, lastDynamicsAt: Date.now() - 86400000 * 30 },
      { id: "normal-1", memoryStrength: 1.0, halfLifeDays: 30, lastDynamicsAt: Date.now() - 86400000 * 30 },
    ];
    const updates = [];
    const mockDb = {
      table: {
        query: () => ({
          limit: () => ({
            toArray: async () => rows,
          }),
        }),
      },
      update: async (id, patch) => { updates.push({ id, patch }); },
    };

    const result = await applyDailyDecayToAll(mockDb, {
      logger: { warn() {}, error() {}, info() {} },
    });

    assert.strictEqual(result.decayed, 1);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].id, "normal-1");
  });

  it("returns errors when table query fails", async () => {
    const mockDb = {
      table: {
        query: () => { throw new Error("table error"); },
      },
      update: async () => {},
    };

    const result = await applyDailyDecayToAll(mockDb, {
      logger: { warn() {}, error() {}, info() {} },
    });

    assert.strictEqual(result.decayed, 0);
    assert.ok(result.errors > 0);
  });
});

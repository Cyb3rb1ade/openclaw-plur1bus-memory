import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyDailyDecayToAll, processRetrievalLedger } from "../lib/jobs/memory-dynamics-maintenance.js";

function makePagedDb(rows) {
  const updates = [];
  return {
    updates,
    table: {
      query() {
        const state = { offset: 0, limit: rows.length };
        return {
          limit(n) {
            state.limit = n;
            return this;
          },
          offset(n) {
            state.offset = n;
            return this;
          },
          async toArray() {
            return rows.slice(state.offset, state.offset + state.limit);
          },
        };
      },
    },
    async update(id, patch) {
      updates.push({ id, patch });
    },
  };
}

function makeNeoStore(ledger) {
  let state = {};
  return {
    readRetrievalLedger: () => ledger,
    readRunState: () => state,
    writeRunState: (next) => {
      state = next;
    },
    get state() {
      return state;
    },
  };
}

describe("memory dynamics maintenance", () => {
  it("applies daily decay across all active batches", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `11111111-1111-4111-8111-11111111111${index}`,
      status: "active",
      memoryStrength: 1,
      halfLifeDays: 30,
      createdAt: Date.now() - 86400000,
    }));
    const db = makePagedDb(rows);

    const result = await applyDailyDecayToAll(db, { batchSize: 2 });

    assert.strictEqual(result.decayed, 5);
    assert.deepStrictEqual(db.updates.map((update) => update.id), [
      "11111111-1111-4111-8111-111111111110",
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111112",
      "11111111-1111-4111-8111-111111111113",
      "11111111-1111-4111-8111-111111111114",
    ]);
  });

  it("skips legacy non-UUID rows during daily decay", async () => {
    const rows = [
      {
        id: "05b05923adac2dd234b3dbf20ee6d2b3e12c72a4426a11d4756231d93779bef3",
        status: "active",
        memoryStrength: 1,
        halfLifeDays: 30,
        createdAt: Date.now() - 86400000,
      },
      {
        id: "11111111-1111-4111-8111-111111111111",
        status: "active",
        memoryStrength: 1,
        halfLifeDays: 30,
        createdAt: Date.now() - 86400000,
      },
    ];
    const db = makePagedDb(rows);

    const result = await applyDailyDecayToAll(db, { batchSize: 2 });

    assert.strictEqual(result.decayed, 1);
    assert.strictEqual(result.skippedInvalidIds, 1);
    assert.deepStrictEqual(db.updates.map((update) => update.id), ["11111111-1111-4111-8111-111111111111"]);
  });

  it("stops daily decay after maxRows valid updates", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `11111111-1111-4111-8111-11111111111${index}`,
      status: "active",
      memoryStrength: 1,
      halfLifeDays: 30,
      createdAt: Date.now() - 86400000,
    }));
    const db = makePagedDb(rows);

    const result = await applyDailyDecayToAll(db, { batchSize: 2, maxRows: 3 });

    assert.strictEqual(result.decayed, 3);
    assert.strictEqual(result.truncated, true);
    assert.deepStrictEqual(db.updates.map((update) => update.id), [
      "11111111-1111-4111-8111-111111111110",
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111112",
    ]);
  });

  it("continues capped daily decay after the previous cursor", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `11111111-1111-4111-8111-11111111111${index}`,
      status: "active",
      memoryStrength: 1,
      halfLifeDays: 30,
      createdAt: Date.now() - 86400000,
    }));
    const db = makePagedDb(rows);

    const result = await applyDailyDecayToAll(db, {
      batchSize: 2,
      maxRows: 2,
      cursorId: "11111111-1111-4111-8111-111111111111",
    });

    assert.strictEqual(result.decayed, 2);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.nextCursorId, "11111111-1111-4111-8111-111111111113");
    assert.deepStrictEqual(db.updates.map((update) => update.id), [
      "11111111-1111-4111-8111-111111111112",
      "11111111-1111-4111-8111-111111111113",
    ]);
  });

  it("keeps capped daily decay ordered when scanned rows arrive unsorted", async () => {
    const rows = [4, 0, 3, 2, 1].map((index) => ({
      id: `11111111-1111-4111-8111-11111111111${index}`,
      status: "active",
      memoryStrength: 1,
      halfLifeDays: 30,
      createdAt: Date.now() - 86400000,
    }));
    const db = makePagedDb(rows);

    const result = await applyDailyDecayToAll(db, {
      batchSize: 1,
      maxRows: 2,
      cursorId: "11111111-1111-4111-8111-111111111111",
    });

    assert.strictEqual(result.decayed, 2);
    assert.strictEqual(result.truncated, true);
    assert.deepStrictEqual(db.updates.map((update) => update.id), [
      "11111111-1111-4111-8111-111111111112",
      "11111111-1111-4111-8111-111111111113",
    ]);
  });

  it("advances ledger watermark through successful entries before a later failure", async () => {
    const okId = "11111111-1111-4111-8111-111111111111";
    const badId = "22222222-2222-4222-8222-222222222222";
    const ledger = [
      { id: "e-1", agentId: "agent", workspaceKey: "ws", selectedIds: [okId], timestamp: 100 },
      { id: "e-2", agentId: "agent", workspaceKey: "ws", selectedIds: [badId], timestamp: 200 },
    ];
    const neoStore = makeNeoStore(ledger);
    const updated = [];
    const db = {
      async getById(id) {
        return { id, status: "active", memoryStrength: 0.5, halfLifeDays: 30, createdAt: 1 };
      },
      async update(id, patch) {
        if (id === badId) throw new Error("write failed");
        updated.push({ id, patch });
      },
    };

    const result = await processRetrievalLedger(db, neoStore, {
      agentId: "agent",
      workspaceKey: "ws",
      logger: { warn() {}, info() {}, error() {} },
    });

    assert.strictEqual(result.processed, 1);
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.watermark, 100);
    assert.strictEqual(
      neoStore.state.memoryDynamics["agent:ws"].lastRetrievalLedgerProcessedAt,
      100,
    );
    assert.deepStrictEqual(updated.map((entry) => entry.id), [okId]);
  });

  it("skips invalid retrieval ledger IDs without failing the entry", async () => {
    const validId = "11111111-1111-4111-8111-111111111111";
    const ledger = [
      {
        id: "e-1",
        agentId: "agent",
        workspaceKey: "ws",
        selectedIds: ["f08acbcecc4c02b5d671105f61c83786", validId],
        timestamp: 100,
      },
    ];
    const neoStore = makeNeoStore(ledger);
    const seen = [];
    const db = {
      async getById(id) {
        seen.push(id);
        return { id, status: "active", memoryStrength: 0.5, halfLifeDays: 30, createdAt: 1 };
      },
      async update() {},
    };

    const result = await processRetrievalLedger(db, neoStore, {
      agentId: "agent",
      workspaceKey: "ws",
      logger: { warn() {}, info() {}, error() {} },
    });

    assert.strictEqual(result.processed, 1);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.skippedInvalidIds, 1);
    assert.deepStrictEqual(seen, [validId]);
  });

  it("resumes a partially capped retrieval ledger entry without advancing the watermark", async () => {
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    const ledger = [
      { id: "e-1", agentId: "agent", workspaceKey: "ws", selectedIds: ids, timestamp: 100 },
    ];
    const neoStore = makeNeoStore(ledger);
    const updated = [];
    const db = {
      async getById(id) {
        return { id, status: "active", memoryStrength: 0.5, halfLifeDays: 30, createdAt: 1 };
      },
      async update(id, patch) {
        updated.push({ id, patch });
      },
    };

    const first = await processRetrievalLedger(db, neoStore, {
      agentId: "agent",
      workspaceKey: "ws",
      logger: { warn() {}, info() {}, error() {} },
      maxUpdates: 2,
    });

    assert.strictEqual(first.processed, 0);
    assert.strictEqual(first.failed, 0);
    assert.strictEqual(first.updated, 2);
    assert.strictEqual(first.truncated, true);
    assert.strictEqual(first.watermark, 0);
    assert.deepStrictEqual(updated.map((entry) => entry.id), ids.slice(0, 2));
    assert.deepStrictEqual(neoStore.state.memoryDynamics["agent:ws"].pendingRetrievalLedgerEntry, {
      entryKey: "e-1",
      timestamp: 100,
      nextSelectedIndex: 2,
    });

    const second = await processRetrievalLedger(db, neoStore, {
      agentId: "agent",
      workspaceKey: "ws",
      logger: { warn() {}, info() {}, error() {} },
      maxUpdates: 2,
    });

    assert.strictEqual(second.processed, 1);
    assert.strictEqual(second.failed, 0);
    assert.strictEqual(second.updated, 1);
    assert.strictEqual(second.truncated, false);
    assert.strictEqual(second.watermark, 100);
    assert.deepStrictEqual(updated.map((entry) => entry.id), ids);
    assert.strictEqual(neoStore.state.memoryDynamics["agent:ws"].lastRetrievalLedgerProcessedAt, 100);
    assert.strictEqual(neoStore.state.memoryDynamics["agent:ws"].pendingRetrievalLedgerEntry, undefined);
  });
});

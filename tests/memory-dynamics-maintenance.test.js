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
      id: `m-${index}`,
      status: "active",
      memoryStrength: 1,
      halfLifeDays: 30,
      createdAt: Date.now() - 86400000,
    }));
    const db = makePagedDb(rows);

    const result = await applyDailyDecayToAll(db, { batchSize: 2 });

    assert.strictEqual(result.decayed, 5);
    assert.deepStrictEqual(db.updates.map((update) => update.id), ["m-0", "m-1", "m-2", "m-3", "m-4"]);
  });

  it("advances ledger watermark through successful entries before a later failure", async () => {
    const ledger = [
      { id: "e-1", agentId: "agent", workspaceKey: "ws", selectedIds: ["ok"], timestamp: 100 },
      { id: "e-2", agentId: "agent", workspaceKey: "ws", selectedIds: ["bad"], timestamp: 200 },
    ];
    const neoStore = makeNeoStore(ledger);
    const updated = [];
    const db = {
      async getById(id) {
        return { id, status: "active", memoryStrength: 0.5, halfLifeDays: 30, createdAt: 1 };
      },
      async update(id, patch) {
        if (id === "bad") throw new Error("write failed");
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
    assert.deepStrictEqual(updated.map((entry) => entry.id), ["ok"]);
  });
});

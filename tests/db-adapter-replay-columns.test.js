import { describe, it } from "node:test";
import assert from "node:assert";
import { createDbAdapter } from "../lib/db-adapter.js";

describe("db-adapter ensureDynamicsColumns — replay columns", () => {
  it("adds replayCount and lastReplayed when missing", async () => {
    const addedColumns = [];

    const mockTable = {
      async schema() {
        return {
          fields: [
            { name: "id" },
            { name: "text" },
            { name: "vector" },
            { name: "retrievalCount" },
            { name: "lastRetrievedAt" },
            { name: "memoryStrength" },
            { name: "halfLifeDays" },
            { name: "lastStrengthenedAt" },
            { name: "lastDynamicsAt" },
            { name: "memoryClass" },
            { name: "neverForget" },
            { name: "coreMemoryScore" },
            { name: "coreMemoryReason" },
          ],
        };
      },
      async addColumns(cols) {
        for (const col of cols) {
          addedColumns.push(col.name);
        }
      },
    };

    const adapter = createDbAdapter({
      basePath: "/tmp/test-db",
      getTable: async () => mockTable,
      logger: { info() {}, warn() {} },
    });

    await adapter._ensureDynamicsColumns("test-agent", mockTable);

    assert.ok(addedColumns.includes("replayCount"), "replayCount should be added");
    assert.ok(addedColumns.includes("lastReplayed"), "lastReplayed should be added");
  });

  it("is idempotent: does not add replayCount or lastReplayed when already present", async () => {
    const addedColumns = [];

    const mockTable = {
      async schema() {
        return {
          fields: [
            { name: "id" },
            { name: "text" },
            { name: "replayCount" },
            { name: "lastReplayed" },
            { name: "retrievalCount" },
            { name: "lastRetrievedAt" },
            { name: "memoryStrength" },
            { name: "halfLifeDays" },
            { name: "lastStrengthenedAt" },
            { name: "lastDynamicsAt" },
            { name: "memoryClass" },
            { name: "neverForget" },
            { name: "coreMemoryScore" },
            { name: "coreMemoryReason" },
          ],
        };
      },
      async addColumns(cols) {
        for (const col of cols) {
          addedColumns.push(col.name);
        }
      },
    };

    const adapter = createDbAdapter({
      basePath: "/tmp/test-db-2",
      getTable: async () => mockTable,
      logger: { info() {}, warn() {} },
    });

    await adapter._ensureDynamicsColumns("test-agent", mockTable);

    assert.strictEqual(addedColumns.length, 0, "no columns should be added when already present");
  });
});

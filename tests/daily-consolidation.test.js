import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runConsolidation } from "../lib/jobs/daily-consolidation.js";

function createMockRawDb(rows) {
  const updates = [];
  return {
    updates,
    table: {
      query: () => ({
        limit: () => ({
          toArray: async () => rows,
        }),
      }),
    },
    init: async () => {},
    purgeExpired: async () => {},
    getById: async (id) => rows.find((row) => row.id === id) || null,
    update: async (id, patch) => {
      updates.push({ id, patch });
      const row = rows.find((item) => item.id === id);
      if (row) Object.assign(row, patch);
    },
  };
}

describe("daily consolidation", () => {
  it("runs dynamics and compaction against a raw MemoryDB surface", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-consolidation-"));
    try {
      const now = Date.now();
      const rows = [
        {
          id: "m1",
          text: "Memory one",
          vector: [1, 0, 0],
          createdAt: now,
          memoryStrength: 0.5,
          halfLifeDays: 30,
          lastDynamicsAt: now,
          retrievalCount: 0,
        },
      ];
      const db = createMockRawDb(rows);
      const state = {};
      const neoStore = {
        readRunState: () => state,
        writeRunState: (next) => Object.assign(state, next),
        readRetrievalLedger: async () => [
          { id: "l1", agentId: "agent-a", workspaceKey: "workspace-a", selectedIds: ["m1"], timestamp: now },
        ],
        pruneAll: () => ({}),
      };

      const result = await runConsolidation(db, "agent-a", {
        workspaceDir: tmpDir,
        workspaceKey: "workspace-a",
        neoStore,
        logger: { info() {}, warn() {}, error() {} },
      });

      assert.strictEqual(result.dynamicsLedger.processed, 1);
      assert.ok(db.updates.some((update) => update.id === "m1" && update.patch.retrievalCount === 1));
      assert.strictEqual(result.compaction.note, "too_few_candidates");
      assert.strictEqual(result.dbAvailable, true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

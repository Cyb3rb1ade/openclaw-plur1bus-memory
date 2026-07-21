import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryDB } from "../index.js";

let lancedb;
try {
  lancedb = await import("@lancedb/lancedb");
} catch {
  // LanceDB native bindings not available in this environment
}

const TEST_DB_PATH = mkdtempSync(join(tmpdir(), "plur1bus-migration-smoke-"));
const VECTOR_DIM = 384;
const TABLE_NAME = "memories";

(lancedb ? describe : describe.skip)("Schema Migration Smoke", () => {
  it("creates a v5.2.11-like table and migrates to v6", async () => {
    // 1. Create v5.2.11-like table
    const db = await lancedb.connect(TEST_DB_PATH);
    const oldData = [
      {
        id: "old-1",
        text: "Legacy memory from v5.2.11",
        vector: new Float32Array(VECTOR_DIM).fill(0.1),
        importance: 0.8,
        category: "fact",
        createdAt: Date.now(),
      },
    ];
    await db.createTable(TABLE_NAME, oldData, { mode: "overwrite" });
    await db.close();

    // 2. Initialize MemoryDB → triggers auto-migration
    const memoryDb = new MemoryDB(TEST_DB_PATH, VECTOR_DIM);
    await memoryDb.init();

    // 3. Verify schema has all v6 columns
    const schema = await memoryDb.table.schema();
    const fieldNames = new Set(schema.fields.map((f) => f.name));

    const v6Columns = [
      "status",
      "versionNumber",
      "memoryStrength",
      "retrievalCount",
      "replayCount",
      "emotionalValence",
      "emotionalDominant",
      "emotionalIntensity",
      "moodContextAtCapture",
      "lastReplayed",
      "lastRetrievedAt",
      "lastStrengthenedAt",
      "lastDynamicsAt",
      "halfLifeDays",
      "memoryClass",
      "neverForget",
      "coreMemoryScore",
      "coreMemoryReason",
      "previousVersion",
      "supersededBy",
      "updateSource",
      "updateEvidence",
      "reconsolidationConfidence",
      "versionCreatedAt",
      "updatedAt",
      "ownerUserId",
      "agentId",
      "workspaceId",
      "memoryKind",
      "reminderStatus",
      "remindAt",
      "remindedAt",
      "dispatchedAt",
      "acknowledgedAt",
      "cancelledAt",
      "reminderKey",
      "dispatchCount",
      "lastDispatchAttemptAt",
      "nextDispatchAttemptAt",
      "workspaceKey",
    ];

    for (const col of v6Columns) {
      assert.ok(fieldNames.has(col), `v6 column ${col} should exist after migration`);
    }

    // 4. Verify old rows are preserved
    const rows = await memoryDb.table.query().toArray();
    assert.strictEqual(rows.length, 1, "row count should not change");
    const oldRow = rows.find((r) => r.id === "old-1");
    assert.ok(oldRow, "old row should still exist");
    assert.strictEqual(oldRow.text, "Legacy memory from v5.2.11", "old text preserved");
    assert.ok(oldRow.vector, "old vector preserved");

    // 5. Verify defaults on migrated rows (use == for BigInt compatibility)
    assert.strictEqual(oldRow.status, "active", "default status = active");
    assert.ok(oldRow.versionNumber == 1, "default versionNumber = 1");
    assert.strictEqual(oldRow.memoryStrength, 1.0, "default memoryStrength = 1.0");
    assert.ok(oldRow.retrievalCount == 0, "default retrievalCount = 0");
    assert.ok(oldRow.replayCount == 0, "default replayCount = 0");
    assert.strictEqual(oldRow.emotionalValence, "", "default emotionalValence = empty");
    assert.strictEqual(oldRow.emotionalDominant, "neutral", "default emotionalDominant = neutral");
    assert.strictEqual(oldRow.emotionalIntensity, 0.0, "default emotionalIntensity = 0.0");
    assert.ok(oldRow.halfLifeDays == 30, "default halfLifeDays = 30");
    assert.strictEqual(oldRow.memoryClass, "standard", "default memoryClass = standard");
    assert.ok(oldRow.neverForget == 0, "default neverForget = 0");
    assert.strictEqual(oldRow.previousVersion, "", "default previousVersion = empty");
    assert.strictEqual(oldRow.supersededBy, "", "default supersededBy = empty");

    // 6. Verify idempotency: init() again should not throw
    await memoryDb.init();
    const rowsAfter = await memoryDb.table.query().toArray();
    assert.strictEqual(rowsAfter.length, 1, "row count still 1 after second init");

    // 7. Store a new v6 memory (all columns required by LanceDB 2.0)
    const newId = "new-v6-1";
    const now = Date.now();
    await memoryDb.table.add([
      {
        id: newId,
        text: "New v6 memory",
        vector: new Float32Array(VECTOR_DIM).fill(0.2),
        importance: 0.9,
        category: "insight",
        createdAt: now,
        status: "active",
        versionNumber: 1,
        memoryStrength: 0.95,
        emotionalDominant: "joy",
        emotionalIntensity: 0.8,
        summary: "",
        origin: "dm",
        mergedFrom: "[]",
        expiresAt: 0,
        agentId: "",
        storedBy: "",
        sourceTurnId: "",
        sourceMessageRole: "",
        sourceTimestamp: 0,
        sourceUrl: "",
        evidenceQuote: "",
        scope: "agent-private",
        ownerUserId: "",
        type: "memory",
        confirmed: false,
        emotionalValence: "",
        moodContextAtCapture: "",
        replayCount: 0,
        lastReplayed: 0,
        retrievalCount: 0,
        lastRetrievedAt: 0,
        lastStrengthenedAt: 0,
        lastDynamicsAt: 0,
        halfLifeDays: 30,
        memoryClass: "standard",
        neverForget: 0,
        coreMemoryScore: 0.0,
        coreMemoryReason: "",
        previousVersion: "",
        supersededBy: "",
        updateSource: "",
        updateEvidence: "",
        reconsolidationConfidence: 0.0,
        versionCreatedAt: 0,
        updatedAt: 0,
        memoryKind: "memory",
        reminderStatus: "",
        remindAt: 0,
        remindedAt: 0,
        dispatchedAt: 0,
        acknowledgedAt: 0,
        cancelledAt: 0,
        reminderKey: "",
        dispatchCount: 0,
        lastDispatchAttemptAt: 0,
        nextDispatchAttemptAt: 0,
        workspaceId: "",
        workspaceKey: "",
      },
    ]);

    const allRows = await memoryDb.table.query().toArray();
    assert.strictEqual(allRows.length, 2, "should have 2 rows after insert");
    const newRow = allRows.find((r) => r.id === newId);
    assert.ok(newRow, "new row should exist");
    assert.strictEqual(newRow.emotionalDominant, "joy", "new row emotionalDominant set");

    // 8. Recall: search by text
    const recalled = await memoryDb.table.query().where("text LIKE '%Legacy%'").toArray();
    assert.strictEqual(recalled.length, 1, "old row recallable by text");
    assert.strictEqual(recalled[0].status, "active", "recalled row has active status");
  });
});

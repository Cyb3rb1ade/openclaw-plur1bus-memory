import { describe, it } from "node:test";
import assert from "node:assert";
import * as lancedb from "@lancedb/lancedb";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryDB } from "../index.js";

const TEST_DB_PATH = mkdtempSync(join(tmpdir(), "plur1bus-migration-robust-"));
const VECTOR_DIM = 384;
const TABLE_NAME = "memories";

describe("Schema Migration Robustness", () => {
  it("migrates missing columns even when one addColumns call fails", async () => {
    // 1. Create a v5.2.11-like table with only basic columns
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

    const criticalColumns = [
      "summary",
      "origin",
      "mergedFrom",
      "expiresAt",
      "storedBy",
      "sourceTurnId",
      "sourceMessageRole",
      "sourceTimestamp",
      "sourceUrl",
      "evidenceQuote",
      "scope",
      "type",
      "confirmed",
      "emotionalValence",
      "emotionalIntensity",
      "emotionalDominant",
      "moodContextAtCapture",
      "replayCount",
      "lastReplayed",
      "retrievalCount",
      "lastRetrievedAt",
      "memoryStrength",
      "halfLifeDays",
      "lastStrengthenedAt",
      "lastDynamicsAt",
      "memoryClass",
      "neverForget",
      "coreMemoryScore",
      "coreMemoryReason",
      "versionNumber",
      "previousVersion",
      "supersededBy",
      "updateSource",
      "updateEvidence",
      "reconsolidationConfidence",
      "status",
      "versionCreatedAt",
      "updatedAt",
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
    ];

    for (const col of criticalColumns) {
      assert.ok(fieldNames.has(col), `column ${col} should exist after robust migration`);
    }

    // 4. Verify old rows are preserved
    const rows = await memoryDb.table.query().toArray();
    assert.strictEqual(rows.length, 1, "row count should not change");
    const oldRow = rows.find((r) => r.id === "old-1");
    assert.ok(oldRow, "old row should still exist");
    assert.strictEqual(oldRow.text, "Legacy memory from v5.2.11", "old text preserved");

    // 5. Verify defaults on migrated rows
    assert.ok(oldRow.replayCount == 0, "default replayCount = 0");
    assert.ok(oldRow.lastReplayed == 0, "default lastReplayed = 0");
    assert.strictEqual(oldRow.status, "active", "default status = active");
    assert.ok(oldRow.versionNumber == 1, "default versionNumber = 1");
    assert.strictEqual(oldRow.memoryStrength, 1.0, "default memoryStrength = 1.0");
  });

  it("idempotent: second init() does not throw or duplicate columns", async () => {
    const memoryDb = new MemoryDB(TEST_DB_PATH, VECTOR_DIM);
    await memoryDb.init();

    const rowsAfter = await memoryDb.table.query().toArray();
    assert.strictEqual(rowsAfter.length, 1, "row count still 1 after second init");

    const schema = await memoryDb.table.schema();
    const fieldNames = schema.fields.map((f) => f.name);
    const uniqueFields = new Set(fieldNames);
    assert.strictEqual(fieldNames.length, uniqueFields.size, "no duplicate column names");
  });
});

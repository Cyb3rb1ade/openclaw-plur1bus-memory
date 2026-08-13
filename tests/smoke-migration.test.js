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
      "epistemicStatus",
      "epistemicStatusUpdatedAt",
      "epistemicStatusActor",
      "epistemicStatusReason",
      "previousEpistemicStatus",
      "validFrom",
      "validUntil",
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
    assert.ok(oldRow.validFrom == 0, "default validFrom = 0 (no known bound, never derived from createdAt)");
    assert.ok(oldRow.validUntil == 0, "default validUntil = 0 (no known bound, still open)");
    assert.equal(typeof oldRow.validFrom, "bigint", "migrated LanceDB int64 validFrom must exercise the native BigInt path");
    assert.equal(typeof oldRow.validUntil, "bigint", "migrated LanceDB int64 validUntil must exercise the native BigInt path");

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
        epistemicStatus: "",
        epistemicStatusUpdatedAt: 0,
        epistemicStatusActor: "",
        epistemicStatusReason: "",
        previousEpistemicStatus: "",
        validFrom: 0,
        validUntil: 0,
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

    // 9. Test 24 (§12): a real, non-zero validFrom/validUntil set on an
    // already-migrated row must survive unchanged — the migration logic only
    // fills columns that are MISSING (see index.js's `if (hasCol) continue;`),
    // it must never touch a column that already exists and already carries a
    // real value.
    const knownValidFrom = Date.parse("2025-01-01T00:00:00.000Z");
    const knownValidUntil = Date.parse("2025-06-01T00:00:00.000Z");
    await memoryDb.table.update({
      where: `id = '${oldRow.id}'`,
      values: { validFrom: knownValidFrom, validUntil: knownValidUntil },
    });
    const rowsAfterSet = await memoryDb.table.query().toArray();
    const rowAfterSet = rowsAfterSet.find((r) => r.id === "old-1");
    assert.ok(rowAfterSet.validFrom == knownValidFrom, "validFrom should be set to the real value written");
    assert.ok(rowAfterSet.validUntil == knownValidUntil, "validUntil should be set to the real value written");

    // 10. Test 25 (§12): migration does not overwrite historical data, only
    // fills unset columns — a further init() (mirrors the idempotency check
    // at step 6 above) must not reset the just-set validFrom/validUntil back
    // to 0, since both columns already exist by this point.
    await memoryDb.init();
    const rowsAfterSecondInit = await memoryDb.table.query().toArray();
    const rowAfterSecondInit = rowsAfterSecondInit.find((r) => r.id === "old-1");
    assert.ok(rowAfterSecondInit.validFrom == knownValidFrom, "a further init() must not reset a previously-set validFrom back to 0");
    assert.ok(rowAfterSecondInit.validUntil == knownValidUntil, "a further init() must not reset a previously-set validUntil back to 0");
  });

  it("brand-new table persists all seven Phase 1/2 fields on the first store", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "plur1bus-migration-smoke-fresh-"));
    const memoryDb = new MemoryDB(freshDir, VECTOR_DIM);

    const knownValidFrom = Date.parse("2025-03-01T00:00:00.000Z");
    const knownValidUntil = Date.parse("2025-09-01T00:00:00.000Z");
    await memoryDb.store({
      id: "fresh-1",
      text: "Freshly created memory in a brand-new agent database",
      vector: new Float32Array(VECTOR_DIM).fill(0.3),
      importance: 0.5,
      category: "fact",
      createdAt: Date.now(),
      epistemicStatus: "trusted",
      epistemicStatusUpdatedAt: Date.parse("2025-03-02T00:00:00.000Z"),
      epistemicStatusActor: "human:owner",
      epistemicStatusReason: "direct confirmation",
      previousEpistemicStatus: "observed",
      validFrom: knownValidFrom,
      validUntil: knownValidUntil,
    });

    const rows = await memoryDb.table.query().toArray();
    const row = rows.find((r) => r.id === "fresh-1");
    assert.ok(row, "freshly stored row should exist");
    assert.strictEqual(
      row.epistemicStatus,
      "trusted",
      "epistemicStatus supplied on the very first store() into a brand-new table must not be silently dropped",
    );
    assert.ok(
      row.validFrom == knownValidFrom,
      "validFrom supplied on the very first store() into a brand-new table must not be silently dropped either",
    );
    assert.ok(row.validUntil == knownValidUntil, "validUntil must persist on the first store too");
    assert.ok(row.epistemicStatusUpdatedAt == Date.parse("2025-03-02T00:00:00.000Z"));
    assert.equal(row.epistemicStatusActor, "human:owner");
    assert.equal(row.epistemicStatusReason, "direct confirmation");
    assert.equal(row.previousEpistemicStatus, "observed");
  });
});

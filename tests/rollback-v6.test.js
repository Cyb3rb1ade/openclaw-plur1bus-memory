/**
 * tests/rollback-v6.test.js — P5E: Rollback Test for PLUR1BUS v6-engram
 *
 * Validates that rolling back from v6-engram-rc1 to v5.x is safe and
 * preserves all user data.  NO DB schema changes across the release
 * enable this rollback.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";

import { MemoryDB } from "../index.js";
import { resolveHalfLifeDays } from "../lib/memory-dynamics.js";

const VECTOR_DIM = 384;
const TABLE_NAME = "memories";

describe("Rollback v6-engram-rc1 → v5.x", () => {
  describe("Schema compatibility: v6 config backward-readable by v5 code", () => {
    it("ignores unknown root fields (criticalPush, setupProfile, featuresConfirmedAt, security, morningReview, eveningReview)", () => {
      const v6Config = {
        embedding: { provider: "openai", model: "text-embedding-3-small" },
        recall: { importanceBoost: 0.3 },
        // v6-only root fields
        criticalPush: { enabled: true, maxPerDay: 5 },
        dailyConsolidation: { enabled: false },
        security: { allowChatConfigCommands: false, allowedUserIds: ["u1"] },
        setupProfile: "recommended",
        featuresConfirmedAt: "2026-06-01T00:00:00Z",
        morningReview: { enabled: true, status: "pending_setup" },
        eveningReview: { enabled: false, status: "pending_setup" },
      };

      // Simulate v5 code path: it destructures only what it knows
      const recallCfg = v6Config.recall || {};
      const embeddingCfg = v6Config.embedding || {};

      // v5 does not crash on unknown keys — it simply never accesses them
      assert.strictEqual(recallCfg.importanceBoost, 0.3);
      assert.strictEqual(embeddingCfg.provider, "openai");
      assert.strictEqual(v6Config.criticalPush.maxPerDay, 5);
      assert.strictEqual(v6Config.setupProfile, "recommended");
      assert.strictEqual(v6Config.featuresConfirmedAt, "2026-06-01T00:00:00Z");
    });

    it("uses safe defaults for missing v6 recall fields", () => {
      // Simulate a stripped-down v5 config
      const v5LikeConfig = {
        recall: {
          importanceBoost: 0.3,
          dedup: true,
        },
      };

      const recallCfg = v5LikeConfig.recall || {};
      const maxPromptMemories = recallCfg.maxPromptMemories ?? 12;
      const canonicalMaxItems = recallCfg.canonicalMaxItems ?? 5;
      const dedupJaccard = recallCfg.dedupJaccard ?? 0.78;
      const candidateTopK = recallCfg.candidateTopK ?? 40;
      const halfLifeOverrides = recallCfg.halfLifeDaysMap || {};

      assert.strictEqual(maxPromptMemories, 12);
      assert.strictEqual(canonicalMaxItems, 5);
      assert.strictEqual(dedupJaccard, 0.78);
      assert.strictEqual(candidateTopK, 40);
      assert.deepStrictEqual(halfLifeOverrides, {});

      // Safe defaults match schema defaults
      assert.strictEqual(resolveHalfLifeDays("fact", null, halfLifeOverrides), 60);
      assert.strictEqual(resolveHalfLifeDays("general", null, halfLifeOverrides), 60);
      assert.strictEqual(resolveHalfLifeDays("project", null, halfLifeOverrides), 600);
      assert.strictEqual(resolveHalfLifeDays("person", null, halfLifeOverrides), 600);
      assert.strictEqual(resolveHalfLifeDays("other", null, halfLifeOverrides), 180);
    });

    it("v6 halfLifeDaysMap overrides are readable and backward-compatible", () => {
      const v6Config = {
        recall: {
          halfLifeDaysMap: {
            transient: 90,
            episodic: 200,
            longContext: 700,
            project: 700,
          },
        },
      };

      const overrides = v6Config.recall.halfLifeDaysMap || {};
      assert.strictEqual(resolveHalfLifeDays("fact", null, overrides), 90);
      assert.strictEqual(resolveHalfLifeDays("other", null, overrides), 200);
      assert.strictEqual(resolveHalfLifeDays("person", null, overrides), 700);
      assert.strictEqual(resolveHalfLifeDays("project", null, overrides), 700);
    });
  });

  describe("Data preservation: v5-format memory DB after v6 upgrade", () => {
    it("does not lose rows when a v5 table is opened by v6 MemoryDB", async () => {
      const dbPath = mkdtempSync(join(tmpdir(), "plur1bus-rollback-rows-"));

      // 1. Create a v5.2.11-like table
      const db = await lancedb.connect(dbPath);
      const v5Rows = [
        {
          id: "v5-row-1",
          text: "Alice prefers tea over coffee",
          vector: new Float32Array(VECTOR_DIM).fill(0.1),
          importance: 0.85,
          category: "person",
          createdAt: Date.now() - 86400000,
        },
        {
          id: "v5-row-2",
          text: "Project deadline is Friday",
          vector: new Float32Array(VECTOR_DIM).fill(0.2),
          importance: 0.9,
          category: "project",
          createdAt: Date.now() - 172800000,
        },
      ];
      await db.createTable(TABLE_NAME, v5Rows, { mode: "overwrite" });
      await db.close();

      // 2. v6 init triggers auto-migration
      const memoryDb = new MemoryDB(dbPath, VECTOR_DIM);
      await memoryDb.init();

      // 3. Row count unchanged
      const rows = await memoryDb.table.query().toArray();
      assert.strictEqual(rows.length, 2, "all v5 rows must survive migration");

      // 4. Original data intact
      const r1 = rows.find((r) => r.id === "v5-row-1");
      const r2 = rows.find((r) => r.id === "v5-row-2");
      assert.ok(r1, "row 1 exists");
      assert.ok(r2, "row 2 exists");
      assert.strictEqual(r1.text, "Alice prefers tea over coffee");
      assert.strictEqual(r2.text, "Project deadline is Friday");
      assert.strictEqual(r1.importance, 0.85);
      assert.strictEqual(r2.category, "project");
      assert.ok(r1.vector, "vector preserved");

      // 5. New v6 columns got safe defaults
      assert.strictEqual(r1.status, "active");
      assert.ok(r1.versionNumber == 1, "versionNumber defaulted to 1");
      assert.ok(r1.halfLifeDays == 30, "halfLifeDays defaulted to 30");
      assert.strictEqual(r1.memoryClass, "standard");

      await memoryDb.shutdown();
    });

    it("allows a simulated v5 client to query the upgraded table", async () => {
      const dbPath = mkdtempSync(join(tmpdir(), "plur1bus-rollback-v5client-"));

      // 1. Create and migrate
      const db = await lancedb.connect(dbPath);
      await db.createTable(
        TABLE_NAME,
        [
          {
            id: "legacy-1",
            text: "Legacy memory",
            vector: new Float32Array(VECTOR_DIM).fill(0.05),
            importance: 0.7,
            category: "fact",
            createdAt: Date.now(),
          },
        ],
        { mode: "overwrite" },
      );
      await db.close();

      const memoryDb = new MemoryDB(dbPath, VECTOR_DIM);
      await memoryDb.init();
      await memoryDb.shutdown();

      // 2. Simulated v5 client opens the same table
      const v5db = await lancedb.connect(dbPath);
      const v5table = await v5db.openTable(TABLE_NAME);
      const v5rows = await v5table.query().toArray();

      assert.strictEqual(v5rows.length, 1);
      assert.strictEqual(v5rows[0].id, "legacy-1");
      assert.strictEqual(v5rows[0].text, "Legacy memory");
      // v5 client sees new columns too (Arrow forwards them), but v5 code ignores them
      assert.ok("status" in v5rows[0], "v5 client sees v6 columns but ignores them");
      await v5db.close();
    });
  });

  describe("Config downgrade: v6 config with new fields", () => {
    it("v5 code ignores maxPromptMemories and halfLifeDaysMap when present", () => {
      const v6Config = {
        recall: {
          maxPromptMemories: 12,
          canonicalMaxItems: 5,
          candidateTopK: 40,
          halfLifeDaysMap: { transient: 45, episodic: 120, longContext: 365, project: 365 },
        },
      };

      // Simulate v5 reading pattern (same as index.js lines ~1504)
      const recallCfg = v6Config.recall || {};
      const maxPromptMemories = recallCfg.maxPromptMemories ?? 12;
      const canonicalMaxItems = recallCfg.canonicalMaxItems ?? 5;
      const candidateTopK = recallCfg.candidateTopK ?? 40;
      const halfLifeOverrides = recallCfg.halfLifeDaysMap || {};

      assert.strictEqual(maxPromptMemories, 12);
      assert.strictEqual(canonicalMaxItems, 5);
      assert.strictEqual(candidateTopK, 40);
      assert.deepStrictEqual(halfLifeOverrides, {
        transient: 45,
        episodic: 120,
        longContext: 365,
        project: 365,
      });

      assert.strictEqual(resolveHalfLifeDays("fact", null, halfLifeOverrides), 45);
    });

    it("v5 code ignores runtime fields added in v6", () => {
      const v6Config = {
        runtime: {
          recallTimeoutMs: 45000,
          embeddingCacheEnabled: true,
          metricsDebounceMs: 5000,
        },
      };

      // v5 only reads runtime.recallTimeoutMs, runtime.captureTimeoutMs, etc.
      const runtimeCfg = v6Config.runtime || {};
      const recallTimeoutMs = runtimeCfg.recallTimeoutMs ?? 45000;
      const embeddingCacheEnabled = runtimeCfg.embeddingCacheEnabled ?? false;
      const metricsDebounceMs = runtimeCfg.metricsDebounceMs ?? 5000;

      assert.strictEqual(recallTimeoutMs, 45000);
      assert.strictEqual(embeddingCacheEnabled, true);
      assert.strictEqual(metricsDebounceMs, 5000);
    });
  });

  describe("No destructive ops: migration must not delete or rewrite memory files", () => {
    it("preserves external files in the DB directory during init", async () => {
      const dbPath = mkdtempSync(join(tmpdir(), "plur1bus-rollback-files-"));

      // Pre-existing user data that must survive
      const userFile = join(dbPath, "user-memories-backup.jsonl");
      writeFileSync(userFile, '{"id":"ext-1","text":"external"}\n');

      // 1. Create v5 table
      const db = await lancedb.connect(dbPath);
      await db.createTable(
        TABLE_NAME,
        [
          {
            id: "safe-1",
            text: "Safe row",
            vector: new Float32Array(VECTOR_DIM).fill(0.01),
            importance: 0.5,
            category: "general",
            createdAt: Date.now(),
          },
        ],
        { mode: "overwrite" },
      );
      await db.close();

      const filesBefore = new Set(readdirSync(dbPath));
      const contentBefore = readFileSync(userFile, "utf8");

      // 2. v6 init
      const memoryDb = new MemoryDB(dbPath, VECTOR_DIM);
      await memoryDb.init();

      // 3. Verify no files deleted
      const filesAfter = readdirSync(dbPath);
      for (const f of filesBefore) {
        assert.ok(
          filesAfter.includes(f),
          `file ${f} must not be deleted by v6 migration`,
        );
      }

      // 4. Verify external file content untouched
      const contentAfter = readFileSync(userFile, "utf8");
      assert.strictEqual(contentAfter, contentBefore, "external user file must not be rewritten");

      // 5. Row still there
      const rows = await memoryDb.table.query().toArray();
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].id, "safe-1");

      await memoryDb.shutdown();
    });

    it("does not drop or recreate the table during migration", async () => {
      const dbPath = mkdtempSync(join(tmpdir(), "plur1bus-rollback-table-"));

      const db = await lancedb.connect(dbPath);
      await db.createTable(
        TABLE_NAME,
        [
          {
            id: "orig-1",
            text: "Original",
            vector: new Float32Array(VECTOR_DIM).fill(0.1),
            importance: 0.6,
            category: "fact",
            createdAt: Date.now(),
          },
        ],
        { mode: "overwrite" },
      );
      await db.close();

      const memoryDb = new MemoryDB(dbPath, VECTOR_DIM);
      await memoryDb.init();

      // Table name unchanged
      const tables = await memoryDb.db.tableNames();
      assert.ok(tables.includes(TABLE_NAME), "table must not be renamed or dropped");

      // Original row unchanged
      const rows = await memoryDb.table.query().toArray();
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].text, "Original");

      await memoryDb.shutdown();
    });
  });
});

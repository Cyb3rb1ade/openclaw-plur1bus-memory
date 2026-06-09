import { describe, it } from "node:test";
import assert from "node:assert";
import * as lancedb from "@lancedb/lancedb";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DB_PATH = mkdtempSync(join(tmpdir(), "plur1bus-smoke-"));

describe("LanceDB Smoke", () => {
  it("connects to a local database", async () => {
    const db = await lancedb.connect(TEST_DB_PATH);
    assert.ok(db, "db should be truthy");
  });

  it("creates a table and inserts vectors", async () => {
    const db = await lancedb.connect(TEST_DB_PATH);
    const data = [
      { id: "test-1", text: "hello world", vector: new Float32Array(384).fill(0.1) },
      { id: "test-2", text: "goodbye world", vector: new Float32Array(384).fill(0.2) },
    ];
    const table = await db.createTable("memories", data, { mode: "overwrite" });
    assert.ok(table, "table should be truthy");
    const count = await table.countRows();
    assert.strictEqual(count, 2, "should have 2 rows");
  });

  it("queries rows with where clause", async () => {
    const db = await lancedb.connect(TEST_DB_PATH);
    const table = await db.openTable("memories");
    const rows = await table.query().where("id = 'test-1'").toArray();
    assert.ok(Array.isArray(rows), "results should be an array");
    assert.strictEqual(rows.length, 1, "should return exactly one row");
    assert.strictEqual(rows[0].id, "test-1", "id should match");
  });
});

// temp dir left for OS cleanup

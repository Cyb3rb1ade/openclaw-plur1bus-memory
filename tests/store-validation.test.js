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

const VECTOR_DIM = 384;
const TABLE_NAME = "memories";

function makeVector() {
  return Array(VECTOR_DIM).fill(0.1);
}

async function createTableWithSchema(dbPath) {
  const db = await lancedb.connect(dbPath);
  const schemaData = [
    {
      id: "schema-dummy",
      text: "dummy",
      vector: makeVector(),
      importance: 0.5,
      category: "fact",
      createdAt: Date.now(),
    },
  ];
  await db.createTable(TABLE_NAME, schemaData, { mode: "overwrite" });
  await db.close();
}

(lancedb ? describe : describe.skip)("MemoryDB.store validation", () => {
  it("rejects entry with empty text and empty summary", async () => {
    const dbPath = mkdtempSync(join(tmpdir(), "plur1bus-store-val-"));
    await createTableWithSchema(dbPath);

    const db = new MemoryDB(dbPath, VECTOR_DIM);
    await db.init();

    const emptyEntry = {
      id: "empty-1",
      text: "",
      summary: "",
      vector: makeVector(),
      createdAt: Date.now(),
    };

    await assert.rejects(
      async () => await db.store(emptyEntry),
      /empty|leer/i,
      "store() should reject an entry with both text and summary empty"
    );
  });

  it("rejects entry with only whitespace text and summary", async () => {
    const dbPath = mkdtempSync(join(tmpdir(), "plur1bus-store-ws-"));
    await createTableWithSchema(dbPath);

    const db = new MemoryDB(dbPath, VECTOR_DIM);
    await db.init();

    const wsEntry = {
      id: "ws-1",
      text: "   \n\t  ",
      summary: "   ",
      vector: makeVector(),
      createdAt: Date.now(),
    };

    await assert.rejects(
      async () => await db.store(wsEntry),
      /empty|leer/i,
      "store() should reject an entry with only whitespace content"
    );
  });

  it("accepts entry with non-empty text", async () => {
    const dbPath = mkdtempSync(join(tmpdir(), "plur1bus-store-ok-"));
    await createTableWithSchema(dbPath);

    const db = new MemoryDB(dbPath, VECTOR_DIM);
    await db.init();

    const validEntry = {
      id: "valid-1",
      text: "This is a real memory",
      summary: "",
      vector: makeVector(),
      createdAt: Date.now(),
    };

    await db.store(validEntry);

    const rows = await db.table.query().toArray();
    assert.strictEqual(rows.length, 2, "valid entry should be stored");
    const stored = rows.find((r) => r.id === "valid-1");
    assert.ok(stored, "stored row should exist");
    assert.strictEqual(stored.text, "This is a real memory");
  });

  it("accepts entry with non-empty summary even if text is empty", async () => {
    const dbPath = mkdtempSync(join(tmpdir(), "plur1bus-store-sum-"));
    await createTableWithSchema(dbPath);

    const db = new MemoryDB(dbPath, VECTOR_DIM);
    await db.init();

    const validEntry = {
      id: "valid-2",
      text: "",
      summary: "Summary only memory",
      vector: makeVector(),
      createdAt: Date.now(),
    };

    await db.store(validEntry);

    const rows = await db.table.query().toArray();
    assert.strictEqual(rows.length, 2, "valid entry should be stored");
    const stored = rows.find((r) => r.id === "valid-2");
    assert.ok(stored, "stored row should exist");
    assert.strictEqual(stored.summary, "Summary only memory");
  });
});

/**
 * tests/memory-db-chunk-group-schema.test.js — E1 Task 8 fix round 1 (I2).
 *
 * A table MemoryDB created itself used to lack `chunkGroupId`: the seed row
 * did not carry it and MemoryDB's own migration list did not add it. The
 * column only appeared when db-adapter opened the table (ensureChunkColumns)
 * through a second handle — after which every append through the first
 * MemoryDB failed with "missing=[chunkGroupId]", because normalizeEntryForTable
 * filters rows by the schema MemoryDB cached at init. On a fresh install that
 * stopped capture until the next restart.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MemoryDB } from "../index.js";
import { createDbAdapter } from "../lib/db-adapter.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const DIM = 8;
const AGENT = "fresh-agent";
const row = (id, seed) => ({
  id,
  type: "memory",
  memoryKind: "memory",
  text: `chunk group schema ${id}`,
  vector: Array.from({ length: DIM }, (_, i) => Math.sin(seed + i)),
  category: "fact",
  importance: 0.5,
  scope: "agent-private",
  agentId: AGENT,
  storedBy: AGENT,
  workspaceId: "",
  workspaceKey: "",
  epistemicStatus: "untrusted",
  status: "active",
});

describe("MemoryDB: chunkGroupId is part of the schema of a table MemoryDB creates", () => {
  const base = join(makeTempDir("plur1bus-chunk-schema-"), "lancedb");
  const handles = [];
  after(async () => {
    for (const db of handles) await db.shutdown().catch(() => {});
  });

  it("a fresh table has chunkGroupId, and a store after db-adapter opened the table still succeeds", async () => {
    const db = new MemoryDB(join(base, AGENT), DIM);
    handles.push(db);
    await db.init();
    await db.store(row("11111111-1111-4111-8111-111111111111", 1));
    assert.ok(db.schemaFieldNames.has("chunkGroupId"), "MemoryDB's own schema carries chunkGroupId");

    // db-adapter opens the same table through its own handle and runs its
    // ensure*Columns migrations (ensureChunkColumns among them).
    const adapter = createDbAdapter({ basePath: base });
    const first = await adapter.getCard(AGENT, "11111111-1111-4111-8111-111111111111");
    assert.ok(first, "db-adapter sees the first row");

    // The same MemoryDB instance, schema cached before db-adapter ran.
    await db.store(row("22222222-2222-4222-8222-222222222222", 2));
    const second = await db.getById("22222222-2222-4222-8222-222222222222");
    assert.equal(second?.chunkGroupId, "");
  });
});

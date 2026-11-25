/**
 * tests/sensitivity-backfill-7212.test.js — scripts/sensitivity-backfill.mjs
 * writes only sensitivity/sensitivitySource of unclassified rows.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { backfillTable } from "../scripts/sensitivity-backfill.mjs";

const require = createRequire(import.meta.url);
const lancedb = require("@lancedb/lancedb");

describe("sensitivity backfill", () => {
  it("dry run counts, apply writes only unclassified rows, text untouched", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-sbf-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const db = await lancedb.connect(dir);
    const table = await db.createTable("memories", [
      { id: "a", text: "Diagnose beim Facharzt", sensitivity: "", sensitivitySource: "" },
      { id: "b", text: "Wir haben Pizza gegessen", sensitivity: "", sensitivitySource: "" },
      { id: "c", text: "Diagnose", sensitivity: "banal", sensitivitySource: "llm" },
    ]);
    const dry = await backfillTable(table, { apply: false });
    assert.deepEqual([dry.unclassified, dry.written], [2, 0]);
    assert.equal(dry.byLevel.confidential, 1);
    const applied = await backfillTable(table, { apply: true });
    assert.equal(applied.written, 2);
    const rows = Object.fromEntries((await table.query().toArray()).map((r) => [r.id, r]));
    assert.deepEqual([rows.a.sensitivity, rows.a.sensitivitySource, rows.a.text], ["confidential", "rules", "Diagnose beim Facharzt"]);
    assert.equal(rows.b.sensitivity, "banal");
    assert.deepEqual([rows.c.sensitivity, rows.c.sensitivitySource], ["banal", "llm"], "an LLM verdict stays");
    await table.close?.();
  });

  it("refuses a table without the columns", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-sbf-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const table = await (await lancedb.connect(dir)).createTable("memories", [{ id: "a", text: "x" }]);
    await assert.rejects(backfillTable(table), /no sensitivity columns/);
  });
});

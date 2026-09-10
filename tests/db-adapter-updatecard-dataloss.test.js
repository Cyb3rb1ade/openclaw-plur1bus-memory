/**
 * tests/db-adapter-updatecard-dataloss.test.js
 *
 * Regression: updateCard must not leave the old row superseded when the
 * insert of the new version fails. The destructive supersede must only
 * happen AFTER the new version is durably written, otherwise a crash/timeout
 * between the two steps loses the memory (old hidden, new never created).
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { createDbAdapter } from "../lib/db-adapter.js";

const EXISTING = {
  id: "11111111-1111-1111-1111-111111111111",
  text: "Original fact",
  summary: "Original fact",
  status: "active",
  supersededBy: "",
  versionNumber: 1,
};

function makeTable({ onAdd, onUpdate }) {
  return {
    query: () => ({
      where: () => ({ limit: () => ({ toArray: async () => [EXISTING] }) }),
    }),
    update: async (arg) => { if (onUpdate) onUpdate(arg); },
    add: async (arg) => { if (onAdd) return onAdd(arg); },
    delete: async () => {},
    close: async () => {},
  };
}

const embedder = { embed: async () => [0.1, 0.2, 0.3] };

describe("db-adapter updateCard — supersede-after-store ordering", () => {
  it("does not supersede the old row when the new-version insert fails", async () => {
    let supersedeCalled = false;
    const table = makeTable({
      onAdd: async () => { throw new Error("simulated insert failure"); },
      onUpdate: () => { supersedeCalled = true; },
    });
    const db = createDbAdapter({
      basePath: "/tmp/db-adapter-updatecard-dataloss",
      getTable: async () => table,
      embedder,
    });

    await assert.rejects(
      () => db.updateCard("agent", EXISTING.id, "Corrected fact"),
      /insert failed|simulated insert failure/,
    );

    assert.strictEqual(
      supersedeCalled,
      false,
      "old row must NOT be marked superseded when the new-version insert fails (data-loss guard)",
    );
  });
});

describe("db-adapter updateCard — BigInt aus LanceDB", () => {
  // LanceDB liefert int64-Spalten als BigInt. `1n + 1` wirft "Cannot mix
  // BigInt and other types" — genau daran scheiterte jedes /correct, und in
  // 21 000 Zeilen entstand nie eine zweite Version. Sichtbar wurde es am
  // 09.09.2026 durch ein getipptes /correct. Die Fixture oben nutzt Number
  // und konnte das deshalb nie zeigen.
  it("legt die neue Version an, wenn versionNumber als BigInt kommt", async () => {
    const existingBigInt = { ...EXISTING, versionNumber: 1n, updatedAt: 0n, retrievalCount: 0n };
    let added = null;
    let superseded = null;
    const table = {
      query: () => ({ where: () => ({ limit: () => ({ toArray: async () => [existingBigInt] }) }) }),
      update: async (arg) => { superseded = arg; },
      add: async (rows) => { added = rows[0]; },
      delete: async () => {},
      close: async () => {},
    };
    const adapter = createDbAdapter({ basePath: "/tmp/plur1bus-test", embedder, getTable: async () => table });
    const result = await adapter.updateCard("main", EXISTING.id, "Corrected fact");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(added.versionNumber, 2, "Number 2, kein BigInt und kein Wurf");
    assert.strictEqual(typeof added.versionNumber, "number");
    assert.strictEqual(added.previousVersion, EXISTING.id);
    assert.strictEqual(superseded.values.status, "superseded");
  });
});

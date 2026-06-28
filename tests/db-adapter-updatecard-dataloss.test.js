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

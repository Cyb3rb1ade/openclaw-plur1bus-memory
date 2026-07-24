/**
 * tests/light-dream-strengthen-dataloss.test.js
 *
 * Regression: strengthenMemory's delete+add fallback (used on older LanceDB
 * without update()) must not lose the memory if the re-add fails after the
 * delete. The memory is identified by the SAME id, so it must roll back by
 * re-inserting the original row when the add throws.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { strengthenMemory } from "../lib/dreaming/light-dream.js";

const ID = "11111111-1111-1111-1111-111111111111";
const ORIGINAL = { id: ID, text: "fact", vector: [0.1, 0.2], replayCount: 0 };

describe("strengthenMemory — delete+add fallback data-loss guard", () => {
  it("re-inserts the original row when the re-add fails after delete", async () => {
    let deleted = false;
    const added = [];
    const db = {
      table: {
        query: () => ({ where: () => ({ limit: () => ({ toArray: async () => [{ ...ORIGINAL }] }) }) }),
        // Force the fallback path by making the in-place update unsupported.
        update: async () => { throw new Error("update() not supported"); },
        delete: async () => { deleted = true; },
        add: async (rows) => {
          added.push(rows[0]);
          // First add (the strengthened version) fails; rollback add must follow.
          if (added.length === 1) throw new Error("simulated add failure");
        },
      },
    };

    await strengthenMemory(db, ID);

    assert.ok(deleted, "delete should have run in the fallback path");
    assert.strictEqual(added.length, 2, "a rollback re-add must be attempted after the failed add");
    assert.strictEqual(added[1].id, ID, "the rollback must re-insert the original memory id");
    assert.strictEqual(added[1].text, "fact", "the rollback must restore the original content");
  });

  it("finishes re-adding the memory when abort arrives after delete starts", async () => {
    const controller = new AbortController();
    const added = [];
    const db = {
      table: {
        query: () => ({ where: () => ({ limit: () => ({ toArray: async () => [{ ...ORIGINAL }] }) }) }),
        update: async () => { throw new Error("update() not supported"); },
        delete: async () => {
          controller.abort();
        },
        add: async (rows) => {
          added.push(rows[0]);
        },
      },
    };

    const strengthened = await strengthenMemory(db, ID, controller.signal);

    assert.strictEqual(strengthened, true, "the started delete+add replacement must settle as one unit");
    assert.strictEqual(added.length, 1, "the updated row must be re-added even though abort arrived during delete");
    assert.strictEqual(added[0].id, ID);
    assert.strictEqual(added[0].replayCount, 1);
  });

  it("surfaces both re-add and rollback failures after delete", async () => {
    const addErrors = [
      new Error("strengthened re-add failed"),
      new Error("original rollback failed"),
    ];
    let addCalls = 0;
    const db = {
      table: {
        query: () => ({ where: () => ({ limit: () => ({ toArray: async () => [{ ...ORIGINAL }] }) }) }),
        update: async () => { throw new Error("update() not supported"); },
        delete: async () => {},
        add: async () => {
          throw addErrors[addCalls++];
        },
      },
    };

    await assert.rejects(
      strengthenMemory(db, ID),
      (error) => error instanceof AggregateError
        && error.errors[0] === addErrors[0]
        && error.errors[1] === addErrors[1],
    );
    assert.strictEqual(addCalls, 2, "the rollback re-add must still be attempted exactly once");
  });
});

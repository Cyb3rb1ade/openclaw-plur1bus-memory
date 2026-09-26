// Unbestätigte Critical-Karten verfallen nach der Frist zur normalen Notiz,
// statt automatisch als Critical akzeptiert zu werden (7.16.10).
import assert from "node:assert/strict";
import { test } from "node:test";
import { expireStaleCriticals } from "../lib/jobs/auto-accept-stale-criticals.js";

function fakeDb(pending) {
  const calls = { rejected: [], confirmed: [], olderThan: null };
  return {
    calls,
    async findUnconfirmedCritical(_agent, { olderThan }) {
      calls.olderThan = olderThan;
      return pending;
    },
    async markCriticalRejected(_agent, id) {
      calls.rejected.push(id);
    },
    async markConfirmed(_agent, id) {
      calls.confirmed.push(id);
    },
  };
}

test("stale unconfirmed criticals fall back to plain notes, never to accepted criticals", async () => {
  const db = fakeDb([{ id: "a" }, { id: "b" }]);
  const before = Date.now();
  const result = await expireStaleCriticals(db, "main", { hours: 24 });

  assert.deepEqual(db.calls.rejected, ["a", "b"]);
  assert.deepEqual(db.calls.confirmed, [], "must not confirm a card as critical");
  assert.equal(result.expired, 2);
  assert.equal(result.scanned, 2);
  assert.ok(db.calls.olderThan <= before - 24 * 3600000 + 1000);
});

test("reports nothing to do and keeps going past a failing card", async () => {
  assert.equal((await expireStaleCriticals(fakeDb([]), "main")).expired, 0);

  const db = fakeDb([{ id: "a" }, { id: "b" }]);
  db.markCriticalRejected = async (_agent, id) => {
    if (id === "a") throw new Error("lance busy");
    db.calls.rejected.push(id);
  };
  const result = await expireStaleCriticals(db, "main");
  assert.equal(result.expired, 1);
  assert.equal(result.errors, 1);
});

test("is a no-op without the adapter methods", async () => {
  assert.equal((await expireStaleCriticals({}, "main")).expired, 0);
});

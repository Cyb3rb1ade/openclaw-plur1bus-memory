/**
 * tests/unconfirmed-clause-sibling.test.js
 *
 * 7.4.5 hat die typ-abhaengige Klausel nur in `findPendingCriticalReviews`
 * korrigiert. `findUnconfirmedCritical` (auto-accept-stale-criticals, taeglich
 * 04:47) baute weiterhin
 *   "(confirmed IS NULL OR confirmed = false OR confirmed = 0)"
 * und scheiterte damit aus demselben Grund: Lance validiert den Ausdruck vorab
 * und vollstaendig, das nicht passende Literal laesst die ganze Abfrage fallen.
 *
 * Beobachtet am 25.08.2026: 3x `[findUnconfirmedCritical.where] failed` — jeder
 * Lauf fiel auf den vollen Tabellen-Scan zurueck.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDbAdapter } from "../lib/db-adapter.js";

/** Minimaler Table-Mock, der die where-Klausel mitschreibt. */
function makeTable(confirmedType) {
  const wheres = [];
  const builder = {
    where(v) { wheres.push(v); return builder; },
    limit() { return builder; },
    select() { return builder; },
    async toArray() { return []; },
  };
  return {
    wheres,
    table: {
      query: () => builder,
      schema: async () => ({
        fields: [
          { name: "id", type: "Utf8" },
          { name: "type", type: "Utf8" },
          { name: "createdAt", type: "Int64" },
          { name: "confirmed", type: confirmedType },
        ],
      }),
    },
  };
}

async function clauseFor(confirmedType) {
  const { table, wheres } = makeTable(confirmedType);
  const adapter = createDbAdapter({ getTable: async () => table, logger: { info() {}, warn() {} } });
  await adapter.findUnconfirmedCritical("agent-x", { olderThan: 1000 });
  return wheres.join(" | ");
}

describe("findUnconfirmedCritical — Literal am Spaltentyp", () => {
  it("nutzt das Integer-Literal bei einer Int64-Spalte", async () => {
    const w = await clauseFor("Int64");
    assert.match(w, /confirmed = 0/);
    assert.ok(!/confirmed = false/.test(w), "kein Boolean-Literal bei Int64");
  });

  it("nutzt das Boolean-Literal bei einer Bool-Spalte", async () => {
    const w = await clauseFor("Bool");
    assert.match(w, /confirmed = false/);
    assert.ok(!/confirmed = 0/.test(w), "kein Integer-Literal bei Bool");
  });

  it("erzeugt nie beide Literale gleichzeitig", async () => {
    for (const t of ["Bool", "Int64"]) {
      const w = await clauseFor(t);
      assert.ok(!(/confirmed = false/.test(w) && /confirmed = 0/.test(w)),
        `beide Literale bei ${t} — genau das laesst Lance scheitern`);
    }
  });

  it("behaelt die uebrigen Bedingungen bei", async () => {
    const w = await clauseFor("Bool");
    assert.match(w, /createdAt <= 1000/);
    assert.match(w, /type = 'gesundheit'/);
    assert.match(w, /confirmed IS NULL/);
  });
});

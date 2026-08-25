/**
 * tests/critical-confirmed-column-type.test.js
 *
 * `findPendingCriticalReviews` baute die Klausel
 *   "(confirmed IS NULL OR confirmed = false OR confirmed = 0)"
 * um typ-agnostisch zu sein. Lance validiert den Ausdruck aber VORAB und
 * vollstaendig: der Zweig, der nicht zum Spaltentyp passt, laesst die ganze
 * Abfrage scheitern — auch als OR-Zweig. Beobachtet am 25.08.2026 auf einer
 * produktiven Tabelle mit `confirmed: Int64` (andere Agenten: Bool):
 *
 *   [findPendingCriticalReviews.where] failed: ... Invalid user input:
 *   Error resolving filter expression (type = 'person' OR ...)
 *
 * Folge: Rueckfall auf den vollen Scan, dort Timeout nach 30000ms, Fehler wird
 * verschluckt — und der Nutzer bekommt "kann die Referenz nicht finden",
 * obwohl die Karte offen in der Tabelle liegt.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildUnconfirmedClause } from "../lib/db-adapter.js";

describe("buildUnconfirmedClause", () => {
  it("nutzt das Boolean-Literal bei einer Bool-Spalte", () => {
    const c = buildUnconfirmedClause("Bool");
    assert.match(c, /confirmed = false/);
    assert.ok(!/confirmed = 0/.test(c), "kein Integer-Literal bei Bool");
  });

  it("nutzt das Integer-Literal bei einer Int64-Spalte", () => {
    const c = buildUnconfirmedClause("Int64");
    assert.match(c, /confirmed = 0/);
    assert.ok(!/confirmed = false/.test(c), "kein Boolean-Literal bei Int64");
  });

  it("behandelt weitere numerische Typen wie Integer", () => {
    for (const t of ["Int32", "UInt8", "Float64", "Decimal128(38, 10)"]) {
      const c = buildUnconfirmedClause(t);
      assert.match(c, /confirmed = 0/, t);
      assert.ok(!/confirmed = false/.test(c), t);
    }
  });

  it("deckt in jedem Fall NULL ab", () => {
    for (const t of ["Bool", "Int64"]) assert.match(buildUnconfirmedClause(t), /confirmed IS NULL/);
  });

  it("faellt bei unbekanntem Typ auf die Boolean-Form zurueck, nie auf leer", () => {
    // Eine leere Klausel waere schaedlich: ohne confirmed-Pushdown verdraengen
    // bestaetigte Zeilen die offenen aus dem Limit (Regression B2). Passt die
    // Boolean-Form nicht, scheitert der Pushdown und der Aufrufer nimmt den
    // Scan — das bisherige Verhalten.
    for (const t of [undefined, null, "", "Utf8"]) {
      const c = buildUnconfirmedClause(t);
      assert.notEqual(c, "", String(t));
      assert.match(c, /confirmed/, String(t));
    }
  });

  it("erzeugt nie beide Literale gleichzeitig", () => {
    for (const t of ["Bool", "Int64", "Int32", "Float64"]) {
      const c = buildUnconfirmedClause(t);
      assert.ok(!(/confirmed = false/.test(c) && /confirmed = 0/.test(c)),
        `beide Literale bei ${t} — genau das laesst Lance scheitern`);
    }
  });
});

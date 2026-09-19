/**
 * tests/importance-phase1-reset.test.js
 *
 * Phase 1 räumt das Agentenband (importance >= 0.95): rund 320 Zeilen mit
 * origin=memory-md-migration und eine Handvoll mit origin=cron stehen dort,
 * ohne je einzeln bewertet worden zu sein. Zeilen mit origin=dm sind die
 * bewussten Entscheidungen des Agenten und bleiben unangetastet.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { selectLegacyBandRows, toPlainRow, findDuplicateActiveIds } from "../scripts/importance-phase1-reset.mjs";

describe("phase 1 selection", () => {
  const rows = [
    { id: "mig", importance: 0.95, origin: "memory-md-migration", status: "active" },
    { id: "cron", importance: 0.95, origin: "cron", status: "active" },
    { id: "agent", importance: 0.95, origin: "dm", status: "active" },
    { id: "normal", importance: 0.7, origin: "cron", status: "active" },
    { id: "deleted", importance: 0.95, origin: "cron", status: "deleted" },
  ];

  it("takes migration and cron rows in the reserved band", () => {
    assert.deepStrictEqual(selectLegacyBandRows(rows).map((r) => r.id), ["mig", "cron"]);
  });

  it("leaves the agent's own decisions alone", () => {
    assert.strictEqual(selectLegacyBandRows(rows).some((r) => r.id === "agent"), false);
  });
});

describe("toPlainRow", () => {
  // LanceDB liefert die Vektorspalte als Arrow-`Vector`-Objekt, nicht als
  // einfaches Array. Ein `{ ...row }`-Spread kopiert dann nur die internen
  // Arrow-Eigenschaften (isValid, get, data, ...), und mergeInsert lehnt das
  // beim Zurückschreiben ab. Live gegen eine Kopie des developer-Stores
  // verifiziert (2026-09-19): ohne diese Entpackung schlägt jeder --apply-Lauf
  // mit echten Vektorspalten fehl.
  it("entpackt ein iterierbares Arrow-Vector-Objekt zu einem echten Array", () => {
    const row = { id: "a", vector: { [Symbol.iterator]: function* () { yield 0.1; yield 0.2; } } };
    const plain = toPlainRow(row);
    assert.strictEqual(Array.isArray(plain.vector), true);
    assert.deepStrictEqual(plain.vector, [0.1, 0.2]);
  });

  it("lässt ein bereits flaches Array unverändert", () => {
    const row = { id: "b", vector: [0.3, 0.4] };
    assert.deepStrictEqual(toPlainRow(row).vector, [0.3, 0.4]);
  });

  it("verträgt eine fehlende Vektorspalte", () => {
    const row = { id: "c", text: "ohne Vektor" };
    assert.deepStrictEqual(toPlainRow(row), row);
  });
});

describe("findDuplicateActiveIds", () => {
  // Live an main/bernhardine gefunden: aktive Zeilen mit identischer id.
  // mergeInsert("id") bricht dabei mit "Ambiguous merge insert" ab —
  // dieser Check macht das schon im Dry-Run sichtbar.
  it("findet eine id, die zweimal unter aktiven Zeilen auftaucht", () => {
    const rows = [
      { id: "dup", status: "active" },
      { id: "dup", status: "active" },
      { id: "solo", status: "active" },
    ];
    assert.deepStrictEqual(findDuplicateActiveIds(rows), ["dup"]);
  });

  // Ziel-seitige Mehrdeutigkeit: der Quell-Batch enthält nur die aktive
  // Zeile, aber mergeInsert trifft im Ziel zwei — live geprüft (2026-09-19),
  // whenMatchedUpdateAll() ersetzt dabei lautlos auch die gelöschte Zeile
  // durch die aktive und lässt eine neue Aktiv-Aktiv-Kollision zurück.
  it("erfasst auch eine Kollision mit einer gelöschten Kopie derselben id", () => {
    const rows = [
      { id: "a", status: "active" },
      { id: "a", status: "deleted" },
    ];
    assert.deepStrictEqual(findDuplicateActiveIds(rows), ["a"]);
  });

  it("lässt eine einzeln vorkommende gelöschte Zeile unangetastet", () => {
    const rows = [
      { id: "a", status: "active" },
      { id: "b", status: "deleted" },
    ];
    assert.deepStrictEqual(findDuplicateActiveIds(rows), []);
  });
});

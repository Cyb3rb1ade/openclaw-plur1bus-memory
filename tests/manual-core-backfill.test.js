/**
 * tests/manual-core-backfill.test.js
 *
 * `applyDynamicsDefaults` kodiert nur bei `isNew` (kein `lastDynamicsAt`).
 * Erinnerungen, die der Agent vor 7.3.4 mit `importance = 1.0` markiert hat,
 * tragen deshalb weiterhin `neverForget = 0` — die Markierung wirkt erst für
 * neue Einträge. Live betroffen (15.08.2026): zwei Zeilen bei bernhardine.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectManualCoreRows } from "../scripts/backfill-manual-core-markers.mjs";

describe("selectManualCoreRows", () => {
  it("wählt eine markierte, noch ungeschützte Zeile", () => {
    const rows = [{ id: "a", importance: 1.0, neverForget: 0, memoryClass: "standard", status: "active" }];
    assert.deepEqual(selectManualCoreRows(rows).map((r) => r.id), ["a"]);
  });

  it("fasst bereits geschützte Zeilen nicht erneut an", () => {
    const rows = [
      { id: "a", importance: 1.0, neverForget: 1, memoryClass: "core", status: "active" },
      { id: "b", importance: 1.0, neverForget: 0, memoryClass: "core", status: "active" },
    ];
    assert.deepEqual(selectManualCoreRows(rows), []);
  });

  it("lässt alles unterhalb der Reservierung liegen", () => {
    const rows = [{ id: "a", importance: 0.99, neverForget: 0, memoryClass: "standard", status: "active" }];
    assert.deepEqual(selectManualCoreRows(rows), []);
  });

  it("rührt gelöschte und archivierte Zeilen nicht an", () => {
    const rows = [
      { id: "a", importance: 1.0, neverForget: 0, memoryClass: "standard", status: "deleted" },
      { id: "b", importance: 1.0, neverForget: 0, memoryClass: "standard", status: "archived" },
    ];
    assert.deepEqual(selectManualCoreRows(rows), []);
  });

  it("verträgt neverForget als BigInt aus LanceDB", () => {
    const rows = [{ id: "a", importance: 1.0, neverForget: 0n, memoryClass: "standard", status: "active" }];
    assert.deepEqual(selectManualCoreRows(rows).map((r) => r.id), ["a"]);
  });
});

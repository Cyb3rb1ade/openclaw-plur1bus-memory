/**
 * Tests für lib/episode-watermark.js.
 *
 * Der zentrale Regressionsfall: Das agent_end-Watermark wurde synchron
 * hochgezählt, während Light-Dream und Episoden-Extraktion fire-and-forget
 * liefen. Schlug ein Pfad fehl, waren dessen Turns dauerhaft verloren.
 * Beim Nachholen ist der Batch-Digest wertlos, weil die Wiederholungs-Slice
 * breiter ist — deshalb dedupliziert die Episoden-Seite über Turn-IDs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filterAlreadyEpisoded,
  mergeEpisodedTurnIds,
  resolveWatermarkAdvance,
} from "../lib/episode-watermark.js";

describe("resolveWatermarkAdvance", () => {
  it("rückt vor, wenn kein Nachverarbeitungspfad lief", () => {
    assert.deepEqual(resolveWatermarkAdvance({ results: [] }), {
      advance: true, nextFailures: 0, gaveUp: false,
    });
  });

  it("rückt vor, wenn alle Pfade erfolgreich waren", () => {
    assert.deepEqual(resolveWatermarkAdvance({ results: [true, true] }), {
      advance: true, nextFailures: 0, gaveUp: false,
    });
  });

  it("bleibt stehen, sobald ein einziger Pfad fehlschlägt", () => {
    const decision = resolveWatermarkAdvance({ results: [true, false], failures: 0 });
    assert.equal(decision.advance, false, "Watermark darf den Bereich nicht überspringen");
    assert.equal(decision.nextFailures, 1);
    assert.equal(decision.gaveUp, false);
  });

  it("zählt aufeinanderfolgende Fehlversuche hoch", () => {
    assert.equal(resolveWatermarkAdvance({ results: [false], failures: 2 }).nextFailures, 3);
  });

  it("gibt nach maxRetries auf und rückt vor, statt die Slice unbegrenzt wachsen zu lassen", () => {
    const decision = resolveWatermarkAdvance({ results: [false], failures: 4, maxRetries: 5 });
    assert.equal(decision.advance, true, "Sicherheitsventil muss greifen");
    assert.equal(decision.gaveUp, true, "Aufgabe muss als solche erkennbar sein");
  });

  it("ein Erfolg nach Fehlversuchen setzt den Zähler zurück", () => {
    assert.equal(resolveWatermarkAdvance({ results: [true], failures: 3 }).nextFailures, 0);
  });
});

describe("filterAlreadyEpisoded", () => {
  const epA = { id: "a", memoryIds: ["turn_1", "turn_2"] };
  const epB = { id: "b", memoryIds: ["turn_3", "turn_4"] };

  it("lässt alles durch, wenn noch nichts episodiert wurde", () => {
    const { fresh, skipped } = filterAlreadyEpisoded([epA, epB], new Set());
    assert.equal(fresh.length, 2);
    assert.equal(skipped, 0);
  });

  it("verwirft eine Spanne, deren Turns vollständig bekannt sind", () => {
    const { fresh, skipped } = filterAlreadyEpisoded([epA, epB], new Set(["turn_1", "turn_2"]));
    assert.deepEqual(fresh.map((e) => e.id), ["b"]);
    assert.equal(skipped, 1);
  });

  it("behält Teilüberlappungen — sie enthalten neue Turns", () => {
    const partial = { id: "c", memoryIds: ["turn_1", "turn_9"] };
    const { fresh, skipped } = filterAlreadyEpisoded([partial], new Set(["turn_1"]));
    assert.deepEqual(fresh.map((e) => e.id), ["c"]);
    assert.equal(skipped, 0);
  });

  it("behält Episoden ohne Turn-Bezug — daraus lässt sich nichts ausschließen", () => {
    const { fresh } = filterAlreadyEpisoded([{ id: "d" }], new Set(["turn_1"]));
    assert.equal(fresh.length, 1);
  });

  it("überlebt eine breitere Wiederholungs-Slice ohne Doppel-Episoden", () => {
    // Lauf 1: Turns 1-4 werden episodiert, danach scheitert das recordHook.
    const run1 = [epA, epB];
    const remembered = mergeEpisodedTurnIds([], run1);

    // Lauf 2: Slice ist breiter (Turns 1-6). Der Batch-Digest wäre ein
    // anderer und würde NICHT greifen — die Turn-IDs schon.
    const epC = { id: "c", memoryIds: ["turn_5", "turn_6"] };
    const { fresh, skipped } = filterAlreadyEpisoded([epA, epB, epC], remembered);

    assert.deepEqual(fresh.map((e) => e.id), ["c"], "nur die neue Spanne darf durch");
    assert.equal(skipped, 2);
  });
});

describe("mergeEpisodedTurnIds", () => {
  it("führt zusammen und dedupliziert", () => {
    const merged = mergeEpisodedTurnIds(["turn_1"], [{ memoryIds: ["turn_1", "turn_2"] }]);
    assert.deepEqual(merged, ["turn_1", "turn_2"]);
  });

  it("begrenzt das Gedächtnis und behält die jüngsten Einträge", () => {
    const previous = Array.from({ length: 10 }, (_, i) => `turn_${i}`);
    const merged = mergeEpisodedTurnIds(previous, [{ memoryIds: ["turn_neu"] }], 3);
    assert.equal(merged.length, 3);
    assert.equal(merged.at(-1), "turn_neu");
  });
});

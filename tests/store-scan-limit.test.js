/**
 * tests/store-scan-limit.test.js
 *
 * Die Wartungsskripte laden den ganzen Store in den Speicher, bevor sie
 * rechnen. Die dafuer noetige Obergrenze stand am 19.09.2026 in vier
 * verschiedenen Zahlen im Code: 100.000 (importance-metrics,
 * importance-phase1-reset), 200.000 (dedupe-memory-ids,
 * backfill-manual-core-markers) und 500.000 (importance-backfill).
 *
 * Das ist gefaehrlich, weil LanceDB bei Erreichen der Grenze klaglos
 * abschneidet: Phase 1 haette oberhalb von 100.000 Zeilen die Haelfte des
 * Bestands nicht in die Warteschlange gestellt und trotzdem "fertig"
 * gemeldet. Die Grenze muss deshalb deutlich ueber der GC-Grenze liegen —
 * mehr aktive Zeilen kann es gar nicht geben — und an EINER Stelle stehen.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STORE_SCAN_LIMIT } from "../lib/store-limits.js";

describe("Ladegrenze der Wartungsskripte", () => {
  it("liegt weit ueber jeder erreichbaren Zeilenzahl", () => {
    // GC deckelt aktive Zeilen je Agent; die Ladegrenze muss mit Reserve
    // darueber liegen, damit ein voller Store noch vollstaendig passt.
    assert.ok(STORE_SCAN_LIMIT >= 1_000_000, `${STORE_SCAN_LIMIT} ist zu knapp`);
  });

  it("wird von jedem Skript benutzt, das den ganzen Store laedt", () => {
    const dir = new URL("../scripts/", import.meta.url).pathname;
    const verdaechtig = [];
    for (const datei of readdirSync(dir).filter((f) => f.endsWith(".mjs"))) {
      const text = readFileSync(join(dir, datei), "utf8");
      // Eine hartkodierte Zahl >= 50.000 in einem limit(...) ist eine
      // heimliche zweite Ladegrenze.
      for (const m of text.matchAll(/\.limit\(\s*(\d[\d_]*)\s*\)/g)) {
        if (Number(String(m[1]).replace(/_/g, "")) >= 50_000) verdaechtig.push(`${datei}: limit(${m[1]})`);
      }
    }
    assert.deepStrictEqual(verdaechtig, [], `hartkodierte Ladegrenzen gefunden:\n  ${verdaechtig.join("\n  ")}`);
  });
});

/**
 * tests/neo-cap-rewrite-thrash.test.js
 *
 * Regression 2026-08-26: Der Cap in appendJsonl() ist record-basiert
 * (NEO_MAX_RECORDS), die Pruefschwelle byte-basiert (NEO_CAP_CHECK_BYTES).
 * Sobald eine Datei die Byte-Schwelle dauerhaft ueberschreitet UND auf genau
 * NEO_MAX_RECORDS steht, gilt bei JEDEM weiteren Append:
 *
 *   size > NEO_CAP_CHECK_BYTES        -> true  (dauerhaft)
 *   recent.length > NEO_MAX_RECORDS   -> true  (5000 + 1 neuer)
 *   => capJsonl() liest und schreibt die GANZE Datei, synchron.
 *
 * Produktiv gemessen (bernhardine): turn-journal.jsonl 5000 Zeilen / 161 MB,
 * memory-candidates.jsonl 5000 / 141 MB, behavior-cards.jsonl 5000 / 78 MB.
 * Jeder Append hat damit ~161 MB synchron umgeschrieben und den Event-Loop
 * blockiert (eventLoopDelayP99 bis 571 s im naechtlichen Dreaming-Fenster).
 *
 * Erwartung: Ein Append auf eine Datei, die bereits auf dem Cap steht, darf
 * NICHT jedes Mal einen Vollrewrite ausloesen. Beobachtbar an der Inode:
 * capJsonl schreibt .tmp und renamed darueber, die Inode wechselt dabei.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_RECORDS = 500; // Untergrenze der Konstante (Math.max(500, ...))

process.env.PLUR1BUS_NEO_MAX_RECORDS = String(MAX_RECORDS);
process.env.PLUR1BUS_NEO_CAP_CHECK_BYTES = String(256 * 1024);

let createNeoStore;
before(async () => {
  ({ createNeoStore } = await import("../lib/neo-arch.js"));
});

function makeTurn(i) {
  return {
    id: `turn-${i}`,
    role: "user",
    // ~800 Bytes pro Record: 500 Records liegen damit sicher ueber der
    // 256-KB-Pruefschwelle, so wie die echten 15-33-KB-Records auch.
    text: `turn ${i} `.padEnd(800, "x"),
    createdAt: new Date(1_700_000_000_000 + i).toISOString(),
  };
}

describe("appendJsonl Cap — kein Vollrewrite bei jedem Append", () => {
  it("meldet Cap-I/O-Fehler redigiert statt sie still zu verschlucken", () => {
    const source = readFileSync(new URL("../lib/neo-arch.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /catch\s*\(_\)\s*\{\s*\/\* Cap ist best-effort/);
    assert.match(source, /safeWarn\([^;]+neo-arch\.cap/);
  });

  it("laesst die Inode stabil, wenn die Datei schon auf dem Cap steht", () => {
    const root = mkdtempSync(join(tmpdir(), "neo-cap-thrash-"));
    try {
      const store = createNeoStore(root, "testws");
      const path = store.paths.turns;

      // Datei auf den Cap fahren.
      for (let i = 0; i < MAX_RECORDS + 50; i++) store.appendTurns([makeTurn(i)]);

      const size = statSync(path).size;
      assert.ok(
        size > 256 * 1024,
        `Vorbedingung: Datei muss ueber der Byte-Schwelle liegen (ist ${size} B)`,
      );

      const inodeBefore = statSync(path).ino;

      // Ein einziger weiterer Append.
      store.appendTurns([makeTurn(9001)]);

      const inodeAfter = statSync(path).ino;
      assert.strictEqual(
        inodeAfter,
        inodeBefore,
        "Ein Append auf eine Datei am Cap hat einen Vollrewrite (rename) ausgeloest",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cappt weiterhin, wenn der Ueberhang gross genug wird", () => {
    const root = mkdtempSync(join(tmpdir(), "neo-cap-thrash-"));
    try {
      const store = createNeoStore(root, "testws");
      const path = store.paths.turns;

      for (let i = 0; i < MAX_RECORDS * 2; i++) store.appendTurns([makeTurn(i)]);

      assert.ok(statSync(path).size > 0, "Datei darf nicht leer sein");

      // Mit Hysterese pendelt die Datei zwischen NEO_MAX_RECORDS und
      // NEO_MAX_RECORDS + Slack (10 %). Entscheidend ist, dass sie BESCHRÄNKT
      // bleibt — nicht, dass sie exakt auf dem Cap steht.
      const slack = Math.max(25, Math.ceil(MAX_RECORDS * 0.1));
      const count = store.readTurns(MAX_RECORDS * 4).length;
      assert.ok(
        count <= MAX_RECORDS + slack,
        `Der Cap muss weiterhin greifen (sind ${count} Records, erlaubt ${MAX_RECORDS + slack})`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Regression: die Groessenmessung lief synchron ueber den ganzen Store und
 * blockierte dabei die Ereignisschleife — am 09.09.2026 bis zu 16 Sekunden bei
 * 12 646 Eintraegen, gemessen 1201 ms Blockade schon im Leerlauf. In der Zeit
 * kam kein anderer Handler dran, weshalb der Recall-Hook in das 15-Sekunden-
 * Fenster des Hosts lief. Teuerster Posten war `resolveInside` je Eintrag
 * (drei Dateisystem-Aufrufe); dieselbe Zusicherung liefert das ohnehin
 * gemachte lstat.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { measureControlHealthStorage } from "../lib/control-plane-storage.js";
import { makeTempDir } from "./helpers/temp-dir.js";

let root;
let aussen;

before(() => {
  aussen = makeTempDir("plur1bus-aussen-");
  writeFileSync(join(aussen, "geheim.bin"), Buffer.alloc(5_000));
  root = makeTempDir("plur1bus-store-");
  writeFileSync(join(root, "a.bin"), Buffer.alloc(1_000));
  mkdirSync(join(root, "unterordner"));
  writeFileSync(join(root, "unterordner", "b.bin"), Buffer.alloc(2_000));
});

after(() => {
  for (const dir of [root, aussen]) rmSync(dir, { recursive: true, force: true });
});

describe("measureControlHealthStorage", () => {
  it("zaehlt Dateien rekursiv und meldet die Messung als vollstaendig", async () => {
    const result = await measureControlHealthStorage(root);
    assert.equal(result.complete, true);
    assert.equal(result.bytes, 3_000);
  });

  it("folgt keinem Symlink und zaehlt sein Ziel nicht mit", async () => {
    // Das ist die Zusicherung, die vorher `resolveInside` je Eintrag gab.
    symlinkSync(join(aussen, "geheim.bin"), join(root, "datei-link"));
    symlinkSync(aussen, join(root, "ordner-link"));
    const result = await measureControlHealthStorage(root);
    assert.equal(result.bytes, 3_000, "Symlink-Ziele bleiben aussen vor");
    assert.equal(result.complete, true);
    rmSync(join(root, "datei-link"));
    rmSync(join(root, "ordner-link"));
  });

  it("meldet eine abgeschnittene Messung als unvollstaendig", async () => {
    const result = await measureControlHealthStorage(root, 2);
    assert.equal(result.complete, false, "Deckel erreicht");
    assert.ok(result.bytes <= 3_000);
  });

  it("behandelt einen fehlenden Pfad als leer, nicht als Fehler", async () => {
    const result = await measureControlHealthStorage(join(root, "gibt-es-nicht"));
    assert.deepEqual(result, { bytes: 0, complete: true });
  });

  it("gibt die Ereignisschleife waehrend des Laufs frei", async () => {
    // Der eigentliche Zweck der Umstellung: ein Timer muss waehrenddessen
    // drankommen. Synchron gemessen blieb er ueber die volle Laufzeit stehen.
    mkdirSync(join(root, "viele"));
    for (let i = 0; i < 600; i += 1) writeFileSync(join(root, "viele", `f${i}.bin`), "x");
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    await measureControlHealthStorage(root);
    await new Promise((r) => setTimeout(r, 10));
    clearInterval(timer);
    rmSync(join(root, "viele"), { recursive: true, force: true });
    assert.ok(ticks > 0, "waehrend der Messung lief kein Timer — die Schleife war blockiert");
  });
});

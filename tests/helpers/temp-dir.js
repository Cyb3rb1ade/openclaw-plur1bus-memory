/**
 * tests/helpers/temp-dir.js
 *
 * Temporäres Verzeichnis für Tests, das sich selbst wieder aufräumt.
 *
 * Vorher legte jeder Test sein Verzeichnis per `mkdtempSync` an und löschte es
 * bestenfalls im Erfolgsfall. Ein voller Suite-Lauf hinterließ dadurch 444
 * Verzeichnisse; auf diesem Rechner lagen im September 2026 rund 33 000 Reste
 * mit 4 GB in /tmp. Node führt jede Testdatei in einem eigenen Prozess aus, ein
 * `exit`-Hook je Datei räumt also alles ab — auch nach einem Fehlschlag, einem
 * Abbruch oder einer geworfenen Ausnahme.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created = new Set();
let hookInstalled = false;

function installHook() {
  if (hookInstalled) return;
  hookInstalled = true;
  process.on("exit", () => {
    for (const dir of created) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Beim Prozessende ist ein nicht löschbares Verzeichnis nichts, was
        // der Test noch melden könnte.
      }
    }
    created.clear();
  });
}

/**
 * Legt ein temporäres Verzeichnis an und merkt es zum Aufräumen vor.
 * @param {string} [prefix] Namenspräfix, wie bei `mkdtempSync`
 * @param {string} [root] Elternverzeichnis, Standard `os.tmpdir()`
 * @returns {string} absoluter Pfad
 */
export function makeTempDir(prefix = "plur1bus-test-", root = tmpdir()) {
  installHook();
  const dir = mkdtempSync(join(root, prefix));
  created.add(dir);
  return dir;
}

/** Ein bereits selbst gelöschtes Verzeichnis aus der Aufräumliste nehmen. */
export function forgetTempDir(dir) {
  created.delete(dir);
}

/** Nur für Tests dieses Helfers: aktuell vorgemerkte Verzeichnisse. */
export function trackedTempDirs() {
  return [...created];
}

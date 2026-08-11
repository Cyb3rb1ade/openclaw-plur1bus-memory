// tests/maintain-lancedb-skip-non-agent-dirs.test.js
//
// Regression: Ein einziges Verzeichnis ohne gültige Agent-ID im Namespace-Root
// hat die gesamte LanceDB-Wartung abgebrochen.
//
// `discoverVersionDirs` rief `safeAgentId()` auf jedem Unterverzeichnis auf und
// warf bei allem, was nicht dem Agent-ID-Muster entspricht. Im Live-System
// liegen dort neben den Agenten auch Backup-Kopien wie
// "bernhardine.bak-20260804" — deren Punkt im Namen ließ das Skript sofort
// aussteigen, sodass fuer KEINEN Agenten mehr geprunt wurde. Gefunden am
// 2026-08-11: bernhardine stand bei 1333 Manifest-Versionen, main bei 507.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/maintain-lancedb.mjs", import.meta.url));

function makeTable(base, agentDir, manifestCount) {
  const versions = join(base, agentDir, "memories.lance", "_versions");
  mkdirSync(versions, { recursive: true });
  for (let i = 0; i < manifestCount; i += 1) {
    writeFileSync(join(versions, `${i}.manifest`), "x");
  }
  return versions;
}

function run(base, extraArgs = []) {
  return execFileSync(process.execPath, [SCRIPT, "--db-path", base, ...extraArgs], {
    encoding: "utf8",
  });
}

describe("maintain-lancedb — Verzeichnisse ohne Agent-ID blockieren die Wartung nicht", () => {
  it("überspringt Backup-Verzeichnisse und verarbeitet die echten Agenten", () => {
    const base = mkdtempSync(join(tmpdir(), "plur1bus-maint-"));
    try {
      makeTable(base, "main", 60);
      makeTable(base, "main.bak-20260804", 60);

      const out = run(base);

      assert.match(out, /main\.bak-20260804/, `Backup muss sichtbar gemeldet werden: ${out}`);
      assert.match(out, /übersprungen/, `Skip-Hinweis fehlt: ${out}`);
      assert.match(out, /main\/memories\.lance/, `echter Agent muss verarbeitet werden: ${out}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("prunt den echten Agenten und lässt das Backup unangetastet", () => {
    const base = mkdtempSync(join(tmpdir(), "plur1bus-maint-"));
    try {
      const live = makeTable(base, "main", 60);
      const backup = makeTable(base, "main.bak-20260804", 60);

      run(base, ["--apply", "--keep", "10"]);

      assert.equal(readdirSync(live).length, 10, "echter Agent muss auf keep=10 geprunt sein");
      assert.equal(readdirSync(backup).length, 60, "Backup darf nicht angefasst werden");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("lehnt Path-Traversal-Namen weiterhin hart ab", () => {
    // Die Sicherheitseigenschaft des Guards bleibt erhalten: ein Name, der wie
    // ein Traversal-Versuch aussieht, bricht die Wartung ab, BEVOR irgendetwas
    // geprunt wird. Nur harmlose Nicht-Agent-Namen werden übersprungen.
    const base = mkdtempSync(join(tmpdir(), "plur1bus-maint-"));
    try {
      const live = makeTable(base, "main", 60);
      makeTable(base, "bad..agent", 4);

      assert.throws(
        () => run(base, ["--apply", "--keep", "2"]),
        /Command failed|Invalid agent/,
        "Traversal-Name muss die Wartung abbrechen",
      );
      assert.equal(readdirSync(live).length, 60, "vor dem Abbruch darf nichts geprunt worden sein");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("läuft ohne Backup-Verzeichnisse unverändert und meldet keinen Skip", () => {
    const base = mkdtempSync(join(tmpdir(), "plur1bus-maint-"));
    try {
      makeTable(base, "main", 60);

      const out = run(base);

      assert.doesNotMatch(out, /übersprungen/, `ohne Backups darf kein Skip gemeldet werden: ${out}`);
      assert.match(out, /main\/memories\.lance/, `Agent fehlt: ${out}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

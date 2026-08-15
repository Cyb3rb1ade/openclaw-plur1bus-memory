/**
 * tests/audit-kleinkram.test.js
 *
 * Restpunkte aus dem Audit vom 13./14.08.2026:
 *
 * K3 — `/plur1bus critical list` war in isSensitiveChatRead autorisiert
 *      (`["", "list"]`), runCriticalCommand kannte aber nur
 *      `["accept","reject","edit"]` → `list` landete im Usage-Zweig.
 * K4 — repair-tombstones.mjs setzte nie einen Exit-Code, auch nicht bei
 *      beschädigten Quellzeilen — die Umkehrung des fail-closed-Vertrags von
 *      reapply-tombstones.mjs.
 * K6 — `critical.failed` wurde ohne `{{error}}`-Var gerendert; der Nutzer sah
 *      „…fehlgeschlagen: " mit hängendem Doppelpunkt.
 *
 * K5 (Existenz-Orakel im memory_forget-ID-Pfad) ist eine reine
 * Meldungsvereinheitlichung und über die bestehenden Forget-Suiten abgedeckt.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const REPAIR_SCRIPT = fileURLToPath(new URL("../scripts/repair-tombstones.mjs", import.meta.url));

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "audit-kleinkram-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ─── K4 ────────────────────────────────────────────────────────────────────

describe("K4 repair-tombstones — fail-closed wie reapply", () => {
  function runRepair(home, extraArgs = []) {
    try {
      const stdout = execFileSync(process.execPath, [REPAIR_SCRIPT, ...extraArgs], {
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_HOME: home },
        timeout: 60_000,
      });
      return { code: 0, report: JSON.parse(stdout) };
    } catch (err) {
      return { code: err.status ?? 1, report: JSON.parse(String(err.stdout || "{}")) };
    }
  }

  it("endet mit 0, wenn nichts zu beanstanden ist", (t) => {
    const home = tempDir(t);
    mkdirSync(join(home, ".adaptive-learning"), { recursive: true });

    const { code, report } = runRepair(home);

    assert.equal(code, 0);
    assert.equal(report.corruptLines, 0);
  });

  it("endet mit 1, wenn destructive-ops.jsonl beschädigte Zeilen hat", (t) => {
    const home = tempDir(t);
    const dir = join(home, ".adaptive-learning");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "destructive-ops.jsonl"), '{"event":"memory.deleted"}\n{kaputt\n', "utf8");

    const { code, report } = runRepair(home, ["--workspace", home]);

    assert.ok(report.corruptLines > 0, "der Report muss die beschädigte Zeile zählen");
    assert.equal(code, 1, "ohne Exit-Code meldete das Skript in einem Gate still Erfolg");
  });
});

// ─── K3 / K6 ───────────────────────────────────────────────────────────────

describe("K3/K6 — statische Prüfung am Quelltext", () => {
  // Der Kommandopfad hat keine eigene Harness; diese beiden Punkte sind
  // Einzeiler, deren Regression sich am zuverlässigsten am Quelltext festhalten
  // lässt. Der Verhaltenstest für die Liste liegt in
  // tests/critical-review-command.test.js.
  const indexSource = fileURLToPath(new URL("../index.js", import.meta.url));

  it("K3: `list` nimmt denselben Pfad wie der leere subKey", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(indexSource, "utf8");
    assert.match(
      src,
      /if \(!subKey \|\| subKey === "list"\) \{/,
      "isSensitiveChatRead autorisiert `list` bereits — der Handler muss es kennen",
    );
  });

  it("K6: critical.failed bekommt die Ursache mitgegeben", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(indexSource, "utf8");
    assert.doesNotMatch(
      src,
      /t\("critical\.failed", \{ lang, tone \}\)/,
      "ohne vars.error entsteht „…fehlgeschlagen: \" mit hängendem Doppelpunkt",
    );
  });
});

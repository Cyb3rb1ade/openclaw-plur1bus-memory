// Morgen-Review vom 06.10.2026 (7.18.21).
//
// Drei Befunde aus einem echten Telegram-Review:
// - obsidianBridge.mode = "apply" ist laut Schema erlaubt, der Health-Check
//   meldete trotzdem jeden Morgen "❌ System: 1 Fehler" ("must run in augment mode").
// - generated_link_review-Hinweise tragen je Datei eine andere Linkliste in der
//   Meldung; die Telegram-Zeile zeigt nur den Code-Text, also stand derselbe Satz
//   fünfmal untereinander.
// - Die Fußnote des Morgen-Reviews war fest englisch.
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { reviewBundleSummary, runMaintenanceLight } from "../lib/obsidian-control-room.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function maintenanceFindings(config) {
  const vault = makeTempDir("plur1bus-review-mode-");
  mkdirSync(join(vault, "plur1bus"), { recursive: true });
  return runMaintenanceLight({ vaultPath: vault, reviewRoot: "plur1bus", ...config }, { baseDbPath: vault }).findings || [];
}

function linkFinding(path, links) {
  return { severity: "warning", code: "generated_link_review", path, message: `Review generated links: ${links}` };
}

describe("Morgen-Review: Wartungsbefunde", () => {
  it("akzeptiert mode=apply und augment, meldet andere Modi weiter", () => {
    for (const mode of ["apply", "augment", undefined]) {
      const codes = maintenanceFindings(mode ? { mode } : {}).map((f) => f.code);
      assert.ok(!codes.includes("invalid_mode"), `mode=${mode} darf kein invalid_mode liefern`);
    }
    const codes = maintenanceFindings({ mode: "slot" }).map((f) => f.code);
    assert.ok(codes.includes("invalid_mode"));
  });

  it("fasst Link-Hinweise mit unterschiedlichen Linklisten zu einer Zeile zusammen", () => {
    const result = {
      bundle: { createdAt: "2026-10-06T07:00:00.000Z" },
      items: [],
      maintenance: {
        findings: [
          linkFinding("a.md", "x"),
          linkFinding("b.md", "y"),
          linkFinding("c.md", "z"),
          linkFinding("c2.md", "z"),
          linkFinding("d.md", "w"),
          linkFinding("e.md", "v"),
        ],
      },
    };
    const text = reviewBundleSummary(result, "PLUR1BUS Morning Review");
    const lines = text.split("\n").filter((l) => l.includes("Dashboard-Link zu prüfen"));
    assert.deepStrictEqual(lines, ["• Dashboard-Link zu prüfen (meist kein Problem) (6×)"]);
  });

  it("übersetzt invalid_mode und die Fußnote des Morgen-Reviews", () => {
    const result = {
      bundle: { createdAt: "2026-10-06T07:00:00.000Z" },
      items: [],
      morningReview: true,
      note: "Morning review prepares proposals only; it never applies changes without explicit approval.",
      maintenance: { findings: [{ severity: "error", code: "invalid_mode", message: "Obsidian Bridge must run in augment mode." }] },
    };
    const de = reviewBundleSummary(result, "PLUR1BUS Morning Review");
    assert.doesNotMatch(de, /must run in augment mode|prepares proposals only/);
    assert.match(de, /Obsidian-Bridge-Modus/);
    assert.match(de, /nur Vorschläge/);
    const en = reviewBundleSummary(result, "PLUR1BUS Morning Review", { lang: "en" });
    assert.match(en, /prepares proposals only/);
  });
});

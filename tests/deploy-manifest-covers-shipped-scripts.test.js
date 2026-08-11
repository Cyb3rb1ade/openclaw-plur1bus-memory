// tests/deploy-manifest-covers-shipped-scripts.test.js
//
// Regression: Das Paket liefert `scripts/` vollständig aus, das
// Deploy-Manifest (DEPLOY_FILES) deckte davon aber nur vier Einträge ab.
// Alles andere wurde von `verify-plugin-deploy.mjs --repair` nie
// synchronisiert und blieb im Deploy auf dem Stand der letzten
// Paket-Installation stehen.
//
// Konkret am 2026-08-11: die deployte `maintain-lancedb.mjs` war zwei Wochen
// alt (231 statt 276 Zeilen) und enthielt den 7.2.5-Fix nicht — obwohl das
// Deploy-Verzeichnis sich als 7.2.5 auswies. Das fällt niemandem auf, weil der
// Integritätscheck nur meldet, was er kennt.
//
// Dieser Test hält Manifest und ausgeliefertes `scripts/` deckungsgleich:
// Wer ein Skript hinzufügt, muss es ins Manifest aufnehmen.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEPLOY_FILES } from "../scripts/lib/deploy-integrity.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function walkScripts(dir = "scripts", out = []) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walkScripts(rel, out);
    else if (/\.(mjs|js)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

describe("Deploy-Manifest deckt alle ausgelieferten Skripte ab", () => {
  it("jedes .mjs/.js unter scripts/ steht in DEPLOY_FILES", () => {
    const shipped = walkScripts();
    const manifest = new Set(DEPLOY_FILES);
    const missing = shipped.filter((f) => !manifest.has(f));

    assert.deepEqual(
      missing,
      [],
      `Diese Skripte werden ausgeliefert, aber nie ins Deploy synchronisiert:\n  ${missing.join("\n  ")}\n`
        + "Trage sie in DEPLOY_FILES (scripts/lib/deploy-integrity.mjs) ein.",
    );
  });

  it("scripts/ wird überhaupt ausgeliefert (sonst wäre der Test wirkungslos)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    assert.ok(
      pkg.files.includes("scripts/"),
      `package.json files enthält kein "scripts/": ${JSON.stringify(pkg.files)}`,
    );
  });

  it("DEPLOY_FILES enthält keine Einträge ohne Datei auf der Platte", () => {
    const shipped = new Set(walkScripts());
    const stale = DEPLOY_FILES.filter((f) => f.startsWith("scripts/") && !shipped.has(f));

    assert.deepEqual(stale, [], `Manifest-Einträge ohne Datei: ${stale.join(", ")}`);
  });
});

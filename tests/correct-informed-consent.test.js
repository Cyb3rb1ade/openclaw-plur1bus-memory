// tests/correct-informed-consent.test.js
//
// Regression: Der /correct-Bestätigungsdialog zeigte nur einen 80-Zeichen-Titel.
//
// Die Zielkarte wird unscharf gesucht (resolveCandidates → searchByTopic, ohne
// Mindestscore), „eindeutig" heißt lediglich, dass der Top-Score den zweiten um
// >0.15 schlägt. Der Nutzer bestätigte also einen Titel-Treffer, während
// safeUpdate anschließend den VOLLEN Text ersetzt — mit abgeschaltetem
// Drift-Gate. Ohne den gespeicherten Text im Dialog ist das keine informierte
// Zustimmung.
//
// Zweiter Punkt: `payload.oldText` trug den Suchbegriff des Nutzers statt des
// tatsächlich ersetzten Inhalts. Da `updateEvidence` daraus die Beweiszeile der
// Korrektur baut, war die Provenance falsch.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { t } from "../lib/i18n.js";
import { dictionary } from "../lib/i18n-dictionary.js";

const KEY = "plur1bus.correct_confirm_text";

const VARS = {
  title: "Gateway läuft als systemd-Service",
  oldText: "Der Gateway läuft als systemd-Service unter openclaw-gateway.service.",
  newText: "Eva hat am 12.08. Geburtstag.",
  token: "a3f9",
};

describe("/correct — Bestätigung zeigt, was überschrieben wird", () => {
  for (const lang of ["de", "en"]) {
    it(`[${lang}] rendert Alt- und Neu-Text, nicht nur den Titel`, () => {
      const out = t(KEY, { lang, tone: "default", vars: VARS });

      assert.ok(out.includes(VARS.oldText), `alter Text fehlt in: ${out}`);
      assert.ok(out.includes(VARS.newText), `neuer Text fehlt in: ${out}`);
      assert.ok(out.includes(VARS.token), `Token fehlt in: ${out}`);
    });

    it(`[${lang}] lässt keinen Platzhalter unersetzt`, () => {
      const out = t(KEY, { lang, tone: "default", vars: VARS });
      assert.doesNotMatch(out, /\{\{\w+\}\}/, `unersetzter Platzhalter in: ${out}`);
    });
  }

  it("beide Sprachen deklarieren dieselben Platzhalter", () => {
    const placeholders = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    const entry = dictionary[KEY];

    assert.deepEqual(
      placeholders(entry.de.default),
      placeholders(entry.en.default),
      "de und en müssen dieselben Variablen verwenden",
    );
    assert.deepEqual(
      placeholders(entry.de.default),
      ["newText", "oldText", "title", "token"],
      "erwartete Platzhalter",
    );
  });
});

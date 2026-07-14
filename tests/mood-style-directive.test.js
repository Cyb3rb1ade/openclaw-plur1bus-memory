/**
 * tests/mood-style-directive.test.js
 *
 * buildMoodStyleDirective: verwandelt describeMood()-Output in eine
 * deutsche Stil-Direktive (Ton, nicht Label) für den Prompt-Kontext.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { buildMoodStyleDirective } from "../lib/mood-style-directive.js";

const NO_LABEL_HINT = "nicht als Label";

describe("buildMoodStyleDirective", () => {
  it("liefert null bei leerem/unbekanntem Input", () => {
    assert.strictEqual(buildMoodStyleDirective(null), null);
    assert.strictEqual(buildMoodStyleDirective(undefined), null);
    assert.strictEqual(buildMoodStyleDirective({}), null);
    assert.strictEqual(buildMoodStyleDirective({ dominant: "unknown-dim", intensity: "hoch" }), null);
  });

  it("enthält die Anweisung, die Stimmung nicht als Label zu nennen", () => {
    const directive = buildMoodStyleDirective({
      label: "fröhlich",
      dominant: "joy",
      intensity: "hoch",
      trend: "stabil",
      nuances: [],
      emoji: "😊",
    });
    assert.ok(directive);
    assert.ok(directive.includes(NO_LABEL_HINT), directive);
  });

  it("ist auf max. ~400 Zeichen begrenzt", () => {
    const directive = buildMoodStyleDirective({
      label: "vorsichtig",
      dominant: "fear",
      intensity: "hoch",
      trend: "steigend",
      nuances: ["loneliness", "resentment"],
      emoji: "😨",
    });
    assert.ok(directive.length <= 400, `zu lang: ${directive.length}`);
  });

  it("moduliert Ton je nach dominanter Dimension (joy vs. sadness)", () => {
    const joy = buildMoodStyleDirective({ label: "fröhlich", dominant: "joy", intensity: "mittel", trend: "stabil", nuances: [], emoji: "😊" });
    const sadness = buildMoodStyleDirective({ label: "nachdenklich", dominant: "sadness", intensity: "mittel", trend: "stabil", nuances: [], emoji: "😔" });
    assert.notStrictEqual(joy, sadness);
  });

  it("deckt alle geforderten dominanten Dimensionen x Intensität ab", () => {
    const dims = ["joy", "trust", "sadness", "fear", "anger", "anticipation"];
    const intensities = ["hoch", "mittel", "niedrig"];
    for (const dominant of dims) {
      for (const intensity of intensities) {
        const directive = buildMoodStyleDirective({
          label: "x",
          dominant,
          intensity,
          trend: "stabil",
          nuances: [],
          emoji: "",
        });
        assert.ok(directive && directive.length > 0, `${dominant}/${intensity} sollte eine Direktive liefern`);
      }
    }
  });

  it("steigender Trend moduliert Energie im Text (unterscheidet sich von fallend)", () => {
    const base = { label: "x", dominant: "joy", intensity: "mittel", nuances: [], emoji: "" };
    const rising = buildMoodStyleDirective({ ...base, trend: "steigend" });
    const falling = buildMoodStyleDirective({ ...base, trend: "fallend" });
    assert.notStrictEqual(rising, falling);
  });

  it("gibt für unbekannte Intensität dennoch eine Direktive zurück (Fallback mittel)", () => {
    const directive = buildMoodStyleDirective({ label: "x", dominant: "joy", intensity: "unbekannt", trend: "stabil", nuances: [], emoji: "" });
    assert.ok(directive);
  });
});

describe("buildMoodStyleDirective — Erweiterungen (F4)", () => {
  const mood = { dominant: "joy", intensity: "mittel", trend: "stabil" };

  it("Tageszeit morgens: knapper", () => {
    const d = buildMoodStyleDirective(mood, { hour: 7 });
    assert.match(d, /knapp/i);
  });

  it("Tageszeit abends: gesprächiger", () => {
    const d = buildMoodStyleDirective(mood, { hour: 21 });
    assert.match(d, /gesprächiger/i);
  });

  it("Tageszeit mittags: kein Tageszeit-Zusatz", () => {
    const d = buildMoodStyleDirective(mood, { hour: 13 });
    assert.doesNotMatch(d, /Morgen|Abend/);
  });

  it("Meinung und Nachfragen als Zusätze", () => {
    const d = buildMoodStyleDirective(mood, { opinion: true, askBack: true });
    assert.match(d, /widersprechen/);
    assert.match(d, /Rückfrage/);
  });

  it("weiches Temperament → sanftere Meinungs-Formulierung", () => {
    const soft = buildMoodStyleDirective(mood, { opinion: true, temperamentName: "warm" });
    const hard = buildMoodStyleDirective(mood, { opinion: true, temperamentName: "ausgewogen" });
    assert.notStrictEqual(soft, hard);
    assert.match(soft, /sanft/);
  });

  it("liefert Direktive auch ohne gültige Mood, wenn opts aktiv", () => {
    const d = buildMoodStyleDirective(null, { opinion: true });
    assert.ok(typeof d === "string" && d.length > 0);
    assert.doesNotMatch(d, /Stimmung/); // NO_LABEL nur bei Mood-Teil
  });

  it("null wenn weder Mood noch opts etwas beitragen", () => {
    assert.strictEqual(buildMoodStyleDirective(null, {}), null);
  });

  it("Längen-Kappung: ganze hintere Teile fallen weg, nie über 400", () => {
    const d = buildMoodStyleDirective({ dominant: "sadness", intensity: "hoch", trend: "steigend" }, { hour: 21, opinion: true, askBack: true });
    assert.ok(d.length <= 400);
  });
});

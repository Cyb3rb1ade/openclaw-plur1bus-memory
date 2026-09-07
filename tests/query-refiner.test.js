import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { removeStopwords, expandQuery, refineQuery } from "../lib/query-refiner.js";

describe("query refiner — German umlauts survive normalisation", () => {
  it("keeps umlauts as single words when removing stopwords", () => {
    assert.equal(removeStopwords("Gespräch Russland Deutschland Ukraine heute"), "Gespräch Russland Deutschland Ukraine heute");
    assert.ok(!/Gespra ch/.test(removeStopwords("Gespräch läuft über Straße")));
  });

  it("recognises stopwords that themselves carry umlauts", () => {
    // "über", "für", "können" stehen in NFC in der Stopwortliste; nach NFKD
    // ohne Rueckfuehrung wuerden sie nie matchen.
    assert.equal(removeStopwords("Gespräch über Ukraine für Erik"), "Gespräch Ukraine Erik");
    assert.equal(removeStopwords("wir können das"), "");
  });

  it("keeps umlauts intact through expansion and refinement", () => {
    assert.match(expandQuery("Gespräch läuft"), /^Gespräch läuft/);
    const refined = refineQuery("Und warum läuft die Konsolidierung?", []);
    assert.match(refined, /läuft/);
    assert.ok(!/la uft/.test(refined));
  });

  it("keeps sharp s and returns precomposed characters", () => {
    const out = removeStopwords("Straße Größe");
    assert.equal(out, "Straße Größe");
    assert.equal(out, out.normalize("NFC"));
  });
});

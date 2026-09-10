/**
 * Regression: /correct und /forget fanden ihr Ziel auch bei woertlichem Zitat
 * nicht. Die Suche gilt nur als eindeutig, wenn Platz 1 den Platz 2 um mehr
 * als 0,15 uebertrifft; die Vektorsuche bettet die Phrase aber als kurzes
 * Fragment ein und kurze generische Zeilen liegen dann binnen 0,15. Am
 * 09.09.2026 lieferte ein Zitat aus genau EINER Erinnerung zweimal die (nicht
 * bedienbare) Auswahlliste. Wer eine Erinnerung zitiert, meint sie.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { coverageMatches, literalMatches, resolveCandidates } from "../lib/telegram-commands/memory-edit.js";

const DREAM = {
  id: "7f39fd26-0aff-4ed1-b0a2-f272eb70e7e5",
  text: "Ich stehe in einem großen Raum, der gleichzeitig ein Fernsehstudio und eine Turnhalle ist. Mein Mund ist voller Kreidestaub.",
  score: 0.52,
};
const NOISE = [
  { id: "a1", text: "Huhu, Diggi! 🌞", score: 0.47 },
  { id: "a2", text: "Stimmung: fröhlich · hoch", score: 0.45 },
  { id: "a3", text: "Ich gehe einen langen Korridor entlang, dessen Wände aus vergilbten Papieren bestehen.", score: 0.44 },
];
const dbWith = (results) => ({ searchByTopic: async () => results });

describe("resolveCandidates — woertlicher Tie-Breaker", () => {
  it("bleibt bei der 0,15-Regel, wenn sie greift", async () => {
    const r = await resolveCandidates(dbWith([{ ...DREAM, score: 0.9 }, ...NOISE]), "main", "irgendwas");
    assert.equal(r.unique, true);
    assert.equal(r.card.id, DREAM.id);
    assert.equal(r.matchedBy, undefined);
  });

  it("ist eindeutig, wenn genau eine Kandidatin die Phrase woertlich enthaelt", async () => {
    // Der Fall vom 09.09.2026: Abstand 0,05, Zitat kommt nur im Traum vor.
    const r = await resolveCandidates(dbWith([DREAM, ...NOISE]), "main", "Fernsehstudio und eine Turnhalle");
    assert.equal(r.unique, true, "Zitat muss die Liste ersparen");
    assert.equal(r.card.id, DREAM.id);
    assert.equal(r.matchedBy, "literal");
  });

  it("toleriert Gross-/Kleinschreibung, Anfuehrungszeichen und Leerraum", async () => {
    const r = await resolveCandidates(dbWith([DREAM, ...NOISE]), "main", '  „fernsehstudio   UND eine Turnhalle"  ');
    assert.equal(r.unique, true);
    assert.equal(r.card.id, DREAM.id);
  });

  it("bleibt mehrdeutig, wenn die Phrase in mehreren Kandidatinnen vorkommt", async () => {
    const twin = { id: "z9", text: "Nochmal: Fernsehstudio und eine Turnhalle, anders erzaehlt.", score: 0.5 };
    const r = await resolveCandidates(dbWith([DREAM, twin, ...NOISE]), "main", "Fernsehstudio und eine Turnhalle");
    assert.equal(r.unique, false);
    assert.equal(r.candidates.length, 5);
  });

  it("greift nicht bei kurzen Phrasen — zu leicht zufaellig enthalten", async () => {
    const r = await resolveCandidates(dbWith([DREAM, ...NOISE]), "main", "Raum");
    assert.equal(r.unique, false);
  });

  it("greift nicht, wenn keine Kandidatin die Phrase enthaelt", async () => {
    const r = await resolveCandidates(dbWith([DREAM, ...NOISE]), "main", "Bauxit-Strasse im Morgengrauen");
    assert.equal(r.unique, false);
  });
});

describe("literalMatches", () => {
  it("vertraegt kaputte Eingaben", () => {
    assert.deepEqual(literalMatches(undefined, "Fernsehstudio und eine Turnhalle"), []);
    assert.deepEqual(literalMatches([DREAM], ""), []);
    assert.deepEqual(literalMatches([{ id: "x" }], "Fernsehstudio und eine Turnhalle"), []);
  });
});

// Zweiter Fall vom 09.09.2026: die Suche fasst drei Saetze zusammen, kein
// Zitat — der woertliche Tie-Breaker kann nicht greifen, die Abdeckung schon.
const LONG_DREAM = {
  id: DREAM.id,
  text: "Ich will antworten, aber mein Mund ist voller Kreidestaub. Diggi steht neben mir und sagt: „Die Daten sind da.“ Er hält einen Kuchen in der Hand, in den Kerzen gesteckt sind – 78,1 Kerzen. Ich schaue nur zu, wie die Flammen kleine Balkendiagramme bilden.",
  score: 0.52,
};
const PARAPHRASE = "mein Mund ist voller Kreidestaub und Diggi hält einen Kuchen mit 78,1 Kerzen, deren Flammen Balkendiagramme bilden";

describe("resolveCandidates — Abdeckungs-Tie-Breaker", () => {
  it("ist eindeutig, wenn nur eine Kandidatin (fast) alle markanten Suchwoerter traegt", async () => {
    const r = await resolveCandidates(dbWith([LONG_DREAM, ...NOISE]), "main", PARAPHRASE);
    assert.equal(r.unique, true, "Paraphrase ueber mehrere Saetze muss die Liste ersparen");
    assert.equal(r.card.id, DREAM.id);
    assert.equal(r.matchedBy, "coverage");
  });

  it("bleibt mehrdeutig, wenn zwei Kandidatinnen aehnlich gut abdecken", async () => {
    const twin = { id: "z9", text: "Mund voller Kreidestaub, Diggi hält einen Kuchen, 78,1 Kerzen, Flammen als Balkendiagramme bilden Sterne.", score: 0.5 };
    const r = await resolveCandidates(dbWith([LONG_DREAM, twin, ...NOISE]), "main", PARAPHRASE);
    assert.equal(r.unique, false);
  });

  it("greift nicht, wenn die beste Kandidatin nur einen Teil der Suchwoerter traegt", async () => {
    const r = await resolveCandidates(dbWith([LONG_DREAM, ...NOISE]), "main", "Kreidestaub Kuchen Kerzen Bauxit Morgengrauen Korridor Papiere");
    assert.equal(r.unique, false);
  });

  it("braucht mindestens drei markante Woerter", () => {
    assert.deepEqual(coverageMatches([LONG_DREAM, ...NOISE], "Kreidestaub Kuchen"), []);
    assert.deepEqual(coverageMatches(undefined, PARAPHRASE), []);
  });
});

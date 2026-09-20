/**
 * Marker wie "nie" und "immer" duerfen nur als eigenstaendige Woerter zaehlen.
 *
 * Gefunden 18.09.2026 im LOCOMO-Lauf: containsPhrase() baute die Regex ohne
 * Wortgrenzen, deshalb loeste jedes "Knie", "Zimmer", "Ingenieur" oder
 * "Melanie" die Regel "explicit instruction" aus und hob die Importance auf den
 * Boden 0.7 — genau die Schwelle, ab der shouldPromoteMemory() nach
 * KNOWLEDGE.md befoerdert.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { explainFactQuality } from "../lib/memory-fact-quality.js";

const reasonsOf = (text) => explainFactQuality(text).reasons.join("; ");

describe("fact-quality marker word boundaries", () => {
  it("does not treat 'nie' inside a longer word as an explicit instruction", () => {
    for (const text of ["Mein Knie tut weh.", "Der Ingenieur kommt Dienstag.", "Hey Melanie, wie geht es dir?"]) {
      assert.doesNotMatch(reasonsOf(text), /explicit instruction/, `substring 'nie' must not fire for: ${text}`);
    }
  });

  it("does not treat 'immer' inside a longer word as an explicit instruction", () => {
    for (const text of ["Das Zimmer ist frei.", "Ein Schimmer Hoffnung."]) {
      assert.doesNotMatch(reasonsOf(text), /explicit instruction/, `substring 'immer' must not fire for: ${text}`);
    }
  });

  it("still detects the standalone German durable markers", () => {
    for (const text of ["Ich habe immer Zeit.", "Ich trinke nie Kaffee.", "Merke dir meine Adresse.", "Ab jetzt bitte kuerzer antworten."]) {
      assert.match(reasonsOf(text), /explicit instruction/, `standalone marker must still fire for: ${text}`);
    }
  });

  it("still detects the standalone English durable markers", () => {
    for (const text of ["From now on use metric units.", "Always cc my assistant.", "Please remember my badge number."]) {
      assert.match(reasonsOf(text), /explicit instruction/, `standalone marker must still fire for: ${text}`);
    }
  });
});

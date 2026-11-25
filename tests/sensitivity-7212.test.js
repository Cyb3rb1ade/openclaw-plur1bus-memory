/**
 * tests/sensitivity-7212.test.js — rule classifier (lib/sensitivity.js).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifySensitivityByRules, normalizeSensitivity } from "../lib/sensitivity.js";

const level = (text) => classifySensitivityByRules(text).sensitivity;

describe("classifySensitivityByRules", () => {
  it("confidential: health, finance, relationship, family conflict, credentials, address, legal", () => {
    assert.equal(level("Ich war beim Facharzt, die Diagnose ist Diabetes."), "confidential");
    assert.equal(level("IBAN DE89 3704 0044 0532 0130 00"), "confidential");
    assert.equal(level("Eva und ihr Mann lassen sich scheiden, die Scheidung läuft."), "confidential");
    assert.equal(level("Seit dem Streit mit meiner Mutter herrscht Kontaktabbruch."), "confidential");
    assert.equal(level("Mein Passwort ist hunter2xyz"), "confidential");
    assert.equal(level("Sie wohnt in der Hauptstraße 12."), "confidential");
    assert.equal(level("Der Anwalt sagt, die Klage hat Aussicht."), "confidential");
  });

  it("banal or personal for everyday and technical talk (no false alarms on common words)", () => {
    assert.equal(level("Hat dein Abendessen gestern geschmeckt?"), "banal");
    assert.equal(level("Der Token wird im Recall gezählt, 20000 Zeichen Budget."), "banal");
    assert.equal(level("Wir suchten gestern ein leckeres Gericht in Berlin."), "banal");
    assert.equal(level("Wir haben einen Prozess für das Deployment."), "banal");
    assert.equal(level("Ich bin heute müde und meine Familie ist zu Besuch."), "personal");
  });

  it("reports the categories and never throws", () => {
    assert.deepEqual(classifySensitivityByRules("Kontostand und Diagnose").categories.sort(), ["finance", "health"]);
    assert.equal(level(undefined), "banal");
    assert.equal(normalizeSensitivity("Confidential"), "confidential");
    assert.equal(normalizeSensitivity("geheim"), "");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMemoryText,
  extractSalientTerms,
  extractStructuredDifferences,
  hasMeaningfulDifference,
  isSafeDuplicate,
  validateMergedTextPreservesFacts,
} from "../lib/memory-merge-safety.js";

describe("normalizeMemoryText", () => {
  it("lowercases and trims", () => {
    assert.strictEqual(normalizeMemoryText("  Hello World  "), "hello world");
  });
  it("removes punctuation", () => {
    assert.strictEqual(normalizeMemoryText("Hello, World!"), "hello world");
  });
  it("collapses whitespace", () => {
    assert.strictEqual(normalizeMemoryText("Hello   World"), "hello world");
  });
  it("returns empty string for non-string input", () => {
    assert.strictEqual(normalizeMemoryText(null), "");
    assert.strictEqual(normalizeMemoryText(undefined), "");
    assert.strictEqual(normalizeMemoryText(123), "");
  });
});

describe("extractSalientTerms", () => {
  it("extracts numbers and versions", () => {
    const terms = extractSalientTerms("Deployment läuft auf Node 20.");
    assert.ok(terms.numbers.has("20"));
    assert.ok(terms.versions.has("node 20"));
  });
  it("extracts titlecase tokens as entities", () => {
    const terms = extractSalientTerms("Projekt Alpha nutzt Auth-Service.");
    assert.ok(terms.entities.has("alpha"));
  });
  it("extracts technologies and databases", () => {
    const terms = extractSalientTerms("Wir nutzen Postgres.");
    assert.ok(terms.technologies.has("postgres") || terms.databases.has("postgres"));
  });
  it("detects negation markers", () => {
    const terms = extractSalientTerms("User mag React nicht mehr.");
    assert.strictEqual(terms.hasNegation, true);
  });
  it("detects temporal/status markers", () => {
    const terms = extractSalientTerms("Früher nutzten wir MySQL, statt Postgres.");
    assert.strictEqual(terms.hasTemporalMarker, true);
  });
});

describe("hasMeaningfulDifference", () => {
  it("detects different project names", () => {
    assert.strictEqual(
      hasMeaningfulDifference("Projekt Alpha nutzt den Auth-Service.", "Projekt Beta nutzt den Auth-Service."),
      true
    );
  });
  it("detects different technologies", () => {
    assert.strictEqual(hasMeaningfulDifference("User mag React.", "User mag Vue."), true);
  });
  it("detects different databases", () => {
    assert.strictEqual(hasMeaningfulDifference("Wir nutzen Postgres.", "Wir nutzen MySQL."), true);
  });
  it("detects different versions", () => {
    assert.strictEqual(hasMeaningfulDifference("Deployment läuft auf Node 20.", "Deployment läuft auf Node 22."), true);
  });
  it("detects different meanings for same entity", () => {
    assert.strictEqual(hasMeaningfulDifference("Dreamdale ist ein Festival.", "Dreamdale ist eine fiktive Stadt."), true);
  });
  it("returns false for exact duplicates", () => {
    assert.strictEqual(hasMeaningfulDifference("User prefers concise answers.", "User prefers concise answers."), false);
  });
  it("returns false for safe paraphrases", () => {
    assert.strictEqual(hasMeaningfulDifference("User prefers concise answers.", "The user prefers concise answers."), false);
  });
  it("returns false for equivalent tech synonyms", () => {
    assert.strictEqual(hasMeaningfulDifference("Projekt Alpha nutzt Node 20.", "Projekt Alpha nutzt Node.js 20."), false);
  });
  it("detects negation differences", () => {
    assert.strictEqual(hasMeaningfulDifference("User mag React.", "User mag React nicht mehr."), true);
  });
  it("detects temporal/status differences", () => {
    assert.strictEqual(hasMeaningfulDifference("Wir nutzen Postgres.", "Früher nutzten wir Postgres."), true);
  });
  it("returns false for single-word variants of otherwise identical facts", () => {
    assert.strictEqual(
      hasMeaningfulDifference("Projekt Alpha nutzt den Auth-Service intern.", "Projekt Alpha nutzt den Auth-Service extern."),
      false
    );
  });
});

describe("isSafeDuplicate", () => {
  it("accepts exact duplicates", () => {
    assert.strictEqual(isSafeDuplicate("User prefers concise answers.", "User prefers concise answers."), true);
  });
  it("accepts safe paraphrases", () => {
    assert.strictEqual(isSafeDuplicate("User prefers concise answers.", "The user prefers concise answers."), true);
  });
  it("rejects different technologies", () => {
    assert.strictEqual(isSafeDuplicate("User mag React.", "User mag Vue."), false);
  });
  it("rejects different databases", () => {
    assert.strictEqual(isSafeDuplicate("Wir nutzen Postgres.", "Wir nutzen MySQL."), false);
  });
  it("rejects different project names", () => {
    assert.strictEqual(
      isSafeDuplicate("Projekt Alpha nutzt den Auth-Service.", "Projekt Beta nutzt den Auth-Service."),
      false
    );
  });
  it("rejects different versions", () => {
    assert.strictEqual(isSafeDuplicate("Deployment läuft auf Node 20.", "Deployment läuft auf Node 22."), false);
  });
  it("rejects complementary phrases that should be merged", () => {
    assert.strictEqual(
      isSafeDuplicate("Original fact about cats", "Additional cat fact"),
      false
    );
  });
  it("accepts canonicalised tech synonyms", () => {
    assert.strictEqual(isSafeDuplicate("Wir nutzen Postgres.", "Wir nutzen PostgreSQL."), true);
  });
});

describe("validateMergedTextPreservesFacts", () => {
  it("passes when merged text preserves both facts", () => {
    assert.strictEqual(
      validateMergedTextPreservesFacts(
        "User prefers concise answers.",
        "The user prefers concise answers.",
        "User prefers concise answers."
      ),
      true
    );
  });
  it("fails when merged text drops a technology", () => {
    assert.strictEqual(
      validateMergedTextPreservesFacts(
        "Projekt Alpha nutzt Node 20.",
        "Projekt Alpha nutzt Node.js 20.",
        "Projekt Alpha nutzt eine Runtime."
      ),
      false
    );
  });
  it("fails when merged text drops a number", () => {
    assert.strictEqual(
      validateMergedTextPreservesFacts(
        "Deployment läuft auf Node 20.",
        "Deployment läuft auf Node 22.",
        "Deployment läuft auf Node."
      ),
      false
    );
  });
  it("fails when merged text drops an entity", () => {
    assert.strictEqual(
      validateMergedTextPreservesFacts(
        "Dreamdale ist ein Festival.",
        "Dreamdale ist eine fiktive Stadt.",
        "Dreamdale ist etwas."
      ),
      false
    );
  });
  it("accepts singular/plural variants", () => {
    assert.strictEqual(
      validateMergedTextPreservesFacts(
        "Original fact about cats",
        "Another cat fact",
        "Original fact about cats and another cat fact"
      ),
      true
    );
  });
});

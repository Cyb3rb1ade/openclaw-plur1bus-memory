/**
 * tests/filter-parser.test.js
 *
 * TDD for /memory filter expression parsing with intuitive aliases,
 * synonym normalization, and helpful error messages.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { parseFilters, buildWhereClause, normalizeFilterValue, validateFilter } from "../lib/filter-parser.js";

describe("parseFilters", () => {
  it("returns empty filters for plain topic", () => {
    const result = parseFilters("Eva");
    assert.deepStrictEqual(result.topic, "Eva");
    assert.deepStrictEqual(result.filters, {});
  });

  // ── Neue Alias-Syntax ──
  it("parses über: / about: / cat: as category (passes through unchanged)", () => {
    assert.strictEqual(parseFilters("Eva über:person").filters.category, "person");
    assert.strictEqual(parseFilters("Eva about:people").filters.category, "people");
    assert.strictEqual(parseFilters("Eva cat:project").filters.category, "project");
  });

  it("parses aus: / source: / src: as source", () => {
    assert.strictEqual(parseFilters("Bug aus:github").filters.source, "github");
    assert.strictEqual(parseFilters("Bug source:github").filters.source, "github");
    assert.strictEqual(parseFilters("Bug src:github").filters.source, "github");
  });

  it("parses wichtig: / min: / important: as minImportance", () => {
    assert.strictEqual(parseFilters("Projekt wichtig:0.7").filters.minimportance, 0.7);
    assert.strictEqual(parseFilters("Projekt min:0.7").filters.minimportance, 0.7);
    assert.strictEqual(parseFilters("Projekt important:0.7").filters.minimportance, 0.7);
  });

  it("parses seit: / after: / von: as from date", () => {
    assert.strictEqual(parseFilters("Meeting seit:2026-01-01").filters.from, "2026-01-01");
    assert.strictEqual(parseFilters("Meeting after:2026-01-01").filters.from, "2026-01-01");
    assert.strictEqual(parseFilters("Meeting von:2026-01-01").filters.from, "2026-01-01");
  });

  it("parses bis: / before: / to: as to date", () => {
    assert.strictEqual(parseFilters("Meeting bis:2026-03-31").filters.to, "2026-03-31");
    assert.strictEqual(parseFilters("Meeting before:2026-03-31").filters.to, "2026-03-31");
    assert.strictEqual(parseFilters("Meeting to:2026-03-31").filters.to, "2026-03-31");
  });

  it("parses gefühl: / emotion: / mood: as emotion", () => {
    assert.strictEqual(parseFilters("Erfolg gefühl:joy").filters.emotion, "joy");
    assert.strictEqual(parseFilters("Erfolg emotion:joy").filters.emotion, "joy");
    assert.strictEqual(parseFilters("Erfolg mood:joy").filters.emotion, "joy");
  });

  // ── Alte Syntax rückwärtskompatibel ──
  it("remains backward compatible with old key:value syntax", () => {
    assert.strictEqual(parseFilters("Eva category:person").filters.category, "person");
    assert.strictEqual(parseFilters("Bug origin:github").filters.origin, "github");
    assert.strictEqual(parseFilters("Bug source:github").filters.source, "github");
    assert.strictEqual(parseFilters("Projekt minImportance:0.5").filters.minimportance, 0.5);
  });

  // ── from: Ambiguität ausgeschlossen ──
  it("rejects ambiguous from: as unknown filter", () => {
    const result = parseFilters("Eva from:2026-01-01");
    assert.strictEqual(result.filters.from, undefined);
    assert.ok(result.errors);
    assert.ok(result.errors.some(e => e.includes("from")));
  });

  it("leaves from: in topic when ambiguous", () => {
    const result = parseFilters("foo from:bar");
    assert.strictEqual(result.topic, "foo from:bar");
    assert.deepStrictEqual(result.filters, {});
    assert.ok(result.errors);
    assert.ok(result.errors.some(e => e.includes("from")));
  });

  // ── Multiple filters ──
  it("parses multiple filters", () => {
    const result = parseFilters("Eva über:person aus:github wichtig:0.5");
    assert.strictEqual(result.topic, "Eva");
    assert.strictEqual(result.filters.category, "person");
    assert.strictEqual(result.filters.source, "github");
    assert.strictEqual(result.filters.minimportance, 0.5);
  });

  // ── Invalid filter key ──
  it("stops parsing when an invalid filter key is encountered", () => {
    const result = parseFilters("Eva invalid:whatever über:person");
    assert.strictEqual(result.topic, "Eva invalid:whatever");
    assert.strictEqual(result.filters.category, "person");
  });

  it("handles topic with spaces and filters", () => {
    const result = parseFilters("Projekt Alpha über:project wichtig:0.8");
    assert.strictEqual(result.topic, "Projekt Alpha");
    assert.strictEqual(result.filters.category, "project");
  });

  it("handles empty input", () => {
    const result = parseFilters("");
    assert.strictEqual(result.topic, "");
    assert.deepStrictEqual(result.filters, {});
  });

  it("passes unknown source value through unchanged", () => {
    const result = parseFilters("Bug aus:unknownsource");
    assert.strictEqual(result.errors, undefined);
    assert.strictEqual(result.filters.source, "unknownsource");
  });
});

describe("normalizeFilterValue", () => {
  it("passes category values through unchanged (DB allows arbitrary values)", () => {
    assert.strictEqual(normalizeFilterValue("category", "person"), "person");
    assert.strictEqual(normalizeFilterValue("category", "people"), "people");
    assert.strictEqual(normalizeFilterValue("category", "project"), "project");
    assert.strictEqual(normalizeFilterValue("category", "decision"), "decision");
    assert.strictEqual(normalizeFilterValue("category", "fact"), "fact");
    assert.strictEqual(normalizeFilterValue("category", "general"), "general");
    assert.strictEqual(normalizeFilterValue("category", "work"), "work");
  });

  it("normalizes source synonyms", () => {
    assert.strictEqual(normalizeFilterValue("source", "github"), "github");
    assert.strictEqual(normalizeFilterValue("source", "git"), "github");
    assert.strictEqual(normalizeFilterValue("source", "dm"), "dm");
    assert.strictEqual(normalizeFilterValue("source", "chat"), "dm");
    assert.strictEqual(normalizeFilterValue("source", "konversation"), "dm");
    assert.strictEqual(normalizeFilterValue("source", "conversation"), "dm");
    assert.strictEqual(normalizeFilterValue("source", "group"), "group");
    assert.strictEqual(normalizeFilterValue("source", "gruppe"), "group");
    assert.strictEqual(normalizeFilterValue("source", "voice"), "voice");
    assert.strictEqual(normalizeFilterValue("source", "sprachnotiz"), "voice");
    assert.strictEqual(normalizeFilterValue("source", "note"), "note");
    assert.strictEqual(normalizeFilterValue("source", "notiz"), "note");
  });

  it("passes through unknown values unchanged", () => {
    assert.strictEqual(normalizeFilterValue("category", "foobar"), "foobar");
    assert.strictEqual(normalizeFilterValue("source", "unknown"), "unknown");
  });
});

describe("validateFilter", () => {
  it("returns null for valid filters", () => {
    assert.strictEqual(validateFilter("category", "person"), null);
    assert.strictEqual(validateFilter("source", "github"), null);
    assert.strictEqual(validateFilter("minimportance", 0.7), null);
    assert.strictEqual(validateFilter("from", "2026-01-01"), null);
    assert.strictEqual(validateFilter("to", "2026-03-31"), null);
    assert.strictEqual(validateFilter("emotion", "joy"), null);
  });

  it("returns error for invalid minImportance", () => {
    const err = validateFilter("minimportance", 1.5);
    assert.ok(err);
    assert.ok(err.includes("0.0") || err.includes("1.0"));
  });

  it("returns error for invalid date", () => {
    const err = validateFilter("from", "2026-13-01");
    assert.ok(err);
    assert.ok(err.includes("YYYY-MM-DD"));
  });

  it("returns error for badly formatted date", () => {
    const err = validateFilter("from", "tomorrow");
    assert.ok(err);
  });
});

describe("buildWhereClause", () => {
  it("returns null for empty filters", () => {
    assert.strictEqual(buildWhereClause({}), null);
  });

  it("builds category clause", () => {
    const clause = buildWhereClause({ category: "person" });
    assert.strictEqual(clause, "category = 'person'");
  });

  it("builds origin clause", () => {
    const clause = buildWhereClause({ origin: "voice" });
    assert.strictEqual(clause, "origin = 'voice'");
  });

  it("builds minImportance clause (maps to memoryStrength)", () => {
    const clause = buildWhereClause({ minimportance: 0.7 });
    assert.strictEqual(clause, "memoryStrength >= 0.7");
  });

  it("builds from date clause", () => {
    const clause = buildWhereClause({ from: "2026-01-01" });
    assert.strictEqual(clause, "createdAt >= 1767225600000");
  });

  it("builds to date clause", () => {
    const clause = buildWhereClause({ to: "2026-03-31" });
    assert.strictEqual(clause, "createdAt <= 1775001599999");
  });

  it("builds emotion clause (maps to emotionalDominant)", () => {
    const clause = buildWhereClause({ emotion: "joy" });
    assert.strictEqual(clause, "emotionalDominant = 'joy'");
  });

  it("builds combined clause with AND", () => {
    const clause = buildWhereClause({ category: "person", minimportance: 0.5 });
    assert.ok(clause.includes("category = 'person'"));
    assert.ok(clause.includes("memoryStrength >= 0.5"));
    assert.ok(clause.includes(" AND "));
  });

  it("sanitizes string values to prevent injection", () => {
    const clause = buildWhereClause({ category: "person' OR '1'='1" });
    assert.ok(clause.includes("\\'"));
    assert.ok(!clause.includes("= 'person' OR '"));
  });
});

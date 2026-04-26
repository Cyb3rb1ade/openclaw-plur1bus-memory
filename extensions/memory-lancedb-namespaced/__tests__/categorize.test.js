/**
 * Tests für lib/categorize.js — Auto-Kategorisierung Heuristik.
 * Run: node --test __tests__/categorize.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MEMORY_CATEGORIES, MEMORY_ORIGINS, MEMORY_SCOPES, categorizeMemory } from "../lib/categorize.js";

test("MEMORY_CATEGORIES enthält alle 11", () => {
  assert.equal(MEMORY_CATEGORIES.length, 11);
  for (const c of ["preference", "fact", "decision", "entity", "reference",
                   "debug", "config", "conversation", "knowledge", "curated", "other"]) {
    assert.ok(MEMORY_CATEGORIES.includes(c), `missing category: ${c}`);
  }
});

test("MEMORY_ORIGINS hat 4 Werte", () => {
  assert.deepEqual(MEMORY_ORIGINS, ["dm", "group", "cron", "internal"]);
});

test("MEMORY_SCOPES hat 3 Werte", () => {
  assert.deepEqual(MEMORY_SCOPES, ["agent-private", "workspace", "user"]);
});

test("categorizeMemory: preference (englisch)", () => {
  assert.equal(categorizeMemory("User prefers short answers"), "preference");
  assert.equal(categorizeMemory("I like Kaffee"), "preference");
});

test("categorizeMemory: preference (deutsch)", () => {
  assert.equal(categorizeMemory("der Nutzer bevorzugt kurze Antworten"), "preference");
  assert.equal(categorizeMemory("Ich mag das"), "preference");
});

test("categorizeMemory: decision", () => {
  assert.equal(categorizeMemory("We decided to use PostgreSQL"), "decision");
  assert.equal(categorizeMemory("Wir nehmen Redis als Cache"), "decision");
});

test("categorizeMemory: debug", () => {
  assert.equal(categorizeMemory("Stack trace: TypeError at line 42"), "debug");
  assert.equal(categorizeMemory("Failed to reproduce the issue"), "debug");
});

test("categorizeMemory: config", () => {
  assert.equal(categorizeMemory("Set threshold to 0.95 in config"), "config");
});

test("categorizeMemory: reference", () => {
  assert.equal(categorizeMemory("https://github.com/example/repo"), "reference");
  assert.equal(categorizeMemory("Siehe url im Browser"), "reference");
});

test("categorizeMemory: entity", () => {
  assert.equal(categorizeMemory("name: der Nutzer Mueller"), "entity");
  assert.equal(categorizeMemory("company: Acme Inc"), "entity");
});

test("categorizeMemory: fact (Datum / sein-Verb)", () => {
  assert.equal(categorizeMemory("Server is running on port 8080"), "fact");
  assert.equal(categorizeMemory("Founded in 2024"), "fact");
});

test("categorizeMemory: default 'conversation'", () => {
  assert.equal(categorizeMemory("Hallo, wie geht's?"), "conversation");
  assert.equal(categorizeMemory("ok danke"), "conversation");
});

test("categorizeMemory: alle returns sind in MEMORY_CATEGORIES", () => {
  const samples = [
    "I prefer Kaffee",
    "We decided X",
    "Stack trace error",
    "Set config option",
    "https://link",
    "name: Bob",
    "Server is up",
    "Random text",
  ];
  for (const t of samples) {
    const cat = categorizeMemory(t);
    assert.ok(MEMORY_CATEGORIES.includes(cat), `'${cat}' not in MEMORY_CATEGORIES (text: ${t})`);
  }
});

/**
 * Unit tests for normaliseTrigger and hasTrigger.
 * Uses Node's built-in test runner (node:test + node:assert).
 *
 * Run: node --test tests/trigger.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Register mock loader for discord.js and related packages so that importing
// discord-voice-stt.mjs does not attempt a real Discord login (process.exit).
register(
  new URL("./helpers/discord-mock-loader.mjs", import.meta.url).href,
  pathToFileURL("./")
);

process.env.DISCORD_TOKEN = "test-token";

const { normaliseTrigger, hasTrigger } = await import("../discord-voice-stt.mjs");

// ── normaliseTrigger ─────────────────────────────────────────────────────────

describe("normaliseTrigger", () => {
  test("strips punctuation: 'Bernd!' → 'bernd'", () => {
    assert.equal(normaliseTrigger("Bernd!"), "bernd");
  });

  test("lowercases: 'BERND' → 'bernd'", () => {
    assert.equal(normaliseTrigger("BERND"), "bernd");
  });

  test("collapses whitespace: 'hey  bernd' → 'hey bernd'", () => {
    assert.equal(normaliseTrigger("hey  bernd"), "hey bernd");
  });

  test("trims leading/trailing whitespace: '  bernd  ' → 'bernd'", () => {
    assert.equal(normaliseTrigger("  bernd  "), "bernd");
  });

  test("strips multiple punctuation chars: 'Bernd, wie geht es?' → 'bernd wie geht es'", () => {
    assert.equal(normaliseTrigger("Bernd, wie geht es?"), "bernd wie geht es");
  });

  test("preserves umlauts: 'Schönes Wetter' → 'schönes wetter'", () => {
    assert.equal(normaliseTrigger("Schönes Wetter"), "schönes wetter");
  });

  test("empty string → ''", () => {
    assert.equal(normaliseTrigger(""), "");
  });
});

// ── hasTrigger — true cases ──────────────────────────────────────────────────

describe("hasTrigger — must return true", () => {
  test("'hey bernd wie geht es'", () => {
    assert.equal(hasTrigger("hey bernd wie geht es"), true);
  });

  test("'bernd' alone", () => {
    assert.equal(hasTrigger("bernd"), true);
  });

  test("'BERND!' — uppercase with punctuation", () => {
    assert.equal(hasTrigger("BERND!"), true);
  });

  test("'hey Bernd, Frage:' — mixed case with comma", () => {
    assert.equal(hasTrigger("hey Bernd, Frage:"), true);
  });

  test("'Bernd?' — question mark", () => {
    assert.equal(hasTrigger("Bernd?"), true);
  });
});

// ── hasTrigger — false cases ─────────────────────────────────────────────────

describe("hasTrigger — must return false", () => {
  test("'aberberndt' — no word boundary, 'bernd' is substring but word is different", () => {
    assert.equal(hasTrigger("aberberndt"), false);
  });

  test("'Oberberndt' — no word boundary", () => {
    assert.equal(hasTrigger("Oberberndt"), false);
  });

  test("'Herbert' — different word entirely", () => {
    assert.equal(hasTrigger("Herbert"), false);
  });

  test("'Berndt' — different word (extra 't')", () => {
    assert.equal(hasTrigger("Berndt"), false);
  });

  test("'abernds' — no match", () => {
    assert.equal(hasTrigger("abernds"), false);
  });

  test("'' — empty string", () => {
    assert.equal(hasTrigger(""), false);
  });

  test("'aberberndt' embedded check — 'bernd' as substring does not trigger", () => {
    // Explicit: "bernd" is a substring of "aberberndt" but no word boundary
    const text = "aberberndt";
    assert.ok(text.includes("bernd"), "precondition: 'bernd' IS a substring");
    assert.equal(hasTrigger(text), false);
  });
});

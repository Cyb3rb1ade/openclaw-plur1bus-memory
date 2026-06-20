/**
 * Unit tests for splitIntoTtsChunks.
 * Uses Node's built-in test runner (node:test + node:assert).
 *
 * Run: node --test tests/chunker.test.mjs
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

const { splitIntoTtsChunks } = await import("../discord-voice-stt.mjs");

// ── Basic cases ──────────────────────────────────────────────────────────────

describe("splitIntoTtsChunks — basic cases", () => {
  test("short text ≤ 400 chars → single chunk", () => {
    const text = "Hallo Welt!";
    const chunks = splitIntoTtsChunks(text);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], text);
  });

  test("empty string → [] or [''] — does not throw, consistent", () => {
    const chunks = splitIntoTtsChunks("");
    assert.ok(Array.isArray(chunks));
    // Either [] or [''] — both are valid; just verify no throw and consistency
    assert.ok(chunks.length === 0 || (chunks.length === 1 && chunks[0] === ""));
  });

  test("single compound sentence 'Hallo! Wie geht es dir?' → sensible chunks", () => {
    const text = "Hallo! Wie geht es dir?";
    const chunks = splitIntoTtsChunks(text);
    assert.ok(chunks.length >= 1);
    // All chunks non-empty
    for (const c of chunks) assert.ok(c.length > 0);
    // No data loss
    assert.equal(chunks.join(" "), text);
  });

  test("text ending without punctuation is returned", () => {
    const text = "Dies ist ein Test ohne Satzzeichen am Ende";
    const chunks = splitIntoTtsChunks(text);
    assert.ok(chunks.length >= 1);
    // Content is preserved
    const joined = chunks.join(" ");
    assert.ok(joined.includes("Test"), "content preserved");
  });
});

// ── Sentence boundary splits ──────────────────────────────────────────────────

describe("splitIntoTtsChunks — sentence boundaries", () => {
  test("multiple sentences, total > maxChars → each sentence is own chunk", () => {
    // Use maxChars=30 so each ~23-char sentence fits individually but combined (~72) does not
    const s1 = "Das ist der erste Satz.";
    const s2 = "Das ist der zweite Satz.";
    const s3 = "Das ist der dritte Satz.";
    const text = `${s1} ${s2} ${s3}`;
    const chunks = splitIntoTtsChunks(text, 30);
    assert.equal(chunks.length, 3, `expected 3 chunks but got ${chunks.length}: ${JSON.stringify(chunks)}`);
    assert.equal(chunks[0], s1);
    assert.equal(chunks[1], s2);
    assert.equal(chunks[2], s3);
  });

  test("no characters lost across sentence splits", () => {
    const text = "Erster Satz. Zweiter Satz! Dritter Satz?";
    const chunks = splitIntoTtsChunks(text);
    // join with space because splitter splits on whitespace after punctuation
    const joined = chunks.join(" ");
    // Every piece of text must appear
    for (const c of chunks) assert.ok(c.length > 0);
    assert.ok(joined.includes("Erster"));
    assert.ok(joined.includes("Zweiter"));
    assert.ok(joined.includes("Dritter"));
  });
});

// ── Clause splits ─────────────────────────────────────────────────────────────

describe("splitIntoTtsChunks — clause splits (when sentence > 400)", () => {
  test("500-char string with comma near middle → splits at comma boundary", () => {
    // Build a string that's > 400 chars with no sentence-ending punctuation
    // but has a comma near the middle
    const part1 = "a".repeat(200) + ",";
    const part2 = " " + "b".repeat(250);
    const text = part1 + part2;
    assert.equal(text.length, 452); // > 400

    const chunks = splitIntoTtsChunks(text);
    assert.ok(chunks.length >= 2, `expected ≥2 chunks but got ${chunks.length}`);

    // No chunk exceeds 400
    for (const c of chunks) {
      assert.ok(c.length <= 400, `chunk "${c.slice(0, 30)}…" length ${c.length} > 400`);
    }

    // No data loss
    assert.equal(chunks.join(" "), text.trim());
  });
});

// ── Word boundary splits ──────────────────────────────────────────────────────

describe("splitIntoTtsChunks — word boundary splits", () => {
  test("500-char multi-word string → no chunk exceeds 400, no data lost", () => {
    // 50 words of 10 chars each → 50 * 10 + 49 spaces = 549 chars
    const word = "abcdefghij"; // 10 chars
    const text = Array(50).fill(word).join(" ");
    assert.ok(text.length > 400);

    const chunks = splitIntoTtsChunks(text);
    assert.ok(chunks.length >= 2);

    for (const c of chunks) {
      assert.ok(c.length <= 400, `chunk length ${c.length} > 400`);
    }

    // No data lost: all words must appear
    const joined = chunks.join(" ");
    assert.equal(joined, text);
  });
});

// ── Hard splits (no whitespace) ───────────────────────────────────────────────

describe("splitIntoTtsChunks — hard splits (no whitespace)", () => {
  test("'A'.repeat(800) with maxChars=400 → exactly two 400-char chunks", () => {
    const text = "A".repeat(800);
    const chunks = splitIntoTtsChunks(text, 400);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], "A".repeat(400));
    assert.equal(chunks[1], "A".repeat(400));
  });

  test("'A'.repeat(801) with maxChars=400 → ['A'×400, 'A'×400, 'A']", () => {
    const text = "A".repeat(801);
    const chunks = splitIntoTtsChunks(text, 400);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0], "A".repeat(400));
    assert.equal(chunks[1], "A".repeat(400));
    assert.equal(chunks[2], "A");
  });

  test("no characters lost on hard split: chunks.join('') === original", () => {
    const text = "A".repeat(800);
    const chunks = splitIntoTtsChunks(text, 400);
    assert.equal(chunks.join(""), text);
  });

  test("no characters lost on 801-char hard split", () => {
    const text = "A".repeat(801);
    const chunks = splitIntoTtsChunks(text, 400);
    assert.equal(chunks.join(""), text);
  });
});

// ── Max char guarantee ────────────────────────────────────────────────────────

describe("splitIntoTtsChunks — max char guarantee", () => {
  test("every chunk length ≤ maxChars for long mixed text", () => {
    const text =
      "Das ist ein sehr langer Text. " +
      "Er enthält mehrere Sätze und auch, sehr lange Satzteile mit Kommas! " +
      "Außerdem gibt es Wörter die ohne Leerzeichen sind: " +
      "a".repeat(500);
    const maxChars = 400;
    const chunks = splitIntoTtsChunks(text, maxChars);
    for (const c of chunks) {
      assert.ok(
        c.length <= maxChars,
        `chunk of length ${c.length} exceeds maxChars=${maxChars}: "${c.slice(0, 30)}…"`
      );
    }
  });

  test("every chunk length ≤ custom maxChars=100", () => {
    const text = "Das ist Satz eins. Das ist Satz zwei. Und hier kommt Satz drei, mit Komma.";
    const maxChars = 100;
    const chunks = splitIntoTtsChunks(text, maxChars);
    for (const c of chunks) {
      assert.ok(c.length <= maxChars, `chunk length ${c.length} > 100`);
    }
  });
});

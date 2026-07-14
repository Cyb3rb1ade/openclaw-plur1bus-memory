import { test } from "node:test";
import assert from "node:assert/strict";
import { formatContradictionDisclosure } from "../lib/contradiction-disclosure.js";

const makeMemory = (text, description, updatedAt) => ({ text, description, updatedAt });

test("empty pairs → null", () => {
  assert.equal(formatContradictionDisclosure([]), null);
});

test("opts.enabled=false → null", () => {
  const pairs = [{ winner: makeMemory("w", null), loser: makeMemory("l", null) }];
  assert.equal(formatContradictionDisclosure(pairs, { enabled: false }), null);
});

test("single pair → German template", () => {
  const winner = makeMemory("Ich mag Katzen", null);
  const loser = makeMemory("Ich mag Hunde", null);
  const result = formatContradictionDisclosure([{ winner, loser }]);
  assert.ok(result.includes("widersprüchliche Erinnerungen"));
  assert.ok(result.includes("Ich mag Hunde"));
  assert.ok(result.includes("Ich mag Katzen"));
  assert.ok(result.includes("(älter)"));
  assert.ok(result.includes("(neuer)"));
});

test("uses description over text", () => {
  const winner = makeMemory("text-w", "desc-w");
  const loser = makeMemory("text-l", "desc-l");
  const result = formatContradictionDisclosure([{ winner, loser }]);
  assert.ok(result.includes("desc-w"));
  assert.ok(result.includes("desc-l"));
  assert.ok(!result.includes("text-w"));
});

test("truncation at 120 chars appends …", () => {
  const long = "x".repeat(200);
  const winner = makeMemory(long, null);
  const loser = makeMemory(long, null);
  const result = formatContradictionDisclosure([{ winner, loser }]);
  // Each truncated to 120 chars + …
  const truncated = "x".repeat(120) + "…";
  assert.ok(result.includes(truncated));
});

test("only first pair used when multiple pairs given", () => {
  const pairs = [
    { winner: makeMemory("first-winner"), loser: makeMemory("first-loser") },
    { winner: makeMemory("second-winner"), loser: makeMemory("second-loser") },
  ];
  const result = formatContradictionDisclosure(pairs);
  assert.ok(result.includes("first-winner"));
  assert.ok(!result.includes("second-winner"));
});

test("total output ≤ 400 chars", () => {
  const long = "a".repeat(200);
  const winner = makeMemory(long, null);
  const loser = makeMemory(long, null);
  const result = formatContradictionDisclosure([{ winner, loser }]);
  assert.ok(result.length <= 400);
});

test("malformed input (null pair fields) → null (fail-open)", () => {
  const result = formatContradictionDisclosure([{ winner: null, loser: null }]);
  // Should not throw; returns string with empty texts or null
  assert.ok(result === null || typeof result === "string");
});

test("null pairs argument → null", () => {
  assert.equal(formatContradictionDisclosure(null), null);
});

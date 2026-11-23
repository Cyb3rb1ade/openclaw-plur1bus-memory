// tests/relevant-memory-context-relative-time.test.js
// Fixed RELATIVE TIME instruction in the <relevant-memories> block: relative
// time words inside a record refer to its created-at, not to today.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";

const NOW_MS = Date.parse("2026-06-17T01:00:00.000Z");
const PREAMBLE = "Recall safety: facts are memory-derived, may be stale, verify before acting.";

function memory(overrides = {}) {
  return {
    id: "m1",
    category: "fact",
    source: "dm",
    display: "Caroline: I went to the LGBTQ support group yesterday.",
    memoryStrength: 1.0,
    createdAt: "2023-05-08T13:56:00.000Z",
    ...overrides,
  };
}

function relativeTimeLines(out) {
  return out.split("\n").filter((line) => line.startsWith("RELATIVE TIME:"));
}

describe("formatRelevantMemoriesContext — RELATIVE TIME instruction", () => {
  it("is present for a plain record without faded/uncertain/truncated markers", () => {
    const out = formatRelevantMemoriesContext([memory()], { now: NOW_MS });
    assert.ok(!out.includes("DEGRADED RECALL"));
    assert.ok(!out.includes("UNCERTAIN RECALL"));
    assert.ok(!out.includes("TRUNCATED RECALL"));
    assert.equal(relativeTimeLines(out).length, 1, `expected one RELATIVE TIME line in: ${out}`);
  });

  it("is one line naming created-at, the en/de examples, without forcing years into replies", () => {
    const [line] = relativeTimeLines(formatRelevantMemoriesContext([memory()], { now: NOW_MS }));
    assert.ok(line.includes("created-at"), line);
    assert.ok(line.includes("not to today"), line);
    for (const word of ["yesterday", "last week", "next month", "gestern", "letzte Woche"]) {
      assert.ok(line.includes(`"${word}"`), `missing example ${word}: ${line}`);
    }
    assert.doesNotMatch(line, /include the year/, "live replies keep their own date style");
    assert.doesNotMatch(line, /approximat|roughly|about|ungefähr|circa/i, "no approximation clause");
  });

  it("the attribute it names is the one records actually carry", () => {
    const out = formatRelevantMemoriesContext([memory()], { now: NOW_MS });
    assert.ok(out.includes('created-at="2023-05-08T13:56:00.000Z"'), out);
  });

  it("sits directly after the safety preamble and before DEGRADED/UNCERTAIN and the first record", () => {
    const out = formatRelevantMemoriesContext([
      memory({ id: "m1", memoryStrength: 0.1 }),
      memory({ id: "m2", recallUncertain: true }),
    ], { now: NOW_MS });
    const lines = out.split("\n");
    const preambleIdx = lines.indexOf(PREAMBLE);
    assert.ok(preambleIdx > 0, out);
    assert.ok(lines[preambleIdx + 1].startsWith("RELATIVE TIME:"), out);
    const timePos = out.indexOf("RELATIVE TIME:");
    assert.ok(timePos < out.indexOf("DEGRADED RECALL"), "before DEGRADED RECALL");
    assert.ok(timePos < out.indexOf("UNCERTAIN RECALL"), "before UNCERTAIN RECALL");
    assert.ok(timePos < out.indexOf("<memory-record"), "before the first memory-record");
  });

  it("appears once even when semantic-lens records are appended", () => {
    const out = formatRelevantMemoriesContext([memory()], {
      now: NOW_MS,
      semanticLensMemories: [memory({ id: "lens-1" })],
    });
    assert.ok(out.includes("<memory-semantic-lens>"), out);
    assert.equal(out.split("RELATIVE TIME:").length - 1, 1, out);
  });

  it("adds nothing when there are no memories", () => {
    assert.equal(formatRelevantMemoriesContext([], { now: NOW_MS }), "");
    assert.equal(formatRelevantMemoriesContext(null, { now: NOW_MS }), "");
  });
});

// tests/relevant-memory-context-temporal.test.js
// P5 Temporal Provenance + Operational Action Guard — context rendering tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";

const NOW_ISO = "2026-06-17T01:00:00.000Z";
const NOW_MS = new Date(NOW_ISO).getTime();

function baseMemory(overrides = {}) {
  return {
    id: overrides.id ?? "m1",
    category: overrides.category ?? "fact",
    source: overrides.source ?? "dm",
    display: overrides.display ?? "memory display",
    memoryStrength: overrides.memoryStrength ?? 1.0,
    createdAt: overrides.createdAt === undefined ? NOW_ISO : overrides.createdAt,
    updatedAt: overrides.updatedAt === undefined ? null : overrides.updatedAt,
    lastRetrievedAt: overrides.lastRetrievedAt === undefined ? null : overrides.lastRetrievedAt,
  };
}

describe("formatRelevantMemoriesContext — temporal provenance", () => {
  it("renders age/freshness attributes when timestamps are present", () => {
    const out = formatRelevantMemoriesContext([
      baseMemory({ id: "m1", display: "Project fact", createdAt: "2026-06-17T00:00:00.000Z" }),
    ], { now: NOW_MS });
    assert.ok(out.includes('age="1h ago"'), `expected age attribute in: ${out}`);
    assert.ok(out.includes('freshness="recent"'), `expected freshness attribute in: ${out}`);
    assert.ok(out.includes('created-at="2026-06-17T00:00:00.000Z"'), `expected created-at attribute in: ${out}`);
  });

  it("renders requires-live-verification for stale operational memory", () => {
    const out = formatRelevantMemoriesContext([
      baseMemory({ id: "m1", display: "Cronjob may produce duplicates", createdAt: "2026-06-16T12:00:00.000Z" }),
    ], { now: NOW_MS });
    assert.ok(out.includes('operational="true"'), `expected operational attribute in: ${out}`);
    assert.ok(out.includes('operational-risk="high"'), `expected operational-risk attribute in: ${out}`);
    assert.ok(out.includes('requires-live-verification="true"'), `expected requires-live-verification attribute in: ${out}`);
    assert.ok(out.includes('freshness="stale"'), `expected stale freshness in: ${out}`);
  });

  it("renders operational warning block for stale operational memory", () => {
    const out = formatRelevantMemoriesContext([
      baseMemory({ id: "m1", display: "Cronjob may produce duplicates", createdAt: "2026-06-16T12:00:00.000Z" }),
    ], { now: NOW_MS });
    assert.ok(out.includes("<operational-memory-warning>"), "expected operational warning block");
    assert.ok(out.includes("Do not disable cronjobs"), "expected disable cronjob warning");
    assert.ok(out.includes("stop services"), "expected stop service warning");
    assert.ok(out.includes("delete files"), "expected delete file warning");
    assert.ok(out.includes("Live verification is required first"), "expected live verification instruction");
    // Warning must be inside <relevant-memories> and before the memory-record.
    const warningPos = out.indexOf("<operational-memory-warning>");
    const recordPos = out.indexOf("<memory-record");
    assert.ok(warningPos < recordPos, "warning must appear before memory-record");
    const closeBlockPos = out.indexOf("</relevant-memories>");
    assert.ok(warningPos < closeBlockPos, "warning must be inside relevant-memories");
  });

  it("renders unknown freshness and warning when operational timestamp is missing", () => {
    const out = formatRelevantMemoriesContext([
      baseMemory({ id: "m1", display: "Cronjob may produce duplicates", createdAt: null }),
    ], { now: NOW_MS });
    assert.ok(out.includes('freshness="unknown"'), `expected unknown freshness in: ${out}`);
    assert.ok(out.includes('requires-live-verification="true"'), "expected live verification for unknown age operational");
    assert.ok(out.includes("<operational-memory-warning>"), "expected warning for unknown age operational");
  });

  it("does not render operational warning for fresh operational memory", () => {
    const out = formatRelevantMemoriesContext([
      baseMemory({ id: "m1", display: "Cronjob may produce duplicates", createdAt: "2026-06-17T00:55:00.000Z" }),
    ], { now: NOW_MS });
    assert.ok(out.includes('operational="true"'), "expected operational attribute");
    assert.ok(out.includes('freshness="fresh"'), "expected fresh freshness");
    assert.ok(!out.includes("<operational-memory-warning>"), "no warning for fresh operational memory");
    assert.ok(!out.includes('requires-live-verification="true"'), "no live-verification requirement for fresh operational");
  });

  it("does not render operational warning for non-operational memory even when stale", () => {
    const out = formatRelevantMemoriesContext([
      baseMemory({ id: "m1", display: "User prefers concise answers", createdAt: "2026-06-16T12:00:00.000Z" }),
    ], { now: NOW_MS });
    assert.ok(!out.includes('operational="true"'), "non-operational memory should not have operational attribute");
    assert.ok(!out.includes("<operational-memory-warning>"), "no warning for non-operational memory");
    assert.ok(!out.includes('requires-live-verification="true"'), "no live-verification for non-operational memory");
  });

  it("does not render operational warning when no memories are operational", () => {
    const out = formatRelevantMemoriesContext([
      baseMemory({ id: "m1", display: "User prefers concise answers", createdAt: "2026-06-16T12:00:00.000Z" }),
      baseMemory({ id: "m2", display: "Project uses Node 22", createdAt: "2026-06-16T10:00:00.000Z" }),
    ], { now: NOW_MS });
    assert.ok(!out.includes("<operational-memory-warning>"), "no warning when no operational memories");
  });

  it("renders warning only once even with multiple stale operational memories", () => {
    const out = formatRelevantMemoriesContext([
      baseMemory({ id: "m1", display: "Cronjob may produce duplicates", createdAt: "2026-06-16T12:00:00.000Z" }),
      baseMemory({ id: "m2", display: "Disable the old service", createdAt: "2026-06-16T10:00:00.000Z" }),
    ], { now: NOW_MS });
    const matches = out.match(/<operational-memory-warning>/g);
    assert.strictEqual(matches?.length, 1, "expected exactly one warning block");
  });

  it("does not break existing attributes when adding temporal attributes", () => {
    const out = formatRelevantMemoriesContext([
      baseMemory({ id: "m1", display: "Cronjob may produce duplicates", createdAt: "2026-06-16T12:00:00.000Z" }),
    ], { now: NOW_MS });
    assert.ok(out.includes('category="fact"'), "category preserved");
    assert.ok(out.includes('id="m1"'), "id preserved");
    assert.ok(out.includes("Recall safety"), "compact recall safety marker preserved");
  });

  it("uses summary when text/display is absent", () => {
    const out = formatRelevantMemoriesContext([
      {
        id: "m1",
        category: "fact",
        source: "dm",
        summary: "Cronjob may produce duplicates",
        memoryStrength: 1.0,
        createdAt: "2026-06-16T12:00:00.000Z",
      },
    ], { now: NOW_MS });
    assert.ok(out.includes('operational="true"'), "expected operational detection from summary");
    assert.ok(out.includes('requires-live-verification="true"'), "expected live verification");
  });
});

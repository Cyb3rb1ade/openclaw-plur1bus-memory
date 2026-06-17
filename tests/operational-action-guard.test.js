// tests/operational-action-guard.test.js
// P5 Temporal Provenance + Operational Action Guard — regression scenario.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";

const NOW_ISO = "2026-06-17T01:00:00.000Z";
const NOW_MS = new Date(NOW_ISO).getTime();

function makeMemory(overrides = {}) {
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

describe("Operational Action Guard regression", () => {
  it("stale cronjob duplicate memory is not presented as current live state", () => {
    const out = formatRelevantMemoriesContext([
      makeMemory({
        id: "cron-duplicate",
        display: "Cronjob may produce duplicates / duplicate risk",
        createdAt: "2026-06-16T08:00:00.000Z", // 17 hours old
      }),
    ], { now: NOW_MS });

    assert.ok(out.includes('requires-live-verification="true"'), "stale cron memory must require live verification");
    assert.ok(out.includes("<operational-memory-warning>"), "stale cron memory must trigger operational warning");
    assert.ok(
      out.includes("Do not disable cronjobs"),
      "warning must explicitly forbid disabling cronjobs",
    );
    assert.ok(
      out.includes("Live verification is required first"),
      "warning must demand live verification",
    );
  });

  it("does not imply current verified state for stale cron memory", () => {
    const out = formatRelevantMemoriesContext([
      makeMemory({
        id: "cron-duplicate",
        display: "Cronjob may produce duplicates / duplicate risk",
        createdAt: "2026-06-16T08:00:00.000Z",
      }),
    ], { now: NOW_MS });

    // The warning should frame the memory as stale evidence, not current truth.
    assert.ok(
      out.includes("stale or have unknown age"),
      "warning must mention staleness",
    );
    assert.ok(
      out.includes("based on recall alone"),
      "warning must say recall alone is insufficient",
    );
  });

  it("fresh cron memory is operational but does not require live verification", () => {
    const out = formatRelevantMemoriesContext([
      makeMemory({
        id: "cron-duplicate",
        display: "Cronjob may produce duplicates / duplicate risk",
        createdAt: "2026-06-17T00:55:00.000Z", // 5 minutes old
      }),
    ], { now: NOW_MS });

    assert.ok(out.includes('operational="true"'), "fresh cron memory is still operational");
    assert.ok(!out.includes('requires-live-verification="true"'), "fresh cron memory does not require live verification");
    assert.ok(!out.includes("<operational-memory-warning>"), "no stale warning for fresh cron memory");
  });

  it("ordinary fact memory remains concise and unmarked", () => {
    const out = formatRelevantMemoriesContext([
      makeMemory({
        id: "pref",
        display: "User prefers concise answers",
        createdAt: "2026-06-16T08:00:00.000Z",
      }),
    ], { now: NOW_MS });

    assert.ok(!out.includes('operational="true"'), "preference memory is not operational");
    assert.ok(!out.includes('requires-live-verification="true"'), "preference memory does not require live verification");
    assert.ok(!out.includes("<operational-memory-warning>"), "preference memory does not trigger warning");
  });

  it("unknown-age operational memory defaults to safe live-verification requirement", () => {
    const out = formatRelevantMemoriesContext([
      makeMemory({
        id: "cron-unknown",
        display: "Disable the old cronjob",
        createdAt: null,
      }),
    ], { now: NOW_MS });

    assert.ok(out.includes('freshness="unknown"'), "unknown age renders unknown freshness");
    assert.ok(out.includes('requires-live-verification="true"'), "unknown age operational requires verification");
    assert.ok(out.includes("<operational-memory-warning>"), "unknown age operational triggers warning");
  });
});

// tests/temporal-provenance.test.js
// P5 Temporal Provenance + Operational Action Guard — helper unit tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseMemoryTimestamp,
  computeMemoryAge,
  classifyMemoryFreshness,
  detectOperationalMemory,
  classifyOperationalRisk,
  buildTemporalProvenance,
  formatAgeForPrompt,
  shouldRequireLiveVerification,
} from "../lib/temporal-provenance.js";

const NOW_ISO = "2026-06-17T01:00:00.000Z";
const NOW_MS = new Date(NOW_ISO).getTime();

function mem(overrides = {}) {
  return {
    id: "m1",
    text: overrides.text ?? "memory text",
    summary: overrides.summary,
    category: overrides.category ?? "fact",
    createdAt: overrides.createdAt === undefined ? NOW_ISO : overrides.createdAt,
    updatedAt: overrides.updatedAt === undefined ? null : overrides.updatedAt,
    lastRetrievedAt: overrides.lastRetrievedAt === undefined ? null : overrides.lastRetrievedAt,
  };
}

describe("parseMemoryTimestamp", () => {
  it("parses ISO string to epoch ms", () => {
    assert.strictEqual(parseMemoryTimestamp("2026-06-16T12:00:00.000Z"), new Date("2026-06-16T12:00:00.000Z").getTime());
  });

  it("returns numeric epoch ms unchanged", () => {
    assert.strictEqual(parseMemoryTimestamp(1750056000000), 1750056000000);
  });

  it("returns Date objects as epoch ms", () => {
    const d = new Date("2026-06-16T12:00:00.000Z");
    assert.strictEqual(parseMemoryTimestamp(d), d.getTime());
  });

  it("returns undefined for null/undefined/empty", () => {
    assert.strictEqual(parseMemoryTimestamp(null), undefined);
    assert.strictEqual(parseMemoryTimestamp(undefined), undefined);
    assert.strictEqual(parseMemoryTimestamp(""), undefined);
  });

  it("returns undefined for invalid strings", () => {
    assert.strictEqual(parseMemoryTimestamp("not-a-date"), undefined);
  });

  it("treats 0 as missing (not Unix epoch)", () => {
    assert.strictEqual(parseMemoryTimestamp(0), undefined);
    assert.strictEqual(parseMemoryTimestamp(new Date(0)), undefined);
  });
});

describe("computeMemoryAge", () => {
  it("computes age from createdAt", () => {
    const age = computeMemoryAge(mem({ createdAt: "2026-06-16T12:00:00.000Z" }), { now: NOW_MS });
    assert.strictEqual(age.ageMs, 13 * 60 * 60 * 1000);
  });

  it("prefers updatedAt over createdAt", () => {
    const age = computeMemoryAge(mem({
      createdAt: "2026-06-16T12:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z",
    }), { now: NOW_MS });
    assert.strictEqual(age.ageMs, 60 * 60 * 1000);
  });

  it("ignores lastRetrievedAt for age because it is recall time, not observation time", () => {
    const age = computeMemoryAge(mem({
      createdAt: "2026-06-16T12:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z",
      lastRetrievedAt: "2026-06-17T00:30:00.000Z",
    }), { now: NOW_MS });
    assert.strictEqual(age.ageMs, 60 * 60 * 1000);
    assert.strictEqual(age.timestampField, "updatedAt");
  });

  it("returns undefined age when no timestamp exists", () => {
    const age = computeMemoryAge(mem({ createdAt: null }), { now: NOW_MS });
    assert.strictEqual(age.ageMs, undefined);
    assert.strictEqual(age.ageLabel, "unknown");
  });

  it("clamps negative age to 0", () => {
    const age = computeMemoryAge(mem({ createdAt: "2026-06-17T02:00:00.000Z" }), { now: NOW_MS });
    assert.strictEqual(age.ageMs, 0);
  });
});

describe("classifyMemoryFreshness", () => {
  it("classifies <= 15 minutes as fresh", () => {
    assert.strictEqual(classifyMemoryFreshness(15 * 60 * 1000), "fresh");
    assert.strictEqual(classifyMemoryFreshness(0), "fresh");
  });

  it("classifies <= 2 hours as recent", () => {
    assert.strictEqual(classifyMemoryFreshness(60 * 60 * 1000), "recent");
    assert.strictEqual(classifyMemoryFreshness(2 * 60 * 60 * 1000), "recent");
  });

  it("classifies > 2 hours as stale", () => {
    assert.strictEqual(classifyMemoryFreshness(2 * 60 * 60 * 1000 + 1), "stale");
  });

  it("classifies undefined age as unknown", () => {
    assert.strictEqual(classifyMemoryFreshness(undefined), "unknown");
  });

  it("respects custom thresholds", () => {
    assert.strictEqual(classifyMemoryFreshness(30 * 60 * 1000, { freshMs: 60 * 60 * 1000, recentMs: 4 * 60 * 60 * 1000 }), "fresh");
  });
});

describe("formatAgeForPrompt", () => {
  it("formats minutes", () => {
    assert.strictEqual(formatAgeForPrompt(5 * 60 * 1000), "5m ago");
  });

  it("formats hours", () => {
    assert.strictEqual(formatAgeForPrompt(3 * 60 * 60 * 1000), "3h ago");
  });

  it("formats days", () => {
    assert.strictEqual(formatAgeForPrompt(2 * 24 * 60 * 60 * 1000), "2d ago");
  });

  it("returns unknown when age is missing", () => {
    assert.strictEqual(formatAgeForPrompt(undefined), "unknown");
  });
});

describe("detectOperationalMemory", () => {
  it("detects cronjob memory", () => {
    assert.strictEqual(detectOperationalMemory("Cronjob may produce duplicates").isOperational, true);
  });

  it("detects systemctl/service memory", () => {
    assert.strictEqual(detectOperationalMemory("Restart the nginx service").isOperational, true);
  });

  it("detects deploy/protect script memory", () => {
    assert.strictEqual(detectOperationalMemory("Protect script restored stale stubs").isOperational, true);
  });

  it("detects delete/disable/stop keywords", () => {
    assert.strictEqual(detectOperationalMemory("Disable the duplicate job").isOperational, true);
  });

  it("detects production/live state memory", () => {
    assert.strictEqual(detectOperationalMemory("Production gateway is down").isOperational, true);
  });

  it("does not flag ordinary preference memory", () => {
    assert.strictEqual(detectOperationalMemory("User prefers concise answers").isOperational, false);
  });

  it("does not flag ordinary project fact", () => {
    assert.strictEqual(detectOperationalMemory("Project Alpha uses Node 22").isOperational, false);
  });

  it("uses summary when text is absent", () => {
    assert.strictEqual(detectOperationalMemory("", { summary: "Cronjob duplicate risk" }).isOperational, true);
  });

  it("is case-insensitive", () => {
    assert.strictEqual(detectOperationalMemory("CRONJOB may produce duplicates").isOperational, true);
  });
});

describe("classifyOperationalRisk", () => {
  it("classifies destructive keywords", () => {
    assert.strictEqual(classifyOperationalRisk("Disable the cronjob").operationalRisk, "destructive");
    assert.strictEqual(classifyOperationalRisk("Stop the service").operationalRisk, "destructive");
    assert.strictEqual(classifyOperationalRisk("Delete the lockfile").operationalRisk, "destructive");
  });

  it("classifies high-risk keywords", () => {
    assert.strictEqual(classifyOperationalRisk("Change the deploy script").operationalRisk, "high");
    assert.strictEqual(classifyOperationalRisk("Edit crontab").operationalRisk, "high");
  });

  it("classifies medium-risk keywords", () => {
    assert.strictEqual(classifyOperationalRisk("Restart the service").operationalRisk, "medium");
    assert.strictEqual(classifyOperationalRisk("Check systemctl status").operationalRisk, "medium");
  });

  it("classifies low-risk for informational logs", () => {
    assert.strictEqual(classifyOperationalRisk("Journalctl shows a warning").operationalRisk, "low");
  });

  it("returns none for non-operational text", () => {
    assert.strictEqual(classifyOperationalRisk("User prefers German").operationalRisk, "none");
  });
});

describe("buildTemporalProvenance", () => {
  it("returns full provenance for stale operational memory", () => {
    const tp = buildTemporalProvenance(mem({
      text: "Cronjob may produce duplicates",
      createdAt: "2026-06-16T12:00:00.000Z",
    }), { now: NOW_MS });
    assert.strictEqual(tp.createdAt, "2026-06-16T12:00:00.000Z");
    assert.strictEqual(tp.freshness, "stale");
    assert.strictEqual(tp.isOperational, true);
    assert.strictEqual(tp.operationalRisk, "high");
    assert.strictEqual(tp.requiresLiveVerification, true);
    assert.ok(tp.reasons.length > 0);
  });

  it("returns fresh operational memory without live-verification requirement", () => {
    const tp = buildTemporalProvenance(mem({
      text: "Cronjob may produce duplicates",
      createdAt: "2026-06-17T00:55:00.000Z",
    }), { now: NOW_MS });
    assert.strictEqual(tp.freshness, "fresh");
    assert.strictEqual(tp.requiresLiveVerification, false);
  });

  it("returns unknown freshness and requires verification when timestamp is missing", () => {
    const tp = buildTemporalProvenance(mem({
      text: "Cronjob may produce duplicates",
      createdAt: null,
    }), { now: NOW_MS });
    assert.strictEqual(tp.freshness, "unknown");
    assert.strictEqual(tp.requiresLiveVerification, true);
  });

  it("does not require verification for non-operational memory even when stale", () => {
    const tp = buildTemporalProvenance(mem({
      text: "User prefers concise answers",
      createdAt: "2026-06-16T12:00:00.000Z",
    }), { now: NOW_MS });
    assert.strictEqual(tp.isOperational, false);
    assert.strictEqual(tp.requiresLiveVerification, false);
  });

  it("normalizes createdAt to ISO string", () => {
    const tp = buildTemporalProvenance(mem({ createdAt: 1781611200000 }), { now: NOW_MS });
    assert.strictEqual(tp.createdAt, "2026-06-16T12:00:00.000Z");
  });
});

describe("shouldRequireLiveVerification", () => {
  it("returns true for stale operational memory", () => {
    assert.strictEqual(shouldRequireLiveVerification({
      isOperational: true,
      freshness: "stale",
    }), true);
  });

  it("returns true for operational memory with unknown freshness", () => {
    assert.strictEqual(shouldRequireLiveVerification({
      isOperational: true,
      freshness: "unknown",
    }), true);
  });

  it("returns false for fresh operational memory", () => {
    assert.strictEqual(shouldRequireLiveVerification({
      isOperational: true,
      freshness: "fresh",
    }), false);
  });

  it("returns false for non-operational memory", () => {
    assert.strictEqual(shouldRequireLiveVerification({
      isOperational: false,
      freshness: "stale",
    }), false);
  });
});

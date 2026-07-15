import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProactiveCheck } from "../lib/jobs/proactive-check.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plur1bus-proactive-check-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeTurns(now) {
  return [
    { id: "alpha-1", content: "alphaissue aa", createdAt: now - 24 * HOUR_MS },
    { id: "alpha-2", content: "alphaissue bb", createdAt: now - 48 * HOUR_MS },
    { id: "alpha-3", content: "alphaissue cc", createdAt: now - 72 * HOUR_MS },
    { id: "beta-1", content: "betatopic dd", createdAt: now - 25 * HOUR_MS },
    { id: "beta-2", content: "betatopic ee", createdAt: now - 49 * HOUR_MS },
    { id: "beta-3", content: "betatopic ff", createdAt: now - 73 * HOUR_MS },
    { id: "gamma-1", content: "gammawork gg", createdAt: now - 26 * HOUR_MS },
    { id: "gamma-2", content: "gammawork hh", createdAt: now - 50 * HOUR_MS },
    { id: "gamma-3", content: "gammawork ii", createdAt: now - 74 * HOUR_MS },
  ];
}

function readNudges(workspaceDir) {
  const path = join(workspaceDir, ".adaptive-learning", "proactive-nudges.json");
  return JSON.parse(readFileSync(path, "utf8")).nudges || [];
}

describe("runProactiveCheck", () => {
  // TZ-safety note: `now` below is a fixed UTC instant that is NOT itself
  // guaranteed to land outside quiet hours (22:00-08:00 local) in every
  // timezone — e.g. it's 05:00 in America/Los_Angeles. That's fine here
  // because every pattern in makeTurns() has no prior cooldown entry, so
  // shouldShowNudge's lastShown==null bypass short-circuits before the
  // quiet-hours check runs at all (see lib/proactive-nudge.js). If a future
  // test adds a pre-seeded cooldown for one of these keywords, pick a `now`
  // that's outside quiet hours in all timezones or pass quietHours:false
  // explicitly — do not rely on this comment alone.
  it("generates at most two nudges when three patterns are eligible on the same day", async () => {
    const now = Date.parse("2026-07-15T12:00:00Z");
    const result = await runProactiveCheck(
      { readTurns: () => makeTurns(now) },
      "agent-a",
      {
        workspaceDir: dir,
        workspaceKey: "ws-a",
        now,
        threshold: 0,
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.patternsFound, 3);
    assert.equal(result.nudgesGenerated, 2);

    const nudges = readNudges(dir);
    assert.equal(nudges.length, 2);
    assert.deepEqual(
      nudges.map((entry) => entry.keyword).sort(),
      ["alphaissue", "betatopic"],
    );
  });

  it("counts existing same-day nudges toward the day cap", async () => {
    const now = Date.parse("2026-07-15T12:00:00Z");
    const adaptiveDir = join(dir, ".adaptive-learning");
    mkdirSync(adaptiveDir, { recursive: true });
    writeFileSync(
      join(adaptiveDir, "proactive-nudges.json"),
      JSON.stringify({
        nudges: [
          {
            id: "existing-1",
            agentId: "agent-a",
            workspaceKey: "ws-a",
            keyword: "already-shown",
            text: "existing",
            score: 0.9,
            generatedAt: "2026-07-15T01:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const result = await runProactiveCheck(
      { readTurns: () => makeTurns(now) },
      "agent-a",
      {
        workspaceDir: dir,
        workspaceKey: "ws-a",
        now,
        threshold: 0,
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.nudgesGenerated, 1);

    const nudges = readNudges(dir);
    assert.equal(nudges.length, 2);
    assert.equal(
      nudges.filter((entry) => entry.generatedAt.startsWith("2026-07-15")).length,
      2,
    );
  });
});

/**
 * tests/engine-plur1bus-command.test.js — PR-03f.
 *
 * The command runner is the deny-by-classification chokepoint and the home of
 * the 17 internal job runners. This pins the boundary; behaviour is covered by
 * the existing command tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPlur1busCommandRunner } from "../engine/commands/plur1bus-command.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "engine", "commands", "plur1bus-command.js"), "utf8");

const INTERNAL_JOBS = [
  "consolidate-daily", "classify-recent", "auto-accept-stale", "rem-dream",
  "skill-miner", "skill-benefit-backfill", "afterthought", "persona-evolve",
  "reminder-dispatch", "discover-semantic-links", "gc-run", "embedding-drain",
  "emotion-refine", "feedback-report", "proactive-check", "meta-reflect",
  "episodes-rebuild",
];

describe("engine/commands/plur1bus-command", () => {
  it("exports a factory", () => {
    assert.equal(typeof createPlur1busCommandRunner, "function");
  });

  it("does not mention the OpenClaw api surface", () => {
    assert.doesNotMatch(source, /(?<![.\w$/-])api\s*\./);
  });

  it("still handles all 17 internal job names", () => {
    for (const job of INTERNAL_JOBS) {
      assert.match(source, new RegExp(`"${job}"`), `internal job ${job} must survive the move`);
    }
  });

  it("checks authorization before dispatching an action", () => {
    const body = source.slice(source.indexOf("return async function"));
    const authAt = body.indexOf("checkAuth");
    const dispatchAt = body.indexOf('actionKey === "internal"');
    assert.ok(authAt >= 0 && dispatchAt >= 0);
    assert.ok(authAt < dispatchAt, "deny-by-classification must run before any internal dispatch");
  });
});

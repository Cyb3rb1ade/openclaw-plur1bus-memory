/**
 * tests/engine-jobs-retry.test.js — PR-08 part 2 (behaviour change, owner decision a).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createJobRegistry } from "../engine/jobs/job-registry.js";
import { ledgerBackedCompletion, remJobOutcome } from "../engine/jobs/rem-outcome.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const DAY = 86_400_000;
const KEY = "rem:w:agent-a:private:2026-W02";

function setup() {
  const root = makeTempDir("plur1bus-retry-");
  const workspaceDir = makeTempDir("plur1bus-retry-ws-");
  let now = Date.UTC(2026, 0, 13, 1, 15);
  let n = 0;
  const host = createStubHost({ clock: () => now });
  const jobs = createJobRegistry({ host, jobsRoot: root, idFactory: () => `run-${++n}` });
  return { root, workspaceDir, jobs, advance: (ms) => { now += ms; } };
}

function bindNoNarrativeRem(jobs, workspaceDir) {
  jobs.bind("rem-dream", async (_n, ctx) => {
    if (ctx.isAbandonedKey(KEY)) return ctx.skip("abandoned", { text: "abandoned" });
    if (ctx.hasCompletedKey(KEY)) return ctx.skip("already_processed", { text: "done" });
    ctx.notePendingKey(KEY);
    ctx.setDiaryTarget(workspaceDir);
    return ctx.incomplete("no_narrative", { text: "open" });
  });
}

describe("retry and abandon", () => {
  it("incomplete is retried on the next sweep with attempt+1 and abandoned after two retries", async () => {
    const { jobs, workspaceDir, advance } = setup();
    bindNoNarrativeRem(jobs, workspaceDir);
    const outcomes = [];
    for (let day = 0; day < 4; day++) {
      const run = await jobs.run("rem-dream", "agent-a", { trigger: "cron" });
      outcomes.push([run.outcome, run.attempt, run.reason]);
      advance(DAY);
    }
    assert.deepEqual(outcomes, [
      ["incomplete", 1, "no_narrative"],
      ["incomplete", 2, "no_narrative"],
      ["abandoned", 3, "abandoned_after_retries:no_narrative"],
      ["skipped", 1, "abandoned"],
    ]);
    const diary = readFileSync(join(workspaceDir, "DREAMS.md"), "utf8");
    assert.match(diary, /abandoned after 3 attempts/);
    const [abandoned] = await jobs.history("agent-a", { limit: 2 }).then((rows) => rows.filter((r) => r.outcome === "abandoned"));
    assert.deepEqual(abandoned.diary, { written: true });
    assert.deepEqual(abandoned.pendingKeys, [KEY]);
  });

  it("already_processed only after a completed row for the same key", async () => {
    const { jobs } = setup();
    let completeNow = false;
    jobs.bind("rem-dream", async (_n, ctx) => {
      if (ctx.hasCompletedKey(KEY)) return ctx.skip("already_processed");
      if (!completeNow) { ctx.notePendingKey(KEY); return ctx.incomplete("no_narrative"); }
      ctx.markCompletedKey(KEY);
      return { text: "dreamed" };
    });
    assert.equal((await jobs.run("rem-dream", "agent-a")).outcome, "incomplete");
    assert.equal((await jobs.run("rem-dream", "agent-a")).outcome, "incomplete");
    completeNow = true;
    const done = await jobs.run("rem-dream", "agent-a");
    assert.deepEqual([done.outcome, done.attempt, done.keys], ["completed", 3, [KEY]]);
    const again = await jobs.run("rem-dream", "agent-a");
    assert.deepEqual([again.outcome, again.reason], ["skipped", "already_processed"]);
  });

  it("the breaker counts ledger rows: a fourth rem/deep LLM session in one sweep is skipped", async () => {
    const { jobs, advance } = setup();
    let bodies = 0;
    jobs.bind("rem-dream", async (_n, ctx) => { bodies += 1; ctx.notePendingKey(`${KEY}:${bodies}`); return ctx.incomplete("no_narrative"); });
    jobs.bind("consolidate-daily", async () => { bodies += 1; return { text: "ok" }; });
    jobs.bind("gc-run", async () => ({ text: "not a phase job" }));
    const results = [];
    for (const name of ["rem-dream", "consolidate-daily", "rem-dream", "gc-run", "rem-dream", "consolidate-daily"]) {
      const run = await jobs.run(name, "agent-a");
      results.push([name, run.outcome, run.reason ?? null]);
      advance(60_000);
    }
    assert.deepEqual(results.slice(-2), [["rem-dream", "skipped", "circuit_open"], ["consolidate-daily", "skipped", "circuit_open"]]);
    assert.equal(bodies, 3);
    advance(DAY);
    assert.equal((await jobs.run("consolidate-daily", "agent-a")).outcome, "completed", "next sweep resets the breaker");
  });

  it("a body that throws after writing the diary records failed with the diary outcome (Review Focus 4)", async () => {
    const { jobs, root } = setup();
    jobs.bind("rem-dream", async (_n, ctx) => { ctx.noteDiary({ written: true }); throw new Error("after diary"); });
    const run = await jobs.run("rem-dream", "agent-a");
    assert.deepEqual([run.outcome, run.diary], ["failed", { written: true }]);
    const [row] = await jobs.history("agent-a");
    assert.deepEqual(row.diary, { written: true });
    assert.deepEqual(readdirSync(join(root, "agent-a", "running")), []);
  });
});

describe("remJobOutcome", () => {
  const report = (runKey, narrative) => ({ result: { report: { runKey, narrative }, trends: [] }, scope: "agent" });
  it("no narrative where one is expected is incomplete", () => {
    assert.deepEqual(remJobOutcome([report("k1", null)], { narrativeExpected: true, dryRun: false }), { outcome: "incomplete", reason: "no_narrative", pendingKeys: ["k1"] });
  });
  it("a narrative, or none expected, is completed", () => {
    assert.equal(remJobOutcome([report("k1", "a dream")], { narrativeExpected: true, dryRun: false }).outcome, "completed");
    assert.equal(remJobOutcome([report("k1", null)], { narrativeExpected: false, dryRun: false }).outcome, "completed");
  });
  it("all partitions skipped is skipped with the first reason", () => {
    const skipped = (reason) => ({ result: { skipped: true, reason }, scope: "agent" });
    assert.deepEqual(remJobOutcome([skipped("too_few_memories"), skipped("lock_held")], { narrativeExpected: true, dryRun: false }), { outcome: "skipped", reason: "too_few_memories", pendingKeys: [] });
  });
});

describe("ledgerBackedCompletion", () => {
  it("keeps the ACL binding and routes completion through the job context", async () => {
    const calls = [];
    const store = Object.freeze({ aclBindings: { scope: "agent" }, hasCompletedRun: () => true, markRunCompleted: (k) => calls.push(["store", k]), readPatterns: () => [] });
    const seen = [];
    const ctx = { hasCompletedKey: (k) => k === "done", isAbandonedKey: (k) => k === "gone", noteAbandonedKey: (k) => seen.push(["abandoned", k]), markCompletedKey: (k) => seen.push(["completed", k]) };
    const wrapped = ledgerBackedCompletion(store, ctx);
    assert.equal(wrapped.aclBindings, store.aclBindings);
    assert.equal(await wrapped.hasCompletedRun("new"), false, "run-state.json is no longer consulted");
    assert.equal(await wrapped.hasCompletedRun("done"), true);
    assert.equal(await wrapped.hasCompletedRun("gone"), true);
    await wrapped.markRunCompleted("k2", {});
    assert.deepEqual(seen, [["abandoned", "gone"], ["completed", "k2"]]);
    assert.deepEqual(calls, [["store", "k2"]], "run-state.json keeps being written for rollback");
  });
});

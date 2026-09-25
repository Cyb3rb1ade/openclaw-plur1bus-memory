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
    assert.match(diary, /rem-dream run abandoned after 3 attempts/, "the diary line names the job, not a hardcoded \"REM run\" (fix round 1, item 5)");
    const [abandoned] = await jobs.history("agent-a", { limit: 2 }).then((rows) => rows.filter((r) => r.outcome === "abandoned"));
    assert.deepEqual(abandoned.diary, { written: true });
    assert.deepEqual(abandoned.pendingKeys, [KEY]);
  });

  it("already_processed only after a completed row for the same key", async () => {
    // Spec 3.3: retries happen on the *next* sweep, so this exercises four
    // sweeps (one session per sweep), not four calls piled into one — a
    // retry must count toward the breaker (fix round 1, item 1), and four
    // real sessions in a single sweep would otherwise trip it before this
    // test ever reaches its `already_processed` assertion.
    const { jobs, advance } = setup();
    let completeNow = false;
    jobs.bind("rem-dream", async (_n, ctx) => {
      if (ctx.hasCompletedKey(KEY)) return ctx.skip("already_processed");
      if (!completeNow) { ctx.notePendingKey(KEY); return ctx.incomplete("no_narrative"); }
      ctx.markCompletedKey(KEY);
      return { text: "dreamed" };
    });
    assert.equal((await jobs.run("rem-dream", "agent-a")).outcome, "incomplete");
    advance(DAY);
    assert.equal((await jobs.run("rem-dream", "agent-a")).outcome, "incomplete");
    advance(DAY);
    completeNow = true;
    const done = await jobs.run("rem-dream", "agent-a");
    assert.deepEqual([done.outcome, done.attempt, done.keys], ["completed", 3, [KEY]]);
    advance(DAY);
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

  it("fix round 1 item 1: a retry of an already-open key still counts toward the breaker (no bypass)", async () => {
    // Reviewer's probe: two consolidate-daily sessions, then a *retry* of a
    // key opened on the previous sweep (not a fresh key), then a fourth
    // consolidate-daily. Before the fix, a retry's row had `llmSession:
    // false` (it was never `attempt === 1`) and did not count, so this
    // fourth call ran; after the fix it must stop at 3 sessions.
    const { jobs, advance } = setup();
    jobs.bind("rem-dream", async (_n, ctx) => {
      if (ctx.hasCompletedKey(KEY)) return ctx.skip("already_processed");
      ctx.notePendingKey(KEY);
      return ctx.incomplete("no_narrative");
    });
    jobs.bind("consolidate-daily", async () => ({ text: "ok" }));
    // Day 1: open the key (attempt 1), its own sweep only has this one session.
    assert.equal((await jobs.run("rem-dream", "agent-a")).outcome, "incomplete");
    advance(DAY);
    // Day 2: consolidate, consolidate, rem retry (attempt 2 of the SAME key), consolidate.
    const results = [];
    for (const name of ["consolidate-daily", "consolidate-daily", "rem-dream", "consolidate-daily"]) {
      const run = await jobs.run(name, "agent-a");
      results.push([name, run.outcome, run.reason ?? null]);
    }
    assert.deepEqual(results, [
      ["consolidate-daily", "completed", null],
      ["consolidate-daily", "completed", null],
      ["rem-dream", "incomplete", "no_narrative"],
      ["consolidate-daily", "skipped", "circuit_open"],
    ]);
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

  it("the abandonment diary line uses the timezone passed to setDiaryTarget, not the host's (fix round 1, item 2)", async () => {
    const { jobs, workspaceDir, advance } = setup();
    jobs.bind("rem-dream", async (_n, ctx) => {
      ctx.notePendingKey(KEY);
      ctx.setDiaryTarget(workspaceDir, { timezone: "America/New_York" });
      return ctx.incomplete("no_narrative");
    });
    for (let day = 0; day < 3; day++) {
      await jobs.run("rem-dream", "agent-a");
      advance(DAY);
    }
    const diary = readFileSync(join(workspaceDir, "DREAMS.md"), "utf8");
    // The abandoning run starts 2026-01-15T01:15Z: in Europe/Berlin (the host
    // TZ this suite runs under) that is "January 15" GMT+1; in the explicit
    // America/New_York zone passed here it is the evening of "January 14"
    // EST — proof the explicit timezone, not the host's, was used.
    assert.match(diary, /January 14, 2026 at 8:15 PM EST/);
    assert.doesNotMatch(diary, /January 15, 2026/);
  });

  it("the abandonment diary respects the opt-out: diary_disabled, no DREAMS.md write (fix round 1, item 3)", async () => {
    const { jobs, workspaceDir, advance } = setup();
    jobs.bind("rem-dream", async (_n, ctx) => {
      ctx.notePendingKey(KEY);
      ctx.setDiaryTarget(null, { disabled: true });
      return ctx.incomplete("no_narrative");
    });
    let last;
    for (let day = 0; day < 3; day++) {
      last = await jobs.run("rem-dream", "agent-a");
      advance(DAY);
    }
    assert.deepEqual([last.outcome, last.diary], ["abandoned", { written: false, reason: "diary_disabled" }]);
    assert.equal(existsSync(join(workspaceDir, "DREAMS.md")), false, "the diary file must not be written at all when the diary is disabled");
  });

  it("a marker is removed best-effort when readAll() throws right after writeMarker succeeds (fix round 1, item 4)", async () => {
    const { root } = setup();
    let n = 0;
    const host = createStubHost({ clock: () => Date.UTC(2026, 0, 13, 1, 15) });
    const jobs = createJobRegistry({ host, jobsRoot: root, idFactory: () => `run-${++n}` });
    jobs.bind("rem-dream", async () => ({ text: "ok" }));
    // First run: ledger.jsonl does not exist yet, so recoverOnce's own
    // readAll() succeeds trivially and marks this agent recovered — its one
    // readAll() per process is now spent, so the next run's snapshot
    // readAll() is the only one that will fire.
    const first = await jobs.run("rem-dream", "agent-a");
    assert.equal(first.outcome, "completed");
    // Corrupt ledger.jsonl into a directory *after* the first run wrote it,
    // so writeMarker() (which never touches ledger.jsonl) still succeeds for
    // the second run, and only the post-marker snapshot readAll() throws.
    const { rmSync, mkdirSync } = await import("node:fs");
    const ledgerPath = join(root, "agent-a", "ledger.jsonl");
    rmSync(ledgerPath, { force: true });
    mkdirSync(ledgerPath, { recursive: true });
    const second = await jobs.run("rem-dream", "agent-a");
    assert.equal(second.outcome, "failed");
    assert.equal(second.reason, "ledger_unwritable");
    assert.deepEqual(
      readdirSync(join(root, "agent-a", "running")),
      [],
      "the second run's marker must not survive a readAll() failure that happened right after it was written",
    );
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

describe("concurrent runs (final review I4)", () => {
  function gate() {
    let open;
    const opened = new Promise((resolve) => { open = resolve; });
    return { opened, open };
  }

  it("in-flight rem/deep sessions count toward the breaker: two prior sessions plus two concurrent starts run one body", async () => {
    const { jobs, advance } = setup();
    const { opened, open } = gate();
    let bodies = 0;
    let blocking = false;
    const body = async () => { bodies += 1; if (blocking) await opened; return { text: "ok" }; };
    jobs.bind("rem-dream", body);
    jobs.bind("consolidate-daily", body);
    await jobs.run("consolidate-daily", "agent-a");
    advance(60_000);
    await jobs.run("consolidate-daily", "agent-a");
    advance(60_000);
    blocking = true;
    const pending = [jobs.run("rem-dream", "agent-a"), jobs.run("consolidate-daily", "agent-a")];
    await new Promise((resolve) => setTimeout(resolve, 20));
    open();
    const runs = await Promise.all(pending);
    assert.equal(bodies, 3, "the breaker's third session is the only concurrent body");
    assert.deepEqual(runs.map((r) => [r.outcome, r.reason ?? null]).sort(), [["completed", null], ["skipped", "circuit_open"]]);
  });

  it("five concurrent rem/deep starts run at most three bodies", async () => {
    const { jobs } = setup();
    const { opened, open } = gate();
    let bodies = 0;
    const body = async () => { bodies += 1; await opened; return { text: "ok" }; };
    jobs.bind("rem-dream", body);
    jobs.bind("consolidate-daily", body);
    const pending = ["rem-dream", "consolidate-daily", "rem-dream", "consolidate-daily", "rem-dream"].map((name) => jobs.run(name, "agent-a"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    open();
    await Promise.all(pending);
    assert.ok(bodies <= 3, `${bodies} bodies ran`);
  });

  it("two concurrent rem-dream runs for one agent run one body; the other is skipped already_running with a ledger row", async () => {
    const { jobs, root } = setup();
    const { opened, open } = gate();
    let bodies = 0;
    jobs.bind("rem-dream", async () => { bodies += 1; await opened; return { text: "ok" }; });
    const pending = [jobs.run("rem-dream", "agent-a"), jobs.run("rem-dream", "agent-a"), jobs.run("rem-dream", "agent-b")];
    await new Promise((resolve) => setTimeout(resolve, 20));
    open();
    const runs = await Promise.all(pending);
    assert.equal(bodies, 2, "one body per agent");
    assert.deepEqual(runs.map((r) => [r.agentId, r.outcome, r.reason ?? null]), [["agent-a", "completed", null], ["agent-a", "skipped", "already_running"], ["agent-b", "completed", null]]);
    const rows = readFileSync(join(root, "agent-a", "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.reason === "already_running" && r.llmSession === false), "the skip is recorded and never counts as a session");
    assert.equal((await jobs.run("rem-dream", "agent-a")).outcome, "completed", "the guard is released when the run finishes");
  });

  it("the gc-run singleton is guarded the same way", async () => {
    const { jobs } = setup();
    const { opened, open } = gate();
    let bodies = 0;
    jobs.bind("gc-run", async () => { bodies += 1; await opened; return { text: "ok" }; });
    const pending = [jobs.run("gc-run", "agent-a"), jobs.run("gc-run", "agent-a")];
    await new Promise((resolve) => setTimeout(resolve, 20));
    open();
    const runs = await Promise.all(pending);
    assert.equal(bodies, 1);
    assert.equal(runs[1].reason, "already_running");
  });
});

/**
 * tests/job-registry-health.test.js — E4 Task 2 (spec 2a-E4).
 *
 * `health()` is a synchronous, ledger-derived snapshot of job health: the
 * latest run per job, the rem/deep breaker for the current sweep (including
 * in-flight sessions), which jobs are running in this process, and how many
 * ledger lines could not be parsed. It never throws, even when the jobs
 * root itself is unreadable.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createJobRegistry, sweepKey, BREAKER_LIMIT } from "../engine/jobs/job-registry.js";
import { createJobLedger } from "../engine/jobs/job-ledger.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function stubHost({ clockStart = Date.UTC(2026, 0, 13, 1, 15) } = {}) {
  let now = clockStart;
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    // Advances on every read so a run's startedAt/finishedAt differ, exactly
    // like the ledger's own test helper (tests/engine-jobs-ledger.test.js).
    clock: () => (now += 10),
  };
}

function idFactoryFrom() {
  let n = 0;
  return () => `run-${++n}`;
}

describe("job registry health", () => {
  it("health reports the latest run per job with outcome, reason, trigger and attempt", async () => {
    const root = makeTempDir("e4-jobs-");
    const host = stubHost();
    const jobs = createJobRegistry({ host, jobsRoot: root, idFactory: idFactoryFrom() });
    let calls = 0;
    jobs.bind("gc-run", async () => {
      calls += 1;
      if (calls === 2) throw new Error("boom");
      return {};
    });
    jobs.bind("feedback-report", async () => ({}));
    await jobs.run("gc-run", "agent-a", { trigger: "manual" });
    const second = await jobs.run("gc-run", "agent-a", { trigger: "manual" });
    assert.deepEqual([second.outcome, second.reason], ["failed", "error:Error"]);
    await jobs.run("feedback-report", "agent-a", { trigger: "cron" });

    const health = jobs.health();
    const agent = health.agents.find((a) => a.agentId === "agent-a");
    assert.deepEqual(agent.lastRuns["gc-run"], {
      runId: second.runId,
      outcome: "failed",
      reason: "error:Error",
      trigger: "manual",
      startedAt: second.startedAt,
      finishedAt: second.finishedAt,
      attempt: 1,
    });
    assert.equal(agent.lastRuns["feedback-report"].trigger, "cron");
    assert.equal("rem-dream" in agent.lastRuns, false);
  });

  it("health counts the rem/deep breaker for the current sweep including in-flight sessions", async () => {
    const root = makeTempDir("e4-jobs-");
    const host = stubHost();
    const jobs = createJobRegistry({ host, jobsRoot: root, idFactory: idFactoryFrom() });
    const sweep = sweepKey(host.clock());
    const dir = join(root, "agent-b");
    mkdirSync(dir, { recursive: true });
    const baseRow = {
      v: 1, job: "rem-dream", phase: "rem", agentId: "agent-b", trigger: "cron",
      startedAt: host.clock(), finishedAt: host.clock(), durationMs: 0,
      outcome: "completed", attempt: 1, cost: { ms: 0 }, counts: {}, llmSession: true,
    };
    const rows = [0, 1, 2].map((i) => ({ ...baseRow, runId: `seed-${i}`, sweep }));
    // Yesterday's sweep must not count toward today's breaker.
    rows.push({ ...baseRow, runId: "seed-yesterday", sweep: sweepKey(host.clock() - 86_400_000) });
    writeFileSync(join(dir, "ledger.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

    const agentB = jobs.health().agents.find((a) => a.agentId === "agent-b");
    assert.deepEqual(agentB.breaker, { sweep, sessions: 3, limit: BREAKER_LIMIT, open: true });
    assert.deepEqual(agentB.running, []);

    // A parked rem-dream body (a different, empty-ledger agent so the
    // breaker does not itself block the start) counts as one in-flight
    // session and one running job until it is released.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    jobs.bind("rem-dream", async () => { await gate; return {}; });
    const runPromise = jobs.run("rem-dream", "agent-c", { trigger: "cron" });
    const whileRunning = jobs.health().agents.find((a) => a.agentId === "agent-c");
    assert.deepEqual(whileRunning.running, ["rem-dream"]);
    assert.deepEqual(whileRunning.breaker, { sweep, sessions: 1, limit: BREAKER_LIMIT, open: false });
    release();
    await runPromise;
    const afterRelease = jobs.health().agents.find((a) => a.agentId === "agent-c");
    assert.deepEqual(afterRelease.running, []);
    // The in-flight reservation is gone, but the run's own completed row is
    // now a durable llmSession for today's sweep, so it still counts.
    assert.equal(afterRelease.breaker.sessions, 1);
  });

  it("health lists a running non-singleton job", async () => {
    const root = makeTempDir("e4-jobs-");
    const host = stubHost();
    const jobs = createJobRegistry({ host, jobsRoot: root, idFactory: idFactoryFrom() });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    jobs.bind("feedback-report", async () => { await gate; return {}; });
    const runPromise = jobs.run("feedback-report", "agent-d", { trigger: "cron" });
    const whileRunning = jobs.health().agents.find((a) => a.agentId === "agent-d");
    assert.deepEqual(whileRunning.running, ["feedback-report"]);
    release();
    await runPromise;
    const afterRelease = jobs.health().agents.find((a) => a.agentId === "agent-d");
    assert.deepEqual(afterRelease.running, []);
  });

  it("health counts unreadable ledger lines and survives a torn last line", async () => {
    const root = makeTempDir("e4-jobs-");
    const host = stubHost();
    const jobs = createJobRegistry({ host, jobsRoot: root, idFactory: idFactoryFrom() });
    const dir = join(root, "agent-e");
    mkdirSync(dir, { recursive: true });
    const validRow = {
      v: 1, runId: "r1", job: "gc-run", phase: null, agentId: "agent-e", trigger: "manual",
      startedAt: 1, finishedAt: 2, durationMs: 1, outcome: "completed", attempt: 1,
      cost: { ms: 1 }, counts: {}, sweep: sweepKey(1), llmSession: false,
    };
    writeFileSync(
      join(dir, "ledger.jsonl"),
      `${JSON.stringify(validRow)}\nnot json\n{"v":1,"job":`,
    );
    const agent = jobs.health().agents.find((a) => a.agentId === "agent-e");
    assert.equal(agent.unreadableLines, 2);
    assert.equal(Object.keys(agent.lastRuns).length, 1);
    assert.equal(agent.lastRuns["gc-run"].runId, "r1");
  });

  it("health does not re-read an unchanged ledger", async () => {
    const root = makeTempDir("e4-jobs-");
    const host = stubHost();
    let snapshotCalls = 0;
    const createLedger = (opts) => {
      const real = createJobLedger(opts);
      return { ...real, snapshot: (...args) => { snapshotCalls += 1; return real.snapshot(...args); } };
    };
    const jobs = createJobRegistry({ host, jobsRoot: root, idFactory: idFactoryFrom(), createLedger });
    jobs.bind("gc-run", async () => ({}));
    await jobs.run("gc-run", "agent-f");

    const before = snapshotCalls;
    jobs.health();
    const afterFirst = snapshotCalls;
    assert.equal(afterFirst - before, 1, "the first health() after a ledger change re-snapshots once");
    jobs.health();
    const afterSecond = snapshotCalls;
    assert.equal(afterSecond - afterFirst, 0, "a second health() with no change in between must not re-snapshot");

    await jobs.run("gc-run", "agent-f");
    const afterRun = snapshotCalls;
    jobs.health();
    assert.equal(snapshotCalls - afterRun, 1, "a run in between changes the ledger, so health() re-snapshots again");
  });

  it("health reports an unavailable ledger root instead of throwing", () => {
    const parent = makeTempDir("e4-jobs-root-");
    const fileRoot = join(parent, "not-a-dir");
    writeFileSync(fileRoot, "occupied");
    const debugged = [];
    const host = {
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: (m) => debugged.push(m) },
      clock: () => Date.UTC(2026, 0, 13),
    };
    const jobsOnFile = createJobRegistry({ host, jobsRoot: fileRoot });
    assert.deepEqual(jobsOnFile.health(), { ledger: "unavailable", agents: [] });
    assert.equal(debugged.length, 1);

    const missingRoot = join(parent, "missing-dir");
    const jobsMissing = createJobRegistry({ host, jobsRoot: missingRoot });
    assert.deepEqual(jobsMissing.health(), { ledger: "ok", agents: [] });
  });

  it("health short-circuits to ok/no-agents with no jobsRoot at all", () => {
    const jobs = createJobRegistry({ host: stubHost() });
    assert.deepEqual(jobs.health(), { ledger: "ok", agents: [] });
  });

  it("the health result is deep-frozen", async () => {
    const root = makeTempDir("e4-jobs-");
    const jobs = createJobRegistry({ host: stubHost(), jobsRoot: root, idFactory: idFactoryFrom() });
    jobs.bind("gc-run", async () => ({}));
    await jobs.run("gc-run", "agent-g");
    const health = jobs.health();
    assert.ok(Object.isFrozen(health));
    assert.ok(Object.isFrozen(health.agents));
    assert.ok(Object.isFrozen(health.agents[0]));
    assert.ok(Object.isFrozen(health.agents[0].breaker));
    assert.ok(Object.isFrozen(health.agents[0].lastRuns));
  });
});

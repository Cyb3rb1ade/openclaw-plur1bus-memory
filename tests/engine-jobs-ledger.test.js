/**
 * tests/engine-jobs-ledger.test.js — PR-08 part 1.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { createJobRegistry, sweepKey } from "../engine/jobs/job-registry.js";
import { createJobLedger } from "../engine/jobs/job-ledger.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function registry(root, { clockStart = Date.UTC(2026, 0, 13, 1, 15), logger } = {}) {
  let now = clockStart;
  let n = 0;
  const host = createStubHost({ clock: () => (now += 10), ...(logger ? { logger } : {}) });
  return { jobs: createJobRegistry({ host, jobsRoot: root, idFactory: () => `run-${++n}` }), setNow: (v) => { now = v; } };
}

const rowsOf = (root, agentId) => readFileSync(join(root, agentId, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("job ledger", () => {
  it("writes the marker before the body and one row per exit, then removes the marker", async () => {
    const root = makeTempDir("plur1bus-ledger-");
    const { jobs } = registry(root);
    let markerSeen = false;
    jobs.bind("gc-run", async () => {
      markerSeen = readdirSync(join(root, "agent-a", "running")).some((f) => f === "run-1.started");
      return { text: "ok" };
    });
    jobs.bind("rem-dream", async (_n, ctx) => ctx.skip("no_llm_config", { text: "skip" }));
    await jobs.run("gc-run", "agent-a");
    await jobs.run("rem-dream", "agent-a");
    assert.equal(markerSeen, true);
    const rows = rowsOf(root, "agent-a");
    assert.deepEqual(rows.map((r) => [r.job, r.outcome, r.reason ?? null]), [["gc-run", "completed", null], ["rem-dream", "skipped", "no_llm_config"]]);
    assert.equal(rows[0].v, 1);
    assert.equal(rows[0].sweep, "2026-01-13");
    assert.equal(rows[1].llmSession, false);
    assert.deepEqual(readdirSync(join(root, "agent-a", "running")), []);
  });

  it("does not run the body when the ledger is unwritable (Review Focus 2)", async () => {
    const parent = makeTempDir("plur1bus-ledger-ro-");
    const root = join(parent, "not-a-dir");
    writeFileSync(root, "occupied");
    const warned = [];
    const { jobs } = registry(root, { logger: { warn: (m) => warned.push(m) } });
    let called = false;
    jobs.bind("gc-run", async () => { called = true; return {}; });
    const run = await jobs.run("gc-run", "agent-a");
    assert.equal(called, false);
    assert.deepEqual([run.outcome, run.reason], ["failed", "ledger_unwritable"]);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /ledger unwritable/);
  });

  it("records an orphaned marker as failed/crash on the next start", async () => {
    const root = makeTempDir("plur1bus-ledger-crash-");
    mkdirSync(join(root, "agent-a", "running"), { recursive: true });
    writeFileSync(join(root, "agent-a", "running", "old-run.started"), JSON.stringify({ runId: "old-run", job: "rem-dream", phase: "rem", trigger: "cron", startedAt: Date.UTC(2026, 0, 12, 1, 15) }));
    const { jobs } = registry(root);
    jobs.bind("gc-run", async () => ({}));
    await jobs.run("gc-run", "agent-a");
    const rows = rowsOf(root, "agent-a");
    assert.deepEqual(rows.map((r) => [r.runId, r.outcome, r.reason ?? null]), [["old-run", "failed", "crash"], ["run-1", "completed", null]]);
    assert.equal(existsSync(join(root, "agent-a", "running", "old-run.started")), false);
  });

  it("history filters by job and since, newest first, with a limit", async () => {
    const root = makeTempDir("plur1bus-ledger-history-");
    const { jobs } = registry(root);
    jobs.bind("gc-run", async () => ({}));
    jobs.bind("rem-dream", async (_n, ctx) => ctx.skip("x"));
    for (let i = 0; i < 3; i++) { await jobs.run("gc-run", "agent-a"); await jobs.run("rem-dream", "agent-a"); }
    const all = await jobs.history("agent-a");
    assert.equal(all.length, 6);
    assert.equal(all[0].runId, "run-6");
    const rem = await jobs.history("agent-a", { job: "rem-dream", limit: 2 });
    assert.deepEqual(rem.map((r) => r.runId), ["run-6", "run-4"]);
    const since = await jobs.history("agent-a", { since: all[1].startedAt });
    assert.deepEqual(since.map((r) => r.runId), ["run-6", "run-5"]);
    assert.deepEqual(await jobs.history("agent-b"), []);
  });

  it("sweepKey is the UTC day", () => {
    assert.equal(sweepKey(Date.UTC(2026, 0, 13, 23, 59)), "2026-01-13");
    assert.equal(sweepKey(Date.UTC(2026, 0, 14, 0, 0)), "2026-01-14");
  });

  it("the ledger tolerates a torn last line", () => {
    const root = makeTempDir("plur1bus-ledger-torn-");
    mkdirSync(join(root, "agent-a"), { recursive: true });
    writeFileSync(join(root, "agent-a", "ledger.jsonl"), `${JSON.stringify({ v: 1, runId: "a", job: "gc-run", outcome: "completed" })}\n{"v":1,"runId":"b"`);
    const ledger = createJobLedger({ root, agentId: "agent-a", logger: createStubHost().logger });
    assert.deepEqual(ledger.readAll().map((r) => r.runId), ["a"]);
  });
});

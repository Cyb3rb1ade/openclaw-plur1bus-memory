/**
 * tests/engine-jobs-ledger.test.js — PR-08 part 1.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { createJobRegistry, sweepKey } from "../engine/jobs/job-registry.js";
import { createJobLedger } from "../engine/jobs/job-ledger.js";
import { createStubHost } from "../lib/host-services.js";
import { readRuntimeSources } from "./helpers/runtime-sources.js";
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

  // ---- Fix round 1 ----------------------------------------------------

  it("survives a torn ledger tail when crash-recovery appends the row for that very run (fix round 1)", async () => {
    const root = makeTempDir("plur1bus-ledger-torn-crash-");
    mkdirSync(join(root, "agent-a", "running"), { recursive: true });
    writeFileSync(
      join(root, "agent-a", "ledger.jsonl"),
      `${JSON.stringify({ v: 1, runId: "a", job: "gc-run", outcome: "completed" })}\n{"v":1,"runId":"b","job":"rem-dream","outcome":"comple`,
    );
    writeFileSync(
      join(root, "agent-a", "running", "b.started"),
      JSON.stringify({ runId: "b", job: "rem-dream", phase: "rem", trigger: "cron", startedAt: Date.UTC(2026, 0, 12, 1, 15) }),
    );
    const { jobs } = registry(root);
    jobs.bind("gc-run", async () => ({}));
    await jobs.run("gc-run", "agent-a");
    const ledger = createJobLedger({ root, agentId: "agent-a", logger: createStubHost().logger });
    const rows = ledger.readAll();
    assert.deepEqual(rows.map((r) => [r.runId, r.outcome, r.reason ?? null]), [
      ["a", "completed", null],
      ["b", "failed", "crash"],
      ["run-1", "completed", null],
    ]);
    const rawLines = readFileSync(join(root, "agent-a", "ledger.jsonl"), "utf8").split("\n").filter((l) => l.trim());
    const unparseable = rawLines.filter((line) => {
      try {
        JSON.parse(line);
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(unparseable.length, 1, "the torn fragment stays as exactly one unparseable line");
    assert.equal(existsSync(join(root, "agent-a", "running", "b.started")), false);
  });

  it("resolves failed/ledger_unwritable instead of rejecting for an invalid agentId (fix round 1)", async () => {
    const root = makeTempDir("plur1bus-ledger-badagent-");
    const warned = [];
    const { jobs } = registry(root, { logger: { warn: (m) => warned.push(m) } });
    jobs.bind("gc-run", async () => ({}));
    const run = await jobs.run("gc-run", "../not-a-safe-agent-id");
    assert.deepEqual([run.outcome, run.reason], ["failed", "ledger_unwritable"]);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /ledger unwritable/);
  });

  it("records a corrupt marker as crash with trigger:null and names the corruption (fix round 1)", async () => {
    const root = makeTempDir("plur1bus-ledger-corrupt-marker-");
    mkdirSync(join(root, "agent-a", "running"), { recursive: true });
    writeFileSync(join(root, "agent-a", "running", "bad-run.started"), "{not json");
    const warned = [];
    const { jobs } = registry(root, { logger: { warn: (m) => warned.push(m) } });
    jobs.bind("gc-run", async () => ({}));
    await jobs.run("gc-run", "agent-a");
    const ledger = createJobLedger({ root, agentId: "agent-a", logger: createStubHost().logger });
    const crashRow = ledger.readAll().find((r) => r.runId === "bad-run");
    assert.ok(crashRow, "a corrupt marker must still produce a crash row");
    assert.deepEqual([crashRow.outcome, crashRow.reason, crashRow.trigger], ["failed", "crash", null]);
    assert.ok(warned.some((m) => /corrupt/i.test(m)), "the warning must name the marker as corrupt");
  });

  it("warns distinctly when only marker removal fails after a successful append (fix round 1)", async () => {
    const root = makeTempDir("plur1bus-ledger-marker-rm-fail-");
    const warned = [];
    const { jobs } = registry(root, { logger: { warn: (m) => warned.push(m) } });
    const markerPath = join(root, "agent-a", "running", "run-1.started");
    jobs.bind("gc-run", async () => {
      // Replace the marker file with a non-empty directory so removing it
      // by that same path fails with something other than ENOENT once the
      // run finishes — the append itself must still succeed independently.
      unlinkSync(markerPath);
      mkdirSync(markerPath);
      writeFileSync(join(markerPath, "keep"), "x");
      return {};
    });
    const run = await jobs.run("gc-run", "agent-a");
    assert.equal(run.outcome, "completed");
    const rows = rowsOf(root, "agent-a");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "completed");
    assert.equal(warned.length, 1);
    assert.match(warned[0], /marker could not be removed/);
    assert.doesNotMatch(warned[0], /append failed/);
  });

  it("retries recovery on the next run() after a failed pass instead of marking the agent permanently recovered (fix round 1)", async () => {
    const root = makeTempDir("plur1bus-ledger-recover-retry-");
    mkdirSync(join(root, "agent-a", "running"), { recursive: true });
    writeFileSync(
      join(root, "agent-a", "running", "orphan-1.started"),
      JSON.stringify({ runId: "orphan-1", job: "rem-dream", phase: "rem", trigger: "cron", startedAt: Date.UTC(2026, 0, 12, 1, 15) }),
    );
    // Force the first recovery pass to fail before it even reaches the
    // orphan marker: ledger.jsonl is a directory, so readAll()'s read throws.
    mkdirSync(join(root, "agent-a", "ledger.jsonl"));
    const { jobs } = registry(root);
    jobs.bind("gc-run", async () => ({}));
    const first = await jobs.run("gc-run", "agent-a");
    assert.deepEqual([first.outcome, first.reason], ["failed", "ledger_unwritable"]);
    assert.equal(existsSync(join(root, "agent-a", "running", "orphan-1.started")), true, "a failed recovery pass must not consume the marker");
    rmSync(join(root, "agent-a", "ledger.jsonl"), { recursive: true, force: true });
    const second = await jobs.run("gc-run", "agent-a");
    assert.equal(second.outcome, "completed");
    const ledger = createJobLedger({ root, agentId: "agent-a", logger: createStubHost().logger });
    const rows = ledger.readAll().map((r) => [r.runId, r.outcome, r.reason ?? null]).sort();
    assert.deepEqual(rows, [["orphan-1", "failed", "crash"], ["run-2", "completed", null]]);
    assert.equal(existsSync(join(root, "agent-a", "running", "orphan-1.started")), false);
  });

  // ---- Fix round 2 -----------------------------------------------------

  it("an undeletable orphan marker never blocks recovery: crash row written once, later runs execute normally (fix round 2)", async () => {
    const root = makeTempDir("plur1bus-ledger-undeletable-marker-");
    mkdirSync(join(root, "agent-a", "running"), { recursive: true });
    // A directory where a `.started` marker file should be: orphanMarkers()
    // still lists it (readFileSync throws, so it comes back `corrupt: true`),
    // but removeMarker()'s unlinkSync fails with EISDIR, not ENOENT — the
    // exact case that must no longer abort the recovery pass.
    mkdirSync(join(root, "agent-a", "running", "orphan-1.started"));
    writeFileSync(join(root, "agent-a", "running", "orphan-1.started", "keep"), "x");
    const warned = [];
    const { jobs } = registry(root, { logger: { warn: (m) => warned.push(m) } });
    jobs.bind("gc-run", async () => ({}));
    for (let i = 0; i < 3; i++) {
      const run = await jobs.run("gc-run", "agent-a");
      assert.equal(run.outcome, "completed", `run ${i + 1} must execute the body normally, not fail on ledger_unwritable`);
    }
    const ledger = createJobLedger({ root, agentId: "agent-a", logger: createStubHost().logger });
    const rows = ledger.readAll();
    const crashRows = rows.filter((r) => r.runId === "orphan-1");
    assert.equal(crashRows.length, 1, "the crash row for the undeletable marker must be written exactly once");
    assert.deepEqual([crashRows[0].outcome, crashRows[0].reason], ["failed", "crash"]);
    const removalWarnings = warned.filter((m) => /could not be removed/.test(m));
    assert.equal(removalWarnings.length, 1, "the removal failure is warned once, not on every later run");
    // Untouched — but harmless, since its crash row is already durable.
    assert.equal(existsSync(join(root, "agent-a", "running", "orphan-1.started")), true);
  });

  it("warns once per agent for a persistently unwritable ledger, then drops to debug (fix round 2)", async () => {
    const parent = makeTempDir("plur1bus-ledger-warnonce-");
    const root = join(parent, "not-a-dir");
    writeFileSync(root, "occupied");
    const warned = [];
    const debugged = [];
    const { jobs } = registry(root, { logger: { warn: (m) => warned.push(m), debug: (m) => debugged.push(m) } });
    jobs.bind("gc-run", async () => ({}));
    for (let i = 0; i < 3; i++) {
      const run = await jobs.run("gc-run", "agent-a");
      assert.deepEqual([run.outcome, run.reason], ["failed", "ledger_unwritable"]);
    }
    assert.equal(warned.length, 1);
    assert.match(warned[0], /ledger unwritable/);
    assert.equal(debugged.length, 2);
    // The latch is per agent, not global.
    const runB = await jobs.run("gc-run", "agent-b");
    assert.deepEqual([runB.outcome, runB.reason], ["failed", "ledger_unwritable"]);
    assert.equal(warned.length, 2);
  });

  it("never swallows a marker-removal failure silently: every catch around removeMarker logs (final review m1)", () => {
    const { engine } = readRuntimeSources();
    const source = engine.jobRegistry;
    assert.doesNotMatch(source, /catch\s*\{/, "no bare catch without a binding in the registry");
    const removals = [...source.matchAll(/ledger\.removeMarker\([^)]*\);\s*\}\s*catch\s*\((\w+)\)\s*\{([\s\S]*?)\n\s*\}/g)];
    assert.ok(removals.length >= 3, `found ${removals.length} guarded removeMarker calls`);
    for (const [, name, body] of removals) {
      assert.match(body, /host\.logger\.(debug|warn)\(/, "the failure is logged");
      assert.ok(body.includes(name), "with its error");
    }
  });
});

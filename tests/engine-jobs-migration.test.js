/**
 * tests/engine-jobs-migration.test.js — PR-08 part 3.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrateRunStateCompletions, MIGRATION_MARKER_KEY } from "../engine/jobs/run-state-migration.js";
import { createJobRegistry } from "../engine/jobs/job-registry.js";
import { ledgerBackedCompletion } from "../engine/jobs/rem-outcome.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "jobs", "run-state.json");

function fakeStore() {
  const dir = makeTempDir("plur1bus-migrate-");
  const runs = join(dir, "run-state.json");
  copyFileSync(FIXTURE, runs);
  return {
    paths: { runs },
    writeRunState: (state) => writeFileSync(runs, JSON.stringify(state)),
  };
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

describe("run-state migration", () => {
  it("imports only this agent's rem keys as completed rows, keeps a copy, and marks the file", () => {
    const store = fakeStore();
    const rows = [];
    const result = migrateRunStateCompletions({ store, agentId: "agent-a", appendRow: (r) => rows.push(r), clock: () => Date.UTC(2026, 0, 13), logger: quiet });
    assert.deepEqual(result, { migrated: 2, status: "migrated" });
    assert.deepEqual(rows.map((r) => r.idempotencyKey).sort(), [
      "rem:workspace:v1:main:agent-a:private:2026-W01",
      "rem:workspace:v1:main:agent-a:workspace:2026-W01",
    ]);
    for (const row of rows) {
      assert.equal(row.outcome, "completed");
      assert.equal(row.migrated, true);
      assert.deepEqual(row.cost, { ms: 0 });
      assert.deepEqual(row.keys, [row.idempotencyKey]);
      assert.equal(row.job, "rem-dream");
    }
    assert.equal(rows.find((r) => r.idempotencyKey.endsWith("private:2026-W01")).startedAt, Date.parse("2026-01-06T00:20:11.000Z"));
    assert.equal(readFileSync(`${store.paths.runs}.migrated`, "utf8"), readFileSync(FIXTURE, "utf8"));
    const after = JSON.parse(readFileSync(store.paths.runs, "utf8"));
    assert.ok(after[MIGRATION_MARKER_KEY]["agent-a"]);
    assert.deepEqual(after.memoryDynamics, JSON.parse(readFileSync(FIXTURE, "utf8")).memoryDynamics, "neighbours untouched");
    assert.ok(after.completed["reflect:agent-a:2026-01-05"], "other jobs' completions untouched");
  });

  it("is a no-op the second time for the same agent, and still migrates another agent", () => {
    const store = fakeStore();
    const rows = [];
    const args = { store, appendRow: (r) => rows.push(r), clock: () => 1, logger: quiet };
    migrateRunStateCompletions({ ...args, agentId: "agent-a" });
    assert.deepEqual(migrateRunStateCompletions({ ...args, agentId: "agent-a" }), { migrated: 0, status: "already" });
    assert.deepEqual(migrateRunStateCompletions({ ...args, agentId: "agent-b" }), { migrated: 1, status: "migrated" });
  });

  it("a corrupt run-state.json imports nothing, is not rewritten, and is preserved (Review Focus 3)", () => {
    const store = fakeStore();
    writeFileSync(store.paths.runs, "{\"completed\": {\"rem:x");
    const warned = [];
    const result = migrateRunStateCompletions({ store, agentId: "agent-a", appendRow: () => assert.fail("no rows"), clock: () => 1, logger: { ...quiet, warn: (m) => warned.push(m) } });
    assert.deepEqual(result, { migrated: 0, status: "corrupt" });
    assert.equal(readFileSync(store.paths.runs, "utf8"), "{\"completed\": {\"rem:x");
    assert.equal(readFileSync(`${store.paths.runs}.migrated`, "utf8"), "{\"completed\": {\"rem:x");
    assert.equal(warned.length, 1);
  });

  it("an absent file is absent", () => {
    const dir = makeTempDir("plur1bus-migrate-none-");
    const store = { paths: { runs: join(dir, "run-state.json") }, writeRunState: () => assert.fail("no write") };
    assert.deepEqual(migrateRunStateCompletions({ store, agentId: "agent-a", appendRow: () => {}, clock: () => 1, logger: quiet }), { migrated: 0, status: "absent" });
    assert.equal(existsSync(`${store.paths.runs}.migrated`), false);
  });
});

describe("migration through the REM wrapper", () => {
  it("keeps a finished week already_processed across the upgrade", async () => {
    const store = { ...fakeStore(), aclBindings: { scope: "agent" }, markRunCompleted: () => {} };
    const jobs = createJobRegistry({ host: createStubHost({ clock: () => Date.UTC(2026, 0, 13) }), jobsRoot: makeTempDir("plur1bus-migrate-ledger-") });
    let seen = null;
    jobs.bind("rem-dream", async (_n, ctx) => {
      const wrapped = ledgerBackedCompletion(Object.freeze(store), ctx);
      seen = await wrapped.hasCompletedRun("rem:workspace:v1:main:agent-a:private:2026-W01");
      return ctx.skip("already_processed");
    });
    await jobs.run("rem-dream", "agent-a");
    assert.equal(seen, true);
    const history = await jobs.history("agent-a");
    assert.equal(history.filter((r) => r.migrated === true).length, 2);
  });
});

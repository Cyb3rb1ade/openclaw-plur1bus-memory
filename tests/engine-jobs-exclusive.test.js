/**
 * tests/engine-jobs-exclusive.test.js — engine-jobs audit F6.
 *
 * classify-recent (cron every 3 h plus the manual RPC) and a few sibling jobs
 * hold read-modify-write state (the per-run maxPerDay budget, brake state files,
 * the unclassified-card list) with no lock, so two overlapping runs of one
 * agent both read the same candidates and both push. `exclusive` gives them the
 * registry's already_running guard without making them cron singletons.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createJobRegistry } from "../engine/jobs/job-registry.js";
import { JOB_SPECS } from "../engine/jobs/job-specs.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const EXCLUSIVE = ["classify-recent", "afterthought", "persona-evolve", "auto-accept-stale", "emotion-refine"];

function setup() {
  let now = 1_000;
  let n = 0;
  const host = createStubHost({ clock: () => (now += 5) });
  return createJobRegistry({ host, jobsRoot: makeTempDir("plur1bus-excl-"), idFactory: () => `run-${++n}` });
}

function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { opened, open };
}

describe("exclusive jobs (F6)", () => {
  it("the spec table marks exactly the unlocked read-modify-write jobs, none of them a cron singleton", () => {
    const exclusive = JOB_SPECS.filter((s) => s.exclusive).map((s) => s.name).sort();
    assert.deepEqual(exclusive, [...EXCLUSIVE].sort());
    for (const spec of JOB_SPECS.filter((s) => s.exclusive)) assert.equal(spec.singleton, false, spec.name);
  });

  for (const name of EXCLUSIVE) {
    it(`${name}: an overlapping run for the same agent runs no second body`, async () => {
      const jobs = setup();
      const { opened, open } = gate();
      let bodies = 0;
      jobs.bind(name, async () => { bodies += 1; await opened; return { text: "ok" }; });
      const pending = [jobs.run(name, "agent-a", { trigger: "cron" }), jobs.run(name, "agent-a", { trigger: "manual" }), jobs.run(name, "agent-b", { trigger: "cron" })];
      await new Promise((resolve) => setTimeout(resolve, 20));
      open();
      const runs = await Promise.all(pending);
      assert.equal(bodies, 2, "one body per agent");
      assert.deepEqual(runs.map((r) => [r.agentId, r.outcome, r.reason ?? null]), [["agent-a", "completed", null], ["agent-a", "skipped", "already_running"], ["agent-b", "completed", null]]);
      assert.equal((await jobs.run(name, "agent-a")).outcome, "completed", "the guard is released when the run finishes");
    });
  }

  it("a skipped overlapping cron run is silent (NO_REPLY), a manual one reports the reason as JSON", async () => {
    const jobs = setup();
    const { opened, open } = gate();
    jobs.bind("classify-recent", async () => { await opened; return { text: "ok" }; });
    const pending = [
      jobs.run("classify-recent", "agent-a", { trigger: "cron" }),
      jobs.run("classify-recent", "agent-a", { trigger: "cron" }),
      jobs.run("classify-recent", "agent-a", { trigger: "manual" }),
    ];
    await new Promise((resolve) => setTimeout(resolve, 20));
    open();
    const runs = await Promise.all(pending);
    assert.equal(runs[1].output.text, "NO_REPLY", "the cron delivery must not relay a skip notice");
    assert.deepEqual(JSON.parse(runs[2].output.text), { job: "classify-recent", skipped: true, reason: "already_running" });
  });

  it("a failing body releases the guard", async () => {
    const jobs = setup();
    let calls = 0;
    jobs.bind("classify-recent", async () => { calls += 1; if (calls === 1) throw new Error("boom"); return { text: "ok" }; });
    assert.equal((await jobs.run("classify-recent", "agent-a")).outcome, "failed");
    assert.equal((await jobs.run("classify-recent", "agent-a")).outcome, "completed");
  });

  it("a preSkip run does not take the guard and is not displaced by a running body", async () => {
    const jobs = setup();
    const { opened, open } = gate();
    jobs.bind("classify-recent", async () => { await opened; return { text: "ok" }; });
    const running = jobs.run("classify-recent", "agent-a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const refused = await jobs.run("classify-recent", "agent-a", { preSkip: { reason: "workspace_disabled", output: { text: "NO_REPLY" } } });
    assert.equal(refused.reason, "workspace_disabled");
    open();
    assert.equal((await running).outcome, "completed");
  });

  it("non-exclusive jobs stay concurrent", async () => {
    const jobs = setup();
    const { opened, open } = gate();
    let bodies = 0;
    jobs.bind("feedback-report", async () => { bodies += 1; await opened; return { text: "ok" }; });
    const pending = [jobs.run("feedback-report", "agent-a"), jobs.run("feedback-report", "agent-a")];
    await new Promise((resolve) => setTimeout(resolve, 20));
    open();
    await Promise.all(pending);
    assert.equal(bodies, 2);
  });
});

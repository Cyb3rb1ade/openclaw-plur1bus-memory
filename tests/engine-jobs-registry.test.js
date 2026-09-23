/**
 * tests/engine-jobs-registry.test.js — PR-07.
 *
 * The registry holds the contract's 18 names with one owner each, and every
 * run — completed, skipped, incomplete, thrown — comes back as a JobRun.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { INTERNAL_JOB_NAMES, JOB_NAMES, JOB_SPECS } from "../engine/jobs/job-specs.js";
import { createJobRegistry } from "../engine/jobs/job-registry.js";
import { createPlur1busCommandRunner } from "../engine/commands/plur1bus-command.js";
import { createStubHost } from "../lib/host-services.js";
import plugin from "../index.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const CONTRACT_JOB_NAMES = [
  "persona-evolve", "afterthought", "consolidate-daily", "auto-accept-stale",
  "embedding-drain", "emotion-refine", "classify-recent", "rem-dream",
  "skill-miner", "discover-semantic-links", "gc-run",
  "reminder-dispatch", "feedback-report", "proactive-check", "meta-reflect",
  "skill-benefit-backfill", "episodes-rebuild",
  "light-dream",
];

function stubHost(events = []) {
  let now = 1_000;
  return createStubHost({ clock: () => (now += 5), events: { emit: (name, payload) => events.push({ name, payload }) } });
}

describe("job specs", () => {
  it("are exactly the contract's 18 names", () => {
    assert.deepEqual(JOB_NAMES, CONTRACT_JOB_NAMES);
    assert.equal(INTERNAL_JOB_NAMES.length, 17);
    assert.ok(!INTERNAL_JOB_NAMES.includes("light-dream"));
  });

  it("carry phases, the gc-run singleton and the cron defaults", () => {
    const byName = new Map(JOB_SPECS.map((s) => [s.name, s]));
    assert.equal(byName.get("light-dream").phase, "light");
    assert.equal(byName.get("rem-dream").phase, "rem");
    assert.equal(byName.get("consolidate-daily").phase, "deep");
    assert.equal(byName.get("gc-run").singleton, true);
    assert.equal(byName.get("persona-evolve").singleton, false);
    assert.deepEqual(byName.get("rem-dream").defaultSchedule, { kind: "cron", expr: "15 1 * * *", timezone: "Europe/Berlin" });
    assert.deepEqual(byName.get("emotion-refine").defaultSchedule, { kind: "every", expr: "3600000" });
    assert.equal(byName.get("meta-reflect").defaultSchedule, undefined);
  });
});

describe("createJobRegistry", () => {
  it("returns a JobRun for all 18 names, including the skip path", async () => {
    const events = [];
    const jobs = createJobRegistry({ host: stubHost(events), idFactory: (() => { let n = 0; return () => `run-${++n}`; })() });
    for (const name of JOB_NAMES) jobs.bind(name, async (_n, ctx) => ctx.skip("test_skip", { text: name }));
    for (const name of JOB_NAMES) {
      const run = await jobs.run(name, "agent-a", { trigger: "harness" });
      assert.equal(run.job, name);
      assert.equal(run.outcome, "skipped");
      assert.equal(run.reason, "test_skip");
      assert.equal(run.output.text, name);
      assert.equal(run.trigger, "harness");
      assert.equal(run.attempt, 1);
      assert.ok(run.finishedAt >= run.startedAt);
    }
    assert.equal(events.filter((e) => e.name === "job.run").length, 18);
  });

  it("maps completed, incomplete and thrown bodies", async () => {
    const jobs = createJobRegistry({ host: stubHost() });
    jobs.bind("gc-run", async () => ({ text: "done" }));
    jobs.bind("rem-dream", async (_n, ctx) => ctx.incomplete("no_narrative", { text: "open" }));
    const boom = new TypeError("boom");
    jobs.bind("skill-miner", async () => { throw boom; });
    const completed = await jobs.run("gc-run", "a");
    assert.equal(completed.outcome, "completed");
    assert.equal(completed.output.text, "done");
    assert.equal(completed.phase, null);
    const incomplete = await jobs.run("rem-dream", "a");
    assert.deepEqual([incomplete.outcome, incomplete.reason, incomplete.phase], ["incomplete", "no_narrative", "rem"]);
    const failed = await jobs.run("skill-miner", "a");
    assert.deepEqual([failed.outcome, failed.reason], ["failed", "error:TypeError"]);
    assert.equal(failed.error, boom);
    assert.equal(Object.keys(failed).includes("error"), false, "error is not enumerable");
  });

  it("enforces one owner per name and rejects unknown names", async () => {
    const jobs = createJobRegistry({ host: stubHost() });
    jobs.bind("gc-run", async () => ({}));
    assert.throws(() => jobs.bind("gc-run", async () => ({})), /already has an owner/);
    assert.throws(() => jobs.bind("nope", async () => ({})), /unknown job/);
    await assert.rejects(() => jobs.run("nope", "a"), /unknown job/);
    const unowned = await jobs.run("meta-reflect", "a");
    assert.deepEqual([unowned.outcome, unowned.reason], ["skipped", "no_owner"]);
  });

  it("honours preSkip and a defaultInput that pre-skips", async () => {
    const jobs = createJobRegistry({ host: stubHost() });
    let called = 0;
    jobs.bind("gc-run", async () => { called += 1; return {}; }, {
      defaultInput: async () => ({ preSkip: { reason: "workspace_disabled", output: { text: "NO_REPLY" } } }),
    });
    const pre = await jobs.run("gc-run", "a", { preSkip: { reason: "policy", output: { text: "NO_REPLY" } } });
    assert.deepEqual([pre.outcome, pre.reason, pre.output.text], ["skipped", "policy", "NO_REPLY"]);
    const viaDefault = await jobs.run("gc-run", "a");
    assert.equal(viaDefault.reason, "workspace_disabled");
    assert.equal(called, 0);
  });
});

describe("/plur1bus internal goes through jobs.run", () => {
  it("every internal name emits one job.run, with the expected skip reasons", async () => {
    const baseDbPath = makeTempDir("plur1bus-jobs-db-");
    const workspaceDir = makeTempDir("plur1bus-jobs-ws-");
    const commands = [];
    const events = [];
    const noop = () => {};
    const api = {
      pluginConfig: {
        baseDbPath,
        embedding: { provider: "local-transformers", local: { dimensions: 384 } },
        autoCapture: false, autoRecall: false,
        neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
        merging: { enabled: false }, skillMiner: { enabled: false }, afterthought: { enabled: false },
        dailyConsolidation: { enabled: false }, criticalPush: { enabled: false },
      },
      logger: { info: noop, warn: noop, error: noop, debug: noop },
      runtime: { agent: { async resolveAgentWorkspaceDir() { return workspaceDir; } } },
      resolvePath: (p) => p,
      registerCommand(command) { commands.push(command); },
      registerTool: noop, registerService: noop, on: noop,
    };
    plugin.register(api, {
      importRouting: async () => ({
        parseAgentSessionKey: (v) => { const m = /^agent:([^:]+):(.+)$/.exec(v); return m ? { agentId: m[1], rest: m[2] } : null; },
        parseThreadSessionSuffix: (v) => ({ baseSessionKey: v, threadId: "" }),
        normalizeOptionalAccountId: (v) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : undefined),
        normalizeMessageChannel: (v) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : undefined),
      }),
      hostEvents: { emit: (name, payload) => events.push({ name, payload }) },
    });
    const command = commands.find((c) => c.name === "plur1bus");
    const expectedSkips = {
      "consolidate-daily": "dailyConsolidation_disabled",
      "classify-recent": "criticalPush_disabled",
      "rem-dream": "no_llm_config",
      "skill-miner": "not_configured",
      "skill-benefit-backfill": "not_configured",
      afterthought: "disabled",
      "episodes-rebuild": "neo_disabled",
      "gc-run": "gc_disabled",
      "embedding-drain": "neo_disabled",
      "feedback-report": "no_workspace",
      "proactive-check": "no_workspace",
      "meta-reflect": "no_workspace",
    };
    for (const name of INTERNAL_JOB_NAMES) {
      const before = events.length;
      await command.handler({ agentId: "agent-a", channel: "cron", sessionKey: "agent:agent-a:cron:test", args: `internal ${name}`, config: {} });
      const runs = events.slice(before).filter((e) => e.name === "job.run");
      assert.equal(runs.length, 1, `${name} emitted ${runs.length} job.run events`);
      assert.equal(runs[0].payload.job, name);
      assert.equal(runs[0].payload.trigger, "cron");
      if (expectedSkips[name]) {
        assert.deepEqual([runs[0].payload.outcome, runs[0].payload.reason], ["skipped", expectedSkips[name]], name);
      }
    }
  });
});

// Fix round 1 — a harness-triggered run (no explicit `input`) goes through
// createPlur1busCommandRunner's `defaultInput`, which must supply everything
// the moved job bodies destructure from `jobCtx.input` (including `id` and
// `tokens`, which episodes-rebuild slices) and must resolve `workspaceDir`
// from the host so feedback-report/proactive-check/meta-reflect are not
// permanently `no_workspace` outside the command path.
describe("createPlur1busCommandRunner defaultInput (fix round 1)", () => {
  function noopLogger() {
    return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  }

  it("backs a harness-triggered episodes-rebuild without a TypeError on tokens/id", async () => {
    const jobs = createJobRegistry({ host: createStubHost() });
    const neoStoreStub = { readEpisodes: () => [], readTurns: () => [], readHooks: () => ({}) };
    createPlur1busCommandRunner({
      jobs,
      host: { config: () => ({}), workspaceDir: async () => "/tmp/plur1bus-episodes-rebuild-ws", logger: noopLogger() },
      checkArgsLength: () => null,
      parsePlur1busArgs: () => [],
      isCronCommandContext: () => false,
      resolveCronMemoryContext: async (commandCtx) => ({ agentId: commandCtx.agentId, workspaceDir: commandCtx.workspaceDir, workspaceIdentity: "ws" }),
      resolveRegisteredMemoryContext: async () => ({}),
      workspacePolicyGuard: { decision: () => ({ allowed: true }) },
      getNeoStore: () => neoStoreStub,
      neoEnabled: true,
      mergingEnabled: false,
      formatJsonCommandResult: (x) => x,
      callLlm: async () => "",
    });
    const run = await jobs.run("episodes-rebuild", "agent-a", { trigger: "harness" });
    assert.equal(run.outcome, "completed", run.outcome === "failed" ? String(run.error) : undefined);
    assert.equal(run.output.job, "episodes-rebuild");
  });

  it("resolves workspaceDir from the host for a harness-triggered job", async () => {
    const jobs = createJobRegistry({ host: createStubHost() });
    const capturedCommandCtx = [];
    createPlur1busCommandRunner({
      jobs,
      host: { config: () => ({}), workspaceDir: async (agentId) => `/ws/${agentId}`, logger: noopLogger() },
      checkArgsLength: () => null,
      parsePlur1busArgs: () => [],
      isCronCommandContext: () => false,
      resolveCronMemoryContext: async (commandCtx) => {
        capturedCommandCtx.push(commandCtx);
        return { agentId: commandCtx.agentId, workspaceDir: commandCtx.workspaceDir, workspaceIdentity: "ws" };
      },
      resolveRegisteredMemoryContext: async () => ({}),
      workspacePolicyGuard: { decision: () => ({ allowed: true }) },
      getNeoStore: () => ({}),
    });
    await jobs.run("gc-run", "agent-x", { trigger: "harness" });
    assert.equal(capturedCommandCtx.length, 1);
    assert.equal(capturedCommandCtx[0].workspaceDir, "/ws/agent-x");
  });
});

// Fix round 1, controller ruling — a non-cron caller never produces a job
// record for a workspace-policy refusal; only a verified cron-internal call
// is recorded (job.run + skip log). The reply is identical either way.
describe("/plur1bus internal policy refusal recording (fix round 1)", () => {
  function makeRefusalCtx(jobs) {
    return {
      jobs,
      checkArgsLength: () => null,
      parsePlur1busArgs: () => [],
      obsidianActionNames: new Set(),
      knownPlur1busActions: new Set(["internal"]),
      isCronCommandContext: (commandCtx) => commandCtx.channel === "cron",
      resolveCronMemoryContext: async () => ({ agentId: "agent-a", workspaceIdentity: "ws" }),
      resolveRegisteredMemoryContext: async () => ({ agentId: "agent-a", workspaceIdentity: "ws" }),
      workspacePolicyGuard: { decision: () => ({ allowed: false, reason: "workspace_disabled" }) },
    };
  }

  it("records no job.run and returns the refusal directly for a non-cron caller", async () => {
    const runCalls = [];
    const jobs = { bind: () => {}, run: async (...args) => { runCalls.push(args); return { output: { text: "must-not-be-used" } }; } };
    const runner = createPlur1busCommandRunner(makeRefusalCtx(jobs));
    const result = await runner({ channel: "telegram", agentId: "agent-a" }, ["internal", "gc-run"]);
    assert.deepEqual(result, { text: "NO_REPLY", metadata: { skipped: true, reason: "workspace_disabled" } });
    assert.equal(runCalls.length, 0);
  });

  it("records the refusal via jobs.run for a cron-internal caller", async () => {
    const runCalls = [];
    const jobs = {
      bind: () => {},
      run: async (name, agentId, opts) => {
        runCalls.push({ name, agentId, opts });
        return { output: opts.preSkip.output };
      },
    };
    const runner = createPlur1busCommandRunner(makeRefusalCtx(jobs));
    const result = await runner({ channel: "cron", agentId: "agent-a" }, ["internal", "gc-run"]);
    assert.deepEqual(result, { text: "NO_REPLY", metadata: { skipped: true, reason: "workspace_disabled" } });
    assert.equal(runCalls.length, 1);
    assert.equal(runCalls[0].name, "gc-run");
    assert.equal(runCalls[0].agentId, "agent-a");
    assert.equal(runCalls[0].opts.trigger, "cron");
    assert.deepEqual(runCalls[0].opts.preSkip, {
      reason: "workspace_disabled",
      output: { text: "NO_REPLY", metadata: { skipped: true, reason: "workspace_disabled" } },
    });
  });
});

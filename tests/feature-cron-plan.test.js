import { describe, it } from "node:test";
import assert from "node:assert";
import {
  REQUIRED_FEATURE_CRONS,
  planFeatureCrons,
  deriveAgentDelivery,
  selectAgentsForCronSetup,
  staggerPersonaEvolveSchedule,
} from "../lib/setup/feature-cron-plan.js";

describe("REQUIRED_FEATURE_CRONS", () => {
  it("declares persona-evolve (weekly, no delivery) and afterthought (every 30m, needs delivery)", () => {
    assert.strictEqual(REQUIRED_FEATURE_CRONS.length, 2);
    const personaEvolve = REQUIRED_FEATURE_CRONS.find((s) => s.name.includes("persona-evolve"));
    const afterthought = REQUIRED_FEATURE_CRONS.find((s) => s.name.includes("afterthought"));
    assert.ok(personaEvolve, "persona-evolve spec present");
    assert.ok(afterthought, "afterthought spec present");

    assert.strictEqual(personaEvolve.needsDelivery, false);
    assert.match(personaEvolve.command, /\/plur1bus internal persona-evolve/);
    assert.strictEqual(personaEvolve.schedule.kind, "cron");
    // Low-traffic weekly slot (Sunday).
    assert.match(personaEvolve.schedule.expr, /^\S+\s+\S+\s+\S+\s+\S+\s+0$/);

    assert.strictEqual(afterthought.needsDelivery, true);
    assert.match(afterthought.command, /\/plur1bus internal afterthought/);
    assert.strictEqual(afterthought.schedule.kind, "every");
    assert.strictEqual(afterthought.schedule.everyMs, 30 * 60 * 1000);
    // README delivery contract must be embedded in the agent message.
    assert.match(afterthought.message, /text/);
    assert.match(afterthought.message, /skipped/i);
    assert.match(afterthought.message, /NOTHING|nothing/);
  });
});

describe("planFeatureCrons", () => {
  const personaSpec = {
    name: "plur1bus persona-evolve",
    command: "/plur1bus internal persona-evolve",
    message: "/plur1bus internal persona-evolve",
    schedule: { kind: "cron", expr: "15 4 * * 0" },
    needsDelivery: false,
  };
  const afterthoughtSpec = {
    name: "plur1bus afterthought",
    command: "/plur1bus internal afterthought",
    message: "/plur1bus internal afterthought (send text verbatim; output NOTHING on skipped)",
    schedule: { kind: "every", everyMs: 30 * 60 * 1000 },
    needsDelivery: true,
  };
  const specs = [personaSpec, afterthoughtSpec];

  it("plans both specs as creates when no existing jobs match", () => {
    const plan = planFeatureCrons([], specs);
    assert.strictEqual(plan.create.length, 2);
    assert.strictEqual(plan.skip.length, 0);
  });

  it("is idempotent: skips a job matching by name (case-insensitive substring)", () => {
    const existing = [{ name: "PLUR1BUS Persona-Evolve (weekly)", payload: { message: "whatever" } }];
    const plan = planFeatureCrons(existing, specs);
    assert.strictEqual(plan.create.length, 1);
    assert.strictEqual(plan.create[0].name, afterthoughtSpec.name);
    assert.strictEqual(plan.skip.length, 1);
    assert.strictEqual(plan.skip[0].spec.name, personaSpec.name);
    assert.match(plan.skip[0].reason, /already|exist/i);
  });

  it("is idempotent: skips a job matching by payload message containing the internal command", () => {
    const existing = [{ name: "my-custom-afterthought-job", payload: { message: "/plur1bus internal afterthought" } }];
    const plan = planFeatureCrons(existing, specs);
    assert.strictEqual(plan.create.length, 1);
    assert.strictEqual(plan.create[0].name, personaSpec.name);
    assert.strictEqual(plan.skip.length, 1);
    assert.strictEqual(plan.skip[0].spec.name, afterthoughtSpec.name);
  });

  it("plans a non-delivery spec as enabled without agent/account", () => {
    const plan = planFeatureCrons([], [personaSpec]);
    assert.strictEqual(plan.create[0].enabled, true);
    assert.strictEqual(plan.create[0].hint, undefined);
  });

  it("plans a needsDelivery spec as disabled with a hint when no agent/account is given", () => {
    const plan = planFeatureCrons([], [afterthoughtSpec]);
    assert.strictEqual(plan.create[0].enabled, false);
    assert.ok(typeof plan.create[0].hint === "string" && plan.create[0].hint.length > 0);
    assert.match(plan.create[0].hint, /cron edit/);
    assert.match(plan.create[0].hint, /--agent/);
    assert.match(plan.create[0].hint, /--account/);
  });

  it("plans a needsDelivery spec as enabled when agent is given", () => {
    const plan = planFeatureCrons([], [afterthoughtSpec], { agent: "main" });
    assert.strictEqual(plan.create[0].enabled, true);
    assert.strictEqual(plan.create[0].agent, "main");
    assert.strictEqual(plan.create[0].hint, undefined);
  });

  it("plans a needsDelivery spec as disabled with a hint when only account is given (no agent) — --account alone never yields a concrete --to, so --announce would resolve to the runtime 'last'-chat fallback and could silently mis-deliver", () => {
    const plan = planFeatureCrons([], [afterthoughtSpec], { account: "telegram-main" });
    assert.strictEqual(plan.create[0].enabled, false);
    assert.strictEqual(plan.create[0].account, "telegram-main");
    assert.ok(typeof plan.create[0].hint === "string" && plan.create[0].hint.length > 0);
  });

  it("passes agent/account through onto every created job", () => {
    const plan = planFeatureCrons([], specs, { agent: "bernhardine", account: "telegram-bernhardine" });
    for (const job of plan.create) {
      assert.strictEqual(job.agent, "bernhardine");
      assert.strictEqual(job.account, "telegram-bernhardine");
    }
  });

  it("handles existingJobs with missing payload/message gracefully", () => {
    const existing = [{ name: "unrelated-job" }, { name: null, payload: null }];
    const plan = planFeatureCrons(existing, specs);
    assert.strictEqual(plan.create.length, 2);
  });

  it("does not treat a bare 'plur1bus' job name as matching any spec (tightened from bidirectional substring)", () => {
    const existing = [{ name: "plur1bus", payload: { message: "unrelated" } }];
    const plan = planFeatureCrons(existing, specs);
    assert.strictEqual(plan.create.length, 2, "bare 'plur1bus' job must not satisfy either spec");
    assert.strictEqual(plan.skip.length, 0);
  });

  it("still matches a decorated job name via word-boundary prefix", () => {
    const existing = [{ name: "PLUR1BUS Persona-Evolve (weekly)", payload: { message: "whatever" } }];
    const plan = planFeatureCrons(existing, specs);
    assert.strictEqual(plan.create.length, 1);
    assert.strictEqual(plan.create[0].name, afterthoughtSpec.name);
  });
});

describe("staggerPersonaEvolveSchedule", () => {
  it("is a no-op for agent index 0", () => {
    const base = { kind: "cron", expr: "15 4 * * 0" };
    assert.deepStrictEqual(staggerPersonaEvolveSchedule(base, 0), { kind: "cron", expr: "15 4 * * 0" });
  });

  it("adds agentIndex * 5 minutes deterministically", () => {
    const base = { kind: "cron", expr: "15 4 * * 0" };
    assert.deepStrictEqual(staggerPersonaEvolveSchedule(base, 1), { kind: "cron", expr: "20 4 * * 0" });
    assert.deepStrictEqual(staggerPersonaEvolveSchedule(base, 2), { kind: "cron", expr: "25 4 * * 0" });
    // 9 * 5 = 45 minutes -> 04:15 + 00:45 = 05:00
    assert.deepStrictEqual(staggerPersonaEvolveSchedule(base, 9), { kind: "cron", expr: "0 5 * * 0" });
  });

  it("is deterministic: same inputs always produce the same output", () => {
    const base = { kind: "cron", expr: "15 4 * * 0" };
    const a = staggerPersonaEvolveSchedule(base, 3);
    const b = staggerPersonaEvolveSchedule(base, 3);
    assert.deepStrictEqual(a, b);
  });

  it("leaves non-cron schedules unchanged", () => {
    const every = { kind: "every", everyMs: 1000 };
    assert.deepStrictEqual(staggerPersonaEvolveSchedule(every, 5), every);
  });
});

describe("deriveAgentDelivery", () => {
  it("returns null when the agent has no delivery-capable jobs", () => {
    const jobs = [{ agentId: "bernhardine", name: "x", delivery: { mode: "none" } }];
    assert.strictEqual(deriveAgentDelivery("bernhardine", jobs), null);
  });

  it("returns null for an unknown/absent agent", () => {
    assert.strictEqual(deriveAgentDelivery("nobody", []), null);
    assert.strictEqual(deriveAgentDelivery("", [{ agentId: "main" }]), null);
  });

  it("derives channel+to when all candidate targets agree (no plur1bus-prefixed jobs, accountId included)", () => {
    const jobs = [
      { agentId: "main", name: "disk-space-monitor", delivery: { mode: "announce", channel: "telegram", to: "55736530", accountId: "default" } },
      { agentId: "main", name: "morning-gas-weather-briefing", delivery: { mode: "announce", channel: "telegram", to: "55736530", accountId: "default" } },
    ];
    const result = deriveAgentDelivery("main", jobs);
    assert.deepStrictEqual(result, { channel: "telegram", to: "55736530", accountId: "default" });
  });

  it("omits accountId when candidates disagree on it but agree on channel+to", () => {
    const jobs = [
      { agentId: "main", name: "plur1bus-morning-review-main", delivery: { mode: "announce", channel: "telegram", to: "55736530" } },
      { agentId: "main", name: "plur1bus-evening-review-main", delivery: { mode: "announce", channel: "telegram", to: "55736530", accountId: "default" } },
    ];
    const result = deriveAgentDelivery("main", jobs);
    assert.deepStrictEqual(result, { channel: "telegram", to: "55736530" });
  });

  it("returns null on conflicting targets within the preferred pool", () => {
    const jobs = [
      { agentId: "heisenberg", name: "plur1bus-morning-review-heisenberg", delivery: { mode: "announce", channel: "telegram", to: "2048378590" } },
      { agentId: "heisenberg", name: "plur1bus-evening-review-heisenberg", delivery: { mode: "announce", channel: "telegram", to: "9999999" } },
    ];
    assert.strictEqual(deriveAgentDelivery("heisenberg", jobs), null);
  });

  it("returns null on conflicting targets among unrelated jobs (no plur1bus jobs to prefer)", () => {
    const jobs = [
      { agentId: "heisenberg", name: "some-cron", delivery: { mode: "announce", channel: "telegram", to: "2048378590" } },
      { agentId: "heisenberg", name: "other-cron", delivery: { mode: "announce", channel: "telegram", to: "9999999" } },
    ];
    assert.strictEqual(deriveAgentDelivery("heisenberg", jobs), null);
  });

  it("prefers plur1bus-prefixed jobs over unrelated jobs when both exist", () => {
    const jobs = [
      { agentId: "bernhardine", name: "Erik BZ Check", delivery: { mode: "announce", channel: "telegram", to: "1111111" } },
      { agentId: "bernhardine", name: "plur1bus-morning-review-bernhardine", delivery: { mode: "announce", channel: "telegram", to: "1211667028" } },
    ];
    const result = deriveAgentDelivery("bernhardine", jobs);
    assert.deepStrictEqual(result, { channel: "telegram", to: "1211667028" });
  });

  it("ignores jobs belonging to other agents", () => {
    const jobs = [{ agentId: "main", name: "plur1bus-x", delivery: { mode: "announce", channel: "telegram", to: "55736530" } }];
    assert.strictEqual(deriveAgentDelivery("bernhardine", jobs), null);
  });

  it("ignores candidates with mode 'none' or missing 'to'", () => {
    const jobs = [
      { agentId: "main", name: "plur1bus-a", delivery: { mode: "none", channel: "telegram", to: "55736530" } },
      { agentId: "main", name: "plur1bus-b", delivery: { mode: "announce", channel: "telegram" } },
    ];
    assert.strictEqual(deriveAgentDelivery("main", jobs), null);
  });
});

describe("selectAgentsForCronSetup", () => {
  it("excludes agents with bindings === 0 (subagents)", () => {
    const agents = [
      { id: "main", workspace: "/ws/main", bindings: 2, isDefault: true },
      { id: "researcher", workspace: "/ws/main", bindings: 0, isDefault: false },
    ];
    const selected = selectAgentsForCronSetup(agents);
    assert.deepStrictEqual(selected, [{ id: "main", isDefault: true }]);
  });

  it("keeps one agent per distinct workspace", () => {
    const agents = [
      { id: "main", workspace: "/ws/main", bindings: 2, isDefault: true },
      { id: "bernhardine", workspace: "/ws/bernhardine", bindings: 1, isDefault: false },
      { id: "heisenberg", workspace: "/ws/heisenberg", bindings: 1, isDefault: false },
    ];
    const selected = selectAgentsForCronSetup(agents);
    assert.strictEqual(selected.length, 3);
    const ids = selected.map((a) => a.id).sort();
    assert.deepStrictEqual(ids, ["bernhardine", "heisenberg", "main"]);
  });

  it("dedupes two bound agents sharing one workspace, preferring isDefault", () => {
    const agents = [
      { id: "main", workspace: "/ws/main", bindings: 2, isDefault: true },
      { id: "main-alt", workspace: "/ws/main", bindings: 3, isDefault: false },
    ];
    const selected = selectAgentsForCronSetup(agents);
    assert.deepStrictEqual(selected, [{ id: "main", isDefault: true }]);
  });

  it("dedupes sharing one workspace without isDefault, preferring most bindings", () => {
    const agents = [
      { id: "bernhardine", workspace: "/ws/bernhardine", bindings: 1, isDefault: false },
      { id: "bernhardine-researcher", workspace: "/ws/bernhardine", bindings: 3, isDefault: false },
    ];
    const selected = selectAgentsForCronSetup(agents);
    assert.deepStrictEqual(selected, [{ id: "bernhardine-researcher", isDefault: false }]);
  });

  it("dedupes sharing one workspace with equal bindings/isDefault, preferring alphabetically-first id", () => {
    const agents = [
      { id: "zeta", workspace: "/ws/x", bindings: 1, isDefault: false },
      { id: "alpha", workspace: "/ws/x", bindings: 1, isDefault: false },
    ];
    const selected = selectAgentsForCronSetup(agents);
    assert.deepStrictEqual(selected, [{ id: "alpha", isDefault: false }]);
  });

  it("orders result with isDefault first, then alphabetical by id", () => {
    const agents = [
      { id: "zeta", workspace: "/ws/zeta", bindings: 1, isDefault: false },
      { id: "alpha", workspace: "/ws/alpha", bindings: 1, isDefault: false },
      { id: "main", workspace: "/ws/main", bindings: 2, isDefault: true },
    ];
    const selected = selectAgentsForCronSetup(agents);
    assert.deepStrictEqual(selected, [
      { id: "main", isDefault: true },
      { id: "alpha", isDefault: false },
      { id: "zeta", isDefault: false },
    ]);
  });

  it("returns an empty array for no agents / non-array input", () => {
    assert.deepStrictEqual(selectAgentsForCronSetup([]), []);
    assert.deepStrictEqual(selectAgentsForCronSetup(null), []);
    assert.deepStrictEqual(selectAgentsForCronSetup(undefined), []);
  });
});

describe("planFeatureCrons — multi-agent mode (opts.agents)", () => {
  const twoAgents = [
    { id: "main", isDefault: true },
    { id: "bernhardine", isDefault: false },
  ];

  it("plans 4 jobs (2 specs x 2 agents) when no existing jobs match", () => {
    const plan = planFeatureCrons([], REQUIRED_FEATURE_CRONS, { agents: twoAgents });
    assert.strictEqual(plan.create.length, 4);
    assert.strictEqual(plan.skip.length, 0);
    const names = plan.create.map((j) => j.name).sort();
    assert.deepStrictEqual(names, [
      "plur1bus afterthought bernhardine",
      "plur1bus afterthought main",
      "plur1bus persona-evolve bernhardine",
      "plur1bus persona-evolve main",
    ]);
  });

  it("uses per-agent --agent target and staggers persona-evolve deterministically", () => {
    const plan = planFeatureCrons([], REQUIRED_FEATURE_CRONS, { agents: twoAgents });
    const mainPersona = plan.create.find((j) => j.name === "plur1bus persona-evolve main");
    const bernhardinePersona = plan.create.find((j) => j.name === "plur1bus persona-evolve bernhardine");
    assert.strictEqual(mainPersona.agent, "main");
    assert.strictEqual(bernhardinePersona.agent, "bernhardine");
    // main is index 0 -> base schedule; bernhardine is index 1 -> +5 min.
    assert.strictEqual(mainPersona.schedule.expr, "15 4 * * 0");
    assert.strictEqual(bernhardinePersona.schedule.expr, "20 4 * * 0");
  });

  it("plans persona-evolve enabled, no delivery flags", () => {
    const plan = planFeatureCrons([], REQUIRED_FEATURE_CRONS, { agents: twoAgents });
    const mainPersona = plan.create.find((j) => j.name === "plur1bus persona-evolve main");
    assert.strictEqual(mainPersona.enabled, true);
    assert.strictEqual(mainPersona.delivery, null);
  });

  it("plans afterthought enabled with derived delivery when the agent's other crons agree", () => {
    const existing = [
      { agentId: "main", name: "plur1bus-morning-review-main", delivery: { mode: "announce", channel: "telegram", to: "55736530" } },
    ];
    const plan = planFeatureCrons(existing, REQUIRED_FEATURE_CRONS, { agents: twoAgents });
    const mainAfterthought = plan.create.find((j) => j.name === "plur1bus afterthought main");
    assert.strictEqual(mainAfterthought.enabled, true);
    assert.deepStrictEqual(mainAfterthought.delivery, { channel: "telegram", to: "55736530" });
    assert.strictEqual(mainAfterthought.hint, undefined);

    const bernhardineAfterthought = plan.create.find((j) => j.name === "plur1bus afterthought bernhardine");
    assert.strictEqual(bernhardineAfterthought.enabled, false);
    assert.ok(typeof bernhardineAfterthought.hint === "string" && bernhardineAfterthought.hint.length > 0);
  });

  it("legacy exact-name job satisfies only the default agent's spec", () => {
    const existing = [{ name: "plur1bus persona-evolve", payload: { message: "/plur1bus internal persona-evolve" } }];
    const plan = planFeatureCrons(existing, REQUIRED_FEATURE_CRONS, { agents: twoAgents });

    const mainSkip = plan.skip.find((s) => s.spec.agentId === "main" && s.spec.name.includes("persona-evolve"));
    assert.ok(mainSkip, "main's persona-evolve must be skipped");
    assert.strictEqual(mainSkip.reason, "legacy");

    const bernhardinePersonaCreated = plan.create.find((j) => j.name === "plur1bus persona-evolve bernhardine");
    assert.ok(bernhardinePersonaCreated, "bernhardine still gets its own persona-evolve job");

    // main's afterthought is unaffected by the persona-evolve legacy job.
    const mainAfterthoughtCreated = plan.create.find((j) => j.name === "plur1bus afterthought main");
    assert.ok(mainAfterthoughtCreated);
  });

  it("per-agent idempotency: an existing 'plur1bus afterthought bernhardine' job skips only bernhardine", () => {
    const existing = [{ name: "plur1bus afterthought bernhardine", payload: { message: "/plur1bus internal afterthought" } }];
    const plan = planFeatureCrons(existing, REQUIRED_FEATURE_CRONS, { agents: twoAgents });

    const bernhardineSkip = plan.skip.find((s) => s.spec.name === "plur1bus afterthought bernhardine");
    assert.ok(bernhardineSkip);
    assert.strictEqual(bernhardineSkip.reason, "already-exists");

    const mainAfterthoughtCreated = plan.create.find((j) => j.name === "plur1bus afterthought main");
    assert.ok(mainAfterthoughtCreated, "main's afterthought is still planned");
    assert.strictEqual(plan.create.length, 3, "3 of the 4 jobs remain to create");
  });

  it("no bare-substring false positive: a job merely named 'plur1bus' matches no per-agent spec", () => {
    const existing = [{ name: "plur1bus", payload: { message: "unrelated" } }];
    const plan = planFeatureCrons(existing, REQUIRED_FEATURE_CRONS, { agents: twoAgents });
    assert.strictEqual(plan.create.length, 4);
    assert.strictEqual(plan.skip.length, 0);
  });

  it("respects the given agents list as-is (subagent exclusion is the caller's job)", () => {
    const withSubagent = [...twoAgents, { id: "researcher", isDefault: false }];
    const plan = planFeatureCrons([], REQUIRED_FEATURE_CRONS, { agents: withSubagent });
    // planFeatureCrons does not filter by bindings itself -- 3 agents x 2 specs = 6.
    assert.strictEqual(plan.create.length, 6);
  });
});

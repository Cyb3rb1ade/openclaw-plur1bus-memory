import { describe, it } from "node:test";
import assert from "node:assert";
import {
  REQUIRED_FEATURE_CRONS,
  planFeatureCrons,
  deriveAgentDelivery,
  deriveDeliveryFromChannelConfig,
  selectAgentsForCronSetup,
  selectEnabledFeatureCronSpecs,
  staggerPersonaEvolveSchedule,
} from "../lib/setup/feature-cron-plan.js";

const LEGACY_TWO_FEATURE_CRONS = REQUIRED_FEATURE_CRONS.filter(
  (spec) => spec.feature === "persona-evolve" || spec.feature === "afterthought",
);

describe("REQUIRED_FEATURE_CRONS", () => {
  it("declares every explicitly provisionable feature job", () => {
    assert.deepStrictEqual(
      REQUIRED_FEATURE_CRONS.map((spec) => spec.feature),
      [
        "persona-evolve",
        "afterthought",
        "consolidate-daily",
        "classify-recent",
        "rem-dream",
        "skill-miner",
        "discover-semantic-links",
      ],
    );
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

describe("selectEnabledFeatureCronSpecs", () => {
  const sourceConfig = (pluginConfig, entry = {}) => ({
    plugins: {
      entries: {
        "memory-lancedb-namespaced": { ...entry, config: pluginConfig },
      },
    },
  });

  it("provisions no job from missing or runtime-defaulted feature values", () => {
    assert.deepStrictEqual(selectEnabledFeatureCronSpecs({}), []);
    assert.deepStrictEqual(selectEnabledFeatureCronSpecs(sourceConfig({})), []);
    assert.deepStrictEqual(
      selectEnabledFeatureCronSpecs(sourceConfig({
        personaVoice: { enabled: false },
        afterthought: { enabled: false },
        criticalPush: { enabled: false },
      })),
      [],
    );
  });

  it("selects all seven jobs only from their explicit owning gates", () => {
    const selected = selectEnabledFeatureCronSpecs(sourceConfig({
      personaVoice: { enabled: true },
      afterthought: { enabled: true },
      dailyConsolidation: { enabled: true },
      criticalPush: { enabled: true },
      merging: { enabled: true },
      skillMiner: { enabled: true },
      obsidianBridge: {
        enabled: true,
        graphLinks: { semanticDiscovery: { enabled: true } },
      },
    }));
    assert.deepStrictEqual(selected.map((spec) => spec.feature), REQUIRED_FEATURE_CRONS.map((spec) => spec.feature));
  });

  it("honors dependency gates and top-level plugin disable", () => {
    assert.deepStrictEqual(
      selectEnabledFeatureCronSpecs(sourceConfig({ personaVoice: { enabled: true } })).map((spec) => spec.feature),
      [],
    );
    assert.deepStrictEqual(
      selectEnabledFeatureCronSpecs(sourceConfig({ afterthought: { enabled: true } })).map((spec) => spec.feature),
      [],
    );
    assert.deepStrictEqual(
      selectEnabledFeatureCronSpecs(sourceConfig({
        afterthought: { enabled: true },
        merging: { enabled: true },
      })).map((spec) => spec.feature),
      ["afterthought", "rem-dream"],
    );
    assert.deepStrictEqual(
      selectEnabledFeatureCronSpecs(sourceConfig({ criticalPush: { enabled: true } }, { enabled: false })),
      [],
    );
  });

  it("uses the raw skill-miner schedule and fails closed on explicit invalid values", () => {
    const custom = selectEnabledFeatureCronSpecs(sourceConfig({
      skillMiner: { enabled: true, cron: "7 6 * * 2", timezone: null },
    })).find((spec) => spec.feature === "skill-miner");
    assert.deepStrictEqual(custom.schedule, { kind: "cron", expr: "7 6 * * 2" });
    assert.strictEqual(custom.timezone, null);

    const invalidCron = selectEnabledFeatureCronSpecs(sourceConfig({
      skillMiner: { enabled: true, cron: "not a cron", timezone: "Europe/Berlin" },
    }));
    assert.ok(!invalidCron.some((spec) => spec.feature === "skill-miner"));
    const invalidTimezone = selectEnabledFeatureCronSpecs(sourceConfig({
      skillMiner: { enabled: true, cron: "0 3 * * 0", timezone: "Not/AZone" },
    }));
    assert.ok(!invalidTimezone.some((spec) => spec.feature === "skill-miner"));

    const outOfRangeCron = selectEnabledFeatureCronSpecs(sourceConfig({
      skillMiner: { enabled: true, cron: "99 99 * * *", timezone: "Europe/Berlin" },
    }));
    assert.ok(!outOfRangeCron.some((spec) => spec.feature === "skill-miner"));
    const invalidNamedMinute = selectEnabledFeatureCronSpecs(sourceConfig({
      skillMiner: { enabled: true, cron: "FOO 3 * * *", timezone: "Europe/Berlin" },
    }));
    assert.ok(!invalidNamedMinute.some((spec) => spec.feature === "skill-miner"));

    const validStepCron = selectEnabledFeatureCronSpecs(sourceConfig({
      skillMiner: { enabled: true, cron: "0 */24 * * *", timezone: "Europe/Berlin" },
    }));
    assert.ok(validStepCron.some((spec) => spec.feature === "skill-miner"));
    const invalidNamedMonth = selectEnabledFeatureCronSpecs(sourceConfig({
      skillMiner: { enabled: true, cron: "0 3 * BANANA MON", timezone: "Europe/Berlin" },
    }));
    assert.ok(!invalidNamedMonth.some((spec) => spec.feature === "skill-miner"));
    const validNamedFields = selectEnabledFeatureCronSpecs(sourceConfig({
      skillMiner: { enabled: true, cron: "0 3 * JAN MON", timezone: "Europe/Berlin" },
    }));
    assert.ok(validNamedFields.some((spec) => spec.feature === "skill-miner"));
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

  it("is idempotent for an exact owned legacy name", () => {
    const existing = [{ agentId: "main", name: "plur1bus persona-evolve", payload: { message: "whatever" } }];
    const plan = planFeatureCrons(existing, specs, { agent: "main" });
    assert.strictEqual(plan.create.length, 1);
    assert.strictEqual(plan.create[0].name, afterthoughtSpec.name);
    assert.strictEqual(plan.skip.length, 1);
    assert.strictEqual(plan.skip[0].spec.name, personaSpec.name);
    assert.match(plan.skip[0].reason, /already|exist/i);
  });

  it("is idempotent for an exact owned first command line", () => {
    const existing = [{ agentId: "main", name: "my-custom-afterthought-job", payload: { message: "/plur1bus internal afterthought\ncustom" } }];
    const plan = planFeatureCrons(existing, specs, { agent: "main" });
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
    assert.match(plan.create[0].hint, /--channel telegram/);
    assert.match(plan.create[0].hint, /--to <chatId>/);
  });

  it("does not mistake an execution agent for a concrete delivery target", () => {
    const plan = planFeatureCrons([], [afterthoughtSpec], { agent: "main" });
    assert.strictEqual(plan.create[0].enabled, false);
    assert.strictEqual(plan.create[0].agent, "main");
    assert.match(plan.create[0].hint, /cron edit/);
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

  it("does not match a decorated legacy name", () => {
    const existing = [{ agentId: "main", name: "plur1bus persona-evolve (weekly)", payload: { message: "whatever" } }];
    const plan = planFeatureCrons(existing, specs, { agent: "main" });
    assert.strictEqual(plan.create.length, 2);
    assert.deepStrictEqual(plan.skip, []);
  });

  it("never claims a legacy job without exact target-agent ownership", () => {
    const cases = [
      { opts: {}, job: { name: afterthoughtSpec.name, agentId: "main", payload: { message: afterthoughtSpec.command } } },
      { opts: { agent: "main" }, job: { name: afterthoughtSpec.name, payload: { message: afterthoughtSpec.command } } },
      { opts: { agent: "main" }, job: { name: afterthoughtSpec.name, agentId: "Main", payload: { message: afterthoughtSpec.command } } },
      { opts: { agent: "main" }, job: { name: `${afterthoughtSpec.name} custom`, agentId: "main", payload: { message: "custom" } } },
      { opts: { agent: "main" }, job: { name: "custom", agentId: "main", payload: { message: `prefix ${afterthoughtSpec.command}` } } },
    ];

    for (const { opts, job } of cases) {
      const plan = planFeatureCrons([job], [afterthoughtSpec], opts);
      assert.strictEqual(plan.create.length, 1);
      assert.deepStrictEqual(plan.skip, []);
      assert.deepStrictEqual(plan.update, []);
    }
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

  it("fails closed when candidates disagree on accountId despite agreeing on channel+to", () => {
    const jobs = [
      { agentId: "main", name: "plur1bus-morning-review-main", delivery: { mode: "announce", channel: "telegram", to: "55736530" } },
      { agentId: "main", name: "plur1bus-evening-review-main", delivery: { mode: "announce", channel: "telegram", to: "55736530", accountId: "default" } },
    ];
    const result = deriveAgentDelivery("main", jobs);
    assert.strictEqual(result, null);
  });

  it("returns null on conflicting targets among PLUR1BUS jobs", () => {
    const jobs = [
      { agentId: "heisenberg", name: "plur1bus-morning-review-heisenberg", delivery: { mode: "announce", channel: "telegram", to: "2048378590" } },
      { agentId: "heisenberg", name: "plur1bus-evening-review-heisenberg", delivery: { mode: "announce", channel: "telegram", to: "9999999" } },
    ];
    assert.strictEqual(deriveAgentDelivery("heisenberg", jobs), null);
  });

  it("returns null on conflicting targets among unrelated jobs", () => {
    const jobs = [
      { agentId: "heisenberg", name: "some-cron", delivery: { mode: "announce", channel: "telegram", to: "2048378590" } },
      { agentId: "heisenberg", name: "other-cron", delivery: { mode: "announce", channel: "telegram", to: "9999999" } },
    ];
    assert.strictEqual(deriveAgentDelivery("heisenberg", jobs), null);
  });

  it("requires unanimity across PLUR1BUS and unrelated safe delivery candidates", () => {
    const jobs = [
      { agentId: "bernhardine", name: "Erik BZ Check", delivery: { mode: "announce", channel: "telegram", to: "1111111" } },
      { agentId: "bernhardine", name: "plur1bus-morning-review-bernhardine", delivery: { mode: "announce", channel: "telegram", to: "1211667028" } },
    ];
    assert.strictEqual(deriveAgentDelivery("bernhardine", jobs), null);
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

  it("ignores a disabled plur1bus job's stale delivery target, falling back to an enabled candidate", () => {
    const jobs = [
      { agentId: "main", name: "plur1bus-decommissioned-main", enabled: false, delivery: { mode: "announce", channel: "telegram", to: "99999999" } },
      { agentId: "main", name: "disk-space-monitor", enabled: true, delivery: { mode: "announce", channel: "telegram", to: "55736530" } },
    ];
    const result = deriveAgentDelivery("main", jobs);
    assert.deepStrictEqual(result, { channel: "telegram", to: "55736530" });
  });

  it("returns null when the only candidates are disabled jobs (afterthought falls back to created-but-disabled)", () => {
    const jobs = [
      { agentId: "main", name: "plur1bus-decommissioned-main", enabled: false, delivery: { mode: "announce", channel: "telegram", to: "99999999" } },
    ];
    assert.strictEqual(deriveAgentDelivery("main", jobs), null);
  });

  it("treats a missing 'enabled' field as enabled (older cron-list shapes without the field)", () => {
    const jobs = [{ agentId: "main", name: "plur1bus-a", delivery: { mode: "announce", channel: "telegram", to: "55736530" } }];
    const result = deriveAgentDelivery("main", jobs);
    assert.deepStrictEqual(result, { channel: "telegram", to: "55736530" });
  });

  it("rejects unsafe modes, channels, wildcard targets, and placeholders", () => {
    const job = (delivery) => ({ agentId: "main", name: "plur1bus seed", delivery });
    assert.strictEqual(deriveAgentDelivery("main", [job({ mode: "none", channel: "telegram", to: "12345" })]), null);
    assert.strictEqual(deriveAgentDelivery("main", [job({ mode: "announce", channel: "last", to: "12345" })]), null);
    assert.strictEqual(deriveAgentDelivery("main", [job({ mode: "announce", channel: "telegram", to: "*" })]), null);
    assert.strictEqual(deriveAgentDelivery("main", [job({ mode: "announce", channel: "telegram", to: "${CHAT_ID}" })]), null);
    assert.strictEqual(deriveAgentDelivery("main", [job({ mode: "announce", channel: "slack", to: "C12345" })]), null);
    assert.strictEqual(deriveAgentDelivery("main", [job({ mode: "announce", channel: "slack", to: "***" })]), null);
    assert.strictEqual(deriveAgentDelivery("main", [job({
      mode: "announce",
      channel: "telegram",
      to: "55736530",
      accountId: "***",
    })]), null);
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
    const plan = planFeatureCrons([], LEGACY_TWO_FEATURE_CRONS, { agents: twoAgents });
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
    const plan = planFeatureCrons([], LEGACY_TWO_FEATURE_CRONS, { agents: twoAgents });
    const mainPersona = plan.create.find((j) => j.name === "plur1bus persona-evolve main");
    const bernhardinePersona = plan.create.find((j) => j.name === "plur1bus persona-evolve bernhardine");
    assert.strictEqual(mainPersona.agent, "main");
    assert.strictEqual(bernhardinePersona.agent, "bernhardine");
    // main is index 0 -> base schedule; bernhardine is index 1 -> +5 min.
    assert.strictEqual(mainPersona.schedule.expr, "15 4 * * 0");
    assert.strictEqual(bernhardinePersona.schedule.expr, "20 4 * * 0");
  });

  it("plans persona-evolve enabled, no delivery flags", () => {
    const plan = planFeatureCrons([], LEGACY_TWO_FEATURE_CRONS, { agents: twoAgents });
    const mainPersona = plan.create.find((j) => j.name === "plur1bus persona-evolve main");
    assert.strictEqual(mainPersona.enabled, true);
    assert.strictEqual(mainPersona.delivery, null);
  });

  it("plans afterthought enabled with derived delivery when the agent's other crons agree", () => {
    const existing = [
      {
        agentId: "main",
        name: "plur1bus-morning-review-main",
        delivery: { mode: "announce", channel: "telegram", to: "55736530", accountId: "telegram-main" },
      },
    ];
    const plan = planFeatureCrons(existing, LEGACY_TWO_FEATURE_CRONS, { agents: twoAgents });
    const mainAfterthought = plan.create.find((j) => j.name === "plur1bus afterthought main");
    assert.strictEqual(mainAfterthought.enabled, true);
    assert.deepStrictEqual(mainAfterthought.delivery, {
      channel: "telegram",
      to: "55736530",
      accountId: "telegram-main",
    });
    assert.strictEqual(mainAfterthought.account, "telegram-main");
    assert.strictEqual(mainAfterthought.hint, undefined);

    const bernhardineAfterthought = plan.create.find((j) => j.name === "plur1bus afterthought bernhardine");
    assert.strictEqual(bernhardineAfterthought.enabled, false);
    assert.strictEqual(bernhardineAfterthought.delivery, null);
    assert.ok(typeof bernhardineAfterthought.hint === "string" && bernhardineAfterthought.hint.length > 0);
    assert.match(bernhardineAfterthought.hint, /--account/);
  });

  it("legacy exact-name job satisfies only the default agent's spec", () => {
    const existing = [{ name: "plur1bus persona-evolve", agentId: "main", payload: { message: "/plur1bus internal persona-evolve" } }];
    const plan = planFeatureCrons(existing, LEGACY_TWO_FEATURE_CRONS, { agents: twoAgents });

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
    const existing = [{
      name: "plur1bus afterthought bernhardine",
      agentId: "bernhardine",
      payload: { message: "/plur1bus internal afterthought" },
      delivery: { mode: "none" },
      enabled: false,
    }];
    const plan = planFeatureCrons(existing, LEGACY_TWO_FEATURE_CRONS, { agents: twoAgents });

    const bernhardineSkip = plan.skip.find((s) => s.spec.name === "plur1bus afterthought bernhardine");
    assert.ok(bernhardineSkip);
    assert.strictEqual(bernhardineSkip.reason, "already-exists");

    const mainAfterthoughtCreated = plan.create.find((j) => j.name === "plur1bus afterthought main");
    assert.ok(mainAfterthoughtCreated, "main's afterthought is still planned");
    assert.strictEqual(plan.create.length, 3, "3 of the 4 jobs remain to create");
  });

  it("no bare-substring false positive: a job merely named 'plur1bus' matches no per-agent spec", () => {
    const existing = [{ name: "plur1bus", payload: { message: "unrelated" } }];
    const plan = planFeatureCrons(existing, LEGACY_TWO_FEATURE_CRONS, { agents: twoAgents });
    assert.strictEqual(plan.create.length, 4);
    assert.strictEqual(plan.skip.length, 0);
  });

  it("respects the given agents list as-is (subagent exclusion is the caller's job)", () => {
    const withSubagent = [...twoAgents, { id: "researcher", isDefault: false }];
    const plan = planFeatureCrons([], LEGACY_TWO_FEATURE_CRONS, { agents: withSubagent });
    // planFeatureCrons does not filter by bindings itself -- 3 agents x 2 specs = 6.
    assert.strictEqual(plan.create.length, 6);
  });

  it("only recognizes an existing job owned by the exact target agent", () => {
    const impostors = [
      {
        id: "wrong-agent",
        name: "plur1bus afterthought main",
        agentId: "other",
        payload: { message: "/plur1bus internal afterthought" },
      },
      {
        id: "missing-agent",
        name: "plur1bus persona-evolve main",
        payload: { message: "/plur1bus internal persona-evolve" },
      },
    ];
    const plan = planFeatureCrons(impostors, LEGACY_TWO_FEATURE_CRONS, { agents: [{ id: "main", isDefault: true }] });
    assert.deepStrictEqual(plan.skip, []);
    assert.deepStrictEqual(plan.update, []);
    assert.strictEqual(plan.create.length, 2);
  });

  it("matches only the canonical name or an exact first command line", () => {
    const laterCommand = {
      id: "later",
      name: "plur1bus afterthought main custom",
      agentId: "main",
      payload: { message: "preface\n/plur1bus internal afterthought" },
    };
    const laterPlan = planFeatureCrons([laterCommand], [LEGACY_TWO_FEATURE_CRONS[1]], {
      agents: [{ id: "main", isDefault: true }],
    });
    assert.strictEqual(laterPlan.create.length, 1);
    assert.deepStrictEqual(laterPlan.update, []);

    const exactFirstLine = {
      id: "exact",
      name: "operator custom name",
      agentId: "main",
      enabled: false,
      payload: { message: "/plur1bus internal afterthought\ncustom contract" },
      delivery: { mode: "none" },
    };
    const exactPlan = planFeatureCrons([exactFirstLine], [LEGACY_TWO_FEATURE_CRONS[1]], {
      agents: [{ id: "main", isDefault: true }],
    });
    assert.strictEqual(exactPlan.create.length, 0);
    assert.strictEqual(exactPlan.skip.length, 1);
  });

  it("treats agent ownership, canonical names, and first command lines as case-sensitive", () => {
    const spec = LEGACY_TWO_FEATURE_CRONS[1];
    const impostors = [
      {
        id: "agent-case",
        name: "plur1bus afterthought main",
        agentId: "Main",
        payload: { message: "/plur1bus internal afterthought" },
      },
      {
        id: "name-case",
        name: "PLUR1BUS AFTERTHOUGHT MAIN",
        agentId: "main",
        payload: { message: "operator prompt" },
      },
      {
        id: "command-case",
        name: "operator prompt",
        agentId: "main",
        payload: { message: "/PLUR1BUS INTERNAL AFTERTHOUGHT" },
      },
    ];

    for (const existing of impostors) {
      const plan = planFeatureCrons([existing], [spec], {
        agents: [{ id: "main", isDefault: true }],
      });
      assert.strictEqual(plan.create.length, 1, `${existing.id} must not claim main's job`);
      assert.deepStrictEqual(plan.skip, []);
      assert.deepStrictEqual(plan.update, []);
    }

    assert.strictEqual(deriveAgentDelivery("main", [{
      agentId: "Main",
      name: "case-collision",
      delivery: { mode: "announce", channel: "telegram", to: "55736530" },
    }]), null);
    assert.strictEqual(deriveDeliveryFromChannelConfig("main", {
      bindings: [{
        agentId: "Main",
        match: { channel: "telegram", accountId: "default", peer: { kind: "direct", id: "55736530" } },
      }],
      channels: { telegram: { accounts: { default: { enabled: true } } } },
    }), null);
  });
});

describe("Message-Contract-Migration bestehender Jobs", () => {
  const OLD_CONTRACT =
    "/plur1bus internal afterthought\n\n" +
    "Delivery contract: the job returns JSON. If it has a `text` field, " +
    "send exactly that text as the message, verbatim, with no additional " +
    "commentary. If `skipped` is true, output NOTHING at all.";
  const agents = [{ id: "main", isDefault: true }];

  it("plant ein Message-Update für einen existierenden Job mit altem 'output NOTHING'-Contract", () => {
    const existing = [
      { id: "job-1", name: "plur1bus afterthought main", agentId: "main", payload: { message: OLD_CONTRACT }, delivery: { mode: "announce", channel: "telegram", to: "55736530" } },
    ];
    const plan = planFeatureCrons(existing, LEGACY_TWO_FEATURE_CRONS, { agents });
    assert.ok(Array.isArray(plan.update), "plan.update existiert");
    assert.strictEqual(plan.update.length, 1);
    assert.strictEqual(plan.update[0].id, "job-1");
    assert.match(plan.update[0].message, /reply with exactly NO_REPLY/);
    assert.doesNotMatch(plan.update[0].message, /output NOTHING at all/);
    // Der Job bleibt trotzdem geskippt (kein Duplikat-Create).
    assert.ok(plan.skip.some((s) => s.existingJob?.id === "job-1"));
  });

  it("erhält Nutzer-Anpassungen rund um den alten Contract-Satz", () => {
    const custom = `MEIN PREFIX\n${OLD_CONTRACT}\nMEIN SUFFIX`;
    const existing = [
      { id: "job-2", name: "plur1bus afterthought main", agentId: "main", payload: { message: custom }, delivery: { mode: "announce", channel: "telegram", to: "55736530" } },
    ];
    const plan = planFeatureCrons(existing, LEGACY_TWO_FEATURE_CRONS, { agents });
    assert.strictEqual(plan.update.length, 1);
    assert.match(plan.update[0].message, /^MEIN PREFIX\n/);
    assert.match(plan.update[0].message, /\nMEIN SUFFIX$/);
    assert.match(plan.update[0].message, /reply with exactly NO_REPLY/);
  });

  it("plant KEIN Update für Jobs ohne alten Contract-Satz (custom oder bereits migriert)", () => {
    const existing = [
      { id: "job-3", name: "plur1bus afterthought main", agentId: "main", payload: { message: "mein eigener prompt ohne contract" }, delivery: { mode: "announce", channel: "telegram", to: "55736530" } },
      { id: "job-4", name: "plur1bus persona-evolve main", agentId: "main", payload: { message: "/plur1bus internal persona-evolve" } },
    ];
    const plan = planFeatureCrons(existing, LEGACY_TWO_FEATURE_CRONS, { agents });
    assert.strictEqual(plan.update.length, 0);
  });

  it("migriert auch im Legacy-Single-Agent-Modus", () => {
    const existing = [{ id: "job-5", name: "plur1bus afterthought", agentId: "main", payload: { message: OLD_CONTRACT } }];
    const plan = planFeatureCrons(existing, LEGACY_TWO_FEATURE_CRONS, { agent: "main" });
    assert.strictEqual(plan.update.length, 1);
    assert.strictEqual(plan.update[0].id, "job-5");
  });

  it("Jobs ohne id werden nicht zum Update geplant (cron edit braucht die id)", () => {
    const existing = [{ name: "plur1bus afterthought main", agentId: "main", payload: { message: OLD_CONTRACT } }];
    const plan = planFeatureCrons(existing, LEGACY_TWO_FEATURE_CRONS, { agents });
    assert.strictEqual(plan.update.length, 0);
  });
});

describe("deriveDeliveryFromChannelConfig", () => {
  const config = {
    bindings: [
      { agentId: "main", match: { channel: "discord", accountId: "default" } },
      { agentId: "main", match: { channel: "telegram", accountId: "default" } },
      { agentId: "bernhardine", match: { channel: "telegram", accountId: "bernhardine" } },
    ],
    channels: {
      telegram: {
        accounts: {
          default: { enabled: true, defaultTo: 55736530, allowFrom: ["*"] },
          bernhardine: { enabled: true, defaultTo: "1211667028" },
          ambiguous: { enabled: true },
        },
      },
    },
  };

  it("leitet das Ziel aus dem expliziten defaultTo ab (Zahl wird zu String)", () => {
    assert.deepStrictEqual(deriveDeliveryFromChannelConfig("main", config), {
      channel: "telegram",
      to: "55736530",
      accountId: "default",
    });
    assert.deepStrictEqual(deriveDeliveryFromChannelConfig("bernhardine", config), {
      channel: "telegram",
      to: "1211667028",
      accountId: "bernhardine",
    });
  });

  it("gibt null zurück bei fehlendem defaultTo, fehlendem Binding oder fehlender Config", () => {
    const cfg = {
      bindings: [{ agentId: "x", match: { channel: "telegram", accountId: "ambiguous" } }],
      channels: config.channels,
    };
    assert.strictEqual(deriveDeliveryFromChannelConfig("x", cfg), null);
    assert.strictEqual(deriveDeliveryFromChannelConfig("unbekannt", config), null);
    assert.strictEqual(deriveDeliveryFromChannelConfig("main", null), null);
    assert.strictEqual(deriveDeliveryFromChannelConfig("main", {}), null);
  });

  it("gibt null zurück, wenn der Agent an mehrere Telegram-Accounts gebunden ist", () => {
    const cfg = {
      bindings: [
        { agentId: "m", match: { channel: "telegram", accountId: "default" } },
        { agentId: "m", match: { channel: "telegram", accountId: "bernhardine" } },
      ],
      channels: config.channels,
    };
    assert.strictEqual(deriveDeliveryFromChannelConfig("m", cfg), null);
  });

  it("planFeatureCrons nutzt die Config als Fallback, wenn keine Cron-Ableitung möglich ist", () => {
    const agents = [{ id: "main", isDefault: true }];
    const plan = planFeatureCrons([], LEGACY_TWO_FEATURE_CRONS, { agents, channelConfig: config });
    const afterthought = plan.create.find((c) => c.name === "plur1bus afterthought main");
    assert.ok(afterthought);
    assert.strictEqual(afterthought.enabled, true);
    assert.deepStrictEqual(afterthought.delivery, { channel: "telegram", to: "55736530", accountId: "default" });
  });

  it("Cron-Ableitung hat Vorrang vor der Config", () => {
    const agents = [{ id: "main", isDefault: true }];
    const existing = [
      {
        agentId: "main",
        name: "plur1bus-morning-review-main",
        delivery: { mode: "announce", channel: "telegram", to: "99999", accountId: "acct" },
      },
    ];
    const plan = planFeatureCrons(existing, LEGACY_TWO_FEATURE_CRONS, { agents, channelConfig: config });
    const afterthought = plan.create.find((c) => c.name === "plur1bus afterthought main");
    assert.strictEqual(afterthought.delivery.to, "99999");
  });

  it("uses a concrete group peer instead of redirecting to an allowFrom sender", () => {
    const cfg = {
      bindings: [
        {
          agentId: "main",
          match: {
            channel: "telegram",
            accountId: "default",
            peer: { kind: "group", id: "-100123" },
          },
        },
      ],
      channels: {
        telegram: {
          accounts: {
            default: { enabled: true, allowFrom: [55736530] },
          },
        },
      },
    };

    assert.deepStrictEqual(deriveDeliveryFromChannelConfig("main", cfg), {
      channel: "telegram",
      to: "-100123",
      accountId: "default",
    });
  });

  it("resolves an omitted binding account through defaultAccount and inherited defaultTo", () => {
    const cfg = {
      bindings: [{ agentId: "main", match: { channel: "telegram" } }],
      channels: {
        telegram: {
          defaultAccount: "primary",
          defaultTo: "-100900",
          accounts: { primary: { enabled: true } },
        },
      },
    };

    assert.deepStrictEqual(deriveDeliveryFromChannelConfig("main", cfg), {
      channel: "telegram",
      to: "-100900",
      accountId: "primary",
    });
  });

  it("rejects invalid explicit default accounts and explicitly missing named accounts", () => {
    const invalidDefaultAccount = {
      bindings: [{ agentId: "main", match: { channel: "telegram" } }],
      channels: {
        telegram: {
          defaultAccount: "*",
          defaultTo: "55736530",
          accounts: { primary: { enabled: true } },
        },
      },
    };
    assert.strictEqual(deriveDeliveryFromChannelConfig("main", invalidDefaultAccount), null);

    const missingNamedAccount = {
      bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "missing" } }],
      channels: { telegram: { defaultTo: "55736530", accounts: {} } },
    };
    assert.strictEqual(deriveDeliveryFromChannelConfig("main", missingNamedAccount), null);
  });

  it("never turns sender allowlists or wildcards into outbound targets", () => {
    const configWith = (account) => ({
      bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "default" } }],
      channels: { telegram: { accounts: { default: account } } },
    });

    assert.strictEqual(
      deriveDeliveryFromChannelConfig("main", configWith({ enabled: true, allowFrom: [55736530] })),
      null,
    );
    assert.strictEqual(
      deriveDeliveryFromChannelConfig("main", configWith({ enabled: true, defaultTo: "*" })),
      null,
    );
  });

  it("rejects delivery sentinels exposed only after Telegram target prefixes are stripped", () => {
    const configWithPeer = (id) => ({
      bindings: [{
        agentId: "main",
        match: {
          channel: "telegram",
          accountId: "default",
          peer: { kind: "group", id },
        },
      }],
      channels: { telegram: { accounts: { default: { enabled: true } } } },
    });

    for (const target of ["telegram:*", "tg:last", "group:default", "telegram:group:null"]) {
      assert.strictEqual(
        deriveDeliveryFromChannelConfig("main", configWithPeer(target)),
        null,
        `${target} must remain ineligible after prefix normalization`,
      );
    }
  });

  it("rejects zero Telegram peer identifiers", () => {
    const configWithPeer = (kind, id) => ({
      bindings: [{
        agentId: "main",
        match: { channel: "telegram", accountId: "default", peer: { kind, id } },
      }],
      channels: { telegram: { accounts: { default: { enabled: true } } } },
    });

    assert.strictEqual(deriveDeliveryFromChannelConfig("main", configWithPeer("direct", "0")), null);
    assert.strictEqual(deriveDeliveryFromChannelConfig("main", configWithPeer("group", "-0")), null);
  });

  it("fails closed for conflicting peers, mixed peer kinds, disabled accounts, and placeholders", () => {
    const runtimeConfig = (bindings, telegram) => ({ bindings, channels: { telegram } });
    const binding = (peer, accountId = "default") => ({
      agentId: "main",
      match: { channel: "telegram", accountId, ...(peer ? { peer } : {}) },
    });
    const baseTelegram = { accounts: { default: { enabled: true, defaultTo: "55736530" } } };

    assert.strictEqual(deriveDeliveryFromChannelConfig("main", runtimeConfig([
      binding({ kind: "group", id: "-1001" }),
      binding({ kind: "group", id: "-1002" }),
    ], baseTelegram)), null);
    assert.strictEqual(deriveDeliveryFromChannelConfig("main", runtimeConfig([
      binding({ kind: "direct", id: "55736530" }),
      binding({ kind: "group", id: "-1001" }),
    ], baseTelegram)), null);
    assert.strictEqual(deriveDeliveryFromChannelConfig("main", runtimeConfig([
      binding(null),
    ], { accounts: { default: { enabled: false, defaultTo: "55736530" } } })), null);
    assert.strictEqual(deriveDeliveryFromChannelConfig("main", runtimeConfig([
      binding({ kind: "group", id: "${GROUP_ID}" }),
    ], baseTelegram)), null);
    assert.strictEqual(deriveDeliveryFromChannelConfig("main", runtimeConfig([
      binding({ kind: "group", id: "12345" }),
    ], baseTelegram)), null);
  });

  it("lets an account defaultTo override the inherited root target", () => {
    const cfg = {
      bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "primary" } }],
      channels: {
        telegram: {
          defaultTo: "111111",
          accounts: { primary: { defaultTo: "222222" } },
        },
      },
    };
    assert.deepStrictEqual(deriveDeliveryFromChannelConfig("main", cfg), {
      channel: "telegram",
      to: "222222",
      accountId: "primary",
    });
  });
});

describe("Delivery-Migration bestehender Jobs (announce -> last ohne Ziel)", () => {
  const agents = [{ id: "main", isDefault: true }];

  it("plant --no-deliver für einen persona-evolve-Job mit announce->last ohne to", () => {
    // Alt-Bug: cron add ohne Delivery-Flag defaultet auf announce -> "last";
    // isolierte Cron-Sessions haben kein "last active chat" → fail-closed.
    const existing = [
      {
        id: "job-p1",
        name: "plur1bus persona-evolve main",
        agentId: "main",
        payload: { message: "/plur1bus internal persona-evolve" },
        delivery: { mode: "announce", channel: "last" },
      },
    ];
    const plan = planFeatureCrons(existing, LEGACY_TWO_FEATURE_CRONS, { agents });
    const mig = plan.update.find((u) => u.id === "job-p1");
    assert.ok(mig, "delivery migration must be planned");
    assert.strictEqual(mig.noDeliver, true);
    // Kein Duplikat-Create.
    assert.ok(plan.skip.some((s) => s.existingJob?.id === "job-p1"));
  });

  it("removes delivery from non-delivery jobs but leaves a safe delivery job untouched", () => {
    const existing = [
      {
        id: "job-p2",
        name: "plur1bus persona-evolve main",
        agentId: "main",
        payload: { message: "/plur1bus internal persona-evolve" },
        delivery: { mode: "announce", channel: "telegram", to: "55736530" },
      },
      {
        id: "job-a1",
        name: "plur1bus afterthought main",
        agentId: "main",
        payload: { message: "/plur1bus internal afterthought" },
        delivery: { mode: "announce", channel: "telegram", to: "55736530" },
      },
    ];
    const plan = planFeatureCrons(existing, LEGACY_TWO_FEATURE_CRONS, { agents });
    assert.deepStrictEqual(plan.update, [{ id: "job-p2", name: "plur1bus persona-evolve main", noDeliver: true }]);
  });

  it("fasst Jobs mit delivery mode none nicht an (bereits korrekt)", () => {
    const existing = [
      {
        id: "job-p3",
        name: "plur1bus persona-evolve main",
        agentId: "main",
        payload: { message: "/plur1bus internal persona-evolve" },
        delivery: { mode: "none" },
      },
    ];
    const plan = planFeatureCrons(existing, LEGACY_TWO_FEATURE_CRONS, { agents });
    assert.strictEqual(plan.update.length, 0);
  });

  it("disables an owned delivery job whose target is the unsafe last-chat fallback", () => {
    const existing = [
      {
        id: "job-a2",
        name: "plur1bus afterthought main",
        agentId: "main",
        payload: { message: "/plur1bus internal afterthought" },
        delivery: { mode: "announce", channel: "last" },
      },
    ];
    const plan = planFeatureCrons(existing, LEGACY_TWO_FEATURE_CRONS, { agents });
    assert.deepStrictEqual(plan.update, [{
      id: "job-a2",
      name: "plur1bus afterthought main",
      noDeliver: true,
      disable: true,
    }]);
  });
});

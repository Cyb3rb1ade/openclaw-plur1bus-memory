import { describe, it } from "node:test";
import assert from "node:assert";
import {
  REQUIRED_FEATURE_CRONS,
  planFeatureCrons,
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

  it("plans a needsDelivery spec as enabled when account is given (agent optional)", () => {
    const plan = planFeatureCrons([], [afterthoughtSpec], { account: "telegram-main" });
    assert.strictEqual(plan.create[0].enabled, true);
    assert.strictEqual(plan.create[0].account, "telegram-main");
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
});

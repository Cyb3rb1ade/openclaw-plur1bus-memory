/**
 * tests/engine-minimal-maintenance.test.js — PR-03c.
 *
 * The auto-recall-off branch still has to return the non-droppable blocks.
 * The important cases are the two early exits, because a regression there is
 * invisible in the golden corpus (which exercises the enabled path).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createMinimalMaintenance } from "../engine/recall/minimal-maintenance.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function baseCtx(overrides = {}) {
  return {
    host: createStubHost(),
    automaticWorkspacePolicyDecision: () => ({ allowed: true }),
    gcEnabled: false,
    getNeoStore: () => ({ recordHook() {} }),
    neoEnabled: false,
    pool: { withDb: async () => undefined },
    resolveCommandLocaleRecall: () => ({ lang: "en", tone: "neutral" }),
    schicht15Enabled: false,
    temporalContextEnabled: false,
    stateDir: makeTempDir("plur1bus-maintenance-state-"),
    ...overrides,
  };
}

describe("createMinimalMaintenance", () => {
  it("returns undefined when the workspace policy refuses the turn", async () => {
    const handler = createMinimalMaintenance(baseCtx({
      automaticWorkspacePolicyDecision: () => ({ allowed: false }),
    }));
    assert.equal(await handler({ prompt: "x" }, { agentId: "a", workspaceDir: "/tmp/ws" }), undefined);
  });

  it("returns undefined when there is no workspace directory", async () => {
    const handler = createMinimalMaintenance(baseCtx());
    assert.equal(await handler({ prompt: "x" }, { agentId: "a" }), undefined);
  });

  it("records the neo hook dispatch when neo is enabled", async () => {
    const recorded = [];
    const handler = createMinimalMaintenance(baseCtx({
      neoEnabled: true,
      getNeoStore: () => ({ recordHook: (name, payload) => recorded.push([name, payload]) }),
    }));
    await handler({ prompt: "hello" }, { agentId: "a" });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0][0], "before_prompt_build");
    assert.equal(recorded[0][1].autoRecallDisabled, true);
    assert.equal(recorded[0][1].promptLength, 5);
  });

  it("survives a neo store that throws, logging instead of failing the turn", async () => {
    const warned = [];
    const handler = createMinimalMaintenance(baseCtx({
      neoEnabled: true,
      host: createStubHost({ logger: { warn: (m) => warned.push(m) } }),
      getNeoStore: () => { throw new Error("neo unavailable"); },
    }));
    assert.equal(await handler({ prompt: "x" }, { agentId: "a" }), undefined);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /before_prompt_build dispatch tracking failed/);
  });
});

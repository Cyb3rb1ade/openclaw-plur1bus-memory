import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  closedMutationGates,
  mutationAllowed,
  parseObsidianCommandPlan,
} from "../lib/obsidian-mutation-policy.js";

/**
 * A denial used to surface as a bare "mutation_policy_denied". Four independent
 * preconditions can close the policy, so that message could not distinguish an
 * unconfirmed vault from a dry run -- for an operator or for anyone debugging.
 */
describe("naming the closed mutation gates", () => {
  const base = {
    memoryCtx: { agentId: "a1", workspaceIdentity: "workspace:v1:a1" },
    agentId: "a1",
    workspaceIdentity: "workspace:v1:a1",
    baseDbPath: "/tmp/base",
    mode: "apply",
    dryRun: false,
    allowWrite: true,
    vaultConfirmed: true,
    actionConfirmed: true,
  };
  const policyFor = (overrides) =>
    parseObsidianCommandPlan(["review", "apply"], { ...base, ...overrides }).mutationPolicy;

  it("names nothing when every gate is open", () => {
    assert.deepEqual(closedMutationGates(policyFor({})), []);
  });

  it("names exactly the gate that is closed", () => {
    assert.deepEqual(closedMutationGates(policyFor({ vaultConfirmed: false })), ["vault_not_confirmed"]);
    assert.deepEqual(closedMutationGates(policyFor({ allowWrite: false })), ["allow_write_disabled"]);
    assert.deepEqual(closedMutationGates(policyFor({ dryRun: true })), ["dry_run"]);
    assert.deepEqual(closedMutationGates(policyFor({ mode: "augment" })), ["mode_not_apply(augment)"]);
  });

  it("names every closed gate at once", () => {
    assert.deepEqual(
      closedMutationGates(policyFor({ allowWrite: false, vaultConfirmed: false })),
      ["allow_write_disabled", "vault_not_confirmed"],
    );
  });

  it("reports a missing policy instead of pretending it is open", () => {
    assert.deepEqual(closedMutationGates(null), ["policy_missing"]);
    assert.deepEqual(closedMutationGates({ kind: "not-a-policy" }), ["policy_missing"]);
  });

  it("exposes only booleans and a mode name, never a path or identity", () => {
    const named = closedMutationGates(policyFor({ allowWrite: false, vaultConfirmed: false, mode: "augment" }));
    for (const gate of named) {
      assert.doesNotMatch(gate, /\/tmp\/base|workspace:v1:a1|\ba1\b/u, `leaks context: ${gate}`);
    }
  });
});

describe("scheduled semantic discovery policy", () => {
  const base = {
    memoryCtx: { agentId: "heisenberg", workspaceIdentity: "workspace:v1:heisenberg", workspaceId: "workspace:v1:heisenberg" },
    baseDbPath: "/store",
    mode: "apply",
    dryRun: false,
    allowWrite: true,
    vaultConfirmed: true,
  };

  it("grants the semantic index write only through the semantic-discovery confirm plan with a confirmed action", () => {
    const dashboards = parseObsidianCommandPlan(["dashboards", "build"], base).mutationPolicy;
    assert.equal(mutationAllowed(dashboards, "vault_write"), true);
    assert.equal(mutationAllowed(dashboards, "semantic_index_write"), false, "the dashboards plan never carries the index capability");

    const scheduled = parseObsidianCommandPlan(["semantic-discovery", "confirm"], { ...base, actionConfirmed: true }).mutationPolicy;
    assert.equal(mutationAllowed(scheduled, "semantic_index_write"), true);
    assert.equal(mutationAllowed(scheduled, "vault_write"), true);

    const unconfirmedAction = parseObsidianCommandPlan(["semantic-discovery", "confirm"], base).mutationPolicy;
    assert.equal(mutationAllowed(unconfirmedAction, "semantic_index_write"), false, "the interactive two-step still needs its confirmation");

    const noReceipt = parseObsidianCommandPlan(["semantic-discovery", "confirm"], { ...base, vaultConfirmed: false, actionConfirmed: true }).mutationPolicy;
    assert.equal(mutationAllowed(noReceipt, "vault_write"), false, "a scheduled run without a vault receipt stays blocked");
  });
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createWorkspacePolicyStore } from "../lib/workspace-policy.js";
import {
  createWorkspacePolicyGuard,
  guardWorkspaceTools,
  workspaceDisabledResult,
} from "../lib/workspace-policy-guard.js";

const context = Object.freeze({
  agentId: "agent-a",
  workspaceIdentity: "workspace:v1:alpha",
});

function harness() {
  const invalidations = [];
  const store = createWorkspacePolicyStore({
    stateRoot: mkdtempSync(join(tmpdir(), "plur1bus-workspace-guard-")),
    now: () => 1234,
  });
  const guard = createWorkspacePolicyGuard({
    store,
    invalidate: async (value) => invalidations.push(value),
  });
  return { guard, invalidations };
}

describe("workspace policy guard", () => {
  it("allows unknown workspaces by default", () => {
    const { guard } = harness();
    assert.deepStrictEqual(guard.decision(context), {
      allowed: true,
      policy: { ...context, enabled: true, revision: 0, source: "default" },
    });
    assert.deepStrictEqual(guard.automatic(context), { allowed: true });
  });

  it("returns a structured explicit result and an automatic no-op while disabled", async () => {
    const { guard } = harness();
    await guard.set({ memoryCtx: context, enabled: false, expectedRevision: 0, actorId: "operator:test" });
    const policy = guard.decision(context).policy;
    assert.deepStrictEqual(guard.automatic(context), { allowed: false, reason: "workspace_disabled" });
    assert.deepStrictEqual(workspaceDisabledResult(policy), {
      ok: false,
      code: "workspace_disabled",
      retryable: false,
      policy,
    });
    assert.throws(
      () => guard.requireEnabled(context),
      (error) => error?.code === "workspace_disabled"
        && error.policy.enabled === false
        && error.policy.workspaceIdentity === policy.workspaceIdentity,
    );
  });

  it("invalidates only after a durable policy mutation", async () => {
    const { guard, invalidations } = harness();
    await guard.set({ memoryCtx: context, enabled: false, expectedRevision: 0, actorId: "operator:test" });
    assert.deepStrictEqual(invalidations, [context]);
    await assert.rejects(
      () => guard.set({ memoryCtx: context, enabled: true, expectedRevision: 0, actorId: "operator:test" }),
      /revision conflict/i,
    );
    assert.deepStrictEqual(invalidations, [context]);
  });

  it("fails closed when the canonical workspace binding is absent", () => {
    const { guard } = harness();
    assert.deepStrictEqual(guard.automatic({ agentId: "agent-a" }), {
      allowed: false,
      reason: "workspace_identity_required",
    });
    assert.throws(
      () => guard.requireEnabled({ agentId: "agent-a" }),
      (error) => error?.code === "workspace_identity_required",
    );
  });

  it("preserves tool metadata while preventing disabled execution", async () => {
    let executions = 0;
    const guarded = guardWorkspaceTools([{
      name: "memory_store",
      description: "store",
      parameters: { type: "object" },
      async execute() { executions += 1; return { content: [] }; },
    }], { allowed: false, policy: { ...context, enabled: false, revision: 1 } });
    assert.equal(guarded[0].name, "memory_store");
    assert.equal(guarded[0].description, "store");
    assert.deepStrictEqual(await guarded[0].execute("call", { text: "secret" }), {
      content: [{ type: "text", text: "PLUR1BUS is disabled for this workspace." }],
      details: { action: "rejected", reason: "workspace_disabled" },
    });
    assert.equal(executions, 0);
  });

  it("leaves execute wrappable by the OpenClaw plugin-tool proxy", () => {
    const [guarded] = guardWorkspaceTools([{
      name: "memory_recall",
      async execute() { return { content: [] }; },
    }], { allowed: false, policy: { ...context, enabled: false, revision: 1 } });
    const wrappedExecute = async () => ({ content: [] });
    const openClawProxy = new Proxy(guarded, {
      get(target, property, receiver) {
        if (property === "execute") return wrappedExecute;
        return Reflect.get(target, property, receiver);
      },
    });

    assert.equal(openClawProxy.execute, wrappedExecute);
    assert.equal(Object.getOwnPropertyDescriptor(guarded, "execute")?.configurable, true);
  });
});

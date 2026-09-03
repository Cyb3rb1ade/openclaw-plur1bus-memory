import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryMaintenanceGate } from "../lib/memory-maintenance-gate.js";
import { createWorkspacePolicyGuard, guardWorkspaceTools } from "../lib/workspace-policy-guard.js";

const memoryCtx = Object.freeze({ agentId: "agent-a", workspaceIdentity: "workspace:v1:alpha" });
const enabledPolicy = Object.freeze({ ...memoryCtx, enabled: true, revision: 0, source: "default" });

describe("memory maintenance gate", () => {
  it("fails closed for explicit and automatic memory paths during a switch", async () => {
    const gate = createMemoryMaintenanceGate();
    const guard = createWorkspacePolicyGuard({
      store: { get: () => enabledPolicy, set: async () => enabledPolicy },
      maintenanceGate: gate,
    });

    await gate.enter({ reason: "reembedding_switch", migrationId: "migration-1" });
    assert.deepStrictEqual(guard.automatic(memoryCtx), {
      allowed: false,
      reason: "migration_switching",
      retryable: true,
    });
    assert.throws(
      () => guard.requireEnabled(memoryCtx),
      (error) => error?.code === "migration_switching" && error?.retryable === true,
    );
    const [tool] = guardWorkspaceTools([{ name: "memory_store", execute: async () => ({}) }], guard.decision(memoryCtx));
    assert.deepStrictEqual(await tool.execute(), {
      content: [{ type: "text", text: "PLUR1BUS memory is temporarily unavailable while re-embedding switches generations." }],
      details: { action: "rejected", reason: "migration_switching", retryable: true },
    });

    await gate.exit({ reason: "reembedding_switch", migrationId: "migration-1" });
    assert.equal(guard.decision(memoryCtx).allowed, true);
  });

  it("requires a matching lease and exposes only redacted status", async () => {
    const gate = createMemoryMaintenanceGate({ now: () => 1234 });
    await gate.enter({ reason: "reembedding_switch", migrationId: "migration-secret-name" });
    assert.deepStrictEqual(gate.status(), {
      active: true,
      reason: "reembedding_switch",
      since: 1234,
    });
    await assert.rejects(
      gate.exit({ reason: "reembedding_switch", migrationId: "wrong" }),
      /lease mismatch/,
    );
    assert.equal(gate.status().active, true);
    await assert.rejects(
      gate.enter({ reason: "reembedding_switch", migrationId: "migration-2" }),
      /already active/,
    );
  });

  it("inherits a durable switching state after plugin reload and releases when it becomes terminal", () => {
    let migrationState = "switching";
    const gate = createMemoryMaintenanceGate({
      externalStatus: () => migrationState === "switching"
        ? { active: true, reason: "reembedding_switch", since: 5678 }
        : { active: false },
    });

    assert.deepStrictEqual(gate.status(), {
      active: true,
      reason: "reembedding_switch",
      since: 5678,
    });
    migrationState = "completed";
    assert.deepStrictEqual(gate.status(), { active: false });
  });
});

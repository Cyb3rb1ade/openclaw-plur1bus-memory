import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createMigrationConfirmation } from "../lib/reembedding/confirmation.js";
import { normalizeEmbeddingFingerprint } from "../lib/reembedding/fingerprint.js";
import { createMigrationStateStore } from "../lib/reembedding/state-store.js";
import {
  createReembeddingSwitchRecovery,
  createReembeddingSwitchRuntime,
} from "../lib/reembedding/switch-runtime.js";

const sourceFingerprint = normalizeEmbeddingFingerprint({ provider: "openai", model: "source", dimensions: 3 }, []);
const targetFingerprint = normalizeEmbeddingFingerprint({ provider: "openai", model: "target", dimensions: 4 }, []);
const planDigest = `sha256:${"a".repeat(64)}`;

async function readyRecord(store, { sourceSecretRef = { source: "env", provider: "default", id: "OPENAI_API_KEY" } } = {}) {
  const confirmation = createMigrationConfirmation({
    planDigest,
    expiresAt: 10_000,
    randomBytes: () => Buffer.alloc(32, 5),
  });
  let record = await store.create({
    id: "migration-0001",
    state: "planned",
    planDigest,
    confirmation: confirmation.persisted,
    source: {
      generation: "generation-source",
      selection: { mode: "legacy" },
      fingerprint: sourceFingerprint,
      fingerprintId: "source-id",
      ...(sourceSecretRef ? { secretRef: sourceSecretRef } : {}),
      tables: [],
      configRevision: "config-a",
    },
    target: {
      generation: "generation-target",
      fingerprint: targetFingerprint,
      fingerprintId: "target-id",
    },
    cursor: { tableIndex: 0, offset: 0, completedRows: 0, providerCalls: 0, bytes: 0 },
    receipts: { validation: { semanticRecall: true } },
  });
  for (const [from, to] of [
    ["planned", "confirmed"],
    ["confirmed", "running"],
    ["running", "validating"],
    ["validating", "ready_to_switch"],
  ]) record = await store.transition(record.id, from, to, { expectedRevision: record.revision });
  return { record, token: confirmation.token };
}

describe("maintenance-gated generation switch", () => {
  let stateRoot;
  beforeEach(() => { stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-reembedding-switch-")); });
  afterEach(() => { rmSync(stateRoot, { recursive: true, force: true }); });

  it("hands a confirmed switch to the activated target runtime before completing", async () => {
    const stateStore = createMigrationStateStore({ stateRoot, now: () => 1_000 });
    const { token } = await readyRecord(stateStore);
    const events = [];
    const runtime = createReembeddingSwitchRuntime({
      stateStore,
      now: () => 1_000,
      maintenanceGate: {
        enter: async () => events.push("gate:enter"),
        exit: async () => events.push("gate:exit"),
      },
      mutateSelection: async (selection) => events.push(`mutate:${selection.generation}`),
    });

    const handedOff = await runtime.switchGeneration({ id: "migration-0001", token });
    assert.equal(handedOff.state, "switching");
    assert.deepStrictEqual(events, ["gate:enter", "mutate:generation-target", "gate:exit"]);

    const recovery = createReembeddingSwitchRecovery({
      stateStore,
      readActiveSelection: () => ({ generation: "generation-target" }),
      mutateSelection: async () => assert.fail("successful target recovery must not mutate config again"),
      probeRuntime: async ({ expectedGeneration, rollback }) => {
        assert.equal(expectedGeneration, "generation-target");
        assert.equal(rollback, false);
        return { readiness: true, store: true, recall: true };
      },
    });
    const completed = await recovery.start();
    assert.equal(completed.state, "completed");
    assert.equal(completed.receipts.switch.generation, "generation-target");
    await recovery.shutdown();
  });

  it("keeps the durable gate active across target failure and source-runtime rollback recovery", async () => {
    const stateStore = createMigrationStateStore({ stateRoot, now: () => 1_000 });
    const { token } = await readyRecord(stateStore);
    const mutations = [];
    const runtime = createReembeddingSwitchRuntime({
      stateStore,
      now: () => 1_000,
      maintenanceGate: { enter: async () => {}, exit: async () => {} },
      mutateSelection: async (selection) => mutations.push(selection.generation),
    });
    assert.equal((await runtime.switchGeneration({ id: "migration-0001", token })).state, "switching");

    const targetRecovery = createReembeddingSwitchRecovery({
      stateStore,
      readActiveSelection: () => ({ generation: "generation-target" }),
      mutateSelection: async (selection) => mutations.push(selection.generation),
      probeRuntime: async () => { throw new Error("target probe failed"); },
    });
    const rollbackPending = await targetRecovery.start();
    assert.equal(rollbackPending.state, "switching");
    assert.equal(rollbackPending.error.code, "switch_probe_failed_pending_rollback");
    await targetRecovery.shutdown();

    const sourceRecovery = createReembeddingSwitchRecovery({
      stateStore,
      readActiveSelection: () => ({ generation: null }),
      mutateSelection: async () => assert.fail("source recovery must not mutate config"),
      probeRuntime: async ({ expectedGeneration, rollback }) => {
        assert.equal(expectedGeneration, null);
        assert.equal(rollback, true);
        return { readiness: true, store: true, recall: true };
      },
    });
    const failed = await sourceRecovery.start();
    assert.equal(failed.state, "failed");
    assert.deepStrictEqual(failed.error, { code: "switch_probe_failed", rollbackRestored: true });
    assert.deepStrictEqual(mutations, ["generation-target", null]);
    await sourceRecovery.shutdown();
  });

  it("retries a failed rollback config mutation after target-runtime restart", async () => {
    const stateStore = createMigrationStateStore({ stateRoot, now: () => 1_000 });
    const { token } = await readyRecord(stateStore);
    const runtime = createReembeddingSwitchRuntime({
      stateStore,
      now: () => 1_000,
      maintenanceGate: { enter: async () => {}, exit: async () => {} },
      mutateSelection: async () => {},
    });
    await runtime.switchGeneration({ id: "migration-0001", token });

    const firstRecovery = createReembeddingSwitchRecovery({
      stateStore,
      readActiveSelection: () => ({ generation: "generation-target" }),
      mutateSelection: async () => { throw new Error("rollback write failed"); },
      probeRuntime: async () => { throw new Error("target probe failed"); },
    });
    await assert.rejects(firstRecovery.start(), /target probe and rollback config mutation failed/);
    await assert.rejects(firstRecovery.shutdown(), /target probe and rollback config mutation failed/);
    assert.equal(stateStore.get("migration-0001").error.code, "switch_rollback_config_mutation_failed");

    let rollbackMutations = 0;
    const retryRecovery = createReembeddingSwitchRecovery({
      stateStore,
      readActiveSelection: () => ({ generation: "generation-target" }),
      mutateSelection: async (selection) => {
        rollbackMutations += 1;
        assert.equal(selection.generation, null);
      },
      probeRuntime: async () => assert.fail("pending rollback must not probe the failed target again"),
    });
    assert.equal((await retryRecovery.start()).state, "switching");
    assert.equal(rollbackMutations, 1);
    await retryRecovery.shutdown();
  });

  it("keeps a config-mutation failure in the durable switching gate", async () => {
    const stateStore = createMigrationStateStore({ stateRoot, now: () => 1_000 });
    const { token } = await readyRecord(stateStore);
    const gateEvents = [];
    let active = false;
    const runtime = createReembeddingSwitchRuntime({
      stateStore,
      now: () => 1_000,
      maintenanceGate: {
        enter: async () => { assert.equal(active, false); active = true; gateEvents.push("enter"); },
        exit: async () => { assert.equal(active, true); active = false; gateEvents.push("exit"); },
      },
      mutateSelection: async () => { assert.equal(active, true); throw new Error("config mutation failed"); },
    });

    await assert.rejects(runtime.switchGeneration({ id: "migration-0001", token }), /config mutation failed/);
    assert.deepStrictEqual(gateEvents, ["enter", "exit"]);
    assert.equal(active, false);
    const pending = await runtime.status("migration-0001");
    assert.equal(pending.state, "switching");
    assert.deepStrictEqual(pending.error, { code: "switch_config_mutation_failed", rollbackRestored: false });
  });

  it("completes only after readiness, store, and recall pass under the gate", async () => {
    const stateStore = createMigrationStateStore({ stateRoot, now: () => 1_000 });
    const { token } = await readyRecord(stateStore);
    const gate = [];
    const runtime = createReembeddingSwitchRuntime({
      stateStore,
      now: () => 1_000,
      maintenanceGate: {
        enter: async () => gate.push("enter"),
        exit: async () => gate.push("exit"),
      },
      mutateSelection: async () => gate.push("mutate"),
    });
    const handedOff = await runtime.switchGeneration({ id: "migration-0001", token });
    assert.equal(handedOff.state, "switching");
    const recovery = createReembeddingSwitchRecovery({
      stateStore,
      readActiveSelection: () => ({ generation: "generation-target" }),
      mutateSelection: async () => assert.fail("successful target recovery must not mutate config"),
      probeRuntime: async ({ fingerprint }) => {
        assert.deepStrictEqual(fingerprint, targetFingerprint);
        return { readiness: true, store: true, recall: true };
      },
    });
    const result = await recovery.start();
    assert.equal(result.state, "completed");
    assert.deepStrictEqual(gate, ["enter", "mutate", "exit"]);
    await recovery.shutdown();
  });

  it("refuses a remote source whose rollback credential cannot be persisted safely", async () => {
    const stateStore = createMigrationStateStore({ stateRoot, now: () => 1_000 });
    const { token } = await readyRecord(stateStore, { sourceSecretRef: null });
    let mutated = false;
    const runtime = createReembeddingSwitchRuntime({
      stateStore,
      now: () => 1_000,
      maintenanceGate: { enter: async () => {}, exit: async () => {} },
      mutateSelection: async () => { mutated = true; },
    });
    await assert.rejects(
      runtime.switchGeneration({ id: "migration-0001", token }),
      /rollback credential reference is required/,
    );
    assert.equal(mutated, false);
    assert.equal((await runtime.status("migration-0001")).state, "ready_to_switch");
  });

  it("plans manual rollback as a new reverse copy-on-write migration", async () => {
    const stateStore = createMigrationStateStore({ stateRoot, now: () => 1_000 });
    const { token } = await readyRecord(stateStore);
    const runtime = createReembeddingSwitchRuntime({
      stateStore,
      now: () => 1_000,
      maintenanceGate: { enter: async () => {}, exit: async () => {} },
      mutateSelection: async () => {},
    });
    await runtime.switchGeneration({ id: "migration-0001", token });
    const recovery = createReembeddingSwitchRecovery({
      stateStore,
      readActiveSelection: () => ({ generation: "generation-target" }),
      mutateSelection: async () => assert.fail("successful target recovery must not mutate config"),
      probeRuntime: async () => ({ readiness: true, store: true, recall: true }),
    });
    await recovery.start();
    const reverseMigrationId = `rollback-e5-${"a".repeat(36)}`;
    const reverse = await runtime.planManualRollback({
      completedId: "migration-0001",
      newMigrationId: reverseMigrationId,
    });
    assert.equal(reverse.id, reverseMigrationId);
    assert.equal(reverse.sourceGeneration, "generation-target");
    assert.deepStrictEqual(reverse.target.fingerprint, sourceFingerprint);
    assert.deepStrictEqual(reverse.target.secretRef, {
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
    assert.notEqual(reverse.targetGeneration, "generation-source");
    assert.match(reverse.targetGeneration, /^rollback-[a-f0-9]{48}$/);
    assert.ok(reverse.targetGeneration.length <= 64, "derived generation must satisfy the Lance generation-id contract");
    await recovery.shutdown();
  });
});

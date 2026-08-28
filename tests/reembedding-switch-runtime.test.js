import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createMigrationConfirmation } from "../lib/reembedding/confirmation.js";
import { normalizeEmbeddingFingerprint } from "../lib/reembedding/fingerprint.js";
import { createMigrationStateStore } from "../lib/reembedding/state-store.js";
import { createReembeddingSwitchRuntime } from "../lib/reembedding/switch-runtime.js";

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

  it("automatically restores the source selection when the target readiness probe fails", async () => {
    const stateStore = createMigrationStateStore({ stateRoot, now: () => 1_000 });
    const { token } = await readyRecord(stateStore);
    const configPatches = [];
    const gateEvents = [];
    let active = false;
    const runtime = createReembeddingSwitchRuntime({
      stateStore,
      now: () => 1_000,
      maintenanceGate: {
        enter: async () => { assert.equal(active, false); active = true; gateEvents.push("enter"); },
        exit: async () => { assert.equal(active, true); active = false; gateEvents.push("exit"); },
      },
      mutateSelection: async (selection) => { assert.equal(active, true); configPatches.push(selection); },
      probeRuntime: async ({ expectedGeneration, rollback }) => {
        assert.equal(active, true);
        if (!rollback && expectedGeneration === "generation-target") throw new Error("readiness probe failed");
        if (rollback) assert.equal(expectedGeneration, null);
        return { readiness: true, store: true, recall: true };
      },
    });

    await assert.rejects(runtime.switchGeneration({ id: "migration-0001", token }), /readiness probe failed/);
    assert.deepStrictEqual(configPatches.map((value) => value.generation), ["generation-target", null]);
    assert.deepStrictEqual(configPatches[1].secretRef, {
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
    assert.deepStrictEqual(gateEvents, ["enter", "exit"]);
    assert.equal(active, false);
    assert.equal((await runtime.status("migration-0001")).state, "failed");
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
      probeRuntime: async ({ fingerprint }) => {
        assert.deepStrictEqual(fingerprint, targetFingerprint);
        return { readiness: true, store: true, recall: true };
      },
    });
    const result = await runtime.switchGeneration({ id: "migration-0001", token });
    assert.equal(result.state, "completed");
    assert.deepStrictEqual(gate, ["enter", "mutate", "exit"]);
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
      probeRuntime: async () => ({ readiness: true, store: true, recall: true }),
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
      probeRuntime: async () => ({ readiness: true, store: true, recall: true }),
    });
    await runtime.switchGeneration({ id: "migration-0001", token });
    const reverse = await runtime.planManualRollback({
      completedId: "migration-0001",
      newMigrationId: "rollback-0001",
    });
    assert.equal(reverse.sourceGeneration, "generation-target");
    assert.deepStrictEqual(reverse.target.fingerprint, sourceFingerprint);
    assert.deepStrictEqual(reverse.target.secretRef, {
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
    assert.notEqual(reverse.targetGeneration, "generation-source");
    assert.match(reverse.targetGeneration, /^rollback-rollback-0001-/);
  });
});

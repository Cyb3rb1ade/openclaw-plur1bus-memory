import { createHash } from "node:crypto";

import { verifyMigrationConfirmation } from "./confirmation.js";

function selectionFrom(record, side) {
  const value = record[side];
  return Object.freeze({
    generation: value.selection?.mode === "legacy" ? null : value.generation,
    fingerprint: value.fingerprint,
    fingerprintId: value.fingerprintId,
    ...(value.secretRef ? { secretRef: value.secretRef } : {}),
  });
}

function validateProbe(result) {
  if (!result || result.readiness !== true || result.store !== true || result.recall !== true) {
    throw new Error("PLUR1BUS target readiness, store, and recall probe failed");
  }
  return Object.freeze({ readiness: true, store: true, recall: true });
}

/** Build the official-config, maintenance-gated generation switch adapter. */
export function createReembeddingSwitchRuntime({
  stateStore,
  maintenanceGate,
  mutateSelection,
  now = Date.now,
} = {}) {
  if (!stateStore || typeof stateStore.transition !== "function") throw new Error("reembedding state store is required");
  if (!maintenanceGate || typeof maintenanceGate.enter !== "function" || typeof maintenanceGate.exit !== "function") {
    throw new Error("PLUR1BUS maintenance gate is required");
  }
  if (typeof mutateSelection !== "function") throw new Error("OpenClaw config mutation capability is required");
  if (typeof now !== "function") throw new Error("reembedding switch clock is required");
  let active = null;

  const exclusive = async (operation) => {
    if (active) throw new Error("another reembedding switch is active");
    const promise = Promise.resolve().then(operation);
    active = promise;
    try { return await promise; } finally { if (active === promise) active = null; }
  };

  const switchGeneration = ({ id, token } = {}) => exclusive(async () => {
    let record = stateStore.get(id);
    if (!record) throw new Error("reembedding migration not found");
    if (record.state !== "ready_to_switch") throw new Error(`reembedding switch requires ready_to_switch state; found ${record.state}`);
    if (!record.receipts?.validation?.semanticRecall) throw new Error("reembedding switch requires a semantic recall validation receipt");
    if (record.source?.fingerprint?.provider !== "local-transformers" && !record.source?.secretRef) {
      throw new Error("a persistable rollback credential reference is required for the remote source provider");
    }
    if (!verifyMigrationConfirmation(token, record.confirmation, now())) throw new Error("invalid or expired reembedding confirmation");

    await maintenanceGate.enter({ reason: "reembedding_switch", migrationId: id });
    try {
      record = await stateStore.transition(id, "ready_to_switch", "switching", { expectedRevision: record.revision });
      const targetSelection = selectionFrom(record, "target");
      await mutateSelection(targetSelection);
      // OpenClaw applies plugin config changes by activating a replacement
      // registry and disposing this runtime generation. The activated target
      // runtime owns the post-switch probe and durable completion transition.
      return stateStore.get(id);
    } catch (error) {
      const current = stateStore.get(id);
      if (current?.state === "switching") {
        try {
          await stateStore.update(id, {
            expectedRevision: current.revision,
            expectedState: "switching",
            patch: {
              error: {
                code: "switch_config_mutation_failed",
                rollbackRestored: false,
              },
            },
          });
        } catch (stateError) {
          throw new AggregateError([error, stateError], "reembedding switch handoff and state update failed");
        }
      }
      throw error;
    } finally {
      await maintenanceGate.exit({ reason: "reembedding_switch", migrationId: id });
    }
  });

  const planManualRollback = async ({ completedId, newMigrationId } = {}) => {
    const record = stateStore.get(completedId);
    if (!record) throw new Error("completed reembedding migration not found");
    if (record.state !== "completed") throw new Error("manual rollback requires a completed migration");
    if (typeof newMigrationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(newMigrationId)) {
      throw new Error("invalid reverse migration id");
    }
    const suffix = createHash("sha256")
      .update(`${record.target.generation}\0${record.source.fingerprintId}\0${newMigrationId}\0${now()}`)
      .digest("hex")
      .slice(0, 48);
    return Object.freeze({
      id: newMigrationId,
      sourceGeneration: record.target.generation,
      targetGeneration: `rollback-${suffix}`,
      target: Object.freeze({
        fingerprint: record.source.fingerprint,
        ...(record.source.secretRef ? { secretRef: record.source.secretRef } : {}),
      }),
      reverseOf: completedId,
    });
  };

  const status = async (id) => stateStore.get(id);
  return Object.freeze({ switchGeneration, planManualRollback, status });
}

/** Reconcile a durable switch only after OpenClaw activates the replacement plugin runtime. */
export function createReembeddingSwitchRecovery({
  stateStore,
  readActiveSelection,
  mutateSelection,
  probeRuntime,
} = {}) {
  if (!stateStore || typeof stateStore.get !== "function" || typeof stateStore.list !== "function") {
    throw new Error("reembedding state store is required");
  }
  if (typeof readActiveSelection !== "function") throw new Error("active selection reader is required");
  if (typeof mutateSelection !== "function") throw new Error("OpenClaw config mutation capability is required");
  if (typeof probeRuntime !== "function") throw new Error("PLUR1BUS runtime probe capability is required");

  let activeTask = null;
  let stopped = false;

  const probeSelection = async (record, side, rollback) => {
    const selection = selectionFrom(record, side);
    return validateProbe(await probeRuntime({
      expectedGeneration: selection.generation,
      fingerprint: record[side].fingerprint,
      ...(record[side].secretRef ? { secretRef: record[side].secretRef } : {}),
      migrationId: record.id,
      rollback,
    }));
  };

  const updateSwitchError = async (record, code) => stateStore.update(record.id, {
    expectedRevision: record.revision,
    expectedState: "switching",
    patch: { error: { code, rollbackRestored: false } },
  });

  const reconcile = async () => {
    const record = stateStore.list().find((candidate) => candidate.state === "switching") || null;
    if (!record) return null;
    const activeGeneration = readActiveSelection()?.generation ?? null;
    const targetSelection = selectionFrom(record, "target");
    const sourceSelection = selectionFrom(record, "source");
    const rollbackPending = [
      "switch_probe_failed_pending_rollback",
      "switch_rollback_config_mutation_failed",
    ].includes(record.error?.code);

    if (activeGeneration === targetSelection.generation && rollbackPending) {
      try {
        await mutateSelection(sourceSelection);
        return stateStore.get(record.id);
      } catch (rollbackMutationError) {
        await updateSwitchError(record, "switch_rollback_config_mutation_failed");
        throw rollbackMutationError;
      }
    }

    if (activeGeneration === targetSelection.generation && !rollbackPending) {
      try {
        const probe = await probeSelection(record, "target", false);
        return stateStore.transition(record.id, "switching", "completed", {
          expectedRevision: record.revision,
          patch: {
            error: null,
            receipts: {
              ...(record.receipts || {}),
              switch: { ...probe, generation: record.target.generation },
            },
          },
        });
      } catch (probeError) {
        let current = await updateSwitchError(record, "switch_probe_failed_pending_rollback");
        try {
          await mutateSelection(sourceSelection);
          return stateStore.get(record.id);
        } catch (rollbackMutationError) {
          current = await updateSwitchError(current, "switch_rollback_config_mutation_failed");
          throw new AggregateError(
            [probeError, rollbackMutationError],
            "reembedding target probe and rollback config mutation failed",
          );
        }
      }
    }

    if (activeGeneration === sourceSelection.generation) {
      try {
        await probeSelection(record, "source", true);
      } catch (rollbackProbeError) {
        await updateSwitchError(record, "switch_rollback_probe_failed");
        throw rollbackProbeError;
      }
      return stateStore.transition(record.id, "switching", "failed", {
        expectedRevision: record.revision,
        patch: {
          error: {
            code: rollbackPending ? "switch_probe_failed" : "switch_target_not_activated",
            rollbackRestored: true,
          },
        },
      });
    }

    throw new Error("active generation selection drift during durable reembedding switch recovery");
  };

  const start = () => {
    if (stopped) throw new Error("reembedding switch recovery is stopped");
    if (!activeTask) activeTask = reconcile();
    return activeTask;
  };
  const shutdown = async () => {
    stopped = true;
    if (activeTask) await activeTask;
  };
  return Object.freeze({ start, shutdown });
}

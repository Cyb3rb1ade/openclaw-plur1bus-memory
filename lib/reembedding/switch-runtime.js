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
  probeRuntime,
  now = Date.now,
} = {}) {
  if (!stateStore || typeof stateStore.transition !== "function") throw new Error("reembedding state store is required");
  if (!maintenanceGate || typeof maintenanceGate.enter !== "function" || typeof maintenanceGate.exit !== "function") {
    throw new Error("PLUR1BUS maintenance gate is required");
  }
  if (typeof mutateSelection !== "function") throw new Error("OpenClaw config mutation capability is required");
  if (typeof probeRuntime !== "function") throw new Error("PLUR1BUS runtime probe capability is required");
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
    let targetSelected = false;
    try {
      record = await stateStore.transition(id, "ready_to_switch", "switching", { expectedRevision: record.revision });
      const targetSelection = selectionFrom(record, "target");
      await mutateSelection(targetSelection);
      targetSelected = true;
      const probe = validateProbe(await probeRuntime({
        expectedGeneration: targetSelection.generation,
        fingerprint: record.target.fingerprint,
        ...(record.target.secretRef ? { secretRef: record.target.secretRef } : {}),
        migrationId: id,
        rollback: false,
      }));
      record = await stateStore.transition(id, "switching", "completed", {
        expectedRevision: record.revision,
        patch: {
          receipts: {
            ...(record.receipts || {}),
            switch: { ...probe, generation: record.target.generation },
          },
        },
      });
      return record;
    } catch (error) {
      const rollbackErrors = [];
      if (targetSelected) {
        try {
          const sourceSelection = selectionFrom(record, "source");
          await mutateSelection(sourceSelection);
          validateProbe(await probeRuntime({
            expectedGeneration: sourceSelection.generation,
            fingerprint: record.source.fingerprint,
            ...(record.source.secretRef ? { secretRef: record.source.secretRef } : {}),
            migrationId: id,
            rollback: true,
          }));
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      const current = stateStore.get(id);
      if (current?.state === "switching") {
        try {
          await stateStore.transition(id, "switching", "failed", {
            expectedRevision: current.revision,
            patch: {
              error: {
                code: rollbackErrors.length ? "switch_and_rollback_failed" : "switch_probe_failed",
                rollbackRestored: targetSelected && rollbackErrors.length === 0,
              },
            },
          });
        } catch (stateError) {
          rollbackErrors.push(stateError);
        }
      }
      if (rollbackErrors.length) {
        throw new AggregateError([error, ...rollbackErrors], "reembedding switch and automatic rollback failed");
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
      .slice(0, 12);
    return Object.freeze({
      id: newMigrationId,
      sourceGeneration: record.target.generation,
      targetGeneration: `rollback-${newMigrationId}-${suffix}`,
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

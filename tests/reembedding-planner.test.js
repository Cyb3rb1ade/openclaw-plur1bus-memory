import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeEmbeddingFingerprint } from "../lib/reembedding/fingerprint.js";
import { createReembeddingPlan } from "../lib/reembedding/planner.js";

const sourceFingerprint = normalizeEmbeddingFingerprint({
  provider: "local-transformers",
  model: "org/source",
  revision: "source-revision",
  dimensions: 384,
}, [{ path: "onnx/model.onnx", sha256: "a".repeat(64) }]);
const targetFingerprint = normalizeEmbeddingFingerprint({
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 1536,
  endpoint: "https://api.openai.com/v1",
}, []);

function inventory(generations = undefined) {
  return generations ?? [{
    generation: "generation-active",
    configRevision: "config-sha256-a",
    fingerprint: sourceFingerprint,
    tables: [
      { tableId: "agent-a/memories", version: "table-version-a", rowCount: 17, estimatedBytes: 10_000 },
      { tableId: "agent-b/memories", version: "table-version-b", rowCount: 3, estimatedBytes: 2_000 },
    ],
  }];
}

describe("read-only reembedding planner", () => {
  it("inventories one source, probes a remote target, and emits only redacted state", async () => {
    const calls = [];
    const secret = "resolved-secret-must-not-appear";
    const result = await createReembeddingPlan({
      id: "migration-0001",
      targetGeneration: "generation-target",
      target: {
        fingerprint: targetFingerprint,
        secretRef: { source: "store", provider: "lab", id: "EMBEDDING_TARGET" },
      },
      confirmationTtlMs: 60_000,
    }, {
      now: () => 1_000,
      randomBytes: () => Buffer.alloc(32, 9),
      inventoryActiveGeneration: async () => { calls.push("inventory"); return inventory(); },
      statDisk: async () => { calls.push("stat"); return { freeBytes: 1_000_000 }; },
      probeTargetProvider: async () => { calls.push("probe"); return new Array(1536).fill(0.25); },
      forbiddenWrite: async () => { calls.push("write"); },
    });

    assert.deepStrictEqual(calls, ["inventory", "stat", "probe"]);
    assert.equal(result.plan.source.tables[0].rowCount, 17);
    assert.equal(result.plan.estimates.rows, 20);
    assert.equal(result.plan.target.probeStatus, "passed");
    assert.deepStrictEqual(result.plan.target.secretRef, { source: "store", provider: "lab", id: "EMBEDDING_TARGET" });
    assert.match(result.planDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(result.confirmation.persisted, "token"), false);
    assert.doesNotMatch(JSON.stringify(result.plan), new RegExp(secret));
  });

  it("defers a local probe only when immutable artifacts are not yet cached", async () => {
    let probes = 0;
    const localTarget = normalizeEmbeddingFingerprint({
      provider: "local-transformers",
      model: "org/target",
      revision: "target-revision",
      dimensions: 768,
    }, [{ path: "onnx/model.onnx", sha256: "c".repeat(64) }]);
    const result = await createReembeddingPlan({
      id: "migration-0001",
      target: { fingerprint: localTarget },
    }, {
      now: () => 1_000,
      randomBytes: () => Buffer.alloc(32, 9),
      inventoryActiveGeneration: async () => inventory(),
      statDisk: async () => ({ freeBytes: 1_000_000 }),
      inspectTargetArtifacts: async () => ({ ready: false, verified: false }),
      probeTargetProvider: async () => { probes += 1; return new Array(768).fill(0.1); },
    });
    assert.equal(result.plan.target.probeStatus, "probe_deferred_local_artifact");
    assert.equal(probes, 0);
  });

  it("fails closed on zero/multiple active generations, low disk, and invalid probes", async () => {
    const baseDeps = {
      now: () => 1_000,
      randomBytes: () => Buffer.alloc(32, 9),
      statDisk: async () => ({ freeBytes: 1_000_000 }),
      probeTargetProvider: async () => new Array(1536).fill(0.1),
    };
    for (const generations of [[], [...inventory(), ...inventory().map((value) => ({ ...value, generation: "other" }))]]) {
      await assert.rejects(
        createReembeddingPlan({ id: "migration-0001", target: { fingerprint: targetFingerprint } }, {
          ...baseDeps,
          inventoryActiveGeneration: async () => generations,
        }),
        /exactly one active generation/,
      );
    }
    await assert.rejects(
      createReembeddingPlan({ id: "migration-0001", target: { fingerprint: targetFingerprint } }, {
        ...baseDeps,
        inventoryActiveGeneration: async () => inventory(),
        statDisk: async () => ({ freeBytes: 1 }),
      }),
      /insufficient disk space/,
    );
    await assert.rejects(
      createReembeddingPlan({ id: "migration-0001", target: { fingerprint: targetFingerprint } }, {
        ...baseDeps,
        inventoryActiveGeneration: async () => inventory(),
        probeTargetProvider: async () => [0.1, Number.NaN],
      }),
      /probe dimension|finite/,
    );
  });

  it("rejects a no-op fingerprint and source schema drift before confirmation", async () => {
    const deps = {
      now: () => 1_000,
      randomBytes: () => Buffer.alloc(32, 9),
      statDisk: async () => ({ freeBytes: 1_000_000 }),
      probeTargetProvider: async () => new Array(384).fill(0.1),
    };
    await assert.rejects(
      createReembeddingPlan({ id: "migration-0001", target: { fingerprint: sourceFingerprint } }, {
        ...deps,
        inventoryActiveGeneration: async () => inventory(),
      }),
      /does not change the embedding fingerprint/,
    );
    await assert.rejects(
      createReembeddingPlan({ id: "migration-0001", target: { fingerprint: targetFingerprint } }, {
        ...deps,
        inventoryActiveGeneration: async () => inventory([{
          ...inventory()[0],
          tables: [{ tableId: "agent-a/memories", version: "v1", rowCount: 1, estimatedBytes: 10, dimensions: 999 }],
        }]),
      }),
      /source table dimension mismatch/,
    );
  });
});

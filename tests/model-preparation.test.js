import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  EMBEDDING_PREPARATION_TARGETS,
  E5_EMBEDDING_PROFILE,
  JINA_EMBEDDING_PROFILE,
} from "../lib/providers/local-model-artifacts.js";
import { embeddingFingerprintFromNormalizedConfig } from "../lib/reembedding/runtime-config.js";
import { embeddingFingerprintId } from "../lib/reembedding/fingerprint.js";
import {
  createFailedModelPreparationCoordinator,
  createModelPreparationCoordinator,
} from "../lib/model-preparation/coordinator.js";

function activeFingerprint() {
  return embeddingFingerprintFromNormalizedConfig({
    provider: "local-transformers",
    model: E5_EMBEDDING_PROFILE.model,
    dimensions: 384,
    local: {
      model: E5_EMBEDDING_PROFILE.model,
      dimensions: 384,
      revision: E5_EMBEDDING_PROFILE.revision,
      queryPrefix: "query: ",
      passagePrefix: "passage: ",
    },
  });
}

function validArtifactInspection(profile) {
  return {
    ok: true,
    artifacts: profile.artifacts.map((expected) => ({
      ok: true,
      expected,
      size: expected.size,
      sha256: expected.sha256,
      path: `/redacted-cache/${expected.path}`,
    })),
  };
}

function targetConfig(profile = "jina-v3-multilingual-256") {
  return { profile, acceptNonCommercialLicense: true };
}

describe("automatic local embedding model preparation", () => {
  it("publishes a closed model/dimension profile catalog", () => {
    const ids = [
        "e5-multilingual-384",
        "jina-v3-multilingual-32",
        "jina-v3-multilingual-64",
        "jina-v3-multilingual-128",
        "jina-v3-multilingual-256",
        "jina-v3-multilingual-512",
        "jina-v3-multilingual-768",
        "jina-v3-multilingual-1024",
      ];
    assert.deepStrictEqual(EMBEDDING_PREPARATION_TARGETS.map(({ id }) => id), ids);
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    assert.deepStrictEqual(manifest.configSchema.properties.modelPreparation.properties.profile.enum, ids);
  });

  it("downloads, validates, persists progress, and only suggests re-embedding", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-model-preparation-"));
    const cacheDir = join(stateRoot, "models");
    const events = [];
    const coordinator = createModelPreparationCoordinator({
      stateRoot,
      cacheDir,
      config: targetConfig(),
      activeFingerprint: activeFingerprint(),
      ensureArtifacts: async (profile, _cacheDir, { onProgress }) => {
        const total = profile.artifacts.reduce((sum, artifact) => sum + artifact.size, 0);
        await onProgress({
          state: "downloading",
          artifact: profile.artifacts[0].path,
          bytesCompleted: Math.floor(total / 2),
          bytesTotal: total,
          artifactsCompleted: 0,
          artifactsTotal: profile.artifacts.length,
        });
        await onProgress({
          state: "verified",
          artifact: profile.artifacts.at(-1).path,
          bytesCompleted: total,
          bytesTotal: total,
          artifactsCompleted: profile.artifacts.length,
          artifactsTotal: profile.artifacts.length,
        });
        return { downloaded: profile.artifacts.length, reused: 0, artifacts: [] };
      },
      validateArtifacts: async (profile) => validArtifactInspection(profile),
      inventoryActiveGeneration: async () => [{
        generation: "generation-active",
        fingerprint: activeFingerprint(),
        tables: [
          { tableId: "agent-a/memories", version: "v1", rowCount: 10, estimatedBytes: 1_000 },
          { tableId: "agent-b/memories", version: "v1", rowCount: 2, estimatedBytes: 200 },
        ],
      }],
      statDisk: async () => ({ freeBytes: 10_000_000 }),
      onState: (snapshot) => events.push(snapshot),
    });

    const ready = await coordinator.start();

    assert.equal(ready.state, "ready");
    assert.equal(ready.model, JINA_EMBEDDING_PROFILE.model);
    assert.equal(ready.dimensions, 256);
    assert.equal(ready.bytesCompleted, ready.bytesTotal);
    assert.equal(ready.artifactsCompleted, ready.artifactsTotal);
    assert.equal(ready.reembedding.status, "recommended");
    assert.equal(ready.reembedding.rows, 12);
    assert.equal(ready.reembedding.targetBytes, 1_200 + (12 * 256 * 4));
    assert.equal(ready.reembedding.nextAction, "plan_with_explicit_confirmation");
    assert.match(ready.targetFingerprintId, /^embedding:v1:sha256:[a-f0-9]{64}$/);
    assert.notEqual(ready.targetFingerprintId, embeddingFingerprintId(activeFingerprint()));
    assert.equal(existsSync(join(stateRoot, "reembedding")), false);
    assert.equal(existsSync(join(stateRoot, "generations")), false);
    assert.deepStrictEqual(readdirSync(stateRoot), ["control"]);
    assert.ok(events.some((entry) => entry.state === "downloading" && entry.bytesCompleted > 0));

    let restartEnsures = 0;
    let restartInventories = 0;
    const reopened = createModelPreparationCoordinator({
      stateRoot,
      cacheDir,
      config: targetConfig(),
      activeFingerprint: activeFingerprint(),
      ensureArtifacts: async (profile) => {
        restartEnsures += 1;
        return {
          downloaded: 0,
          reused: profile.artifacts.length,
          artifacts: [],
          receipts: validArtifactInspection(profile).artifacts,
        };
      },
      validateArtifacts: async () => { throw new Error("validated receipts must not be hashed twice"); },
      inventoryActiveGeneration: async () => {
        restartInventories += 1;
        return [{
          generation: "generation-active",
          fingerprint: activeFingerprint(),
          tables: [
            { tableId: "agent-a/memories", version: "v1", rowCount: 10, estimatedBytes: 1_000 },
            { tableId: "agent-b/memories", version: "v1", rowCount: 2, estimatedBytes: 200 },
          ],
        }];
      },
      statDisk: async () => ({ freeBytes: 10_000_000 }),
    });
    assert.deepStrictEqual(reopened.snapshot(), ready);
    const restarted = await reopened.start();
    assert.equal(restarted.state, "ready");
    assert.equal(restarted.targetFingerprintId, ready.targetFingerprintId);
    assert.equal(restartEnsures, 1);
    assert.equal(restartInventories, 1);
    assert.equal(existsSync(join(stateRoot, "reembedding")), false);
    assert.equal(existsSync(join(stateRoot, "generations")), false);
    await reopened.shutdown();
    await coordinator.shutdown();
  });

  it("does not download Jina until the non-commercial license is acknowledged", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-model-license-"));
    let downloads = 0;
    const coordinator = createModelPreparationCoordinator({
      stateRoot,
      cacheDir: join(stateRoot, "models"),
      config: { profile: "jina-v3-multilingual-256", acceptNonCommercialLicense: false },
      activeFingerprint: activeFingerprint(),
      ensureArtifacts: async () => { downloads += 1; },
      validateArtifacts: async () => ({ ok: false, artifacts: [] }),
      inventoryActiveGeneration: async () => [],
      statDisk: async () => ({ freeBytes: 1 }),
    });

    const blocked = await coordinator.start();
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.errorCode, "non_commercial_license_acknowledgement_required");
    assert.equal(downloads, 0);
    assert.doesNotMatch(JSON.stringify(blocked), /error message|cacheDir|secret/i);
  });

  it("recognizes a prepared active fingerprint without proposing a migration", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-model-same-fingerprint-"));
    const fingerprint = activeFingerprint();
    const coordinator = createModelPreparationCoordinator({
      stateRoot,
      cacheDir: join(stateRoot, "models"),
      config: { profile: "e5-multilingual-384" },
      activeFingerprint: fingerprint,
      ensureArtifacts: async () => ({ downloaded: 0, reused: E5_EMBEDDING_PROFILE.artifacts.length, artifacts: [] }),
      validateArtifacts: async (profile) => validArtifactInspection(profile),
      inventoryActiveGeneration: async () => { throw new Error("equal fingerprints need no inventory"); },
      statDisk: async () => { throw new Error("equal fingerprints need no disk estimate"); },
    });

    const ready = await coordinator.start();
    assert.equal(ready.state, "ready");
    assert.deepStrictEqual(ready.reembedding, {
      required: false,
      status: "not_required",
      rows: 0,
      targetBytes: 0,
      requiredFreeBytes: 0,
      freeBytes: null,
      nextAction: "none",
    });
  });

  it("stores only a stable diagnostic code when artifact validation fails", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-model-failure-"));
    const sentinel = `secret-${createHash("sha256").update(stateRoot).digest("hex")}`;
    const coordinator = createModelPreparationCoordinator({
      stateRoot,
      cacheDir: join(stateRoot, "models"),
      config: { profile: "e5-multilingual-384" },
      activeFingerprint: activeFingerprint(),
      ensureArtifacts: async () => { throw new Error(`HTTP 503 ${sentinel}`); },
      validateArtifacts: async () => ({ ok: false, artifacts: [] }),
      inventoryActiveGeneration: async () => [],
      statDisk: async () => ({ freeBytes: 1 }),
    });

    const failed = await coordinator.start();
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "artifact_download_failed");
    assert.doesNotMatch(JSON.stringify(failed), new RegExp(sentinel));
  });

  it("cancels validation on shutdown and never publishes a ready state afterwards", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-model-validation-abort-"));
    let signalSeen;
    let validationStarted;
    const started = new Promise((resolve) => { validationStarted = resolve; });
    const coordinator = createModelPreparationCoordinator({
      stateRoot,
      cacheDir: join(stateRoot, "models"),
      config: { profile: "e5-multilingual-384" },
      activeFingerprint: activeFingerprint(),
      ensureArtifacts: async () => ({ downloaded: 0, reused: 0, artifacts: [] }),
      validateArtifacts: async (_profile, _cacheDir, options = {}) => {
        signalSeen = options.signal;
        validationStarted();
        if (!signalSeen) throw new Error("validation did not receive a cancellation signal");
        await new Promise((_, reject) => signalSeen.addEventListener(
          "abort",
          () => reject(signalSeen.reason),
          { once: true },
        ));
      },
      inventoryActiveGeneration: async () => { throw new Error("inventory must not run after shutdown"); },
      statDisk: async () => { throw new Error("disk inspection must not run after shutdown"); },
    });

    const running = coordinator.start();
    await started;
    await coordinator.shutdown();
    const interrupted = await running;

    assert.ok(signalSeen);
    assert.equal(signalSeen.aborted, true);
    assert.equal(interrupted.state, "interrupted");
    assert.equal(interrupted.errorCode, "model_preparation_interrupted");
    assert.notEqual(coordinator.snapshot().state, "ready");
  });

  it("uses phase-specific stable diagnostics for inventory and disk failures", async () => {
    const makeCoordinator = (overrides) => {
      const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-model-dry-run-code-"));
      return createModelPreparationCoordinator({
        stateRoot,
        cacheDir: join(stateRoot, "models"),
        config: targetConfig(),
        activeFingerprint: activeFingerprint(),
        ensureArtifacts: async (profile) => ({
          downloaded: 0,
          reused: profile.artifacts.length,
          artifacts: [],
          receipts: validArtifactInspection(profile).artifacts,
        }),
        validateArtifacts: async (profile) => validArtifactInspection(profile),
        ...overrides,
      });
    };
    const inventoryFailure = await makeCoordinator({
      inventoryActiveGeneration: async () => { throw new Error("private inventory detail"); },
      statDisk: async () => ({ freeBytes: 1 }),
    }).start();
    assert.equal(inventoryFailure.errorCode, "generation_inventory_failed");

    const diskFailure = await makeCoordinator({
      inventoryActiveGeneration: async () => [{
        generation: "active",
        tables: [{ tableId: "agent/memories", rowCount: 1, estimatedBytes: 1 }],
      }],
      statDisk: async () => { throw new Error("private disk detail"); },
    }).start();
    assert.equal(diskFailure.errorCode, "disk_status_unavailable");
  });

  it("keeps malformed durable preparation state fail-closed without breaking status reads", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-model-state-invalid-"));
    const coordinator = createModelPreparationCoordinator({
      stateRoot,
      cacheDir: join(stateRoot, "models"),
      config: { profile: "e5-multilingual-384" },
      activeFingerprint: activeFingerprint(),
    });
    mkdirSync(join(stateRoot, "control"), { recursive: true });
    writeFileSync(join(stateRoot, "control", "model-preparation.json"), "{not-json", { mode: 0o600 });

    const failed = coordinator.snapshot();

    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "model_preparation_state_unavailable");
    assert.doesNotMatch(JSON.stringify(failed), /cacheDir|not-json|secret/i);
  });

  it("provides a stable optional failure runtime when coordinator construction is unavailable", async () => {
    const failedRuntime = createFailedModelPreparationCoordinator({
      config: { profile: "e5-multilingual-384" },
      activeFingerprint: activeFingerprint(),
    });

    const failed = await failedRuntime.start();

    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "model_preparation_initialization_failed");
    assert.deepStrictEqual(failedRuntime.snapshot(), failed);
    await failedRuntime.shutdown();
  });
});

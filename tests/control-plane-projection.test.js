import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildControlPlaneProjection } from "../lib/control-plane-projection.js";

describe("redacted PLUR1BUS control-plane projection", () => {
  it("builds the schema-v2 operator view from aggregate health and explicit workspace overrides", () => {
    const sentinel = "sentinel-secret-material";
    const projection = buildControlPlaneProjection({
      config: {
        autoCapture: true,
        autoRecall: true,
        skillMiner: { enabled: true },
        featureCronSetup: { auto: true },
        dreaming: { enabled: false },
        obsidianBridge: { enabled: true },
        reranker: { enabled: true, provider: "local-transformers" },
        embedding: { apiKey: sentinel },
      },
      hooks: { allowConversationAccess: true },
      capabilities: { skillWorkshop: true, cronDispatch: true },
      workspacePolicies: [
        {
          agentId: "agent-a",
          workspaceIdentity: "workspace:v1:alpha",
          enabled: false,
          revision: 2,
          actorId: sentinel,
        },
        {
          agentId: "agent-b",
          workspaceIdentity: "workspace-dir:v1:/must-not-project",
          enabled: true,
          revision: 1,
          actorId: sentinel,
        },
      ],
      health: {
        status: "ready",
        namespaces: [{ id: "lancedb-namespaced", dimensions: 768, rows: 7, path: "/must-not-project" }],
        cards: {
          byAgent: [{ id: "agent-a", cards: 3, text: "memory body must not project" }],
          byWorkspace: [{ id: "workspace:v1:alpha", cards: 2 }],
          byUser: [],
        },
        storage: { bytes: 2048, complete: true, path: "/must-not-project" },
        lastError: { component: "lancedb", code: "partition_count_failed", message: sentinel },
        observedAt: 1234,
      },
      migration: {
        id: "migration-a",
        state: "running",
        processed: 2,
        total: 4,
        estimatedBytes: 4096,
        targetFingerprint: "embedding:v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        targetDimensions: 1024,
        checkpointBytes: 256,
        failureCode: null,
        targetSecretRef: { id: sentinel },
      },
      embeddingDimensionProfiles: [{
        id: "openai:text-embedding-3-small",
        provider: "openai",
        model: "text-embedding-3-small",
        mode: "selectable",
        defaultDimensions: 1536,
        minDimensions: 1,
        maxDimensions: 1536,
        presets: [256, 512, 1536],
        current: true,
        selectedDimensions: 512,
        verification: "runtime_vector",
        apiKey: sentinel,
      }],
    });

    assert.equal(projection.schemaVersion, 2);
    assert.deepStrictEqual(projection.memoryHealth.cards.byAgent, [{ id: "agent-a", cards: 3 }]);
    assert.deepStrictEqual(projection.memoryHealth.storage, { bytes: 2048, complete: true });
    assert.equal(projection.workspaceMatrix.defaultEnabled, true);
    assert.deepStrictEqual(projection.workspaceMatrix.overrides[0], {
      agentId: "agent-a",
      workspace: "workspace:v1:alpha",
      enabled: false,
      revision: 2,
    });
    assert.match(projection.workspaceMatrix.overrides[1].workspace, /^workspace-ref:w-[a-f0-9]{62}$/);
    assert.deepStrictEqual(
      projection.featureCards.map((card) => card.id),
      ["capture", "recall", "skill-miner", "feature-cron", "rem", "obsidian", "reranker"],
    );
    assert.deepStrictEqual(projection.reembeddingWorkflow.migration, {
      id: "migration-a",
      state: "running",
      processed: 2,
      total: 4,
      estimatedBytes: 4096,
      targetFingerprint: "embedding:v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      targetDimensions: 1024,
      checkpointBytes: 256,
      failureCode: null,
    });
    assert.equal(projection.reembeddingWorkflow.steps.find((step) => step.id === "checkpoint").state, "current");
    assert.deepStrictEqual(projection.embeddingDimensionProfiles, [{
      id: "openai:text-embedding-3-small",
      provider: "openai",
      model: "text-embedding-3-small",
      mode: "selectable",
      defaultDimensions: 1536,
      minDimensions: 1,
      maxDimensions: 1536,
      presets: [256, 512, 1536],
      current: true,
      selectedDimensions: 512,
      verification: "runtime_vector",
    }]);
    assert.doesNotMatch(JSON.stringify(projection), /sentinel-secret-material|memory body|must-not-project/);
  });

  it("accepts OpenClaw plugin-entry hook permissions separately from pluginConfig", () => {
    const projection = buildControlPlaneProjection({
      config: { autoCapture: true },
      hooks: { allowConversationAccess: true },
    });

    assert.deepStrictEqual(projection.features.autoCapture, {
      configured: true,
      effective: true,
      reason: null,
    });
  });

  it("reports configured versus effective feature state with stable reasons", () => {
    const projection = buildControlPlaneProjection({
      config: {
        autoCapture: true,
        autoRecall: true,
        hooks: { allowConversationAccess: false },
        skillMiner: { enabled: true },
        featureCronSetup: { auto: true },
      },
      policy: { enabled: true, revision: 4, agentId: "agent-a", workspaceIdentity: "workspace:v1:alpha" },
      capabilities: { skillWorkshop: false, cronDispatch: true },
    });

    assert.deepStrictEqual(projection.features.autoCapture, {
      configured: true,
      effective: false,
      reason: "conversation_access_disabled",
    });
    assert.deepStrictEqual(projection.features.skillMiner, {
      configured: true,
      effective: false,
      reason: "skill_workshop_unavailable",
    });
    assert.deepStrictEqual(projection.features.featureCronSetup, {
      configured: true,
      effective: true,
      reason: null,
    });
  });

  it("makes workspace disablement override every configured data-plane feature", () => {
    const projection = buildControlPlaneProjection({
      config: {
        autoCapture: true,
        autoRecall: true,
        hooks: { allowConversationAccess: true },
        skillMiner: { enabled: true },
        merging: { enabled: true },
      },
      policy: { enabled: false, revision: 2, agentId: "agent-a", workspaceIdentity: "workspace:v1:alpha" },
      capabilities: { skillWorkshop: true, cronDispatch: true },
    });

    for (const name of ["autoCapture", "autoRecall", "skillMiner", "merging"]) {
      assert.equal(projection.features[name].effective, false, name);
      assert.equal(projection.features[name].reason, "workspace_disabled", name);
    }
    assert.deepStrictEqual(projection.workspace, {
      agentId: "agent-a",
      identity: "workspace:v1:alpha",
      enabled: false,
      revision: 2,
    });
  });

  it("omits every credential value, identifier, path, command, and provider alias", () => {
    const sentinel = "sentinel-secret-material";
    const privateId = "private/credential/id";
    const projection = buildControlPlaneProjection({
      config: {
        embedding: {
          apiKey: { source: "store", provider: "private-provider", id: privateId },
          fallback: { apiKey: sentinel },
        },
        reranker: {
          apiKey: { source: "exec", provider: "vault", id: `command/${sentinel}` },
        },
      },
    });

    assert.deepStrictEqual(projection.credentials.embedding, { status: "configured", source: "store" });
    assert.deepStrictEqual(projection.credentials.embeddingFallback, { status: "configured", source: "plaintext" });
    assert.deepStrictEqual(projection.credentials.reranker, { status: "configured", source: "exec" });
    const serialized = JSON.stringify(projection);
    assert.doesNotMatch(serialized, new RegExp(sentinel));
    assert.doesNotMatch(serialized, /private\/credential\/id|private-provider|vault/);
  });

  it("copies only closed provider, namespace, and migration status fields", () => {
    const projection = buildControlPlaneProjection({
      providers: {
        embedding: {
          provider: "local-transformers",
          model: "model-a",
          revision: "rev-a",
          dimensions: 768,
          fingerprint: "sha256:abc",
          apiKey: "must-not-copy",
          endpoint: "https://secret@example.invalid",
        },
      },
      namespaces: [{ id: "private", dimensions: 768, rows: 12, path: "/must/not/copy" }],
      migration: {
        id: "migration-a",
        state: "validating",
        processed: 8,
        total: 12,
        failureCode: null,
        targetSecretRef: { id: "must-not-copy" },
      },
    });

    assert.deepStrictEqual(projection.providers.embedding, {
      provider: "local-transformers",
      model: "model-a",
      revision: "rev-a",
      dimensions: 768,
      fingerprint: "sha256:abc",
    });
    assert.deepStrictEqual(projection.namespaces, [{ id: "private", dimensions: 768, rows: 12 }]);
    assert.deepStrictEqual(projection.migration, {
      id: "migration-a",
      state: "validating",
      processed: 8,
      total: 12,
      failureCode: null,
    });
    assert.doesNotMatch(JSON.stringify(projection), /must-not-copy|secret@example/);
  });
});

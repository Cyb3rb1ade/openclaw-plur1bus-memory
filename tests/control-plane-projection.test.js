import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FEATURE_CARD_DEFINITIONS,
  FEATURE_DEFINITIONS,
  buildControlPlaneProjection,
} from "../lib/control-plane-projection.js";

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
      modelPreparation: {
        state: "downloading",
        profileId: "jina-v3-multilingual-256",
        model: "jinaai/jina-embeddings-v3",
        revision: "68ed94909d564380f954be27ae2e133214c1adc9",
        dimensions: 256,
        license: "CC-BY-NC-4.0",
        commercialUse: false,
        bytesCompleted: 400,
        bytesTotal: 1_000,
        artifactsCompleted: 2,
        artifactsTotal: 5,
        targetFingerprintId: null,
        reembedding: null,
        errorCode: null,
        cacheDir: "/must-not-project",
        secret: sentinel,
      },
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
    // Every projected feature gets a card; the tab must not show a subset of
    // what is actually running.
    const cardIds = projection.featureCards.map((card) => card.id);
    for (const id of ["capture", "recall", "skill-miner", "feature-cron", "rem", "obsidian", "reranker",
      "merging", "daily-consolidation", "gc", "emotion-t3", "knowledge-promotion", "critical-push",
      "afterthought", "persona-voice", "dream-echo", "continuity", "reply-outcome", "contradiction",
      "semantic-lens", "query-refinement", "decision-trace", "semantic-compression", "neo",
      "meta-cognition", "temporal-context"]) {
      assert.ok(cardIds.includes(id), `missing feature card: ${id}`);
    }
    assert.equal(new Set(cardIds).size, cardIds.length, "card ids are unique");
    assert.ok(projection.featureCards.every((card) => typeof card.purpose === "string" && card.purpose),
      "every card explains what its feature does");
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
    assert.deepStrictEqual(projection.modelPreparation, {
      state: "downloading",
      profileId: "jina-v3-multilingual-256",
      model: "jinaai/jina-embeddings-v3",
      revision: "68ed94909d564380f954be27ae2e133214c1adc9",
      dimensions: 256,
      license: "CC-BY-NC-4.0",
      commercialUse: false,
      bytesCompleted: 400,
      bytesTotal: 1_000,
      artifactsCompleted: 2,
      artifactsTotal: 5,
      targetFingerprintId: null,
      reembedding: null,
      errorCode: null,
    });
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
          apiKey: { source: "exec", provider: "acme-secrets", id: `command/${sentinel}` },
        },
      },
    });

    assert.deepStrictEqual(projection.credentials.embedding, { status: "configured", source: "store", path: "embedding.apiKey" });
    assert.deepStrictEqual(projection.credentials.embeddingFallback, { status: "configured", source: "plaintext", path: "embedding.fallback.apiKey" });
    assert.deepStrictEqual(projection.credentials.reranker, { status: "configured", source: "exec", path: "reranker.apiKey" });
    const serialized = JSON.stringify(projection);
    assert.doesNotMatch(serialized, new RegExp(sentinel));
    // The alias sentinel must stay unambiguous: "vault" is also the domain
    // term for the Obsidian target the tab legitimately reports on.
    assert.doesNotMatch(serialized, /private\/credential\/id|private-provider|acme-secrets/);
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

describe("legacy dreaming sidecar compatibility switch", () => {
  it("stays off under an all-features-on profile and is not the dream engine", () => {
    // dreaming.enabled is documented in the config schema as "Controls OpenClaw
    // memory-core dreaming sidecar compatibility. Keep false when PLUR1BUS owns
    // consolidation/dreaming." Nothing in the plugin reads it -- the light/REM
    // engines are gated by neo.enabled. Defaulting it to true under the
    // all-features-on profile re-enabled a bridge that was deliberately retired.
    const sidecar = FEATURE_DEFINITIONS.find((entry) => entry.name === "dreamingSidecarCompat");
    assert.ok(sidecar, "the legacy switch must stay visible under its own name");
    assert.deepEqual(sidecar.path, ["dreaming", "enabled"]);
    assert.equal(sidecar.defaultValue, false);
    assert.equal(
      FEATURE_DEFINITIONS.some((entry) => entry.name === "dreaming"),
      false,
      "no feature may claim the ambiguous name 'dreaming'",
    );

    const neo = FEATURE_DEFINITIONS.find((entry) => entry.name === "neo");
    assert.deepEqual(neo.path, ["neo", "enabled"]);
    assert.equal(neo.defaultValue, true);

    // The REM card describes the real engine, so it must follow neo.
    const rem = FEATURE_CARD_DEFINITIONS.find((card) => card.id === "rem");
    assert.equal(rem.feature, "neo");
    for (const card of FEATURE_CARD_DEFINITIONS) {
      assert.ok(
        FEATURE_DEFINITIONS.some((entry) => entry.name === card.feature),
        `card ${card.id} points at unknown feature ${card.feature}`,
      );
    }
  });

  it("keeps every other feature on by default", () => {
    for (const entry of FEATURE_DEFINITIONS) {
      if (entry.name === "dreamingSidecarCompat") continue;
      assert.equal(entry.defaultValue, true, `${entry.name} must stay on by default`);
    }
  });
});

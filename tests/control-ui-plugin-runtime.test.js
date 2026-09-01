import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONTROL_UI_GATEWAY_METHOD,
  CONTROL_UI_PATH,
  createControlUiHttpHandler,
  registerControlUiRuntime,
} from "../lib/setup/control-ui-plugin-runtime.js";

function fakeResponse() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: undefined,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    end(body = "") { this.body = body; },
  };
}

describe("PLUR1BUS OpenClaw Control UI runtime", () => {
  it("registers one read-scoped status method and one authenticated external tab", () => {
    const gatewayMethods = [];
    const routes = [];
    const descriptors = [];
    registerControlUiRuntime({
      api: {
        registerGatewayMethod: (...args) => gatewayMethods.push(args),
        registerHttpRoute: (route) => routes.push(route),
        session: { controls: { registerControlUiDescriptor: (descriptor) => descriptors.push(descriptor) } },
        logger: { warn() {} },
      },
      getProjection: async () => ({ schemaVersion: 1 }),
    });

    assert.equal(gatewayMethods.length, 1);
    assert.equal(gatewayMethods[0][0], CONTROL_UI_GATEWAY_METHOD);
    assert.deepStrictEqual(gatewayMethods[0][2], { scope: "operator.read" });
    assert.deepStrictEqual(routes, [{
      path: CONTROL_UI_PATH,
      auth: "gateway",
      match: "exact",
      handler: routes[0].handler,
    }]);
    assert.deepStrictEqual(descriptors, [{
      surface: "tab",
      id: "plur1bus",
      label: "PLUR1BUS",
      description: "Workspace memory, providers, and migration status",
      path: CONTROL_UI_PATH,
      icon: "database",
      group: "control",
      requiredScopes: ["operator.read"],
    }]);
  });

  it("renders the schema-v2 operator dashboard under a locked-down CSP", async () => {
    const secret = "sentinel-secret-material";
    const handler = createControlUiHttpHandler({
      getProjection: async () => ({
        schemaVersion: 2,
        title: secret,
        credentials: { embedding: { status: "configured", source: "store" } },
        providers: { embedding: { provider: "local-transformers", model: "<unsafe>", dimensions: 768, fingerprint: "embedding:v1:sha256:abc" } },
        embeddingDimensionProfiles: [{
          id: "local-transformers:intfloat-multilingual-e5-small",
          provider: "local-transformers",
          model: "intfloat/multilingual-e5-small",
          mode: "fixed",
          defaultDimensions: 384,
          minDimensions: 384,
          maxDimensions: 384,
          presets: [384],
          current: true,
          selectedDimensions: 384,
          verification: "runtime_vector",
        }, {
          id: "local-jina-embeddings-v3",
          provider: "local-transformers",
          model: "jinaai/jina-embeddings-v3",
          mode: "selectable",
          defaultDimensions: 1024,
          minDimensions: 32,
          maxDimensions: 1024,
          presets: [32, 64, 128, 256, 512, 768, 1024],
          presetOnly: true,
          current: false,
          verification: "runtime_vector",
          license: "CC-BY-NC-4.0",
          commercialUse: false,
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
        },
        memoryHealth: {
          status: "degraded",
          namespaces: [{ id: "lancedb-namespaced", dimensions: 768, rows: 3 }],
          cards: { byAgent: [{ id: "agent-a", cards: 3 }], byWorkspace: [], byUser: [] },
          storage: { bytes: 2048, complete: true },
          lastError: { component: "lancedb", code: "partition_count_failed" },
          observedAt: 1_000,
        },
        workspaceMatrix: {
          defaultEnabled: true,
          overrides: [{ agentId: "agent-a", workspace: "workspace:v1:alpha", enabled: false, revision: 2 }],
          disabledWorkspaceEffects: ["automatic_capture", "automatic_recall"],
        },
        featureCards: [{
          id: "capture",
          label: "Capture",
          configured: true,
          effective: true,
          reason: null,
          dependencies: ["conversation_access"],
          configurationSurface: "/config",
          credentialSurface: "/secrets",
          audit: "openclaw_config_audit",
        }],
        reembeddingWorkflow: {
          mutationSurface: "operator_admin",
          noImplicitDimensionChange: true,
          migration: {
            id: "migration-a",
            state: "running",
            processed: 2,
            total: 3,
            targetDimensions: 1024,
            targetFingerprint: "embedding:v1:sha256:abc",
          },
          steps: [
            { id: "dry-run", label: "Dry run", state: "complete" },
            { id: "checkpoint", label: "Copy progress and checkpoint", state: "current" },
          ],
        },
      }),
    });
    const response = fakeResponse();

    assert.equal(await handler({ method: "GET", url: CONTROL_UI_PATH }, response), true);
    assert.equal(response.statusCode, 200);
    assert.match(response.getHeader("content-security-policy"), /default-src 'none'/);
    assert.equal(response.getHeader("cache-control"), "no-store, max-age=0");
    assert.match(response.body, /Memory Health/);
    assert.match(response.body, /Workspace Matrix/);
    assert.match(response.body, /Feature Controls/);
    assert.match(response.body, /Re-Embedding Workflow/);
    assert.match(response.body, /Embedding Dimension Planner/);
    assert.match(response.body, /Model Preparation/);
    assert.match(response.body, /400 B of 1,000 B/);
    assert.match(response.body, /<progress[^>]+aria-label="Local model download progress"[^>]+value="400"[^>]+max="1000"/);
    assert.match(response.body, /downloaded and hash-validated automatically/i);
    assert.match(response.body, /<select[^>]+aria-label="Dimensions for intfloat\/multilingual-e5-small"/);
    assert.match(response.body, /<option value="384" selected>384 \(fixed\)<\/option>/);
    assert.match(response.body, /jinaai\/jina-embeddings-v3/);
    assert.match(response.body, /CC-BY-NC-4\.0.*non-commercial only/i);
    assert.match(response.body, /Only the listed dimensions are valid/);
    assert.match(response.body, /workspace:v1:alpha/);
    assert.match(response.body, /href="\/config"/);
    assert.match(response.body, /href="\/secrets"/);
    assert.match(response.body, /&lt;unsafe&gt;/);
    assert.doesNotMatch(response.body, /<unsafe>|<script|<form|fetch\s*\(/i);
    assert.doesNotMatch(response.body, new RegExp(secret));
  });

  it("renders a persisted model preparation suggestion without starting migration", async () => {
    const handler = createControlUiHttpHandler({
      getProjection: async () => ({
        schemaVersion: 2,
        modelPreparation: {
          state: "ready",
          profileId: "jina-v3-multilingual-256",
          model: "jinaai/jina-embeddings-v3",
          revision: "68ed94909d564380f954be27ae2e133214c1adc9",
          dimensions: 256,
          license: "CC-BY-NC-4.0",
          commercialUse: false,
          bytesCompleted: 1_000,
          bytesTotal: 1_000,
          artifactsCompleted: 5,
          artifactsTotal: 5,
          targetFingerprintId: `embedding:v1:sha256:${"b".repeat(64)}`,
          errorCode: null,
          reembedding: {
            required: true,
            status: "recommended",
            rows: 125,
            targetBytes: 129_000,
            requiredFreeBytes: 161_250,
            freeBytes: 5_000_000,
            nextAction: "plan_with_explicit_confirmation",
          },
        },
        reembeddingWorkflow: { migration: null, steps: [] },
      }),
    });
    const response = fakeResponse();

    await handler({ method: "GET", url: CONTROL_UI_PATH }, response);

    assert.match(response.body, /Re-embedding dry-run recommendation/i);
    assert.match(response.body, /125 cards/);
    assert.match(response.body, /does not start copying or switch the active model/i);
    assert.match(response.body, /acknowledged.*CC-BY-NC-4\.0|CC-BY-NC-4\.0.*acknowledged/i);
    assert.doesNotMatch(response.body, /License acknowledgement required/i);
    assert.doesNotMatch(response.body, /<meta http-equiv="refresh"/);
    assert.doesNotMatch(response.body, /<script|<form|fetch\s*\(/i);
  });

  it("does not claim Jina license acknowledgement for a failed initialization snapshot", async () => {
    const handler = createControlUiHttpHandler({
      getProjection: async () => ({
        schemaVersion: 2,
        modelPreparation: {
          state: "failed",
          profileId: "jina-v3-multilingual-256",
          model: "jinaai/jina-embeddings-v3",
          revision: "68ed94909d564380f954be27ae2e133214c1adc9",
          dimensions: 256,
          license: "CC-BY-NC-4.0",
          commercialUse: false,
          bytesCompleted: 0,
          bytesTotal: 1_000,
          artifactsCompleted: 0,
          artifactsTotal: 5,
          targetFingerprintId: null,
          errorCode: "model_preparation_initialization_failed",
          reembedding: null,
        },
        reembeddingWorkflow: { migration: null, steps: [] },
      }),
    });
    const response = fakeResponse();

    await handler({ method: "GET", url: CONTROL_UI_PATH }, response);

    assert.match(response.body, /CC-BY-NC-4\.0.*explicit acknowledgement.*OpenClaw Config/i);
    assert.doesNotMatch(response.body, /Non-commercial license acknowledged/i);
  });

  it("renders durable re-embedding progress and refreshes only an active read-only migration", async () => {
    let processed = 12;
    const handler = createControlUiHttpHandler({
      getProjection: async () => ({
        schemaVersion: 2,
        reembeddingWorkflow: {
          mutationSurface: "operator_admin",
          noImplicitDimensionChange: true,
          migration: {
            id: "reembed-20260828",
            state: "running",
            processed,
            total: 100,
            targetDimensions: 1024,
            targetFingerprint: "embedding:v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          steps: [{ id: "checkpoint", label: "Copy progress and checkpoint", state: "current" }],
        },
      }),
    });

    const first = fakeResponse();
    assert.equal(await handler({ method: "GET", url: CONTROL_UI_PATH }, first), true);
    assert.match(first.body, /<meta http-equiv="refresh" content="5">/);
    assert.match(first.body, /12 \/ 100 cards/);
    assert.match(first.body, /<progress[^>]+value="12"[^>]+max="100"/);
    assert.match(first.body, /Auto-refresh is active while the migration runs/);
    assert.doesNotMatch(first.body, /<script|fetch\s*\(/i);

    processed = 73;
    const reopened = fakeResponse();
    assert.equal(await handler({ method: "GET", url: CONTROL_UI_PATH }, reopened), true);
    assert.match(reopened.body, /73 \/ 100 cards/);

    const completedHandler = createControlUiHttpHandler({
      getProjection: async () => ({
        schemaVersion: 2,
        reembeddingWorkflow: {
          migration: { id: "reembed-20260828", state: "completed", processed: 100, total: 100 },
          steps: [],
        },
      }),
    });
    const completed = fakeResponse();
    assert.equal(await completedHandler({ method: "GET", url: CONTROL_UI_PATH }, completed), true);
    assert.doesNotMatch(completed.body, /<meta http-equiv="refresh"/);
  });

  it("renders every projected credential with its config path and visible help", async () => {
    // The projection carries eight credentials; the table used to show four,
    // leaving merging, knowledge promotion, critical push and emotion tier 3
    // invisible to the operator.
    const handler = createControlUiHttpHandler({
      getProjection: async () => ({
        schemaVersion: 2,
        credentials: {
          embedding: { status: "configured", source: "store" },
          embeddingFallback: { status: "missing", source: null },
          reranker: { status: "configured", source: "plaintext" },
          merging: { status: "missing", source: null },
          knowledgePromotion: { status: "missing", source: null },
          skillMiner: { status: "configured", source: "env" },
          criticalPush: { status: "missing", source: null },
          emotionTier3: { status: "invalid", source: null },
        },
      }),
    });
    const response = fakeResponse();
    assert.equal(await handler({ method: "GET", url: CONTROL_UI_PATH }, response), true);

    for (const path of [
      "embedding.apiKey",
      "embedding.fallback.apiKey",
      "reranker.apiKey",
      "merging.apiKey",
      "schicht15.apiKey",
      "skillMiner.apiKey",
      "criticalPush.apiKey",
      "emotion.t3.apiKey",
    ]) {
      assert.match(response.body, new RegExp(path.replaceAll(".", "\\.")), path);
    }
    // Help must be readable text, not a title attribute: a hover reaches
    // neither the keyboard nor most screen readers.
    assert.match(response.body, /Turns text into vectors/, "capability purpose is rendered as text");
    assert.match(response.body, /sits directly in the config file/, "source types are explained in the legend");
    assert.doesNotMatch(response.body, /title="/, "no help may hide in a title attribute");
    assert.doesNotMatch(response.body, /sk-[A-Za-z0-9_-]{8}/, "no secret-shaped value may ever be rendered");
  });

  it("supports HEAD and rejects every mutation method", async () => {
    let projections = 0;
    const handler = createControlUiHttpHandler({
      getProjection: async () => { projections += 1; return { schemaVersion: 1 }; },
    });
    const head = fakeResponse();
    assert.equal(await handler({ method: "HEAD", url: CONTROL_UI_PATH }, head), true);
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, "");
    assert.equal(projections, 1);

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = fakeResponse();
      assert.equal(await handler({ method, url: CONTROL_UI_PATH }, response), true);
      assert.equal(response.statusCode, 405, method);
      assert.equal(response.getHeader("allow"), "GET, HEAD");
    }
    assert.equal(projections, 1, "mutation requests never reach projection code");
  });

  it("validates the Gateway request and never forwards projection errors", async () => {
    const registrations = [];
    registerControlUiRuntime({
      api: {
        registerGatewayMethod: (...args) => registrations.push(args),
        registerHttpRoute() {},
        session: { controls: { registerControlUiDescriptor() {} } },
        logger: { warn() {} },
      },
      getProjection: async () => { throw new Error("sentinel-secret-must-not-leak"); },
    });
    const handler = registrations[0][1];
    const responses = [];
    await handler({ params: { unexpected: true }, respond: (...args) => responses.push(args) });
    await handler({ params: {}, respond: (...args) => responses.push(args) });

    assert.equal(responses[0][0], false);
    assert.equal(responses[1][0], false);
    assert.doesNotMatch(JSON.stringify(responses), /sentinel-secret-must-not-leak/);
  });

  it("keeps the Gateway status method when the external-tab capability is absent", () => {
    const methods = [];
    const warnings = [];
    registerControlUiRuntime({
      api: {
        registerGatewayMethod: (...args) => methods.push(args),
        logger: { warn: (message) => warnings.push(message) },
      },
      getProjection: async () => ({ schemaVersion: 1 }),
    });
    assert.equal(methods.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Control UI tab capability unavailable/);
  });
});

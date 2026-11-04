/**
 * tests/control-plane-api-key-ref.test.js — engine-jobs audit F8.
 *
 * The credential table said "missing" (or "host_route") for a capability whose
 * key is configured through `apiKeyRef` only, although the runtime resolves it
 * from the host secret store. The table has to mirror the runtime's order:
 * apiKeyRef, apiKeyEnv, apiKey.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { buildControlPlaneProjection } from "../lib/control-plane-projection.js";

const CASES = [
  ["embedding", { embedding: { provider: "openai", apiKeyRef: "openai/main" } }, "embedding.apiKeyRef"],
  ["reranker", { reranker: { provider: "voyage", apiKeyRef: "voyage/key" } }, "reranker.apiKeyRef"],
  ["merging", { merging: { model: "m", baseUrl: "https://x.example.test/v1", apiKeyRef: "or/merge" } }, "merging.apiKeyRef"],
  ["knowledgePromotion", { schicht15: { apiKeyRef: "or/s15" } }, "schicht15.apiKeyRef"],
  ["skillMiner", { skillMiner: { apiKeyRef: "or/skill" } }, "skillMiner.apiKeyRef"],
  ["criticalPush", { criticalPush: { apiKeyRef: "or/crit" } }, "criticalPush.apiKeyRef"],
  ["emotionTier3", { emotion: { t3: { apiKeyRef: "or/t3" } } }, "emotion.t3.apiKeyRef"],
];

for (const [capability, config, path] of CASES) {
  test(`${capability}: a key configured only through apiKeyRef is configured from the host secret store`, () => {
    const projection = buildControlPlaneProjection({ config, env: {} });
    assert.deepEqual(projection.credentials[capability], { status: "configured", source: "host_secret", path });
  });
}

test("apiKeyRef is the first path, as at runtime: it names the source when apiKeyEnv and apiKey are set too", () => {
  const projection = buildControlPlaneProjection({
    config: { embedding: { provider: "openai", apiKeyRef: "openai/main", apiKeyEnv: "MY_KEY", apiKey: "sk-literal" } },
    env: {},
  });
  assert.deepEqual(projection.credentials.embedding, { status: "configured", source: "host_secret", path: "embedding.apiKeyRef" });
});

test("the projection never carries the reference name's value or any key", () => {
  const projection = buildControlPlaneProjection({ config: { embedding: { provider: "openai", apiKeyRef: "openai/main" } }, env: {} });
  assert.doesNotMatch(JSON.stringify(projection.credentials), /openai\/main/);
});

test("unchanged: without apiKeyRef the old paths and labels apply", () => {
  const missing = buildControlPlaneProjection({ config: { embedding: { provider: "openai" } }, env: {} });
  assert.deepEqual(missing.credentials.embedding, { status: "missing", source: null, path: "embedding.apiKey" });
  const env = buildControlPlaneProjection({ config: { embedding: { provider: "openai", apiKeyEnv: "MY_KEY" } }, env: {} });
  assert.deepEqual(env.credentials.embedding, { status: "configured", source: "env", path: "embedding.apiKeyEnv" });
  const hostRouted = buildControlPlaneProjection({ config: { merging: {} }, env: {} });
  assert.deepEqual(hostRouted.credentials.merging, { status: "missing", source: "host_route", path: "merging.apiKey" });
});

test("an empty apiKeyRef counts as not set", () => {
  const projection = buildControlPlaneProjection({ config: { embedding: { provider: "openai", apiKeyRef: "" } }, env: {} });
  assert.equal(projection.credentials.embedding.status, "missing");
});

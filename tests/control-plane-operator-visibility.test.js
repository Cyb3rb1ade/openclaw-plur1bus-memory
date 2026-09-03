import { strict as assert } from "node:assert";
import test from "node:test";

import { buildControlPlaneProjection } from "../lib/control-plane-projection.js";
import { resolveEffectiveConfig } from "../lib/setup/config-contract.js";
import { CONTROL_UI_PATH as CONTROL_UI_PATH_FOR_TEST } from "../lib/setup/control-ui-plugin-runtime.js";

// Three defects the operator dashboard showed against a healthy 7.5.0 install
// on 2026-09-03: features the tab called "off" that nobody had switched off,
// a working reranker key reported as missing, and no way at all to see which
// reranking provider was in use.

test("continuity engine, semantic lens and query refinement default to on", () => {
  // The tab states "an absent switch means on". Before this, the manifest
  // defaulted these three to false, so an untouched install contradicted the
  // sentence printed directly above the feature cards.
  const effective = resolveEffectiveConfig({});
  assert.equal(effective.continuityEngine.enabled, true);
  assert.equal(effective.semanticLens.enabled, true);
  assert.equal(effective.recall.queryRefinement.enabled, true);

  const projection = buildControlPlaneProjection({ config: effective });
  for (const name of ["continuityEngine", "semanticLens", "queryRefinement"]) {
    assert.equal(projection.features[name].configured, true, `${name} configured`);
    assert.equal(projection.features[name].effective, true, `${name} effective`);
  }
});

test("an explicit false still turns those features off", () => {
  const projection = buildControlPlaneProjection({
    config: resolveEffectiveConfig({
      continuityEngine: { enabled: false },
      semanticLens: { enabled: false },
      recall: { queryRefinement: { enabled: false } },
    }),
  });
  for (const name of ["continuityEngine", "semanticLens", "queryRefinement"]) {
    assert.equal(projection.features[name].configured, false, `${name} stays off`);
  }
});

test("a key configured through apiKeyEnv counts as configured", () => {
  // The live install had reranker.apiKeyEnv = "COHERE_API_KEY" and a running
  // Cohere reranker, yet readiness said "missing / not configured".
  const projection = buildControlPlaneProjection({
    config: { reranker: { provider: "cohere", apiKeyEnv: "COHERE_API_KEY" } },
  });
  assert.deepEqual(projection.credentials.reranker, { status: "configured", source: "env", path: "reranker.apiKeyEnv" });
});

test("apiKey wins over apiKeyEnv and keeps its own source", () => {
  const projection = buildControlPlaneProjection({
    config: { reranker: { apiKey: "sk-literal", apiKeyEnv: "COHERE_API_KEY" } },
  });
  assert.deepEqual(projection.credentials.reranker, { status: "configured", source: "plaintext", path: "reranker.apiKey" });
});

test("host-routed capabilities are marked as such instead of looking abandoned", () => {
  // These five fall back to OpenClaw's own model route. Reporting a bare
  // "missing" next to "the feature that needs it stays off" was wrong: all of
  // them run without a key of their own.
  const projection = buildControlPlaneProjection({ config: {} });
  for (const name of ["merging", "knowledgePromotion", "skillMiner", "criticalPush", "emotionTier3"]) {
    assert.deepEqual(projection.credentials[name], { status: "missing", source: "host_route", path: projection.credentials[name].path }, name);
    assert.match(projection.credentials[name].path, /\.apiKey$/, `${name} names a config path`);
  }
  // Embedding has no host route: without a key it really is unset.
  assert.deepEqual(projection.credentials.embedding, { status: "missing", source: null, path: "embedding.apiKey" });
});

test("the reranking provider reaches the projection", () => {
  const projection = buildControlPlaneProjection({
    config: { reranker: { enabled: true } },
    capabilities: { reranker: true },
    providers: { reranker: { provider: "cohere", model: "rerank-v3.5" } },
  });
  assert.equal(projection.providers.reranker.provider, "cohere");
  assert.equal(projection.providers.reranker.model, "rerank-v3.5");
});

test("the dashboard shows which reranker is active and how to change it", async () => {
  const { createControlUiHttpHandler } = await import("../lib/setup/control-ui-plugin-runtime.js");
  const headers = new Map();
  const res = {
    statusCode: 0,
    body: "",
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    end(body = "") { this.body = body; },
  };
  const handler = createControlUiHttpHandler({
    getProjection: async () => buildControlPlaneProjection({
      config: resolveEffectiveConfig({ reranker: { provider: "cohere", apiKeyEnv: "COHERE_API_KEY" } }),
      capabilities: { reranker: true },
      providers: { reranker: { provider: "cohere", model: "rerank-v3.5" } },
    }),
  });
  await handler({ method: "GET", url: CONTROL_UI_PATH_FOR_TEST }, res);
  const html = String(res.body);
  assert.match(html, /Reranking/);
  assert.match(html, /cohere/);
  assert.match(html, /rerank-v3\.5/);
  // The operator must be able to read off how to switch providers.
  assert.match(html, /reranker\.provider/);
  assert.match(html, /jina/);
  assert.match(html, /local/);
});

test("with no reranker the card says so and still explains the switch", async () => {
  const { createControlUiHttpHandler } = await import("../lib/setup/control-ui-plugin-runtime.js");
  const res = {
    statusCode: 0, body: "",
    setHeader() {}, getHeader() { return undefined; },
    end(body = "") { this.body = body; },
  };
  const handler = createControlUiHttpHandler({
    getProjection: async () => buildControlPlaneProjection({ config: resolveEffectiveConfig({}) }),
  });
  await handler({ method: "GET", url: CONTROL_UI_PATH_FOR_TEST }, res);
  const html = String(res.body);
  assert.match(html, /No reranker is active/);
  assert.match(html, /reranker\.provider/);
});

test("the resolved credential path travels with the result", () => {
  // The table used to print a fixed "<section>.apiKey" label, so a key living
  // in apiKeyEnv sent the reader to a config line that did not exist.
  const viaEnv = buildControlPlaneProjection({ config: { reranker: { apiKeyEnv: "COHERE_API_KEY" } } });
  assert.equal(viaEnv.credentials.reranker.path, "reranker.apiKeyEnv");

  const viaLiteral = buildControlPlaneProjection({ config: { reranker: { apiKey: "sk-literal" } } });
  assert.equal(viaLiteral.credentials.reranker.path, "reranker.apiKey");

  // With nothing configured the primary path is still named, so the reader
  // knows where to put a key.
  const absent = buildControlPlaneProjection({ config: {} });
  assert.equal(absent.credentials.reranker.path, "reranker.apiKey");
});

test("the dashboard names the path that holds the key and explains host_route", async () => {
  const { createControlUiHttpHandler } = await import("../lib/setup/control-ui-plugin-runtime.js");
  const res = {
    statusCode: 0, body: "",
    setHeader() {}, getHeader() { return undefined; },
    end(body = "") { this.body = body; },
  };
  const handler = createControlUiHttpHandler({
    getProjection: async () => buildControlPlaneProjection({
      config: resolveEffectiveConfig({ reranker: { provider: "cohere", apiKeyEnv: "COHERE_API_KEY" } }),
    }),
  });
  await handler({ method: "GET", url: CONTROL_UI_PATH_FOR_TEST }, res);
  const html = String(res.body);
  assert.match(html, /reranker\.apiKeyEnv/);
  // The legend must explain the source a host-routed capability reports,
  // otherwise "missing / host_route" reads like a defect.
  assert.match(html, /host_route/);
  // The apostrophe is HTML-escaped on render, so match the plain part.
  assert.match(html, /configured model route/);
  // And "missing" must no longer claim the feature stays off unconditionally.
  assert.doesNotMatch(html, /Nothing is configured at this path\. The feature that needs it stays off\./);
});

test("a host-routed capability does not wear the missing badge", async () => {
  // "missing / host_route" read like a defect on a healthy install. The status
  // column now carries the meaning and the source names the route.
  const { createControlUiHttpHandler } = await import("../lib/setup/control-ui-plugin-runtime.js");
  const res = { statusCode: 0, body: "", setHeader() {}, getHeader() { return undefined; }, end(b = "") { this.body = b; } };
  const handler = createControlUiHttpHandler({
    getProjection: async () => buildControlPlaneProjection({ config: resolveEffectiveConfig({}) }),
  });
  await handler({ method: "GET", url: CONTROL_UI_PATH_FOR_TEST }, res);
  const html = String(res.body);
  assert.match(html, /badge-host_route/);
  assert.match(html, /OpenClaw default route/);
  assert.match(html, /Nothing is missing here/);
  // Embedding has no host route, so it keeps the honest "missing" badge.
  assert.match(html, /badge-missing/);
});

test("the control UI tab registers through the flat api method", async () => {
  // 2026.8.2 exposes registerControlUiDescriptor flat on the api object. Reading
  // only api.session.controls left the tab unregistered: the route answered but
  // the dashboard said "Plugin panel unavailable".
  const { registerControlUiRuntime } = await import("../lib/setup/control-ui-plugin-runtime.js");
  const descriptors = [];
  const routes = [];
  const api = {
    registerHttpRoute: (route) => routes.push(route),
    registerControlUiDescriptor: (descriptor) => descriptors.push(descriptor),
    registerGatewayMethod: () => {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  registerControlUiRuntime({ api, getProjection: async () => ({}) });
  assert.equal(descriptors.length, 1, "a descriptor must be registered");
  assert.equal(descriptors[0].id, "plur1bus");
  assert.equal(routes.length, 1, "the http route must still be registered");
});

test("the dashboard wears the Control UI tokens and says how old the health snapshot is", async () => {
  const { createControlUiHttpHandler } = await import("../lib/setup/control-ui-plugin-runtime.js");
  const headers = new Map();
  const res = {
    statusCode: 0,
    body: "",
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    end(body = "") { this.body = body; },
  };
  const observedAt = 1_700_000_000_000;
  const handler = createControlUiHttpHandler({
    now: () => observedAt + 95_000,
    getProjection: async () => buildControlPlaneProjection({
      config: resolveEffectiveConfig({}),
      health: {
        status: "ready",
        namespaces: [],
        cards: { byAgent: [], byWorkspace: [], byUser: [] },
        storage: { bytes: 0, complete: true },
        lastError: null,
        observedAt,
      },
    }),
  });
  await handler({ method: "GET", url: CONTROL_UI_PATH_FOR_TEST }, res);
  const html = String(res.body);
  // The host's own token names and values, dark first, light on the OS setting.
  assert.match(html, /--bg: #0e1015/);
  assert.match(html, /--accent: #ff5c5c/);
  assert.match(html, /prefers-color-scheme: light/);
  assert.match(html, /--card: #fff/);
  assert.doesNotMatch(html, /\bCanvas\b|light-dark\(/, "no system-colour leftovers");
  // The reader can tell how old the cached numbers are.
  assert.match(html, /Snapshot observed <time datetime="2023-11-14T22:13:20.000Z">2 min ago<\/time>/);
  assert.match(html, /refreshed in the background/);
});

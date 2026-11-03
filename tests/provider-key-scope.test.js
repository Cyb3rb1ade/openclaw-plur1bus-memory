/**
 * tests/provider-key-scope.test.js — where provider credentials may go (engine audit F1, F2, F3, F6, F7).
 *
 *  F1 OPENAI_API_KEY is the implicit key for the OpenAI host only.
 *  F2 An unknown embedding provider is a configuration error, not an OpenAI call.
 *  F3 A key goes over https, or over http to loopback only.
 *  F6 The legacy migration treats baseUrl / apiKey / apiKeyRef / apiKeyEnv as a deliberate choice.
 *  F7 A failed fetchWithTimeout request carries `.status`.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { normalizeEmbeddingConfig, normalizeRerankerConfig } from "../lib/providers/config-normalize.js";
import { createEmbeddingProvider } from "../lib/providers/factory.js";
import { OpenAIEmbeddingProvider } from "../lib/providers/embedding-openai.js";
import { RemoteRerankerProvider } from "../lib/providers/reranker-remote.js";
import { applyLegacyProviderDefaults } from "../lib/providers/legacy-provider-migration.js";
import { createOpenClawMemoryEmbeddingProviderAdapters } from "../lib/providers/openclaw-memory-embedding-adapters.js";
import { redactedEmbeddingSecretRef } from "../lib/reembedding/runtime-config.js";
import { buildControlPlaneProjection } from "../lib/control-plane-projection.js";
import {
  assertKeyTransportAllowed,
  defaultEmbeddingKeyEnv,
  isLoopbackHostname,
  isOpenAiHost,
} from "../lib/providers/credential-scope.js";
import { fetchWithTimeout } from "../lib/fetch-with-timeout.js";
import { buildEmbeddingConfig } from "../scripts/auto-capture-lancedb.mjs";
import { makeTempDir } from "./helpers/temp-dir.js";

const OPENAI_SECRET = "sk-openai-canary-7a1c";
const COMPAT_SECRET = "gw-compatible-canary-5e22";
const ENV_NAMES = ["OPENAI_API_KEY", "OPENAI_COMPATIBLE_API_KEY", "OPENAI_BASE_URL"];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  process.env.OPENAI_API_KEY = OPENAI_SECRET;
  delete process.env.OPENAI_COMPATIBLE_API_KEY;
  delete process.env.OPENAI_BASE_URL;
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const GATEWAY = "https://gw.example.com/v1";

describe("F1: OPENAI_API_KEY is only the default for the OpenAI host", () => {
  it("does not send OPENAI_API_KEY to an OpenAI-compatible gateway", async () => {
    const provider = new OpenAIEmbeddingProvider({ provider: "openai-compatible", baseUrl: GATEWAY, model: "m", dimensions: 8 });
    assert.equal(await provider._resolveApiKey(), undefined);
    await assert.rejects(() => provider._clientForPrimary(), /API key is not configured/);
  });

  it("uses OPENAI_COMPATIBLE_API_KEY for the gateway when it is set", async () => {
    process.env.OPENAI_COMPATIBLE_API_KEY = COMPAT_SECRET;
    const provider = new OpenAIEmbeddingProvider({ provider: "openai-compatible", baseUrl: GATEWAY, model: "m", dimensions: 8 });
    assert.equal(await provider._resolveApiKey(), COMPAT_SECRET);
  });

  it("asks the credential resolver for the scoped default variable", async () => {
    const seen = [];
    const credentialResolver = async (request) => { seen.push(request.defaultEnv); return "resolved"; };
    await new OpenAIEmbeddingProvider({ provider: "openai-compatible", baseUrl: GATEWAY, model: "m", dimensions: 8, credentialResolver })._resolveApiKey();
    await new OpenAIEmbeddingProvider({ provider: "openai", model: "text-embedding-3-small", dimensions: 1536, credentialResolver })._resolveApiKey();
    assert.deepEqual(seen, ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"]);
  });

  it("the SDK fallback OPENAI_BASE_URL counts as the endpoint", async () => {
    process.env.OPENAI_BASE_URL = GATEWAY;
    const provider = new OpenAIEmbeddingProvider({ provider: "openai", model: "text-embedding-3-small", dimensions: 1536 });
    assert.equal(await provider._resolveApiKey(), undefined);
  });

  it("createEmbeddingProvider does not hand OPENAI_API_KEY to a gateway", () => {
    const cfg = normalizeEmbeddingConfig({ provider: "openai-compatible", baseUrl: GATEWAY, model: "m", dimensions: 8 });
    assert.throws(() => createEmbeddingProvider(cfg), /OPENAI_COMPATIBLE_API_KEY/);
    process.env.OPENAI_COMPATIBLE_API_KEY = COMPAT_SECRET;
    const provider = createEmbeddingProvider(cfg);
    assert.equal(provider.apiKeyRef, COMPAT_SECRET);
  });

  it("the auto-capture script does not name OPENAI_API_KEY for a gateway", () => {
    assert.equal(buildEmbeddingConfig({ embedding: { provider: "openai-compatible", baseUrl: GATEWAY } }, {}).apiKeyEnv, "OPENAI_COMPATIBLE_API_KEY");
    assert.equal(buildEmbeddingConfig({ embedding: { baseUrl: GATEWAY } }, {}).apiKeyEnv, "OPENAI_COMPATIBLE_API_KEY");
  });

  it("the persisted secret reference and the readiness table follow the same scope", () => {
    const gateway = normalizeEmbeddingConfig({ provider: "openai-compatible", baseUrl: GATEWAY, model: "m", dimensions: 8 });
    assert.deepEqual(redactedEmbeddingSecretRef(gateway), { source: "env", provider: "default", id: "OPENAI_COMPATIBLE_API_KEY" });
    const config = { embedding: { provider: "openai-compatible", baseUrl: GATEWAY, model: "m", dimensions: 8 } };
    const onlyOpenAi = buildControlPlaneProjection({ config, env: { OPENAI_API_KEY: OPENAI_SECRET } });
    assert.equal(onlyOpenAi.credentials.embedding.status, "missing");
    const compat = buildControlPlaneProjection({ config, env: { OPENAI_COMPATIBLE_API_KEY: COMPAT_SECRET } });
    assert.deepEqual(compat.credentials.embedding, { status: "configured", source: "env_default", path: "OPENAI_COMPATIBLE_API_KEY" });
  });

  it("still uses OPENAI_API_KEY for the OpenAI host (counter-test)", async () => {
    assert.equal(defaultEmbeddingKeyEnv(undefined, {}), "OPENAI_API_KEY");
    assert.equal(defaultEmbeddingKeyEnv("https://api.openai.com/v1", {}), "OPENAI_API_KEY");
    assert.equal(defaultEmbeddingKeyEnv("https://eu.api.openai.com/v1", {}), "OPENAI_API_KEY");
    assert.equal(defaultEmbeddingKeyEnv("https://api.openai.com.evil.example/v1", {}), "OPENAI_COMPATIBLE_API_KEY");
    assert.equal(defaultEmbeddingKeyEnv("http://api.openai.com/v1", {}), "OPENAI_COMPATIBLE_API_KEY");
    for (const cfg of [
      { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
      { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", dimensions: 1536 },
      { provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", dimensions: 1536 },
    ]) {
      assert.equal(await new OpenAIEmbeddingProvider(cfg)._resolveApiKey(), OPENAI_SECRET);
    }
    const provider = createEmbeddingProvider(normalizeEmbeddingConfig({ provider: "openai", model: "text-embedding-3-small" }));
    assert.equal(provider.apiKeyRef, OPENAI_SECRET);
    const projection = buildControlPlaneProjection({ config: { embedding: { provider: "openai" } }, env: { OPENAI_API_KEY: OPENAI_SECRET } });
    assert.deepEqual(projection.credentials.embedding, { status: "configured", source: "env_default", path: "OPENAI_API_KEY" });
  });

  it("an explicit key source is never rewritten (counter-test)", async () => {
    process.env.MY_GATEWAY_KEY = "explicit-gateway-key";
    try {
      const provider = new OpenAIEmbeddingProvider({ provider: "openai-compatible", baseUrl: GATEWAY, apiKeyEnv: "MY_GATEWAY_KEY", model: "m", dimensions: 8 });
      assert.equal(await provider._resolveApiKey(), "explicit-gateway-key");
      const literal = new OpenAIEmbeddingProvider({ provider: "openai-compatible", baseUrl: GATEWAY, apiKey: "literal-key", model: "m", dimensions: 8 });
      assert.equal(await literal._resolveApiKey(), "literal-key");
    } finally {
      delete process.env.MY_GATEWAY_KEY;
    }
  });
});

describe("F2: unknown embedding provider is a configuration error", () => {
  it("normalizeEmbeddingConfig refuses a typo instead of choosing the OpenAI branch", () => {
    for (const provider of ["local", "Openai", "local_transformers", "cohere"]) {
      assert.throws(
        () => normalizeEmbeddingConfig({ provider, model: "text-embedding-3-small" }),
        /embedding\.provider .* is not supported/,
        provider,
      );
    }
    assert.throws(() => normalizeEmbeddingConfig({ provider: 42 }), /not supported/);
  });

  it("createEmbeddingProvider and OpenAIEmbeddingProvider refuse it too", () => {
    assert.throws(() => createEmbeddingProvider({ provider: "local", model: "text-embedding-3-small", dimensions: 1536 }), /not supported/);
    assert.throws(() => new OpenAIEmbeddingProvider({ provider: "local", model: "text-embedding-3-small", dimensions: 1536, apiKey: "k" }), /not supported/);
  });

  it("the three real providers and the inferred ones still work (counter-test)", () => {
    assert.equal(normalizeEmbeddingConfig({ provider: "openai", model: "text-embedding-3-small" }).provider, "openai");
    assert.equal(normalizeEmbeddingConfig({ provider: "openai-compatible", baseUrl: GATEWAY, model: "m", dimensions: 8 }).provider, "openai-compatible");
    assert.equal(normalizeEmbeddingConfig({ provider: "local-transformers" }).provider, "local-transformers");
    assert.equal(normalizeEmbeddingConfig({}).provider, "openai");
    assert.equal(normalizeEmbeddingConfig({ baseUrl: GATEWAY, model: "m", dimensions: 8 }).provider, "openai-compatible");
    assert.equal(normalizeEmbeddingConfig({ apiKey: "k", model: "m", dimensions: 8 }).provider, "openai-compatible");
  });
});

describe("F3: a key goes over http only to loopback", () => {
  it("classifies hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "127.8.9.10", "[::1]", "[::ffff:7f00:1]"]) assert.equal(isLoopbackHostname(host), true, host);
    for (const host of ["gw.example.com", "10.0.0.5", "192.168.1.2", "0.0.0.0", "[::]", "127.example.com", "localhost.evil.example"]) assert.equal(isLoopbackHostname(host), false, host);
    assert.equal(isOpenAiHost("https://api.openai.com/v1"), true);
    assert.equal(isOpenAiHost("http://api.openai.com/v1"), false);
  });

  it("assertKeyTransportAllowed", () => {
    assert.doesNotThrow(() => assertKeyTransportAllowed("https://gw.example.com/v1", "x"));
    assert.doesNotThrow(() => assertKeyTransportAllowed("http://127.0.0.1:8080/v1", "x"));
    assert.doesNotThrow(() => assertKeyTransportAllowed("http://localhost:11434/v1", "x"));
    assert.doesNotThrow(() => assertKeyTransportAllowed("http://[::1]:8080/v1", "x"));
    assert.doesNotThrow(() => assertKeyTransportAllowed(undefined, "x"));
    assert.throws(() => assertKeyTransportAllowed("http://gw.example.com/v1", "embedding.baseUrl"), /embedding\.baseUrl uses plain http/);
    assert.throws(() => assertKeyTransportAllowed("http://10.0.0.5:8080", "x"), /plain http/);
  });

  it("the embedding configuration refuses http to a non-loopback host", () => {
    assert.throws(
      () => normalizeEmbeddingConfig({ provider: "openai-compatible", baseUrl: "http://gw.example.com/v1", apiKey: "k", model: "m", dimensions: 8 }),
      /plain http/,
    );
    const local = normalizeEmbeddingConfig({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "k", model: "m", dimensions: 8 });
    assert.equal(local.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(normalizeEmbeddingConfig({ provider: "openai-compatible", baseUrl: GATEWAY, apiKey: "k", model: "m", dimensions: 8 }).baseUrl, GATEWAY);
  });

  it("the embedding client is not built for http to a non-loopback host (SDK env fallback included)", async () => {
    const direct = new OpenAIEmbeddingProvider({ provider: "openai-compatible", baseUrl: "http://gw.example.com/v1", apiKey: "k", model: "m", dimensions: 8 });
    await assert.rejects(() => direct._clientForPrimary(), /plain http/);
    process.env.OPENAI_BASE_URL = "http://gw.example.com/v1";
    const viaEnv = new OpenAIEmbeddingProvider({ provider: "openai", apiKey: "k", model: "text-embedding-3-small", dimensions: 1536 });
    await assert.rejects(() => viaEnv._clientForPrimary(), /plain http/);
  });

  it("the OpenClaw remote adapter does not send its key over http to a non-loopback host", async () => {
    let called = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { called += 1; throw new Error("network must not be reached"); };
    try {
      const adapters = createOpenClawMemoryEmbeddingProviderAdapters({ embedding: {} });
      const adapter = adapters.find((entry) => entry.id === "plur1bus-openai-compatible");
      const { provider } = await adapter.create({ model: "m", dimensions: 4, remote: { baseUrl: "http://gw.example.com/v1", apiKey: "k" } });
      await assert.rejects(() => provider.embed("hello"), /plain http/);
      assert.equal(called, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("the reranker configuration refuses a keyed http endpoint, a keyless one stays allowed", () => {
    assert.throws(
      () => normalizeRerankerConfig({ provider: "remote", baseUrl: "http://rr.example.com/v1", apiKeyEnv: "SOME_KEY" }),
      /plain http/,
    );
    assert.throws(
      () => normalizeRerankerConfig({ provider: "cohere", baseUrl: "http://rr.example.com/v1", apiKeyEnv: "COHERE_API_KEY" }),
      /plain http/,
    );
    assert.equal(normalizeRerankerConfig({ provider: "remote", baseUrl: "http://rr.example.com/v1" }).baseUrl, "http://rr.example.com/v1");
    assert.equal(normalizeRerankerConfig({ provider: "remote", baseUrl: "http://127.0.0.1:8081", apiKeyEnv: "SOME_KEY" }).baseUrl, "http://127.0.0.1:8081");
    assert.equal(normalizeRerankerConfig({ provider: "remote", baseUrl: "https://rr.example.com/v1", apiKeyEnv: "SOME_KEY" }).baseUrl, "https://rr.example.com/v1");
  });

  it("the reranker does not send a Bearer over http to a non-loopback host", async () => {
    let called = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { called += 1; throw new Error("network must not be reached"); };
    try {
      const provider = new RemoteRerankerProvider({ provider: "remote", baseUrl: "http://rr.example.com/v1", protocol: "cohere", apiKey: "rr-secret" });
      await assert.rejects(() => provider.rerank("q", ["a", "b"], 2), /plain http/);
      assert.equal(called, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("F6: the legacy migration respects a deliberate provider choice", () => {
  const deliberate = [
    { baseUrl: "https://gw.example.com/v1" },
    { apiKey: "${OPENAI_COMPATIBLE_API_KEY}" },
    { apiKey: { source: "env", provider: "default", id: "GW_KEY" } },
    { apiKeyRef: "embedding-key" },
    { apiKeyEnv: "GW_KEY" },
  ];

  it("keeps an embedding with baseUrl, apiKey, apiKeyRef or apiKeyEnv but no provider", () => {
    for (const embedding of deliberate) {
      const root = makeTempDir("plur1bus-f6-embedding-");
      const result = applyLegacyProviderDefaults({ embedding, reranker: { provider: "disabled", enabled: false } }, { baseDbPath: root });
      assert.deepEqual(result.config.embedding, embedding, JSON.stringify(embedding));
      assert.equal(result.migrations.includes("embedding"), false);
    }
  });

  it("keeps a reranker with baseUrl, apiKey, apiKeyRef or apiKeyEnv but no provider", () => {
    for (const reranker of deliberate) {
      const root = makeTempDir("plur1bus-f6-reranker-");
      const result = applyLegacyProviderDefaults({ embedding: { provider: "openai" }, reranker }, { baseDbPath: root });
      assert.deepEqual(result.config.reranker, reranker, JSON.stringify(reranker));
      assert.equal(result.migrations.includes("reranker"), false);
    }
  });

  it("still moves a store with no provider and no endpoint or credential to the local default (counter-test)", () => {
    for (const embedding of [{}, undefined, { apiKey: "" }, { baseUrl: "  " }, { model: "text-embedding-3-small" }]) {
      const root = makeTempDir("plur1bus-f6-default-");
      const result = applyLegacyProviderDefaults({ embedding, reranker: {} }, { baseDbPath: root });
      assert.equal(result.config.embedding.provider, "local-transformers", JSON.stringify(embedding));
      assert.equal(result.config.reranker.provider, "local-transformers");
    }
  });
});

describe("F7: a failed request carries its HTTP status", () => {
  it("fetchWithTimeout sets .status on the error", async () => {
    const server = createServer((req, res) => { res.writeHead(401, { "content-type": "text/plain" }); res.end("no"); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await assert.rejects(
        () => fetchWithTimeout(`http://127.0.0.1:${server.address().port}/x`, {}, 2000),
        (error) => error.status === 401 && /HTTP 401/.test(error.message),
      );
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

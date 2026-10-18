/**
 * tests/reranker-remote.test.js — configurable HTTP reranker (contract 1.15.0):
 * presets, protocols against a local stub server, apiKeyRef through
 * HostServices.secrets with rotation, size limits, clean errors and no
 * silent model fallback.
 */

import { afterEach, before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import {
  RERANK_PRESETS,
  RemoteRerankerProvider,
  buildRerankBody,
  normalizeRerankResults,
  rerankEndpoint,
} from "../lib/providers/reranker-remote.js";
import { CohereRerankerProvider } from "../lib/providers/reranker-cohere.js";
import { ChainedRerankerProvider } from "../lib/providers/reranker-chained.js";
import { normalizeRerankerConfig } from "../lib/providers/config-normalize.js";
import { createRerankerProvider } from "../lib/providers/factory.js";
import { createRuntimeRerankerProvider } from "../engine/providers/runtime-reranker.js";
import { bindHostNetwork, resetHostNetwork } from "../lib/host-network.js";

const SECRET = "sk-rerank-canary-91f0";

/** One local HTTP server; each test sets `handler` and reads `requests`. */
let server;
let baseUrl;
let handler = null;
const requests = [];

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      requests.push(entry);
      const reply = handler ? handler(entry) : { status: 500, body: {} };
      if (reply.hang) return; // never answer
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...(reply.headers || {}) });
      const text = typeof reply.raw === "string" ? reply.raw : JSON.stringify(reply.body);
      if (reply.chunked) { // no content-length: the size cap must hold on the stream itself
        res.write(text.slice(0, 10));
        res.end(text.slice(10));
        return;
      }
      res.end(text);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  handler = null;
  requests.length = 0;
  resetHostNetwork();
});

const docs = ["alpha", "beta", "gamma"];

describe("protocols against a stub server", () => {
  it("cohere: {model, query, documents, top_n} → results, sorted and cut to topN", async () => {
    handler = () => ({ body: { results: [{ index: 2, relevance_score: 0.1 }, { index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.5 }] } });
    const provider = new RemoteRerankerProvider({ provider: "remote", baseUrl: `${baseUrl}/v1`, model: "bge-reranker" });
    const out = await provider.rerank("q", docs, 2);
    assert.deepEqual(out, [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.5 }]);
    assert.equal(requests[0].url, "/v1/rerank");
    assert.deepEqual(requests[0].body, { model: "bge-reranker", query: "q", documents: docs, top_n: 2, return_documents: false });
    assert.equal(requests[0].headers.authorization, undefined, "keyless remote sends no Authorization");
  });

  it("jina: same wire format, Bearer key from apiKeyEnv", async () => {
    process.env._RR_JINA_KEY = SECRET;
    try {
      handler = () => ({ body: { model: "x", results: [{ index: 1, relevance_score: 0.7, document: { text: "beta" } }] } });
      const provider = new RemoteRerankerProvider({ provider: "jina", baseUrl, apiKeyEnv: "_RR_JINA_KEY" });
      assert.deepEqual(await provider.rerank("q", docs, 3), [{ index: 1, relevance_score: 0.7 }]);
      assert.equal(requests[0].headers.authorization, `Bearer ${SECRET}`);
      assert.equal(requests[0].body.model, RERANK_PRESETS.jina.model);
      assert.equal(requests[0].body.top_n, 3);
    } finally {
      delete process.env._RR_JINA_KEY;
    }
  });

  it("voyage: top_k in, data out", async () => {
    handler = () => ({ body: { object: "list", data: [{ index: 0, relevance_score: 0.3 }, { index: 2, relevance_score: 0.8 }] } });
    const provider = new RemoteRerankerProvider({ provider: "voyage", baseUrl, apiKey: SECRET });
    assert.deepEqual(await provider.rerank("q", docs, 5), [{ index: 2, relevance_score: 0.8 }, { index: 0, relevance_score: 0.3 }]);
    assert.deepEqual(requests[0].body, { model: "rerank-2.5", query: "q", documents: docs, top_k: 3, return_documents: false });
  });

  it("tei: {query, texts} → flat [{index, score}]", async () => {
    handler = () => ({ body: [{ index: 1, score: 0.99 }, { index: 0, score: 0.2 }, { index: 2, score: 0.01 }] });
    const provider = new RemoteRerankerProvider({ provider: "remote", protocol: "tei", baseUrl: `${baseUrl}/rerank` });
    assert.deepEqual(await provider.rerank("q", docs, 2), [{ index: 1, relevance_score: 0.99 }, { index: 0, relevance_score: 0.2 }]);
    assert.equal(requests[0].url, "/rerank");
    assert.deepEqual(requests[0].body, { query: "q", texts: docs, raw_scores: false, return_text: false });
  });

  it("the Cohere class keeps its error wording and honours a baseUrl override", async () => {
    handler = () => ({ status: 429, body: { message: "slow down: alpha" } });
    const provider = new CohereRerankerProvider({ apiKey: SECRET, baseUrl: `${baseUrl}/v2` });
    const err = await provider.rerank("q", docs, 1).then(() => null, (e) => e);
    assert.match(err.message, /^Cohere rerank failed \(429\)/);
    assert.equal(err.status, 429);
    assert.ok(!err.message.includes("alpha"), "error body never reaches the message");
    assert.equal(requests[0].url, "/v2/rerank");
  });
});

describe("presets", () => {
  it("default endpoints, protocols and models, all overridable", async () => {
    const seen = [];
    bindHostNetwork({
      fetch: async (url, init) => {
        seen.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ results: [], data: [] }), { status: 200 });
      },
    });
    await new RemoteRerankerProvider({ provider: "cohere", apiKey: "k" }).rerank("q", ["d"], 1);
    await new RemoteRerankerProvider({ provider: "jina", apiKey: "k" }).rerank("q", ["d"], 1);
    await new RemoteRerankerProvider({ provider: "voyage", apiKey: "k" }).rerank("q", ["d"], 1);
    await new RemoteRerankerProvider({ provider: "voyage", apiKey: "k", baseUrl: "https://gw.example.test/voyage", model: "rerank-2.5-lite" }).rerank("q", ["d"], 1);
    assert.deepEqual(seen.map((s) => s.url), [
      "https://api.cohere.com/v2/rerank",
      "https://api.jina.ai/v1/rerank",
      "https://api.voyageai.com/v1/rerank",
      "https://gw.example.test/voyage/rerank",
    ]);
    assert.equal(seen[0].body.model, "rerank-v3.5");
    assert.equal(seen[3].body.model, "rerank-2.5-lite");
    assert.ok("top_k" in seen[2].body && !("top_n" in seen[2].body));
  });

  it("rejects bad endpoints and protocols", () => {
    assert.throws(() => rerankEndpoint("ftp://x.test"), /http or https/);
    assert.throws(() => rerankEndpoint("https://user:pw@x.test"), /must not carry credentials/);
    assert.throws(() => rerankEndpoint("not a url"), /not a valid URL/);
    assert.equal(rerankEndpoint("https://x.test/v1/"), "https://x.test/v1/rerank");
    assert.equal(rerankEndpoint("https://x.test/v2/rerank"), "https://x.test/v2/rerank");
    assert.throws(() => new RemoteRerankerProvider({ provider: "remote" }), /baseUrl is required/);
    assert.throws(() => new RemoteRerankerProvider({ provider: "remote", baseUrl, protocol: "soap" }), /protocol must be one of/);
    assert.throws(() => buildRerankBody("soap", { query: "q", documents: [], topN: 1 }), /unknown reranker protocol/);
  });
});

describe("apiKeyRef through HostServices.secrets", () => {
  it("resolves the key with purpose 'reranker', prefers it over apiKeyEnv and re-resolves after a 401", async () => {
    let current = "key-old";
    const calls = [];
    bindHostNetwork({ secrets: { resolve: async (ref, purpose) => { calls.push([ref, purpose]); return current; } } });
    process.env._RR_ENV_KEY = "env-key-must-not-win";
    try {
      handler = (req) => (req.headers.authorization === "Bearer key-new"
        ? { body: { results: [{ index: 0, relevance_score: 1 }] } }
        : { status: 401, body: { message: "invalid key" } });
      const provider = new RemoteRerankerProvider({ provider: "cohere", baseUrl, apiKeyRef: "cohere/prod", apiKeyEnv: "_RR_ENV_KEY" });
      await assert.rejects(provider.rerank("q", ["d"], 1), (err) => err.status === 401 && !err.message.includes("key-old"));
      current = "key-new"; // rotated in the host store
      assert.deepEqual(await provider.rerank("q", ["d"], 1), [{ index: 0, relevance_score: 1 }]);
      assert.deepEqual(calls, [["cohere/prod", "reranker"], ["cohere/prod", "reranker"]]);
      assert.deepEqual(requests.map((r) => r.headers.authorization), ["Bearer key-old", "Bearer key-new"]);
    } finally {
      delete process.env._RR_ENV_KEY;
    }
  });

  it("fails closed when apiKeyRef is set but the host has no secret store", async () => {
    handler = () => ({ body: { results: [] } });
    const provider = new RemoteRerankerProvider({ provider: "remote", baseUrl, apiKeyRef: "missing" });
    await assert.rejects(provider.rerank("q", ["d"], 1), (err) => err.code === "PLUR1BUS_SECRET_STORE_UNAVAILABLE");
    assert.equal(requests.length, 0, "no request leaves without the configured key");
  });
});

describe("limits and malformed responses", () => {
  it("refuses too many documents and oversized requests before any request", async () => {
    const provider = new RemoteRerankerProvider({ provider: "remote", baseUrl, maxDocuments: 2, maxRequestBytes: 200 });
    await assert.rejects(provider.rerank("q", docs, 3), /exceed maxDocuments=2/);
    await assert.rejects(provider.rerank("q", ["x".repeat(500)], 1), /exceeds maxRequestBytes=200/);
    assert.equal(requests.length, 0);
  });

  it("aborts an oversized response (declared or streamed)", async () => {
    handler = () => ({ raw: JSON.stringify({ results: [{ index: 0, relevance_score: 1 }], pad: "x".repeat(5000) }) });
    const provider = new RemoteRerankerProvider({ provider: "remote", baseUrl, maxResponseBytes: 1000 });
    await assert.rejects(provider.rerank("q", ["d"], 1), /response exceeds 1000 bytes/);
    handler = () => ({ chunked: true, raw: JSON.stringify({ results: [{ index: 0, relevance_score: 1 }], pad: "x".repeat(5000) }) });
    await assert.rejects(provider.rerank("q", ["d"], 1), /response exceeds 1000 bytes/);
    handler = () => ({ chunked: true, body: { results: [{ index: 0, relevance_score: 1 }] } });
    assert.deepEqual(await provider.rerank("q", ["d"], 1), [{ index: 0, relevance_score: 1 }]);
  });

  it("rejects malformed payloads with a clean error", async () => {
    const provider = new RemoteRerankerProvider({ provider: "remote", baseUrl });
    for (const [raw, pattern] of [
      ["not json", /invalid JSON/],
      [JSON.stringify({ nothing: true }), /no results array/],
      [JSON.stringify({ results: [{ index: 7, relevance_score: 1 }] }), /invalid index/],
      [JSON.stringify({ results: [{ index: 0, relevance_score: "high" }] }), /invalid score/],
      [JSON.stringify({ results: [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 0.5 }] }), /duplicate index/],
    ]) {
      handler = () => ({ raw });
      await assert.rejects(provider.rerank("q", ["d"], 1), pattern);
    }
  });

  it("normalizeRerankResults accepts every documented shape", () => {
    assert.deepEqual(normalizeRerankResults({ results: [{ index: 0, relevance_score: 0.4 }] }, 1, 1), [{ index: 0, relevance_score: 0.4 }]);
    assert.deepEqual(normalizeRerankResults({ data: [{ index: 0, relevance_score: 0.4 }] }, 1, 1), [{ index: 0, relevance_score: 0.4 }]);
    assert.deepEqual(normalizeRerankResults([{ index: 0, score: 0.4 }], 1, 1), [{ index: 0, relevance_score: 0.4 }]);
  });

  it("times out on its own timer only when no signal is passed", async () => {
    handler = () => ({ hang: true });
    const provider = new RemoteRerankerProvider({ provider: "remote", baseUrl, timeoutMs: 50 });
    const started = Date.now();
    await assert.rejects(provider.rerank("q", ["d"], 1));
    assert.ok(Date.now() - started < 2000);
  });
});

describe("config and factories", () => {
  it("normalizes the new providers and keeps the Cohere defaults", () => {
    const cohere = normalizeRerankerConfig({ provider: "cohere", apiKeyEnv: "COHERE_API_KEY" });
    assert.equal(cohere.baseUrl, "https://api.cohere.com/v2");
    assert.equal(cohere.protocol, "cohere");
    assert.equal(cohere.model, "rerank-v3.5");
    assert.equal(cohere.enabled, true);

    const jinaNoKey = normalizeRerankerConfig({ provider: "jina" });
    assert.equal(jinaNoKey.enabled, false, "a preset that needs a key stays off without one");
    assert.equal(normalizeRerankerConfig({ provider: "jina", apiKeyRef: "jina" }).enabled, true);

    const remote = normalizeRerankerConfig({ baseUrl: "http://localhost:8080", protocol: "tei" });
    assert.equal(remote.provider, "remote", "baseUrl alone infers the generic remote provider");
    assert.equal(remote.enabled, true, "remote may run keyless");
    assert.equal(remote.model, undefined);

    assert.throws(() => normalizeRerankerConfig({ provider: "remote" }), /baseUrl is required/);
    assert.throws(() => normalizeRerankerConfig({ provider: "voyage", apiKey: "k", protocol: "grpc" }), /protocol must be one of/);
    assert.throws(() => normalizeRerankerConfig({ provider: "voyage", apiKey: "k", apiKeyRef: "bad ref" }), /apiKeyRef must be/);
  });

  it("builds a chained provider without a fallback model unless fallbackProvider is set", async () => {
    handler = () => ({ status: 503, body: {} });
    const cfg = normalizeRerankerConfig({ provider: "remote", baseUrl });
    for (const reranker of [createRerankerProvider(cfg, null), createRuntimeRerankerProvider({ provider: "remote", baseUrl }).reranker]) {
      assert.ok(reranker instanceof ChainedRerankerProvider);
      assert.equal(reranker.primary.id, "remote");
      assert.equal(reranker.fallback, null);
      // No fallback configured: the failure means "no reranking", never another model.
      assert.deepEqual(await reranker.rerank("q", ["d"], 1), []);
    }
    const withFallback = createRuntimeRerankerProvider({ provider: "voyage", apiKey: "k", fallbackProvider: "local-transformers" }).reranker;
    assert.equal(withFallback.fallback.id, "local-transformers");
  });
});

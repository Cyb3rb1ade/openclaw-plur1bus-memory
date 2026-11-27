/**
 * tests/host-fetch-port.test.js — HostServices.fetch carries every outbound
 * HTTP request of the engine (contract 1.15.0).
 *
 * The global fetch is replaced by one that throws; a host fetch is bound and
 * records every call. Every HTTP-speaking component must reach the stub
 * through the port: the OpenAI-SDK embedding provider, the OpenClaw remote
 * embedding adapter, the HTTP rerankers, the engine's direct LLM calls
 * (lib/llm-call.js and the feature router), the tier-3 emotion LLM, the JEV
 * chunk decider, fetchWithTimeout (webhooks), pinned model downloads and the
 * transformers module's own downloads. A source scan keeps new call sites
 * from bypassing the port. Also covers apiKeyRef for embeddings and LLM calls
 * and createEngine's binding.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { bindHostNetwork, hostFetch, isHostFetchBound, resetHostNetwork } from "../lib/host-network.js";
import { OpenAIEmbeddingProvider } from "../lib/providers/embedding-openai.js";
import { createOpenClawMemoryEmbeddingProviderAdapters } from "../lib/providers/openclaw-memory-embedding-adapters.js";
import { RemoteRerankerProvider } from "../lib/providers/reranker-remote.js";
import { CohereRerankerProvider } from "../lib/providers/reranker-cohere.js";
import { callLlm } from "../lib/llm-call.js";
import { callLlm as callFeatureLlm } from "../engine/runtime/llm-calls.js";
import { resolveFeatureLlmRoute } from "../lib/llm-router.js";
import { Tier3LLMClassifier } from "../lib/tier3-llm.js";
import { createJevChunkDecider } from "../lib/jev-chunk-decider.js";
import { fetchWithTimeout } from "../lib/fetch-with-timeout.js";
import { E5_EMBEDDING_PROFILE, ensurePinnedModelArtifacts } from "../lib/providers/local-model-artifacts.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { createLlmResultCache } from "../lib/llm-result-cache.js";
import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls;
let originalFetch;
let keyByCall;

function stubResponse(url, init) {
  const href = String(url);
  if (href.endsWith("/embeddings")) {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return json({ object: "list", data: inputs.map((_, index) => ({ object: "embedding", index, embedding: [0.1, 0.2, 0.3] })), model: body.model, usage: { prompt_tokens: 1, total_tokens: 1 } });
  }
  if (href.endsWith("/chat/completions")) {
    return json({ id: "c", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "{\"primary\":\"neutral\",\"valence\":0,\"arousal\":0,\"confidence\":0.5,\"language\":\"en\"}" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }
  if (href.endsWith("/rerank")) return json({ results: [{ index: 0, relevance_score: 0.5 }] });
  return json({ error: "not found" }, 404);
}

beforeEach(() => {
  calls = [];
  keyByCall = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`global fetch bypassed the host port: ${url}`); };
  bindHostNetwork({
    fetch: async (url, init = {}) => {
      const headers = new Headers(init.headers || {});
      calls.push({ url: String(url), method: init.method || "GET" });
      keyByCall.push(headers.get("authorization"));
      return stubResponse(url, init);
    },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetHostNetwork();
});

const hit = (fragment) => calls.some((c) => c.url.includes(fragment));

describe("every outbound HTTP path uses HostServices.fetch", () => {
  it("OpenAI-SDK embedding provider (OpenAI, OpenRouter, Gemini, … via baseUrl)", async () => {
    const provider = new OpenAIEmbeddingProvider({ provider: "openai-compatible", model: "qwen/qwen3-embedding-8b", baseUrl: "https://openrouter.example.test/api/v1", apiKey: "k", dimensions: 3, embeddingCacheEnabled: false });
    assert.deepEqual(await provider.embedQuery("hello"), [0.1, 0.2, 0.3]);
    assert.ok(hit("openrouter.example.test/api/v1/embeddings"));
  });

  it("OpenClaw remote embedding adapter (fetchWithTimeout)", async () => {
    const adapter = createOpenClawMemoryEmbeddingProviderAdapters({
      embedding: { apiKey: "sk-test", baseUrl: "https://embed.example.test/v1", dimensions: 3, model: "custom" },
    }).find((item) => item.id === "plur1bus-openai-compatible");
    const created = await adapter.create({ config: {}, model: "custom", remote: {} });
    const provider = created?.provider ?? created;
    await provider.embedBatch(["a"]);
    assert.ok(hit("embed.example.test/v1/embeddings"));
  });

  it("HTTP rerankers (Cohere preset and generic remote)", async () => {
    await new CohereRerankerProvider({ apiKey: "k" }).rerank("q", ["d"], 1);
    await new RemoteRerankerProvider({ provider: "remote", baseUrl: "http://tei.local:8080" }).rerank("q", ["d"], 1);
    assert.ok(hit("api.cohere.com/v2/rerank"));
    assert.ok(hit("tei.local:8080/rerank"));
  });

  it("direct LLM calls: lib/llm-call.js and the feature router", async () => {
    assert.match(await callLlm([{ role: "user", content: "hi" }], { model: "m", apiKey: "k", baseUrl: "https://llm.example.test/v1" }), /neutral/);
    const route = resolveFeatureLlmRoute({ model: "m", baseUrl: "https://router.example.test/v1", apiKey: "k" }, { feature: "test" });
    assert.match(await callFeatureLlm([{ role: "user", content: "hi" }], route), /neutral/);
    assert.ok(hit("llm.example.test/v1/chat/completions"));
    assert.ok(hit("router.example.test/v1/chat/completions"));
  });

  it("tier-3 emotion LLM client", async () => {
    const classifier = new Tier3LLMClassifier({ apiKey: "k", baseUrl: "https://t3.example.test/v1", model: "m" });
    await classifier.classify("I am fine");
    assert.ok(hit("t3.example.test/v1/chat/completions"));
  });

  it("JEV chunk decider and fetchWithTimeout (webhooks)", async () => {
    const decide = createJevChunkDecider({ apiKey: "k" });
    await decide("some state");
    assert.equal(calls.length, 1);
    await fetchWithTimeout("https://hooks.example.test/x", { method: "POST", body: "{}" }).catch(() => {});
    assert.ok(hit("hooks.example.test/x"));
  });

  it("pinned model downloads and the transformers module's own fetch", async () => {
    const cacheDir = makeTempDir("hfp-models-");
    await assert.rejects(ensurePinnedModelArtifacts(E5_EMBEDDING_PROFILE, cacheDir));
    assert.ok(calls.some((c) => c.url.startsWith("https://huggingface.co/")), "artifact download went through the port");

    const fakeTransformers = { env: { fetch: originalFetch }, pipeline: async () => { throw new Error("stop after load"); } };
    const local = new LocalTransformersEmbeddingProvider({ model: "Xenova/test-model", dimensions: 3, loadTransformers: async () => fakeTransformers, embeddingCacheEnabled: false });
    await local.embedQuery("x").catch(() => {});
    assert.equal(fakeTransformers.env.fetch, hostFetch, "transformers downloads use the host fetch");
  });

  it("no source file calls the global fetch or builds an SDK client past the port", () => {
    const offenders = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.(m?js)$/.test(name)) continue;
        const rel = relative(REPO, path).replaceAll("\\", "/");
        if (rel === "lib/host-network.js") continue;
        // Browser-side script embedded in the control UI page, not engine egress.
        if (rel === "lib/setup/control-ui-plugin-runtime.js") continue;
        const source = readFileSync(path, "utf8");
        source.split("\n").forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, "");
          if (/^\s*\*/.test(line)) return;
          if (/(?<![\w.])fetch\s*\(/.test(code) || /globalThis\.fetch\b(?!Impl)/.test(code)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
          // Every file that builds an OpenAI client must route it through sdkFetchOptions().
          if (/new OpenAI\s*\(/.test(code) && !/sdkFetchOptions\(\)/.test(source)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
          if (/from\s+["']node:https?["']/.test(code)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    };
    for (const dir of ["lib", "engine", "adapter"]) walk(join(REPO, dir));
    assert.deepEqual(offenders, []);
  });
});

describe("apiKeyRef for embeddings and LLM calls", () => {
  it("embedding: key from the host store (purpose 'embedding'), new client after rotation, re-resolve after 401", async () => {
    let now = 0;
    let current = "emb-1";
    const resolved = [];
    let reject = false;
    bindHostNetwork({
      fetch: async (url, init = {}) => {
        keyByCall.push(new Headers(init.headers).get("authorization"));
        calls.push({ url: String(url) });
        if (reject) { reject = false; return json({ error: { type: "invalid_request_error", code: "invalid_api_key" } }, 401); }
        return stubResponse(url, init);
      },
      secrets: { resolve: async (ref, purpose) => { resolved.push([ref, purpose]); return current; } },
    });
    const provider = new OpenAIEmbeddingProvider({ provider: "openai", model: "text-embedding-3-small", apiKeyRef: "openai/main", apiKeyEnv: "_NOT_SET_HFP", dimensions: 3, embeddingCacheEnabled: false, clock: () => now });
    await provider.embedQuery("a");
    current = "emb-2";
    await provider.embedQuery("b"); // within the TTL: same key
    now += 60_000;
    await provider.embedQuery("c"); // TTL elapsed: re-resolved, new client
    reject = true;
    current = "emb-3";
    await provider.embedBatch(["d"], 1); // 401 → invalidate → retry with the re-resolved key
    assert.deepEqual(keyByCall, ["Bearer emb-1", "Bearer emb-1", "Bearer emb-2", "Bearer emb-2", "Bearer emb-3"]);
    assert.deepEqual(resolved.map(([, purpose]) => purpose), ["embedding", "embedding", "embedding"]);
    assert.ok(resolved.every(([ref]) => ref === "openai/main"));
  });

  it("embedding: apiKeyRef without a host store fails closed, no request", async () => {
    bindHostNetwork({ fetch: async (url) => { calls.push({ url }); return json({}); } });
    const provider = new OpenAIEmbeddingProvider({ provider: "openai", model: "text-embedding-3-small", apiKeyRef: "x", dimensions: 3, embeddingCacheEnabled: false });
    await assert.rejects(provider.embedQuery("a"), (err) => err.code === "PLUR1BUS_SECRET_STORE_UNAVAILABLE");
    assert.equal(calls.length, 0);
  });

  it("LLM: apiKeyRef resolved per call (purpose 'llm'); the result cache keys on its hash, never the value", async () => {
    let current = "llm-1";
    const resolved = [];
    bindHostNetwork({
      fetch: async (url, init = {}) => { keyByCall.push(new Headers(init.headers).get("authorization")); return stubResponse(url, init); },
      secrets: { resolve: async (ref, purpose) => { resolved.push([ref, purpose]); return current; } },
    });
    const route = resolveFeatureLlmRoute({ model: "m", baseUrl: "https://llm.example.test/v1", apiKeyRef: "openrouter/llm" }, { feature: "test" });
    assert.equal(route.kind, "direct-override");
    assert.equal(route.apiKeyRef, "openrouter/llm");
    await callFeatureLlm([{ role: "user", content: "hi" }], route);
    current = "llm-2";
    await callFeatureLlm([{ role: "user", content: "hi" }], route);
    assert.deepEqual(keyByCall, ["Bearer llm-1", "Bearer llm-2"]);
    assert.deepEqual(resolved, [["openrouter/llm", "llm"], ["openrouter/llm", "llm"]]);

    const cache = createLlmResultCache({ enabled: true, persist: false, metrics: false, baseDbPath: makeTempDir("hfp-llmcache-") });
    const seen = [];
    const spy = { getOrCompute: async (request, compute) => { seen.push(JSON.stringify(request)); return cache.getOrCompute(request, compute); } };
    await callLlm([{ role: "user", content: "hi" }], { model: "m", apiKeyRef: "openrouter/llm", baseUrl: "https://llm.example.test/v1" }, { resultCache: spy });
    assert.equal(seen.length, 1);
    assert.ok(seen[0].includes("llm-2"), "the cache sees the credential so rotation invalidates");
    await cache.close?.();
  });
});

describe("createEngine binds the ports", () => {
  const config = (baseDbPath, reranker) => ({
    baseDbPath,
    embedding: { provider: "local-transformers", local: { dimensions: 384 } },
    ...(reranker ? { reranker } : {}),
    autoCapture: false, autoRecall: true,
    neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  });

  it("host.fetch and host.secrets reach a configured remote reranker", async () => {
    resetHostNetwork();
    const engineCalls = [];
    const host = createStubHost({
      stateDir: makeTempDir("hfp-state-"),
      fetch: async (url, init = {}) => { engineCalls.push({ url: String(url), auth: new Headers(init.headers).get("authorization") }); return stubResponse(url, init); },
      secrets: { resolve: async (ref, purpose) => (ref === "voyage/key" && purpose === "reranker" ? "vk-1" : "") },
    });
    const engine = createEngine(host, config(makeTempDir("hfp-db-"), { enabled: true, provider: "voyage", apiKeyRef: "voyage/key", baseUrl: "https://voyage.example.test/v1" }));
    try {
      assert.equal(isHostFetchBound(), true);
      const reranker = internalsOf(engine).reranker;
      assert.equal(reranker.primary.id, "voyage");
      await reranker.rerank("q", ["d"], 1);
      assert.deepEqual(engineCalls, [{ url: "https://voyage.example.test/v1/rerank", auth: "Bearer vk-1" }]);
    } finally {
      await engine.close();
    }
  });

  it("rejects a non-function host.fetch", () => {
    const host = createStubHost({ stateDir: makeTempDir("hfp-state-"), fetch: "https://proxy" });
    assert.throws(() => createEngine(host, config(makeTempDir("hfp-db-"))), /HostServices.fetch must be a function/);
  });
});

/**
 * tests/provider-error-redaction.test.js
 *
 * N2 leak audit I-6: provider error bodies must not reach thrown messages or
 * logs. Every site is fed a body carrying a unique marker; the message, the
 * stack and a Harness-style `{ err }` log line must lack it and must carry the
 * status plus the body hash.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CohereRerankerProvider } from "../lib/providers/reranker-cohere.js";
import { OpenAIEmbeddingProvider } from "../lib/providers/embedding-openai.js";
import { createOpenClawMemoryEmbeddingProviderAdapters } from "../lib/providers/openclaw-memory-embedding-adapters.js";
import { callLlm } from "../lib/llm-call.js";
import {
  PROVIDER_BODY_DEBUG_ENV,
  createProviderHttpError,
  extractProviderErrorFields,
  sanitizeProviderSdkError,
} from "../lib/provider-error.js";
import { shortHash } from "../lib/log-redact.js";

const MARKER = "CANARY-7f3a9c-prompt-echo";
const BEARER = "Bearer sk-live-abcdefghijklmnop";
const here = dirname(fileURLToPath(import.meta.url));
const originalFetch = globalThis.fetch;
const originalDebug = process.env[PROVIDER_BODY_DEBUG_ENV];

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDebug === undefined) delete process.env[PROVIDER_BODY_DEBUG_ENV];
  else process.env[PROVIDER_BODY_DEBUG_ENV] = originalDebug;
});

function bodyWith(extra = {}) {
  return JSON.stringify({ error: { type: "invalid_request_error", code: "context_length_exceeded", message: `bad input: ${MARKER} ${BEARER}`, ...extra } });
}

/** What the Harness does with a failed handler: message and stack. */
function loggedForm(err) {
  return JSON.stringify({ err: { message: err.message, stack: err.stack } }) + String(err);
}

function assertClean(err, { status, hash }) {
  const logged = loggedForm(err);
  assert.ok(!logged.includes(MARKER), "marker leaked");
  assert.ok(!logged.includes("sk-live"), "token leaked");
  assert.ok(logged.includes(String(status)), "status missing");
  if (hash) assert.ok(logged.includes(hash), "hash missing");
}

describe("provider error helper", () => {
  it("keeps only whitelisted type/code and drops free text", () => {
    assert.deepEqual(extractProviderErrorFields(bodyWith()), { type: "invalid_request_error", code: "context_length_exceeded" });
    assert.deepEqual(extractProviderErrorFields(JSON.stringify({ error: { code: `has spaces ${MARKER}`, type: 5 } })), { type: "5" });
    assert.deepEqual(extractProviderErrorFields("not json " + MARKER), {});
  });

  it("builds an Error with status, hash and length but no body", () => {
    const body = bodyWith();
    const err = createProviderHttpError("X failed", 400, body);
    assert.equal(err.constructor, Error);
    assert.equal(err.status, 400);
    assert.match(err.message, /^X failed \(400\): type=invalid_request_error code=context_length_exceeded bodyLen=\d+ bodySha=[0-9a-f]{12}$/);
    assertClean(err, { status: 400, hash: shortHash(body) });
  });

  it("appends a bounded redacted excerpt only when the debug flag is set", () => {
    const body = bodyWith();
    process.env[PROVIDER_BODY_DEBUG_ENV] = "1";
    const err = createProviderHttpError("X failed", 400, body);
    assert.ok(err.message.includes("bodyExcerpt="));
    assert.ok(!err.message.includes("sk-live"), "excerpt must still redact tokens");
    delete process.env[PROVIDER_BODY_DEBUG_ENV];
    assert.ok(!createProviderHttpError("X failed", 400, body).message.includes("bodyExcerpt"));
  });

  it("leaves errors without a numeric status untouched", () => {
    const abort = new Error(`aborted ${MARKER}`);
    abort.name = "AbortError";
    assert.equal(sanitizeProviderSdkError(abort, "LLM").message, `aborted ${MARKER}`);
    assert.equal(sanitizeProviderSdkError(null, "LLM"), null);
  });
});

describe("Cohere reranker (lib/providers/reranker-cohere.js)", () => {
  it("does not put the response body into the error", async () => {
    const body = bodyWith();
    globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => body });
    const provider = new CohereRerankerProvider({ apiKey: "test-key" });
    const err = await provider.rerank("q", ["d"], 1).then(() => null, (e) => e);
    assert.ok(err, "must reject");
    assert.equal(err.status, 400);
    assert.match(err.message, /^Cohere rerank failed \(400\)/);
    assertClean(err, { status: 400, hash: shortHash(body) });
  });

  it("survives an unreadable body", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => { throw new Error(MARKER); } });
    const err = await new CohereRerankerProvider({ apiKey: "test-key" }).rerank("q", ["d"], 1).then(() => null, (e) => e);
    assert.equal(err.status, 503);
    assertClean(err, { status: 503, hash: shortHash("") });
  });
});

describe("OpenAI-compatible embedding adapter (fetch path)", () => {
  it("never surfaces the body (fetchWithTimeout is status-only; the in-adapter branch is hash-only)", async () => {
    const body = bodyWith();
    globalThis.fetch = async () => ({ ok: false, status: 400, statusText: "Bad Request", text: async () => body });
    const adapter = createOpenClawMemoryEmbeddingProviderAdapters({
      embedding: { apiKey: "sk-test", baseUrl: "https://embedding.example.test", dimensions: 3, model: "custom-embedding-model" },
    }).find((item) => item.id === "plur1bus-openai-compatible");
    const { provider } = await adapter.create({});
    try {
      const err = await provider.embed("input text", { inputType: "query" }).then(() => null, (e) => e);
      assert.ok(err, "must reject");
      assertClean(err, { status: 400 });
    } finally {
      await provider.close?.();
    }
  });
});

describe("SDK errors (OpenAI client): llm-call and embedding-openai", () => {
  class FakeApiError extends Error {
    constructor(status, bodyObj) {
      super(`${status} ${bodyObj.error.message}`);
      this.name = "APIError";
      this.status = status;
      this.error = bodyObj.error;
      this.code = bodyObj.error.code;
      this.type = bodyObj.error.type;
    }
  }
  const sdkBody = JSON.parse(bodyWith());

  it("callLlm throws a scrubbed error and keeps class, status and instanceof", async () => {
    let thrown;
    class FakeOpenAI {
      constructor() {
        this.chat = { completions: { create: async () => { thrown = new FakeApiError(400, sdkBody); throw thrown; } } };
      }
    }
    const err = await callLlm([{ role: "user", content: MARKER }], { apiKey: "k", model: "m" }, { OpenAI: FakeOpenAI }).then(() => null, (e) => e);
    assert.equal(err, thrown, "same object so identity and class are preserved");
    assert.ok(err instanceof FakeApiError);
    assert.equal(err.status, 400);
    assert.equal(err.code, "context_length_exceeded");
    assert.deepEqual(err.error, { type: "invalid_request_error", code: "context_length_exceeded" });
    assertClean(err, { status: 400, hash: shortHash(JSON.stringify(sdkBody.error)) });
  });

  it("callLlm leaves a non-HTTP failure alone", async () => {
    class FakeOpenAI {
      constructor() { this.chat = { completions: { create: async () => { throw new Error("Connection error."); } } }; }
    }
    const err = await callLlm([], { apiKey: "k", model: "m" }, { OpenAI: FakeOpenAI }).then(() => null, (e) => e);
    assert.equal(err.message, "Connection error.");
  });

  it("OpenAIEmbeddingProvider retries on 429 as before, then throws a scrubbed error", async () => {
    let calls = 0;
    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test", model: "text-embedding-3-small", dimensions: 3, cache: { enabled: false } });
    provider._cache = null;
    provider._client = { embeddings: { create: async () => { calls += 1; throw new FakeApiError(429, { error: { ...sdkBody.error, code: "rate_limit_exceeded" } }); } } };
    const err = await provider.embedBatch(["x"], 0).then(() => null, (e) => e);
    assert.ok(err instanceof FakeApiError);
    assert.equal(err.status, 429);
    assert.equal(calls, 2, "one primary attempt plus the single-item fallback, unchanged");
    assertClean(err, { status: 429 });
  });

  it("the unreachable legacy classes carry no raw body interpolation", () => {
    const src = readFileSync(join(here, "../engine/providers/legacy-providers.js"), "utf8");
    assert.ok(!/\$\{err\}/.test(src), "raw body interpolation");
    assert.ok(!/\(\$\{e\.message\}\)/.test(src), "raw SDK message interpolation");
    assert.ok(src.includes("createProviderHttpError"));
  });
});

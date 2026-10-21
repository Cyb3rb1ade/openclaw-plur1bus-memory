/**
 * tests/provider-stall-body.test.js — engine audit F7 and the two provider side findings.
 *
 *  F7  The fetchWithTimeout deadline covers reading the response body, not only the headers.
 *  N1  The OpenClaw remote embedding adapters honour apiKeyEnv and apiKeyRef (host secret store).
 *  N2  A 401/403 makes the remote reranker forget a legacy (apiKeyEnv / credentialResolver) key too.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { fetchWithTimeout } from "../lib/fetch-with-timeout.js";
import { RemoteRerankerProvider } from "../lib/providers/reranker-remote.js";
import { createOpenClawMemoryEmbeddingProviderAdapters } from "../lib/providers/openclaw-memory-embedding-adapters.js";
import { bindHostNetwork, resetHostNetwork } from "../lib/host-network.js";

const HUNG = Symbol("hung");
/** Resolves with the promise's outcome, or HUNG when it does not settle in `ms`. */
async function settle(promise, ms = 3000) {
  let timer;
  const guard = new Promise((resolve) => { timer = setTimeout(() => resolve(HUNG), ms); });
  try {
    return await Promise.race([promise.then((value) => ({ value }), (error) => ({ error })), guard]);
  } finally {
    clearTimeout(timer);
  }
}

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Headers and the first bytes arrive, then the connection stalls. */
const stallInBody = (req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.write('{"data":[');
};

describe("F7: the timeout covers the response body", () => {
  it("text() of a stalled body rejects at the deadline instead of hanging", async () => {
    await withServer(stallInBody, async (base) => {
      const res = await fetchWithTimeout(`${base}/x`, {}, 300);
      const out = await settle(res.text());
      assert.notEqual(out, HUNG, "the body read must not outlive the deadline");
      assert.equal(out.error?.name, "AbortError");
      assert.match(out.error.message, /timed out/i);
      assert.ok(!out.error.message.includes("/x"), "no URL path in the message");
    });
  });

  it("json() and a stream reader are bound by the same deadline", async () => {
    await withServer(stallInBody, async (base) => {
      const viaJson = await fetchWithTimeout(`${base}/a`, {}, 300);
      const jsonOut = await settle(viaJson.json());
      assert.notEqual(jsonOut, HUNG);
      assert.equal(jsonOut.error?.name, "AbortError");

      const viaReader = await fetchWithTimeout(`${base}/b`, {}, 300);
      const reader = viaReader.body.getReader();
      const readOut = await settle((async () => { for (;;) { const { done } = await reader.read(); if (done) return "done"; } })());
      assert.notEqual(readOut, HUNG);
      assert.ok(readOut.error, "the stream errors at the deadline");
    });
  });

  it("a body that arrives in time is read normally and nothing aborts later (counter-test)", async () => {
    await withServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"ok":');
      setTimeout(() => res.end("true}"), 50);
    }, async (base) => {
      const res = await fetchWithTimeout(`${base}/x`, {}, 400);
      assert.deepEqual(await res.json(), { ok: true });
      await new Promise((resolve) => setTimeout(resolve, 500)); // past the deadline: no late error
    });
  });

  it("the deadline is one budget for headers plus body, not per phase (counter-test)", async () => {
    await withServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.write("a");
        setTimeout(() => res.end("b"), 300);
      }, 200);
    }, async (base) => {
      const res = await fetchWithTimeout(`${base}/x`, {}, 400);
      const out = await settle(res.text());
      assert.equal(out.error?.name, "AbortError", "200 ms headers + 300 ms body exceed 400 ms");
    });
  });

  it("stalled headers and non-ok responses behave as before (counter-test)", async () => {
    await withServer(() => { /* never answers */ }, async (base) => {
      await assert.rejects(() => fetchWithTimeout(`${base}/x`, {}, 200), (e) => e.name === "AbortError");
    });
    await withServer((req, res) => { res.writeHead(503); res.end("busy"); }, async (base) => {
      await assert.rejects(() => fetchWithTimeout(`${base}/x`, {}, 2000), (e) => e.status === 503 && /HTTP 503/.test(e.message));
    });
  });

  it("a response without a body needs no wrapper (counter-test)", async () => {
    await withServer((req, res) => { res.writeHead(204); res.end(); }, async (base) => {
      const res = await fetchWithTimeout(`${base}/x`, { method: "POST" }, 2000);
      assert.equal(res.status, 204);
      assert.equal(await res.text(), "");
    });
  });
});

describe("N1: OpenClaw remote adapters honour apiKeyEnv and apiKeyRef", () => {
  const realFetch = globalThis.fetch;
  const ENV = "_ADAPTER_KEY_ENV";
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetHostNetwork();
    delete process.env[ENV];
  });

  function stubFetch(statusFor = () => 200) {
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), authorization: init?.headers?.Authorization });
      const status = statusFor(seen.length);
      return {
        ok: status < 400,
        status,
        statusText: status === 200 ? "OK" : "Denied",
        async json() { return { data: [{ embedding: [0.1, 0.2, 0.3] }] }; },
        async text() { return ""; },
      };
    };
    return seen;
  }

  async function provider(embedding, options = {}, id = "plur1bus-openai-compatible") {
    const adapter = createOpenClawMemoryEmbeddingProviderAdapters({ embedding }).find((a) => a.id === id);
    return (await adapter.create({ model: "m", dimensions: 3, ...options })).provider;
  }

  it("sends the key named by embedding.apiKeyEnv", async () => {
    process.env[ENV] = "env-key-1";
    const seen = stubFetch();
    const p = await provider({ apiKeyEnv: ENV, baseUrl: "https://gw.example.test/v1" });
    await p.embed("hello");
    assert.equal(seen[0].authorization, "Bearer env-key-1");
  });

  it("fails closed, naming the variable, when apiKeyEnv is unset", async () => {
    const seen = stubFetch();
    const p = await provider({ apiKeyEnv: ENV, baseUrl: "https://gw.example.test/v1" });
    await assert.rejects(() => p.embed("hello"), (e) => e.message.includes(ENV));
    assert.equal(seen.length, 0, "no request without the configured key");
  });

  it("resolves embedding.apiKeyRef through the host secret store with purpose 'embedding'", async () => {
    const calls = [];
    bindHostNetwork({ secrets: { resolve: async (ref, purpose) => { calls.push([ref, purpose]); return "store-key"; } } });
    process.env[ENV] = "env-key-must-not-win";
    const seen = stubFetch();
    const p = await provider({ apiKeyRef: "emb/prod", apiKeyEnv: ENV, baseUrl: "https://gw.example.test/v1" });
    await p.embed("hello");
    assert.deepEqual(calls, [["emb/prod", "embedding"]]);
    assert.equal(seen[0].authorization, "Bearer store-key");
  });

  it("re-resolves a rotated apiKeyRef after a 401", async () => {
    let current = "key-old";
    let resolves = 0;
    bindHostNetwork({ secrets: { resolve: async () => { resolves += 1; return current; } } });
    const seen = stubFetch((n) => (n === 1 ? 401 : 200));
    const p = await provider({ apiKeyRef: "emb/prod", baseUrl: "https://gw.example.test/v1" });
    await assert.rejects(() => p.embed("hello"), (e) => e.status === 401 && !e.message.includes("key-old"));
    current = "key-new";
    await p.embed("hello");
    assert.deepEqual(seen.map((s) => s.authorization), ["Bearer key-old", "Bearer key-new"]);
    assert.equal(resolves, 2);
  });

  it("fails closed when apiKeyRef is set and the host has no secret store", async () => {
    const seen = stubFetch();
    const p = await provider({ apiKeyRef: "emb/prod", baseUrl: "https://gw.example.test/v1" });
    await assert.rejects(() => p.embed("hello"), (e) => e.code === "PLUR1BUS_SECRET_STORE_UNAVAILABLE");
    assert.equal(seen.length, 0);
  });

  it("works for the plur1bus-openai adapter too", async () => {
    process.env[ENV] = "env-key-2";
    const seen = stubFetch();
    const p = await provider({ apiKeyEnv: ENV }, {}, "plur1bus-openai");
    await p.embed("hello");
    assert.equal(seen[0].authorization, "Bearer env-key-2");
    assert.match(seen[0].url, /^https:\/\/api\.openai\.com\/v1\/embeddings$/);
  });

  it("the host-supplied remote.apiKey and the literal embedding.apiKey keep working (counter-test)", async () => {
    process.env[ENV] = "env-key-must-not-win";
    const seen = stubFetch();
    const viaHost = await provider({ apiKeyEnv: ENV, baseUrl: "https://gw.example.test/v1" }, { remote: { apiKey: "host-key" } });
    await viaHost.embed("hello");
    const viaLiteral = await provider({ apiKey: "literal-key", baseUrl: "https://gw.example.test/v1" });
    await viaLiteral.embed("hello");
    assert.deepEqual(seen.map((s) => s.authorization), ["Bearer host-key", "Bearer literal-key"]);
  });

  it("an HTTP failure still carries its status and never leaks the key (counter-test)", async () => {
    stubFetch(() => 403);
    const p = await provider({ apiKey: "literal-key", baseUrl: "https://gw.example.test/v1" });
    await assert.rejects(() => p.embed("hello"), (e) => e.status === 403 && !e.message.includes("literal-key"));
  });
});

describe("N2: a rejected legacy reranker key is resolved again", () => {
  const ENV = "_RR_LEGACY_KEY";
  afterEach(() => { delete process.env[ENV]; resetHostNetwork(); });

  /** Accepts only `good`; answers `status` otherwise. */
  function rerankServer(good, seen, failStatus = 401) {
    return (req, res) => {
      req.resume();
      req.on("end", () => {
        seen.push(req.headers.authorization);
        if (req.headers.authorization !== `Bearer ${good}`) { res.writeHead(failStatus); res.end("{}"); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ results: [{ index: 0, relevance_score: 1 }] }));
      });
    };
  }

  it("apiKeyEnv: the rotated variable is read after a 401", async () => {
    const seen = [];
    await withServer(rerankServer("key-new", seen), async (base) => {
      process.env[ENV] = "key-old";
      const reranker = new RemoteRerankerProvider({ provider: "remote", baseUrl: base, apiKeyEnv: ENV });
      await assert.rejects(reranker.rerank("q", ["d"], 1), (e) => e.status === 401);
      process.env[ENV] = "key-new";
      assert.deepEqual(await reranker.rerank("q", ["d"], 1), [{ index: 0, relevance_score: 1 }]);
      assert.deepEqual(seen, ["Bearer key-old", "Bearer key-new"]);
    });
  });

  it("credentialResolver: it is asked again after a 403", async () => {
    const seen = [];
    await withServer(rerankServer("key-new", seen, 403), async (base) => {
      let current = "key-old";
      let asked = 0;
      const reranker = new RemoteRerankerProvider({
        provider: "remote", baseUrl: base, apiKey: "ref", credentialResolver: async () => { asked += 1; return current; },
      });
      await assert.rejects(reranker.rerank("q", ["d"], 1), (e) => e.status === 403);
      current = "key-new";
      await reranker.rerank("q", ["d"], 1);
      assert.equal(asked, 2);
    });
  });

  it("the key stays cached on success and after a non-credential failure (counter-test)", async () => {
    const seen = [];
    await withServer(rerankServer("key-1", seen, 500), async (base) => {
      let asked = 0;
      const reranker = new RemoteRerankerProvider({
        provider: "remote", baseUrl: base, apiKey: "ref", credentialResolver: async () => { asked += 1; return "key-1"; },
      });
      await reranker.rerank("q", ["d"], 1);
      await reranker.rerank("q", ["d"], 1);
      assert.equal(asked, 1, "no re-resolution without a rejection");
    });
    await withServer(rerankServer("never", seen, 500), async (base) => {
      let asked = 0;
      const reranker = new RemoteRerankerProvider({
        provider: "remote", baseUrl: base, apiKey: "ref", credentialResolver: async () => { asked += 1; return "key-1"; },
      });
      await assert.rejects(reranker.rerank("q", ["d"], 1), (e) => e.status === 500);
      await assert.rejects(reranker.rerank("q", ["d"], 1), (e) => e.status === 500);
      assert.equal(asked, 1, "a 500 is not a credential rejection");
    });
  });

  it("a literal key is simply resolved again to the same value (counter-test)", async () => {
    const seen = [];
    await withServer(rerankServer("lit", seen), async (base) => {
      const reranker = new RemoteRerankerProvider({ provider: "remote", baseUrl: base, apiKey: "lit" });
      await reranker.rerank("q", ["d"], 1);
      await reranker.rerank("q", ["d"], 1);
      assert.deepEqual(seen, ["Bearer lit", "Bearer lit"]);
    });
  });
});

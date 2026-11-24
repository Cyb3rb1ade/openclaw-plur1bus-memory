// 7.20.10: Cohere-Reranker — Modell konfigurierbar (Rerank 4/5), v2-Parameter,
// Kostenbremse reranker.maxDocChars. Kein echter Netzaufruf: fetch ist ersetzt.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  CohereRerankerProvider,
  DEFAULT_COHERE_MAX_DOC_CHARS,
  normalizeCohereMaxDocChars,
  resolveCohereDocCharLimit,
  truncateCohereDocument,
} from "../lib/providers/reranker-cohere.js";
import { ChainedRerankerProvider } from "../lib/providers/reranker-chained.js";
import { normalizeRerankerConfig } from "../lib/providers/config-normalize.js";

const realFetch = globalThis.fetch;
let calls;

function fakeFetch({ ok = true, status = 200 } = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    if (!ok) return { ok: false, status, text: async () => "boom" };
    return {
      ok: true,
      json: async () => ({
        results: body.documents.map((_, index) => ({ index, relevance_score: 1 - index / 10 })).reverse().slice(0, body.top_n),
      }),
    };
  };
}

const provider = (cfg = {}) => new CohereRerankerProvider({
  credentialResolver: async () => "test-key",
  ...cfg,
});

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

describe("CohereRerankerProvider: Anfrage", () => {
  it("Default-Modell rerank-v3.5, v2-Endpunkt, kein return_documents", async () => {
    globalThis.fetch = fakeFetch();
    await provider().rerank("frage", ["a", "b"], 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.cohere.com/v2/rerank");
    assert.deepEqual(Object.keys(calls[0].body).sort(), ["documents", "model", "query", "top_n"]);
    assert.equal(calls[0].body.model, "rerank-v3.5");
    assert.equal(calls[0].body.top_n, 2);
    assert.equal(calls[0].headers.Authorization, "Bearer test-key");
  });

  it("konfiguriertes Modell (rerank-v5.0-fast) geht unverändert durch, auch über die Normalisierung", async () => {
    globalThis.fetch = fakeFetch();
    const cfg = normalizeRerankerConfig({ provider: "cohere", apiKeyEnv: "BENCH_COHERE_API_KEY", model: "rerank-v5.0-fast" });
    assert.equal(cfg.model, "rerank-v5.0-fast");
    await provider(cfg).rerank("frage", ["a"], 1);
    assert.equal(calls[0].body.model, "rerank-v5.0-fast");
  });

  it("Antwort: Indizes beziehen sich auf die Originalliste", async () => {
    globalThis.fetch = fakeFetch();
    const result = await provider({ maxDocChars: 300 }).rerank("frage", ["x".repeat(2000), "kurz"], 2);
    assert.deepEqual(result.map((r) => r.index).sort(), [0, 1]);
  });
});

describe("Kostenbremse reranker.maxDocChars", () => {
  it("Default 1400 Zeichen je Dokument bei kurzer Anfrage, kurze Dokumente unverändert", async () => {
    globalThis.fetch = fakeFetch();
    const long = `${"wort ".repeat(400)}ende`;
    await provider().rerank("kurze Frage", [long, "kurz"], 2);
    const [sentLong, sentShort] = calls[0].body.documents;
    assert.ok(sentLong.length <= DEFAULT_COHERE_MAX_DOC_CHARS && sentLong.length >= DEFAULT_COHERE_MAX_DOC_CHARS * 0.85, String(sentLong.length));
    assert.ok(long.startsWith(sentLong));
    assert.equal(sentShort, "kurz");
  });

  it("lange Anfrage verkleinert die Grenze, nie unter 300 Zeichen", () => {
    assert.equal(resolveCohereDocCharLimit("q".repeat(400), 1400), 1400);
    assert.equal(resolveCohereDocCharLimit("q".repeat(900), 1400), 900);
    assert.equal(resolveCohereDocCharLimit("q".repeat(5000), 1400), 300);
    assert.equal(resolveCohereDocCharLimit("q".repeat(5000), 200), 200, "kleineres maxDocChars bleibt Obergrenze");
    assert.equal(resolveCohereDocCharLimit("q".repeat(5000), 0), 0, "0 = keine Grenze");
  });

  it("0 schaltet die Kürzung ab", async () => {
    globalThis.fetch = fakeFetch();
    const long = "x".repeat(5000);
    await provider({ maxDocChars: 0 }).rerank("frage", [long], 1);
    assert.equal(calls[0].body.documents[0].length, 5000);
  });

  it("normalizeCohereMaxDocChars", () => {
    assert.equal(normalizeCohereMaxDocChars(undefined), 1400);
    assert.equal(normalizeCohereMaxDocChars(0), 0);
    assert.equal(normalizeCohereMaxDocChars(50), 1400, "unter 100 ungültig");
    assert.equal(normalizeCohereMaxDocChars(900.7), 900);
    assert.equal(normalizeCohereMaxDocChars("x"), 1400);
    assert.equal(normalizeRerankerConfig({ provider: "cohere", apiKeyEnv: "K", maxDocChars: 900 }).maxDocChars, 900);
    assert.equal(normalizeRerankerConfig({ provider: "cohere", apiKeyEnv: "K" }).maxDocChars, 1400);
  });

  it("truncateCohereDocument: Wortgrenze, kein halbes Surrogatpaar", () => {
    assert.equal(truncateCohereDocument("abc def ghi", 9), "abc def");
    assert.equal(truncateCohereDocument("abcdefghij", 5), "abcde");
    const emoji = `${"a".repeat(4)}😀rest`;
    const cut = truncateCohereDocument(emoji, 5);
    assert.equal(cut, "aaaa");
    assert.equal(truncateCohereDocument("kurz", 0), "kurz");
  });

  it("der lokale Rückfall bekommt die vollen Dokumente", async () => {
    globalThis.fetch = fakeFetch({ ok: false, status: 402 });
    let seen = null;
    const fallback = { id: "fake-local", async rerank(_q, docs) { seen = docs; return docs.map((_, index) => ({ index, relevance_score: 0.5 })); } };
    const chained = new ChainedRerankerProvider(provider(), fallback, { warn: () => {} });
    const long = "y".repeat(3000);
    await chained.rerank("frage", [long], 1);
    assert.equal(calls[0].body.documents[0].length <= 1400, true, "an Cohere gekürzt");
    assert.equal(seen[0].length, 3000, "Rückfall ungekürzt");
  });
});

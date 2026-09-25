import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChainedRerankerProvider } from "../lib/providers/reranker-chained.js";

const fakePrimary = {
  id: "cohere",
  rerank: async () => { throw new Error("cohere unavailable"); },
};

const fakeDocuments = ["doc a", "doc b", "doc c"];

describe("ChainedRerankerProvider mit null-Fallback", () => {
  it("fallback=null: gibt leeres Array zurück bei Primary-Fehler", async () => {
    const provider = new ChainedRerankerProvider(fakePrimary, null, null);
    const result = await provider.rerank("query", fakeDocuments, 2);
    assert.ok(Array.isArray(result), "Erwartet Array, auch bei null-Fallback");
  });

  it("fallback=null: kein lokales Modell wird geladen", async () => {
    let localModelLoaded = false;
    const trackingPrimary = {
      id: "cohere",
      rerank: async () => { throw new Error("timeout"); },
    };
    const provider = new ChainedRerankerProvider(trackingPrimary, null, {
      warn: (msg) => {
        if (msg.includes("local") || msg.includes("transformers")) localModelLoaded = true;
      },
    });
    await provider.rerank("query", fakeDocuments, 2);
    assert.strictEqual(localModelLoaded, false, "Lokales Modell wurde unerwartet geladen");
  });

  it("id-Format ist korrekt wenn fallback=null", () => {
    const provider = new ChainedRerankerProvider(fakePrimary, null, null);
    assert.ok(provider.id.startsWith("chained:cohere"), `Unerwartete id: ${provider.id}`);
  });

  it("mit echtem Fallback: Fallback wird bei Primary-Fehler genutzt", async () => {
    const fakeFallback = {
      id: "local",
      rerank: async (query, docs, topN) => docs.slice(0, topN).map((_, i) => ({ index: i, relevance_score: 1 })),
    };
    const provider = new ChainedRerankerProvider(fakePrimary, fakeFallback, null);
    const result = await provider.rerank("query", fakeDocuments, 2);
    assert.strictEqual(result.length, 2);
  });

  it("stops after the first abort: an aborted signal never invokes the fallback (fix round 1)", async () => {
    let fallbackCalls = 0;
    let warnedTryingFallback = false;
    const controller = new AbortController();
    const abortingPrimary = {
      id: "cohere",
      rerank: (_q, _d, _n, { signal } = {}) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        controller.abort(new Error("caller gone"));
      }),
    };
    const fallback = {
      id: "local",
      rerank: async () => { fallbackCalls += 1; return []; },
    };
    const provider = new ChainedRerankerProvider(abortingPrimary, fallback, {
      warn: (msg) => { if (msg.includes("Trying fallback")) warnedTryingFallback = true; },
    });
    await assert.rejects(
      () => provider.rerank("query", fakeDocuments, 2, { signal: controller.signal }),
      /caller gone/,
    );
    assert.strictEqual(fallbackCalls, 0, "fallback must never run after an abort");
    assert.strictEqual(warnedTryingFallback, false, "no 'Trying fallback' log after an abort");
  });
});

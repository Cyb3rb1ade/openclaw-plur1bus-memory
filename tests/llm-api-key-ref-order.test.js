/**
 * tests/llm-api-key-ref-order.test.js — engine-jobs audit F7.
 *
 * CHANGELOG 1.15.0: the key resolves `apiKeyRef` first, then the plain key.
 * The feature LLM routes did it the other way round (apiKey won, the ref was
 * ignored while a plain key was set), so a rotation in the host secret store
 * had no effect for a feature that still carried a literal key.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { bindHostNetwork, resetHostNetwork } from "../lib/host-network.js";
import { callLlm } from "../lib/llm-call.js";
import { resolveFeatureLlmRoute } from "../lib/llm-router.js";

function fakeOpenAI(seen) {
  return class FakeOpenAI {
    constructor(opts) { seen.push(opts.apiKey); }
    get chat() {
      return { completions: { create: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }) } };
    }
  };
}

const messages = [{ role: "user", content: "hi" }];

describe("LLM key order: apiKeyRef before apiKey (F7)", () => {
  afterEach(() => resetHostNetwork());

  it("callLlm uses the secret-store value when both are set", async () => {
    bindHostNetwork({ secrets: { resolve: async () => "from-store" } });
    const seen = [];
    await callLlm(messages, { model: "m", apiKey: "plain-literal", apiKeyRef: "openrouter/llm" }, { OpenAI: fakeOpenAI(seen) });
    assert.deepEqual(seen, ["from-store"]);
  });

  it("a set apiKeyRef that cannot be resolved fails closed, without falling back to the plain key", async () => {
    resetHostNetwork();
    const seen = [];
    await assert.rejects(
      callLlm(messages, { model: "m", apiKey: "plain-literal", apiKeyRef: "openrouter/llm" }, { OpenAI: fakeOpenAI(seen) }),
      (err) => err.code === "PLUR1BUS_SECRET_STORE_UNAVAILABLE",
    );
    assert.deepEqual(seen, [], "no client, no request");
  });

  it("a feature route carries the ref and the call resolves it, although a plain key is configured", async () => {
    const route = resolveFeatureLlmRoute({ model: "m", baseUrl: "https://llm.example.test/v1", apiKey: "plain-literal", apiKeyRef: "openrouter/llm" }, { feature: "test" });
    assert.equal(route.kind, "direct-override");
    assert.equal(route.apiKeyRef, "openrouter/llm");
    assert.equal(route.apiKey, undefined, "the plain key does not travel with a route that has a ref");
  });

  it("the legacy path stays: only apiKey set, no store needed", async () => {
    resetHostNetwork();
    const seen = [];
    await callLlm(messages, { model: "m", apiKey: "plain-literal" }, { OpenAI: fakeOpenAI(seen) });
    assert.deepEqual(seen, ["plain-literal"]);
    const route = resolveFeatureLlmRoute({ model: "m", apiKey: "plain-literal" }, { feature: "test" });
    assert.equal(route.apiKey, "plain-literal");
    assert.equal(route.apiKeyRef, undefined);
  });

  it("only the ref set: resolved per call as before", async () => {
    let current = "k1";
    bindHostNetwork({ secrets: { resolve: async () => current } });
    const seen = [];
    await callLlm(messages, { model: "m", apiKeyRef: "r" }, { OpenAI: fakeOpenAI(seen) });
    current = "k2";
    await callLlm(messages, { model: "m", apiKeyRef: "r" }, { OpenAI: fakeOpenAI(seen) });
    assert.deepEqual(seen, ["k1", "k2"]);
  });
});

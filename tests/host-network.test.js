/**
 * tests/host-network.test.js — HostServices.fetch / HostServices.secrets ports
 * (lib/host-network.js, contract 1.15.0).
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SECRET_REF_TTL_MS,
  applyHostFetchToTransformers,
  bindHostNetwork,
  createSecretRefCache,
  hostFetch,
  isHostFetchBound,
  isHostSecretStoreBound,
  normalizeApiKeyRef,
  resetHostNetwork,
  resolveHostSecret,
  sdkFetchOptions,
} from "../lib/host-network.js";

const SECRET = "sk-canary-host-network-7d1e";

afterEach(() => resetHostNetwork());

describe("bindHostNetwork", () => {
  it("rejects a non-function fetch and a store without resolve/lease", () => {
    assert.throws(() => bindHostNetwork({ fetch: "nope" }), /HostServices.fetch must be a function/);
    assert.throws(() => bindHostNetwork({ secrets: {} }), /HostServices.secrets must provide resolve/);
    assert.throws(() => bindHostNetwork({ secrets: "x" }), /HostServices.secrets/);
  });

  it("binds and unbinds; absent members mean global fetch and no store", () => {
    bindHostNetwork({ fetch: async () => new Response("{}"), secrets: { resolve: async () => SECRET } });
    assert.equal(isHostFetchBound(), true);
    assert.equal(isHostSecretStoreBound(), true);
    bindHostNetwork({});
    assert.equal(isHostFetchBound(), false);
    assert.equal(isHostSecretStoreBound(), false);
    assert.deepEqual(sdkFetchOptions(), {});
  });
});

describe("hostFetch", () => {
  it("uses the bound host fetch and passes input and init through unchanged", async () => {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("global fetch must not be used"); };
    try {
      bindHostNetwork({ fetch: async (input, init) => { calls.push({ input, init }); return new Response("ok"); } });
      const controller = new AbortController();
      const init = { method: "POST", headers: { "X-A": "1" }, body: "{}", signal: controller.signal };
      const res = await hostFetch("https://example.test/x", init);
      assert.equal(await res.text(), "ok");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].input, "https://example.test/x");
      assert.equal(calls[0].init, init);
      assert.deepEqual(Object.keys(sdkFetchOptions()), ["fetch"]);
      assert.equal(sdkFetchOptions().fetch, hostFetch);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("falls back to the global fetch at call time when nothing is bound", async () => {
    const original = globalThis.fetch;
    let seen = null;
    globalThis.fetch = async (input) => { seen = input; return new Response("g"); };
    try {
      const res = await hostFetch("https://example.test/g");
      assert.equal(await res.text(), "g");
      assert.equal(seen, "https://example.test/g");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("routes a transformers module's env.fetch through the port only when bound", () => {
    const mod = { env: { fetch: "default" } };
    applyHostFetchToTransformers(mod);
    assert.equal(mod.env.fetch, "default");
    bindHostNetwork({ fetch: async () => new Response("") });
    applyHostFetchToTransformers(mod);
    assert.equal(mod.env.fetch, hostFetch);
  });
});

describe("resolveHostSecret", () => {
  it("passes ref and purpose to resolve() and trims the value", async () => {
    const calls = [];
    bindHostNetwork({ secrets: { resolve: async (ref, purpose) => { calls.push([ref, purpose]); return `  ${SECRET}\n`; } } });
    assert.equal(await resolveHostSecret("openrouter/key", "embedding"), SECRET);
    assert.deepEqual(calls, [["openrouter/key", "embedding"]]);
  });

  it("accepts a legacy lease()-only store", async () => {
    bindHostNetwork({ secrets: { lease: async (ref) => (ref === "k" ? SECRET : "") } });
    assert.equal(await resolveHostSecret("k", "reranker"), SECRET);
  });

  it("fails closed without a store, on empty values and on store errors, never echoing a value", async () => {
    await assert.rejects(resolveHostSecret("k", "llm"), (err) => err.code === "PLUR1BUS_SECRET_STORE_UNAVAILABLE");
    bindHostNetwork({ secrets: { resolve: async () => "   " } });
    await assert.rejects(resolveHostSecret("k", "llm"), (err) => err.code === "PLUR1BUS_SECRET_REF_UNRESOLVED");
    bindHostNetwork({ secrets: { resolve: async () => { throw new Error(`store said ${SECRET}`); } } });
    await assert.rejects(resolveHostSecret("k", "llm"), (err) => {
      assert.equal(err.code, "PLUR1BUS_SECRET_REF_UNRESOLVED");
      assert.ok(!err.message.includes(SECRET));
      return true;
    });
  });

  it("validates apiKeyRef names", () => {
    assert.equal(normalizeApiKeyRef(undefined), undefined);
    assert.equal(normalizeApiKeyRef(" voyage.key "), "voyage.key");
    assert.throws(() => normalizeApiKeyRef("bad name"), /apiKeyRef must be/);
    assert.throws(() => normalizeApiKeyRef({ id: "x" }), /apiKeyRef must be/);
  });
});

describe("createSecretRefCache", () => {
  it("coalesces concurrent resolutions and re-resolves after the TTL (rotation)", async () => {
    let now = 1_000;
    let value = "key-1";
    let calls = 0;
    bindHostNetwork({ secrets: { resolve: async () => { calls += 1; await new Promise((r) => setImmediate(r)); return value; } } });
    const cache = createSecretRefCache({ ref: "k", purpose: "embedding", clock: () => now });
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    assert.equal(a, "key-1");
    assert.equal(b, "key-1");
    assert.equal(calls, 1);
    value = "key-2";
    now += SECRET_REF_TTL_MS - 1;
    assert.equal(await cache.get(), "key-1");
    now += 1;
    assert.equal(await cache.get(), "key-2");
    assert.equal(calls, 2);
  });

  it("invalidate() forces the next get() to ask the host again", async () => {
    let value = "old";
    bindHostNetwork({ secrets: { resolve: async () => value } });
    const cache = createSecretRefCache({ ref: "k", purpose: "reranker" });
    assert.equal(await cache.get(), "old");
    value = "new";
    assert.equal(await cache.get(), "old");
    cache.invalidate();
    assert.equal(await cache.get(), "new");
  });

  it("does not cache a failed resolution", async () => {
    let fail = true;
    bindHostNetwork({ secrets: { resolve: async () => { if (fail) throw new Error("down"); return "ok"; } } });
    const cache = createSecretRefCache({ ref: "k", purpose: "llm" });
    await assert.rejects(cache.get());
    fail = false;
    assert.equal(await cache.get(), "ok");
  });
});

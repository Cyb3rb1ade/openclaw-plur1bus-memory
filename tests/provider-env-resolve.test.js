import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolveApiKey } from "../lib/providers/env.js";

describe("resolveApiKey", () => {
  before(() => {
    process.env._TEST_OPENAI_KEY = "sk-openai-test";
    process.env._TEST_COHERE_KEY = "co-test-key";
  });
  after(() => {
    delete process.env._TEST_OPENAI_KEY;
    delete process.env._TEST_COHERE_KEY;
  });

  it("löst apiKeyEnv aus process.env auf (höchste Priorität)", () => {
    const key = resolveApiKey({ apiKeyEnv: "_TEST_OPENAI_KEY" });
    assert.strictEqual(key, "sk-openai-test");
  });

  it("wirft wenn apiKeyEnv gesetzt aber Env-Var fehlt", () => {
    assert.throws(
      () => resolveApiKey({ apiKeyEnv: "_NONEXISTENT_VAR_XYZ" }),
      /Env var _NONEXISTENT_VAR_XYZ not set/
    );
  });

  it("wirft bei leerem Env-Var mit Label in der Fehlermeldung", () => {
    assert.throws(
      () => resolveApiKey({ apiKeyEnv: "_NONEXISTENT_VAR_XYZ" }, { label: "OpenAI embedding" }),
      /OpenAI embedding/
    );
  });

  it("löst apiKey als Literal auf wenn apiKeyEnv nicht gesetzt", () => {
    const key = resolveApiKey({ apiKey: "sk-literal-key" });
    assert.strictEqual(key, "sk-literal-key");
  });

  it("apiKeyEnv hat Vorrang vor apiKey", () => {
    const key = resolveApiKey({ apiKeyEnv: "_TEST_OPENAI_KEY", apiKey: "sk-should-not-be-used" });
    assert.strictEqual(key, "sk-openai-test");
  });

  it("defaultEnv wird genutzt wenn apiKeyEnv + apiKey beide fehlen", () => {
    const key = resolveApiKey({}, { defaultEnv: "_TEST_OPENAI_KEY" });
    assert.strictEqual(key, "sk-openai-test");
  });

  it("defaultEnv='_TEST_COHERE_KEY' → Cohere-Key, NICHT OpenAI-Key", () => {
    const key = resolveApiKey({}, { defaultEnv: "_TEST_COHERE_KEY" });
    assert.strictEqual(key, "co-test-key");
    assert.notStrictEqual(key, "sk-openai-test");
  });

  it("KEIN globaler OPENAI-Fallback ohne defaultEnv — wirft statt OPENAI_API_KEY zu raten", () => {
    // Auch wenn OPENAI_API_KEY in process.env wäre: ohne defaultEnv kein Fallback
    assert.throws(
      () => resolveApiKey({}),
      /no API key/i
    );
  });

  it("optional=true: gibt undefined wenn kein Key gefunden", () => {
    const key = resolveApiKey({}, { optional: true });
    assert.strictEqual(key, undefined);
  });

  it("optional=true mit defaultEnv: gibt undefined wenn Env-Var fehlt (kein Wurf)", () => {
    const key = resolveApiKey({}, { defaultEnv: "_NONEXISTENT_VAR_XYZ", optional: true });
    assert.strictEqual(key, undefined);
  });
});

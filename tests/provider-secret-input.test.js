import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createConfiguredSecretInputResolver,
  secretInputSourceKind,
} from "../lib/providers/secret-input.js";

const CONFIG_PATH = "plugins.entries.memory-lancedb-namespaced.config.embedding.apiKey";

describe("provider SecretInput runtime", () => {
  it("resolves canonical SecretRefs only through the injected OpenClaw capability", async () => {
    const calls = [];
    const reference = { source: "store", provider: "lab", id: "PLUR1BUS_EMBEDDING_KEY" };
    const config = {
      plugins: {
        entries: {
          "memory-lancedb-namespaced": { config: { embedding: { apiKey: reference } } },
        },
      },
    };
    const resolveCredential = createConfiguredSecretInputResolver({
      getConfig: () => config,
      env: Object.freeze({}),
      loadSecretRuntime: async () => ({
        resolveConfiguredSecretInputString: async (params) => {
          calls.push(params);
          return { value: "resolved-secret-sentinel" };
        },
      }),
    });

    assert.equal(await resolveCredential({ value: reference, path: CONFIG_PATH }), "resolved-secret-sentinel");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].config, config);
    assert.equal(calls[0].path, CONFIG_PATH);
    assert.equal(calls[0].value, reference);
    assert.equal(calls[0].unresolvedReasonStyle, "generic");
  });

  it("preserves backward literal and allowlisted environment strings without loading OpenClaw", async () => {
    let loads = 0;
    const resolveCredential = createConfiguredSecretInputResolver({
      getConfig: () => ({}),
      env: { OPENAI_API_KEY: "environment-secret-sentinel" },
      loadSecretRuntime: async () => {
        loads += 1;
        throw new Error("must not load");
      },
    });

    assert.equal(await resolveCredential({ value: "literal-secret-sentinel", path: CONFIG_PATH }), "literal-secret-sentinel");
    assert.equal(await resolveCredential({ value: "${OPENAI_API_KEY}", path: CONFIG_PATH }), "environment-secret-sentinel");
    assert.equal(loads, 0);
  });

  it("supports legacy apiKeyEnv precedence and an explicit default environment fallback", async () => {
    const resolveCredential = createConfiguredSecretInputResolver({
      getConfig: () => ({}),
      env: {
        PLUR1BUS_OPENAI_API_KEY: "preferred-secret-sentinel",
        OPENAI_API_KEY: "fallback-secret-sentinel",
      },
      loadSecretRuntime: async () => { throw new Error("must not load"); },
    });

    assert.equal(await resolveCredential({
      value: "ignored-literal",
      apiKeyEnv: "PLUR1BUS_OPENAI_API_KEY",
      defaultEnv: "OPENAI_API_KEY",
      path: CONFIG_PATH,
    }), "preferred-secret-sentinel");
    assert.equal(await resolveCredential({ defaultEnv: "OPENAI_API_KEY", path: CONFIG_PATH }), "fallback-secret-sentinel");
  });

  it("fails closed without stringifying SecretRefs or exposing ids and resolved values", async () => {
    const reference = { source: "exec", provider: "vault", id: "private/credential/id" };
    const secret = "resolved-secret-must-not-leak";
    const resolveCredential = createConfiguredSecretInputResolver({
      getConfig: () => ({}),
      loadSecretRuntime: async () => ({
        resolveConfiguredSecretInputString: async () => ({
          unresolvedRefReason: `failed ${reference.id} ${secret}`,
        }),
      }),
    });

    await assert.rejects(
      resolveCredential({ value: reference, path: CONFIG_PATH }),
      (error) => {
        assert.equal(error.code, "PLUR1BUS_SECRET_INPUT_UNRESOLVED");
        assert.match(error.message, /embedding\.apiKey/);
        assert.doesNotMatch(error.message, /private\/credential\/id/);
        assert.doesNotMatch(error.message, /resolved-secret-must-not-leak/);
        assert.doesNotMatch(error.message, /\[object Object\]/);
        return true;
      },
    );
  });

  it("projects only non-sensitive source kinds", () => {
    assert.equal(secretInputSourceKind(undefined), "unset");
    assert.equal(secretInputSourceKind("literal-secret"), "configured");
    for (const source of ["env", "store", "file", "exec"]) {
      assert.deepStrictEqual(
        secretInputSourceKind({ source, provider: "private-provider", id: "private-id" }),
        source,
      );
    }
  });
});

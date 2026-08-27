import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { validatePluginConfig } from "../lib/setup/config-contract.js";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
const credentialPaths = Object.freeze([
  "embedding.apiKey",
  "embedding.fallback.apiKey",
  "reranker.apiKey",
  "merging.apiKey",
  "schicht15.apiKey",
  "skillMiner.apiKey",
  "criticalPush.apiKey",
  "emotion.t3.apiKey",
]);

describe("PLUR1BUS SecretInput manifest", () => {
  it("declares every credential path as a sensitive OpenClaw SecretInput", () => {
    assert.deepStrictEqual(
      manifest.configContracts.secretInputs.paths,
      credentialPaths.map((path) => ({ path, expected: "string" })),
    );
    for (const path of credentialPaths) {
      assert.equal(manifest.uiHints[path].sensitive, true, path);
      assert.equal(manifest.uiHints[path].advanced, true, path);
    }
  });

  it("accepts canonical env, store, file, and exec references", () => {
    for (const apiKey of [
      { source: "env", provider: "default", id: "PLUR1BUS_EMBEDDING_KEY" },
      { source: "store", provider: "default", id: "PLUR1BUS_EMBEDDING_KEY" },
      { source: "file", provider: "mounted-json", id: "/embedding/apiKey" },
      { source: "exec", provider: "vault", id: "plur1bus/embedding" },
    ]) {
      assert.deepStrictEqual(validatePluginConfig({ embedding: { apiKey } }).embedding.apiKey, apiKey);
    }
  });

  it("keeps backward strings but rejects malformed or open SecretRef objects", () => {
    assert.equal(validatePluginConfig({ embedding: { apiKey: "${OPENAI_API_KEY}" } }).embedding.apiKey, "${OPENAI_API_KEY}");
    for (const apiKey of [
      { source: "env", provider: "default", id: "../bad" },
      { source: "file", provider: "mounted-json", id: "relative" },
      { source: "exec", provider: "vault", id: "a/../b" },
      { source: "store", provider: "Default", id: "PLUR1BUS_KEY" },
      { source: "env", provider: "default", id: "PLUR1BUS_KEY", value: "secret" },
      { source: "env", id: "PLUR1BUS_KEY" },
    ]) {
      assert.throws(
        () => validatePluginConfig({ embedding: { apiKey } }),
        (error) => error?.configPath?.startsWith("plugins.entries.memory-lancedb-namespaced.config.embedding.apiKey"),
      );
    }
  });
});

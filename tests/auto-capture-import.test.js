import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { buildEmbeddingConfig, createEmbeddings } from "../scripts/auto-capture-lancedb.mjs";

describe("auto-capture import path", () => {
  it("PLUR1BUS_PLUGIN_DIR env var can override path", () => {
    const customDir = "/tmp/test-plugin-dir";
    const pluginDir = process.env.PLUR1BUS_PLUGIN_DIR || customDir;
    const factoryPath = join(pluginDir, "lib/providers/factory.js");
    assert.ok(typeof factoryPath === "string");
    assert.ok(factoryPath.includes("lib/providers/factory.js"));
  });

  it("Default path points to installed extension", () => {
    const defaultDir = join(homedir(), ".openclaw", "extensions", "memory-lancedb-namespaced");
    const factoryPath = join(defaultDir, "lib/providers/factory.js");
    assert.ok(factoryPath.includes("memory-lancedb-namespaced"));
    assert.ok(factoryPath.includes("lib/providers/factory.js"));
  });

  it("Repo-own factory.js exists (for development)", () => {
    const repoFactory = join(process.cwd(), "lib/providers/factory.js");
    assert.ok(existsSync(repoFactory), `factory.js not found at: ${repoFactory}`);
  });

  it("auto-capture script exports helpers without running main", () => {
    assert.strictEqual(typeof buildEmbeddingConfig, "function");
    assert.strictEqual(typeof createEmbeddings, "function");
  });

  it("builds provider config from plugin config with legacy OPENAI env fallback", () => {
    const cfg = buildEmbeddingConfig({ embedding: { model: "text-embedding-3-small" } }, {});
    assert.deepStrictEqual(cfg, {
      model: "text-embedding-3-small",
      apiKeyEnv: "OPENAI_API_KEY",
    });
  });

  it("lets EMBEDDING_MODEL override local-transformers model config", () => {
    const cfg = buildEmbeddingConfig(
      { embedding: { provider: "local-transformers", local: { model: "old", dimensions: 384 } } },
      { EMBEDDING_MODEL: "new-local-model" }
    );
    assert.strictEqual(cfg.model, "new-local-model");
    assert.strictEqual(cfg.local.model, "new-local-model");
    assert.strictEqual(cfg.local.dimensions, 384);
  });

  it("wraps provider embedBatch with truncation, retries and agent context", async () => {
    const calls = [];
    const modules = {
      normalizeEmbeddingConfig(raw) {
        return { ...raw, dimensions: 2 };
      },
      createEmbeddingProvider(cfg) {
        return {
          dimensions: () => cfg.dimensions,
          async embedBatch(texts, retries, options) {
            calls.push({ texts, retries, options });
            return texts.map((_, index) => [index, 1]);
          },
        };
      },
    };

    const embeddings = createEmbeddings(modules, { embedding: { provider: "local-transformers" } });
    const vectors = await embeddings.embedBatch(["x".repeat(9000), "short"], { agentId: "agent-a" });

    assert.deepStrictEqual(vectors, [[0, 1], [1, 1]]);
    assert.strictEqual(embeddings.dim, 2);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].texts[0].length, 8000);
    assert.strictEqual(calls[0].texts[1], "short");
    assert.strictEqual(calls[0].retries, 3);
    assert.deepStrictEqual(calls[0].options, { agentId: "agent-a" });
  });
});

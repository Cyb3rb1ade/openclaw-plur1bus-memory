import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import {
  buildEmbeddingConfig,
  createEmbeddings,
  filterPreparedForStorageByBatchDedup,
  findExistingDuplicateIndexes,
  readLinesFromOffset,
  readSessionLinesSinceOffset,
} from "../scripts/auto-capture-lancedb.mjs";

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
    assert.strictEqual(typeof filterPreparedForStorageByBatchDedup, "function");
    assert.strictEqual(typeof findExistingDuplicateIndexes, "function");
    assert.strictEqual(typeof readLinesFromOffset, "function");
    assert.strictEqual(typeof readSessionLinesSinceOffset, "function");
  });

  it("streams session slices instead of reading whole capture files", () => {
    const source = readFileSync(join(process.cwd(), "scripts", "auto-capture-lancedb.mjs"), "utf8");
    assert.doesNotMatch(source, /readFileSync\(file\.path,\s*["']utf8["']\)/);
    assert.match(source, /createReadStream/);
  });

  it("reads only complete lines appended after a byte offset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-capture-offset-"));
    const path = join(dir, "session.jsonl");
    const existing = `${JSON.stringify({ message: { role: "user", content: "old memory text" } })}\n`;
    const appendedLines = [
      JSON.stringify({ message: { role: "user", content: "new memory text" } }),
      JSON.stringify({ message: { role: "assistant", content: "new answer text" } }),
    ];
    writeFileSync(path, existing + appendedLines.join("\n") + "\n", "utf8");

    const lines = await readLinesFromOffset(path, Buffer.byteLength(existing));

    assert.deepStrictEqual(lines, appendedLines);
  });

  it("does not advance past a partial trailing JSONL record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-capture-partial-"));
    const path = join(dir, "session.jsonl");
    const existing = `${JSON.stringify({ message: { role: "user", content: "old memory text" } })}\n`;
    const complete = `${JSON.stringify({ message: { role: "user", content: "complete memory text" } })}\n`;
    const partial = JSON.stringify({ message: { role: "assistant", content: "partial answer text" } }).slice(0, -3);
    writeFileSync(path, existing + complete + partial, "utf8");

    const result = await readSessionLinesSinceOffset(path, Buffer.byteLength(existing));

    assert.deepStrictEqual(result.lines, [complete.trimEnd()]);
    assert.strictEqual(result.nextOffset, Buffer.byteLength(existing + complete));
  });

  it("batches LanceDB inserts after duplicate checks", () => {
    const source = readFileSync(join(process.cwd(), "scripts", "auto-capture-lancedb.mjs"), "utf8");
    assert.match(source, /const rowsToAdd = \[\]/);
    assert.match(source, /await table\.add\(rowsToAdd\)/);
  });

  it("uses one ANN multi-query to find existing duplicate candidates", async () => {
    const calls = { query: 0, nearestTo: [], addQueryVector: [], limit: [], toArray: 0, search: 0 };
    const table = {
      query() {
        calls.query++;
        return {
          nearestTo(vector) {
            calls.nearestTo.push(vector);
            return this;
          },
          addQueryVector(vector) {
            calls.addQueryVector.push(vector);
            return this;
          },
          limit(value) {
            calls.limit.push(value);
            return this;
          },
          async toArray() {
            calls.toArray++;
            return [{ query_index: 1, _distance: 0 }];
          },
        };
      },
      search() {
        calls.search++;
        throw new Error("per-candidate search should not be used");
      },
    };

    const duplicates = await findExistingDuplicateIndexes(table, [[1, 0], [0, 1], [0.5, 0.5]], {
      duplicateThreshold: 0.95,
      distanceToScoreFn: (distance) => 1 / (1 + distance),
    });

    assert.deepStrictEqual([...duplicates], [1]);
    assert.strictEqual(calls.query, 1);
    assert.deepStrictEqual(calls.nearestTo, [[1, 0]]);
    assert.deepStrictEqual(calls.addQueryVector, [[0, 1], [0.5, 0.5]]);
    assert.deepStrictEqual(calls.limit, [1]);
    assert.strictEqual(calls.toArray, 1);
    assert.strictEqual(calls.search, 0);
  });

  it("filters existing and in-batch duplicates before storage", async () => {
    const table = {
      query() {
        return {
          nearestTo() { return this; },
          addQueryVector() { return this; },
          limit() { return this; },
          async toArray() {
            return [{ query_index: 2, _distance: 0 }];
          },
        };
      },
    };
    const prepared = [
      { text: "keep original", vector: [1, 0] },
      { text: "skip same batch duplicate", vector: [1, 0] },
      { text: "skip existing duplicate", vector: [0, 1] },
      { text: "keep distinct", vector: [0, 0.1] },
    ];

    const filtered = await filterPreparedForStorageByBatchDedup(table, prepared, {
      duplicateThreshold: 0.95,
      distanceToScoreFn: (distance) => 1 / (1 + distance),
    });

    assert.deepStrictEqual(filtered.map((entry) => entry.text), ["keep original", "keep distinct"]);
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

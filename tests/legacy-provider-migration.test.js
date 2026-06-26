import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyLegacyProviderDefaults,
  hasExistingLanceMemoryData,
  hasExistingLanceMemoryTables,
} from "../lib/providers/legacy-provider-migration.js";

describe("legacy provider migration", () => {
  it("treats missing and table-free LanceDB roots as switchable", () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-provider-empty-"));
    mkdirSync(join(root, "main"), { recursive: true });

    assert.equal(hasExistingLanceMemoryTables(join(root, "missing")), false);
    assert.equal(hasExistingLanceMemoryTables(root), false);
  });

  it("detects existing memory tables without opening LanceDB", () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-provider-table-"));
    mkdirSync(join(root, "main", "memories.lance"), { recursive: true });

    assert.equal(hasExistingLanceMemoryTables(root), true);
    assert.equal(hasExistingLanceMemoryData(root), false);
  });

  it("detects existing LanceDB data fragments without opening LanceDB", () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-provider-data-"));
    mkdirSync(join(root, "main", "memories.lance", "data"), { recursive: true });
    mkdirSync(join(root, "main", "memories.lance", "_versions"), { recursive: true });
    const dataFile = join(root, "main", "memories.lance", "data", "fragment.lance");
    writeFileSync(dataFile, "fragment");

    assert.equal(hasExistingLanceMemoryTables(root), true);
    assert.equal(hasExistingLanceMemoryData(root), true);
  });

  it("treats empty LanceDB table directories as switchable", () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-provider-empty-table-"));
    mkdirSync(join(root, "main", "memories.lance"), { recursive: true });

    const result = applyLegacyProviderDefaults(
      {
        embedding: { provider: "openai" },
        reranker: { provider: "disabled", enabled: false },
      },
      { baseDbPath: root }
    );

    assert.equal(result.changed, true);
    assert.equal(result.config.embedding.provider, "local-transformers");
    assert.equal(result.config.reranker.provider, "local-transformers");
  });

  it("treats PLUR1BUS schema-seed-only LanceDB tables as switchable", async () => {
    const lancedb = await import("@lancedb/lancedb");
    const root = mkdtempSync(join(tmpdir(), "plur1bus-provider-schema-only-"));
    const db = await lancedb.connect(join(root, "main"));
    const table = await db.createTable("memories", [
      { id: "__schema__", text: "", vector: [0, 0, 0], importance: 0 },
    ], { mode: "overwrite" });
    await table.delete('id = "__schema__"');

    const result = applyLegacyProviderDefaults(
      {
        embedding: { provider: "openai" },
        reranker: { provider: "disabled", enabled: false },
      },
      { baseDbPath: root }
    );

    assert.equal(await table.countRows(), 0);
    assert.equal(result.changed, true);
    assert.equal(result.config.embedding.provider, "local-transformers");
    assert.equal(result.config.reranker.provider, "local-transformers");
  });

  it("does not switch a one-fragment real LanceDB table with a later delete transaction", async () => {
    const lancedb = await import("@lancedb/lancedb");
    const root = mkdtempSync(join(tmpdir(), "plur1bus-provider-one-fragment-real-"));
    const db = await lancedb.connect(join(root, "main"));
    const table = await db.createTable("memories", [
      { id: "real-1", text: "real memory", vector: [0.1, 0.2, 0.3], importance: 1 },
    ], { mode: "overwrite" });
    await table.delete('id = "missing"');
    const existing = {
      embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
      reranker: { provider: "disabled", enabled: false },
    };

    const result = applyLegacyProviderDefaults(existing, { baseDbPath: root });

    assert.equal(await table.countRows(), 1);
    assert.equal(result.changed, false);
    assert.deepEqual(result.config, existing);
  });

  it("moves legacy no-provider installs with no tables to local embedding and reranker", () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-provider-legacy-"));
    const result = applyLegacyProviderDefaults(
      {
        reranker: { enabled: false },
      },
      { baseDbPath: root }
    );

    assert.equal(result.changed, true);
    assert.equal(result.config.embedding.provider, "local-transformers");
    assert.equal(result.config.embedding.local.model, "intfloat/multilingual-e5-small");
    assert.equal(result.config.embedding.local.dimensions, 384);
    assert.equal(result.config.reranker.provider, "local-transformers");
    assert.equal(result.config.reranker.enabled, true);
    assert.equal(result.config.reranker.local.model, "BAAI/bge-reranker-v2-m3");
  });

  it("does not switch providers once a memory table has data", () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-provider-locked-"));
    mkdirSync(join(root, "main", "memories.lance", "data"), { recursive: true });
    writeFileSync(join(root, "main", "memories.lance", "data", "fragment.lance"), "fragment");
    const existing = {
      embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
      reranker: { provider: "disabled", enabled: false },
    };

    const result = applyLegacyProviderDefaults(existing, { baseDbPath: root });

    assert.equal(result.changed, false);
    assert.deepEqual(result.config, existing);
  });

  it("preserves explicit remote provider credentials on empty installs", () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-provider-explicit-"));
    const existing = {
      embedding: { provider: "openai", apiKeyEnv: "OPENAI_API_KEY", model: "text-embedding-3-large", dimensions: 3072 },
      reranker: { provider: "cohere", apiKeyEnv: "COHERE_API_KEY", enabled: true },
    };

    const result = applyLegacyProviderDefaults(existing, { baseDbPath: root });

    assert.equal(result.changed, false);
    assert.deepEqual(result.config, existing);
  });
});

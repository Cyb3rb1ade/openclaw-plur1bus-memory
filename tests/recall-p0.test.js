/**
 * tests/recall-p0.test.js
 *
 * P0 Critical Fixes: tokenize acronyms, dedupJaccard 0.78,
 * canonicalMaxItems 5, maxPromptMemories (topN) 12.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { tokenize } from "../lib/text-utils.js";
import { dedupResults, runRecallPipeline } from "../lib/recall-pipeline.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("P0 tokenize acronyms", () => {
  it("preserves 2-3 letter tech acronyms: AI, API, GPU, SQL, CSS, HTML, IoT", () => {
    const tokens = tokenize("AI and API for GPU SQL CSS HTML IoT");
    assert.ok(tokens.has("ai"), "expected 'ai' token");
    assert.ok(tokens.has("api"), "expected 'api' token");
    assert.ok(tokens.has("gpu"), "expected 'gpu' token");
    assert.ok(tokens.has("sql"), "expected 'sql' token");
    assert.ok(tokens.has("css"), "expected 'css' token");
    assert.ok(tokens.has("html"), "expected 'html' token");
    assert.ok(tokens.has("iot"), "expected 'iot' token");
  });

  it("still filters out 1-character tokens and noise", () => {
    const tokens = tokenize("A B C x y z ! @ #");
    assert.ok(!tokens.has("a"), "1-char token 'a' should be filtered");
    assert.ok(!tokens.has("x"), "1-char token 'x' should be filtered");
    assert.ok(!tokens.has("!"), "punctuation should be filtered");
  });

  it("preserves normal 4+ letter words alongside acronyms", () => {
    const tokens = tokenize("AI helps with machine learning");
    assert.ok(tokens.has("ai"));
    assert.ok(tokens.has("helps"));
    assert.ok(tokens.has("machine"));
    assert.ok(tokens.has("learning"));
  });
});

describe("P0 dedupJaccard default", () => {
  it("dedupResults keeps moderately similar results when default threshold is 0.78", () => {
    // Two results with ~0.70 Jaccard similarity (not 0.78+)
    const r1 = { entry: { id: "a", text: "AI machine learning project with Python" } };
    const r2 = { entry: { id: "b", text: "AI machine learning project with JavaScript" } };
    const results = [r1, r2];
    const deduped = dedupResults(results, 10);
    // With threshold 0.78 these should both stay; with 0.6 the second would be dropped.
    assert.strictEqual(deduped.length, 2, "expected both results to survive with threshold 0.78");
  });
});

describe("P0 recall defaults", () => {
  const makeDbTable = (rows) => ({
    vectorSearch: () => ({
      limit: () => ({
        toArray: async () => rows,
      }),
    }),
  });

  const embeddings = {
    dim: 3,
    embed: async () => [0.1, 0.2, 0.3],
    embedQuery: async () => [0.1, 0.2, 0.3],
  };

  const makeRows = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: String.fromCharCode(97 + i),
      text: `memory ${i + 1}`,
      _distance: i * 0.01,
      importance: 0.5,
    }));

  it("runRecallPipeline returns up to 12 memories by default (maxPromptMemories)", async () => {
    const rows = makeRows(15);
    const { memories } = await runRecallPipeline({
      query: "test",
      dbTable: makeDbTable(rows),
      embeddings,
      canonicalEnabled: false,
      dedupEnabled: false,
      logger: { warn: () => {}, info: () => {} },
      // topN intentionally omitted → should default to 12
    });
    assert.strictEqual(memories.length, 12, "expected default topN=12");
  });

  it("runRecallPipeline allows up to 5 canonical items by default (canonicalMaxItems)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-canonical-"));
    try {
      const memoryDir = join(tmpDir, "memory");
      mkdirSync(memoryDir, { recursive: true });
      const sections = Array.from({ length: 10 }, (_, i) =>
        `# Section ${i + 1}\n\nThis is canonical content number ${i + 1} with more than thirty characters to pass the filter.\n`
      );
      writeFileSync(join(memoryDir, "KNOWLEDGE.md"), sections.join(""), "utf8");

      const rows = makeRows(20);
      const { memories, canonical } = await runRecallPipeline({
        query: "test",
        dbTable: makeDbTable(rows),
        embeddings,
        workspaceDir: tmpDir,
        canonicalEnabled: true,
        canonicalMinScore: -1, // force all rows to qualify as canonical
        dedupEnabled: false,
        logger: { warn: () => {}, info: () => {} },
        // canonicalMaxItems intentionally omitted → should default to 5
      });
      // canonical items are returned separately; callers prepend them to vector results.
      assert.ok(
        canonical.length >= 5,
        `expected at least 5 canonical memories, got ${canonical.length}`
      );
      // vector results are capped to the remaining slots.
      assert.ok(
        memories.length <= 12,
        `expected at most 12 vector memories, got ${memories.length}`
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

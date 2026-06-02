import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMemoryCompaction } from "../lib/jobs/memory-compaction.js";

function mockVector(dim, seed) {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed + i * 0.1);
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / (len || 1));
}

function createMockTable(rows) {
  const data = [...rows];
  return {
    query: () => ({
      limit: () => ({
        toArray: async () => data,
      }),
    }),
    update: async ({ where, values }) => {
      const idMatch = where.match(/id = '([^']+)'/);
      if (idMatch) {
        const idx = data.findIndex(r => r.id === idMatch[1]);
        if (idx >= 0) data[idx] = { ...data[idx], ...values };
      }
    },
    add: async (items) => {
      for (const item of items) data.push(item);
    },
  };
}

function createMockDb(table) {
  return { table, dbPath: "mock", purgeExpired: async () => {} };
}

function createMockNeoStore() {
  const state = {};
  return {
    paths: { runs: "/dev/null" },
    readRunState: () => state,
    markRunCompleted: (key, meta) => { state[key] = meta; },
  };
}

describe("memory-compaction", () => {
  it("findet und aliast identische Duplikate", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "compaction-test-"));
    try {
      const dim = 10;
      const v = mockVector(dim, 1);
      const rows = [
        { id: "a", text: "Docker setup", vector: v, createdAt: Date.now(), importance: 0.7, category: "fact" },
        { id: "b", text: "Docker setup", vector: v, createdAt: Date.now() - 1000, importance: 0.5, category: "fact" },
      ];
      const table = createMockTable(rows);
      const result = await runMemoryCompaction(createMockDb(table), {
        similarityThreshold: 0.99,
        lookbackDays: 30,
        dryRun: false,
        workspaceDir: tmpDir,
        logger: { info: () => {}, warn: () => {} },
        neoStore: createMockNeoStore(),
      });
      assert.strictEqual(result.deleted, 1);
      assert.strictEqual(result.merged, 0);
      assert.strictEqual(result.compacted, 1);
      // Non-destructive: Rows still exist, but aliases were written
      assert.strictEqual(rows.length, 2);
      const aliasPath = join(tmpDir, ".adaptive-learning", "memory-aliases.jsonl");
      assert.strictEqual(existsSync(aliasPath), true);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("dry-run ändert nichts", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "compaction-test-"));
    try {
      const dim = 10;
      const v = mockVector(dim, 1);
      const rows = [
        { id: "a", text: "Same", vector: v, createdAt: Date.now() },
        { id: "b", text: "Same", vector: v, createdAt: Date.now() - 1000 },
      ];
      const table = createMockTable(rows);
      const result = await runMemoryCompaction(createMockDb(table), {
        similarityThreshold: 0.99,
        dryRun: true,
        workspaceDir: tmpDir,
        logger: { info: () => {}, warn: () => {} },
      });
      assert.strictEqual(result.dryRun, true);
      assert.strictEqual(rows.length, 2);
      const aliasPath = join(tmpDir, ".adaptive-learning", "memory-aliases.jsonl");
      assert.strictEqual(existsSync(aliasPath), false);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("ignoriert Memories außerhalb lookbackDays", async () => {
    const dim = 10;
    const v = mockVector(dim, 1);
    const old = Date.now() - 60 * 86400000;
    const rows = [
      { id: "a", text: "Old", vector: v, createdAt: old },
      { id: "b", text: "Old", vector: v, createdAt: old + 1000 },
    ];
    const table = createMockTable(rows);
    const result = await runMemoryCompaction(createMockDb(table), {
      similarityThreshold: 0.99,
      lookbackDays: 30,
      logger: { info: () => {}, warn: () => {} },
    });
    assert.strictEqual(result.note, "too_few_candidates");
  });

  it("schließt core memories von der Kompaktierung aus", async () => {
    const dim = 10;
    const v = mockVector(dim, 1);
    const rows = [
      { id: "core", text: "Never forget this deep moment", vector: v, createdAt: Date.now(), memoryClass: "core", neverForget: 1 },
      { id: "ordinary", text: "Never forget this deep moment", vector: v, createdAt: Date.now() - 1000 },
    ];
    const table = createMockTable(rows);
    const result = await runMemoryCompaction(createMockDb(table), {
      similarityThreshold: 0.99,
      dryRun: false,
      logger: { info: () => {}, warn: () => {} },
    });
    assert.strictEqual(result.note, "too_few_candidates");
    assert.strictEqual(rows.find(r => r.id === "core")?.status, undefined);
    assert.strictEqual(rows.find(r => r.id === "ordinary")?.status, undefined);
  });

  it("markiert widersprüchliche Memories als Konflikt", async () => {
    const dim = 10;
    const v = mockVector(dim, 1);
    const rows = [
      { id: "a", text: "Use npm", vector: v, createdAt: Date.now() },
      { id: "b", text: "Use pnpm exclusively", vector: v, createdAt: Date.now() - 1000 },
    ];
    const table = createMockTable(rows);
    const result = await runMemoryCompaction(createMockDb(table), {
      similarityThreshold: 0.99,
      dryRun: true,
      logger: { info: () => {}, warn: () => {} },
    });
    assert.ok(result.compacted > 0);
  });

  it("merged kompatible Memories via LLM", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "compaction-test-"));
    try {
      const dim = 10;
      const v = mockVector(dim, 1);
      const rows = [
        { id: "a", text: "Docker setup requires compose", vector: v, createdAt: Date.now() },
        { id: "b", text: "Docker setup requires compose and networks", vector: v, createdAt: Date.now() - 1000 },
      ];
      const table = createMockTable(rows);
      const mockLlm = async () => JSON.stringify({ merge: true, reason: "compatible", mergedText: "Docker setup requires compose and networks" });
      const result = await runMemoryCompaction(createMockDb(table), {
        similarityThreshold: 0.99,
        dryRun: true,
        workspaceDir: tmpDir,
        llmCfg: { model: "test" },
        callLlm: mockLlm,
        logger: { info: () => {}, warn: () => {} },
      });
      assert.ok(result.compacted > 0);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("respektiert maxBatchSize", async () => {
    const dim = 10;
    const rows = [];
    for (let i = 0; i < 10; i++) {
      rows.push({ id: `m${i}`, text: `Memory ${i}`, vector: mockVector(dim, i), createdAt: Date.now() - i * 1000 });
    }
    const table = createMockTable(rows);
    const result = await runMemoryCompaction(createMockDb(table), {
      similarityThreshold: 0.95,
      maxBatchSize: 5,
      logger: { info: () => {}, warn: () => {} },
    });
    assert.strictEqual(result.candidates, 5);
  });
});

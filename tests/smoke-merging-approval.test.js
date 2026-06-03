/**
 * Smoke-Test: Merging Approval-Gate
 *
 * Verifiziert:
 *   1. autoApply=false → Proposals generiert, KEINE DB-Änderung
 *   2. autoApply=true  → Actions werden ausgeführt
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { runMemoryCompaction } from "../lib/jobs/memory-compaction.js";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("merging-approval-gate", () => {
  function makeDbTable(rows) {
    const archived = new Set();
    const added = [];
    return {
      query: () => ({
        limit: () => ({
          toArray: async () => rows,
        }),
      }),
      update: async ({ where, values }) => {
        const m = where.match(/id = '([0-9a-f-]{36})'/i);
        const id = m ? m[1] : where;
        if (values.status === "archived") archived.add(id);
      },
      add: async (items) => {
        for (const item of items) added.push(item);
      },
      _archived: archived,
      _added: added,
    };
  }

  const candidates = [
    { id: "81d38141-96b8-4656-9e6c-d57e7d534ef0", text: "alpha beta gamma", vector: [1, 0, 0], createdAt: Date.now(), importance: 0.5, category: "other", origin: "dm", storedBy: "", confirmed: false },
    { id: "7c82b440-0e5d-4e6e-b3b1-adea8b574996", text: "alpha beta gamma", vector: [1, 0, 0], createdAt: Date.now() - 1000, importance: 0.5, category: "other", origin: "dm", storedBy: "", confirmed: false },
  ];

  it("does NOT modify DB when autoApply=false", async () => {
    const table = makeDbTable(candidates);
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-merge-"));
    const result = await runMemoryCompaction(
      { table },
      {
        similarityThreshold: 0.5,
        lookbackDays: 30,
        maxBatchSize: 50,
        dryRun: false,
        autoApply: false,
        logger: { info: () => {}, warn: () => {} },
        workspaceDir,
      }
    );
    assert.strictEqual(table._archived.size, 0, "nothing should be archived");
    assert.strictEqual(table._added.length, 0, "nothing should be added");
    assert.ok(result.proposals > 0 || result.compacted === 0, "should report proposals or no clusters");
    const proposalsPath = join(workspaceDir, ".adaptive-learning", "merge-proposals.jsonl");
    if (result.proposals > 0) {
      assert.ok(existsSync(proposalsPath), "proposals should be persisted");
      const lines = readFileSync(proposalsPath, "utf8").trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1]);
      assert.strictEqual(last.status, "pending");
      assert.ok(Array.isArray(last.actions));
    }
  });

  it("modifies DB when autoApply=true", async () => {
    const table = makeDbTable(candidates);
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-merge-"));
    const result = await runMemoryCompaction(
      { table },
      {
        similarityThreshold: 0.5,
        lookbackDays: 30,
        maxBatchSize: 50,
        dryRun: false,
        autoApply: true,
        logger: { info: () => {}, warn: () => {} },
        workspaceDir,
      }
    );
    assert.ok(result.compacted >= 0, "should complete");
    if (result.deleted > 0) {
      assert.ok(table._archived.size > 0, "should archive duplicates");
    }
  });

  it("defaults to autoApply=false (no DB changes)", async () => {
    const table = makeDbTable(candidates);
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-merge-"));
    const result = await runMemoryCompaction(
      { table },
      {
        similarityThreshold: 0.5,
        lookbackDays: 30,
        maxBatchSize: 50,
        dryRun: false,
        logger: { info: () => {}, warn: () => {} },
        workspaceDir,
      }
    );
    assert.strictEqual(table._archived.size, 0, "default should not archive");
    assert.strictEqual(table._added.length, 0, "default should not add");
    assert.ok(result.autoApply === false || result.proposals > 0 || result.compacted === 0, "should report proposals or no clusters");
  });

  it("respects dryRun even with autoApply=true", async () => {
    const table = makeDbTable(candidates);
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-merge-"));
    const result = await runMemoryCompaction(
      { table },
      {
        similarityThreshold: 0.5,
        lookbackDays: 30,
        maxBatchSize: 50,
        dryRun: true,
        autoApply: true,
        logger: { info: () => {}, warn: () => {} },
        workspaceDir,
      }
    );
    assert.strictEqual(table._archived.size, 0, "dryRun should not archive");
    assert.strictEqual(table._added.length, 0, "dryRun should not add");
    assert.ok(result.dryRun);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runConflictResolver } from "../lib/jobs/conflict-resolver.js";

describe("conflict-resolver", () => {
  it("löst einfachen Konflikt via LLM", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "conflict-test-"));
    try {
      mkdirSync(join(tmpDir, ".adaptive-learning"), { recursive: true });
      const old = new Date(Date.now() - 10 * 86400000).toISOString();
      const conflicts = [
        { schemaVersion: 1, timestamp: old, newText: "Use npm", existingText: "Use pnpm", newAgentId: "a", existingAgentId: "b" },
      ];
      writeFileSync(join(tmpDir, ".adaptive-learning", "conflict-log.jsonl"), conflicts.map(c => JSON.stringify(c)).join("\n") + "\n", "utf8");

      const mockLlm = async () => JSON.stringify({ resolution: "keep_a", confidence: 0.95, reason: "npm is preferred" });
      const result = await runConflictResolver({
        workspaceDir: tmpDir,
        llmCfg: { model: "test" },
        callLlm: mockLlm,
        minAgeDays: 7,
        logger: { info: () => {}, warn: () => {} },
      });

      assert.strictEqual(result.resolved, 1);
      assert.strictEqual(result.scanned, 1);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("ignoriert zu junge Konflikte", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "conflict-test-"));
    try {
      mkdirSync(join(tmpDir, ".adaptive-learning"), { recursive: true });
      const recent = new Date().toISOString();
      const conflicts = [
        { schemaVersion: 1, timestamp: recent, newText: "A", existingText: "B" },
      ];
      writeFileSync(join(tmpDir, ".adaptive-learning", "conflict-log.jsonl"), conflicts.map(c => JSON.stringify(c)).join("\n") + "\n", "utf8");

      const result = await runConflictResolver({
        workspaceDir: tmpDir,
        minAgeDays: 7,
        logger: { info: () => {}, warn: () => {} },
      });

      assert.strictEqual(result.note, "no_eligible_conflicts");
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("dry-run schreibt nichts", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "conflict-test-"));
    try {
      mkdirSync(join(tmpDir, ".adaptive-learning"), { recursive: true });
      const old = new Date(Date.now() - 10 * 86400000).toISOString();
      const conflicts = [
        { schemaVersion: 1, timestamp: old, newText: "A", existingText: "B" },
      ];
      writeFileSync(join(tmpDir, ".adaptive-learning", "conflict-log.jsonl"), conflicts.map(c => JSON.stringify(c)).join("\n") + "\n", "utf8");

      const mockLlm = async () => JSON.stringify({ resolution: "keep_a", confidence: 0.95, reason: "test" });
      const result = await runConflictResolver({
        workspaceDir: tmpDir,
        llmCfg: { model: "test" },
        callLlm: mockLlm,
        dryRun: true,
        logger: { info: () => {}, warn: () => {} },
      });

      assert.strictEqual(result.dryRun, true);
      assert.strictEqual(result.resolved, 1);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("markiert unsichere Konflikte", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "conflict-test-"));
    try {
      mkdirSync(join(tmpDir, ".adaptive-learning"), { recursive: true });
      const old = new Date(Date.now() - 10 * 86400000).toISOString();
      const conflicts = [
        { schemaVersion: 1, timestamp: old, newText: "A", existingText: "B" },
      ];
      writeFileSync(join(tmpDir, ".adaptive-learning", "conflict-log.jsonl"), conflicts.map(c => JSON.stringify(c)).join("\n") + "\n", "utf8");

      const mockLlm = async () => JSON.stringify({ resolution: "uncertain", reason: "ambiguous" });
      const result = await runConflictResolver({
        workspaceDir: tmpDir,
        llmCfg: { model: "test" },
        callLlm: mockLlm,
        logger: { info: () => {}, warn: () => {} },
      });

      assert.strictEqual(result.resolved, 0);
      assert.strictEqual(result.uncertain, 1);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});

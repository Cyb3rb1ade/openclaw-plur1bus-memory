/**
 * Smoke-Test: Conflict Resolver — Proposal-Only Semantics
 *
 * Verifiziert:
 *   1. Conflict Resolver erzeugt nur Proposals, kein autoApply
 *   2. recommendation-Feld ist gesetzt
 *   3. Ergebnisse werden in conflict-resolved.jsonl persistiert
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConflictResolver } from "../lib/jobs/conflict-resolver.js";

describe("conflict-resolver", () => {
  it("proposes resolutions without autoApply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-conflict-"));
    const conflict = {
      timestamp: new Date(Date.now() - 8 * 86400000).toISOString(),
      newMemoryId: "11111111-1111-1111-1111-111111111111",
      existingMemoryId: "22222222-2222-2222-2222-222222222222",
      newText: "User prefers dark mode in all apps",
      existingText: "User prefers light mode in all apps",
      newAgentId: "agent-a",
      existingAgentId: "agent-b",
    };
    mkdirSync(join(dir, ".adaptive-learning"), { recursive: true }); writeFileSync(join(dir, ".adaptive-learning", "conflict-log.jsonl"), JSON.stringify(conflict) + "\n", "utf8");

    const mockLlm = async () => JSON.stringify({ resolution: "keep_a", confidence: 0.85, reason: "A is more recent" });

    const result = await runConflictResolver({
      workspaceDir: dir,
      llmCfg: { model: "mock" },
      callLlm: mockLlm,
      minAgeDays: 7,
      maxConflicts: 10,
      dryRun: false,
      logger: { info: () => {}, warn: () => {} },
    });

    assert.strictEqual(result.scanned, 1, "should scan 1 conflict");
    assert.strictEqual(result.proposed, 1, "should propose 1 resolution");
    assert.strictEqual(result.resolved, 0, "should not auto-resolve");

    const resolvedPath = join(dir, ".adaptive-learning", "conflict-resolved.jsonl");
    assert.ok(existsSync(resolvedPath), "should write conflict-resolved.jsonl");
    const lines = readFileSync(resolvedPath, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[0]);
    assert.strictEqual(entry.resolution, "keep_a");
    assert.strictEqual(entry.recommendation, "review_only", "should recommend review, not apply");
    assert.strictEqual(entry.autoApply, undefined, "should NOT have autoApply field");
    assert.ok(entry.confidence > 0);
  });

  it("high confidence gets apply_via_safe_reconsolidation recommendation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-conflict-"));
    const conflict = {
      timestamp: new Date(Date.now() - 8 * 86400000).toISOString(),
      newMemoryId: "33333333-3333-3333-3333-333333333333",
      existingMemoryId: "44444444-4444-4444-4444-444444444444",
      newText: "Alpha",
      existingText: "Beta",
      newAgentId: "agent-a",
      existingAgentId: "agent-b",
    };
    mkdirSync(join(dir, ".adaptive-learning"), { recursive: true }); writeFileSync(join(dir, ".adaptive-learning", "conflict-log.jsonl"), JSON.stringify(conflict) + "\n", "utf8");

    const mockLlm = async () => JSON.stringify({ resolution: "keep_a", confidence: 0.95, reason: "Very clear" });

    const result = await runConflictResolver({
      workspaceDir: dir,
      llmCfg: { model: "mock" },
      callLlm: mockLlm,
      minAgeDays: 7,
      maxConflicts: 10,
      dryRun: false,
      logger: { info: () => {}, warn: () => {} },
    });

    assert.strictEqual(result.resolved, 1, "high confidence counts as resolved recommendation");

    const resolvedPath = join(dir, ".adaptive-learning", "conflict-resolved.jsonl");
    const lines = readFileSync(resolvedPath, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[0]);
    assert.strictEqual(entry.recommendation, "apply_via_safe_reconsolidation");
    assert.strictEqual(entry.autoApply, undefined);
  });

  it("skips conflicts younger than minAgeDays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-conflict-"));
    const conflict = {
      timestamp: new Date().toISOString(),
      newMemoryId: "55555555-5555-5555-5555-555555555555",
      existingMemoryId: "66666666-6666-6666-6666-666666666666",
      newText: "X",
      existingText: "Y",
    };
    mkdirSync(join(dir, ".adaptive-learning"), { recursive: true }); writeFileSync(join(dir, ".adaptive-learning", "conflict-log.jsonl"), JSON.stringify(conflict) + "\n", "utf8");

    const result = await runConflictResolver({
      workspaceDir: dir,
      minAgeDays: 7,
      maxConflicts: 10,
      dryRun: false,
      logger: { info: () => {}, warn: () => {} },
    });

    assert.strictEqual(result.note, "no_eligible_conflicts");
  });
});

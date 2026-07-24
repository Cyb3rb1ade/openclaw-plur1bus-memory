/**
 * Smoke-Test: Obsidian Bridge Apply-Modus
 *
 * Verifiziert:
 *   1. requireVaultPathConfirmation=true + nicht bestätigt → Apply blockiert
 *   2. Backup vor Apply, Manifest mit beforeHash/afterHash, Audit-Log
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  syncWorkspace,
  bridgePaths,
} from "../lib/obsidian-bridge.js";
import { parseObsidianCommandPlan } from "../lib/obsidian-mutation-policy.js";

describe("obsidian-apply", () => {
  function makeWorkspace(dir) {
    return {
      workspaceId: "test-ws",
      agentId: "test-agent",
      path: dir,
      includeGlobs: ["**/*.md"],
      ignoreGlobs: [".git/**", ".obsidian/**"],
    };
  }

  function writeNote(dir, relPath, content) {
    const abs = join(dir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  function applyPolicy(dir, vaultConfirmed = true) {
    return parseObsidianCommandPlan(["review", "apply"], {
      memoryCtx: {
        agentId: "test-agent",
        workspaceIdentity: "workspace:v1:test-ws",
      },
      baseDbPath: dir,
      mode: "apply",
      allowWrite: true,
      vaultConfirmed,
      actionConfirmed: true,
    }).mutationPolicy;
  }

  it("blocks apply when vault path is not confirmed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-obs-"));
    const ws = makeWorkspace(dir);
    const result = await syncWorkspace(ws, {
      dryRun: false,
      requireVaultPathConfirmation: true,
      backupBeforeApply: true,
      auditLog: true,
      mutationPolicy: applyPolicy(dir, false),
    });
    assert.equal(result.applied, false);
    assert.equal(result.reason, "mutation_policy_denied");
    assert.equal(result.scan, null);
  });

  it("allows apply when vault path is confirmed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-obs-"));
    const ws = makeWorkspace(dir);
    mkdirSync(join(dir, "memory", "cards"), { recursive: true });
    writeFileSync(join(dir, "memory", "cards", "test.md"), [
      "---",
      "plur1bus_type: memory_card",
      "workspace_id: test-ws",
      "agent_id: test-agent",
      "category: fact",
      "importance: 0.7",
      "scope: workspace",
      "source_kind: obsidian",
      "sync_status: validated",
      "content_hash: 8105838adb992bba5b117b46e5266b3628ea5a11e5c70bc3369063f4892e434f",
      "---",
      "",
      "Test memory content.",
    ].join("\n"), "utf8");

    const result = await syncWorkspace(ws, {
      dryRun: false,
      requireVaultPathConfirmation: true,
      backupBeforeApply: true,
      auditLog: true,
      applyApproved: true,
      approvedPaths: "all",
      mutationPolicy: applyPolicy(dir),
      memoryStore: async () => ({ details: { id: "mem-123" } }),
    });
    assert.ok(!result.actions.some(a => a.action === "vault_not_confirmed"), "should not block confirmed vault");
  });

  it("creates backup, manifest and audit log on apply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-obs-"));
    const ws = makeWorkspace(dir);
    mkdirSync(join(dir, "memory", "cards"), { recursive: true });
    const originalContent = [
      "---",
      "plur1bus_type: memory_card",
      "workspace_id: test-ws",
      "agent_id: test-agent",
      "category: fact",
      "importance: 0.7",
      "scope: workspace",
      "source_kind: obsidian",
      "sync_status: validated",
      "content_hash: 8105838adb992bba5b117b46e5266b3628ea5a11e5c70bc3369063f4892e434f",
      "---",
      "",
      "Original content here.",
    ].join("\n");
    writeFileSync(join(dir, "memory", "cards", "test.md"), originalContent, "utf8");

    const result = await syncWorkspace(ws, {
      dryRun: false,
      requireVaultPathConfirmation: true,
      backupBeforeApply: true,
      auditLog: true,
      applyApproved: true,
      approvedPaths: "all",
      mutationPolicy: applyPolicy(dir),
      memoryStore: async () => ({ details: { id: "mem-456" } }),
    });

    assert.ok(result.manifestFiles > 0, "should have manifest files");
    assert.ok(result.batchId, "should have batchId");

    const paths = bridgePaths(ws);
    const backupDir = join(paths.backupDir, result.batchId);
    assert.ok(existsSync(backupDir), "backup dir should exist");

    const manifestPath = join(backupDir, "manifest.json");
    assert.ok(existsSync(manifestPath), "manifest should exist");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.strictEqual(manifest.batchId, result.batchId);
    assert.ok(Array.isArray(manifest.files));
    assert.ok(manifest.files[0].beforeHash, "should have beforeHash");
    assert.ok(manifest.files[0].afterHash, "should have afterHash");

    assert.ok(existsSync(paths.auditLog), "audit log should exist");
    const auditLines = readFileSync(paths.auditLog, "utf8").trim().split("\n");
    const lastAudit = JSON.parse(auditLines[auditLines.length - 1]);
    assert.strictEqual(lastAudit.event, "file.modified");
    assert.ok(lastAudit.beforeHash);
    assert.ok(lastAudit.afterHash);
    assert.strictEqual(lastAudit.batchId, result.batchId);
  });
});

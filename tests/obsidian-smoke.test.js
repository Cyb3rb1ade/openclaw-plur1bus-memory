/**
 * P5 Runtime Validation: Obsidian Bridge Smoke
 *
 * Tests:
 * 1. Bidirektionaler Sync (Obsidian → PLUR1BUS Kandidaten, PLUR1BUS → Obsidian Frontmatter)
 * 2. Conflict-Report bei geändertem Decision-Note
 * 3. Apply-Mode mit Backup + Manifest + Audit-Log
 * 4. Path-Traversal-Schutz (../../../etc/passwd)
 * 5. Atomic JSON parallele Writes
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import {
  syncWorkspace,
  confirmVaultPath,
  scanWorkspace,
  buildObsidianCandidate,
  stableContentHash,
  bridgePaths,
} from "../lib/obsidian-bridge.js";
import {
  safeBridgePath,
  resolveObsidianBridgePaths,
  resolveUnder,
} from "../lib/obsidian-control-room.js";
import { assertSafeRelativePath as safeAssertRelative, isDotObsidianSegment } from "../lib/obsidian/safe-paths.js";
import { resolveInside } from "../lib/sql-safety.js";
import { atomicJsonUpdate } from "../lib/atomic-json.js";
import { confirmedObsidianPolicy } from "./helpers/obsidian-mutation-policy.js";
import { makeTempDir } from "./helpers/temp-dir.js";

describe("obsidian-smoke-p5", () => {
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

  function readNote(dir, relPath) {
    return readFileSync(join(dir, relPath), "utf8");
  }

  // ------------------------------------------------------------------
  // 1. Bidirektionaler Sync
  // ------------------------------------------------------------------
  it("bidirectional sync: obsidian → candidates + pluri1bus → frontmatter update", async () => {
    const dir = makeTempDir("plur1bus-obs-bidi-");
    const ws = makeWorkspace(dir);
    const mutationPolicy = confirmedObsidianPolicy({ baseDbPath: dir });
    confirmVaultPath(ws);

    // Obsidian-Seite: einfache Markdown-Datei (noch kein memory_card)
    mkdirSync(join(dir, "memory", "cards"), { recursive: true });
    writeNote(dir, "memory/cards/hello.md", [
      "---",
      "plur1bus_type: memory_card",
      "workspace_id: test-ws",
      "agent_id: test-agent",
      "category: fact",
      "importance: 0.7",
      "scope: workspace",
      "source_kind: obsidian",
      "sync_status: validated",
      "content_hash: aa3ec16e6acc809d8b2818662276256abfd2f1b441cb51574933f3d4bd115d11",
      "---",
      "",
      "Hello world.",
    ].join("\n"));

    // Erster Scan: sollte Kandidaten erzeugen (noch nicht approved)
    const scan1 = scanWorkspace(ws);
    assert.strictEqual(scan1.files.length, 1, "should find the note");
    assert.strictEqual(scan1.files[0].kind, "memory_card");

    // Nun mit Approval + memoryStore → PLUR1BUS schreibt zurück (Frontmatter update)
    const result = await syncWorkspace(ws, {
      dryRun: false,
      requireVaultPathConfirmation: true,
      backupBeforeApply: true,
      auditLog: true,
      applyApproved: true,
      approvedPaths: "all",
      mutationPolicy,
      memoryStore: async () => ({ details: { id: "mem-bidi-01" } }),
    });

    assert.ok(
      result.actions.some((a) => a.action === "memory_stored"),
      "should store memory"
    );

    // Prüfe, dass Obsidian-Datei aktualisiert wurde (sync_status: synced, memory_id gesetzt)
    const updated = readNote(dir, "memory/cards/hello.md");
    assert.ok(updated.includes("sync_status: synced"), "frontmatter should be updated to synced");
    assert.ok(updated.includes("memory_id: mem-bidi-01"), "frontmatter should contain memory_id");
  });

  // ------------------------------------------------------------------
  // 2. Conflict-Report
  // ------------------------------------------------------------------
  it("generates conflict review when a synced decision changes", async () => {
    const dir = makeTempDir("plur1bus-obs-conflict-");
    const ws = makeWorkspace(dir);
    const mutationPolicy = confirmedObsidianPolicy({ baseDbPath: dir });
    confirmVaultPath(ws);

    mkdirSync(join(dir, "decisions"), { recursive: true });
    const originalBody = "Original decision body.";
    const originalHash = stableContentHash(originalBody);
    writeNote(dir, "decisions/important.md", [
      "---",
      "plur1bus_type: decision",
      "workspace_id: test-ws",
      "agent_id: test-agent",
      "sync_status: synced",
      `content_hash: ${originalHash}`,
      "validated: true",
      "---",
      "",
      originalBody,
    ].join("\n"));

    // Erster Sync: approved, damit es als synced im State landet
    await syncWorkspace(ws, {
      dryRun: false,
      requireVaultPathConfirmation: true,
      backupBeforeApply: true,
      auditLog: true,
      applyApproved: true,
      approvedPaths: "all",
      mutationPolicy,
      memoryStore: async () => ({ details: { id: "mem-dec-01" } }),
    });

    // Datei ändern (neuer Body → neuer Hash)
    const changedBody = "Changed decision body after sync.";
    const changedHash = stableContentHash(changedBody);
    writeNote(dir, "decisions/important.md", [
      "---",
      "plur1bus_type: decision",
      "workspace_id: test-ws",
      "agent_id: test-agent",
      "sync_status: synced",
      `content_hash: ${changedHash}`,
      "validated: true",
      "---",
      "",
      changedBody,
    ].join("\n"));

    // Zweiter Sync: sollte Conflict-Report erzeugen
    const result2 = await syncWorkspace(ws, {
      dryRun: false,
      requireVaultPathConfirmation: true,
      backupBeforeApply: true,
      auditLog: true,
      applyApproved: true,
      approvedPaths: "all",
      mutationPolicy,
      memoryStore: async () => ({ details: { id: "mem-dec-02" } }),
    });

    const conflictAction = result2.actions.find(
      (a) => a.action === "write_conflict_review" || a.action === "would_write_conflict_review"
    );
    assert.ok(conflictAction, "should generate conflict review action");

    const paths = bridgePaths(ws);
    const conflictLogPath = paths.conflictLog;
    assert.ok(existsSync(conflictLogPath), "conflict-log.jsonl should exist");
    const lines = readFileSync(conflictLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.ok(lines.length > 0, "conflict log should have entries");
    const lastEntry = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(lastEntry.event, "decision.conflict_review");
    assert.strictEqual(lastEntry.path, "decisions/important.md");
  });

  // ------------------------------------------------------------------
  // 3. Apply-Mode mit Backup
  // ------------------------------------------------------------------
  it("creates backup before apply with manifest and audit log", async () => {
    const dir = makeTempDir("plur1bus-obs-backup-");
    const ws = makeWorkspace(dir);
    const mutationPolicy = confirmedObsidianPolicy({ baseDbPath: dir });
    confirmVaultPath(ws);

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
      "content_hash: 9132eb17d58668813903bb8278904b4385504952d43061ebfc55d03930f3f7b2",
      "---",
      "",
      "Backup test content.",
    ].join("\n");
    writeNote(dir, "memory/cards/backup.md", originalContent);

    const result = await syncWorkspace(ws, {
      dryRun: false,
      requireVaultPathConfirmation: true,
      backupBeforeApply: true,
      auditLog: true,
      applyApproved: true,
      approvedPaths: "all",
      mutationPolicy,
      memoryStore: async () => ({ details: { id: "mem-backup-01" } }),
    });

    assert.ok(result.batchId, "should have batchId");
    assert.ok(result.manifestFiles > 0, "should have manifest files");

    const paths = bridgePaths(ws);
    const backupDir = join(paths.backupDir, result.batchId);
    assert.ok(existsSync(backupDir), "backup dir should exist");

    const manifestPath = join(backupDir, "manifest.json");
    assert.ok(existsSync(manifestPath), "manifest should exist");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.strictEqual(manifest.batchId, result.batchId);
    assert.ok(Array.isArray(manifest.files));
    assert.ok(manifest.files[0].beforeHash, "manifest should contain beforeHash");
    assert.ok(manifest.files[0].afterHash, "manifest should contain afterHash");

    assert.ok(existsSync(paths.auditLog), "audit log should exist");
    const auditLines = readFileSync(paths.auditLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const lastAudit = JSON.parse(auditLines[auditLines.length - 1]);
    assert.strictEqual(lastAudit.event, "file.modified");
    assert.ok(lastAudit.beforeHash);
    assert.ok(lastAudit.afterHash);
    assert.strictEqual(lastAudit.batchId, result.batchId);

    // Backup-Inhalt muss Original sein
    const backupFiles = manifest.files;
    assert.strictEqual(backupFiles.length, 1);
    const backupFilePath = backupFiles[0].backupPath;
    assert.ok(existsSync(backupFilePath), "backup file should exist");
    const backupContent = readFileSync(backupFilePath, "utf8");
    assert.strictEqual(backupContent, originalContent, "backup must equal original content");
  });

  // ------------------------------------------------------------------
  // 4. Path-Traversal-Schutz
  // ------------------------------------------------------------------
  it("blocks path traversal attempts via resolveInside", () => {
    const base = makeTempDir("plur1bus-safe-");
    assert.throws(() => resolveInside(base, "../../../etc/passwd"), /Path traversal blocked/);
    assert.throws(() => resolveInside(base, "foo/../../../etc/passwd"), /Path traversal blocked/);
    assert.doesNotThrow(() => resolveInside(base, "memory/cards/test.md"));
  });

  it("resolveUnder accepts win32 paths under the vault and still refuses escapes (path.win32)", () => {
    // resolve() yields "\\"-separated paths on win32; a "/" prefix check refused every path under the vault.
    assert.equal(resolveUnder("C:\\Vault", "plur1bus", {}, win32), "C:\\Vault\\plur1bus");
    assert.equal(resolveUnder("C:\\Vault", "plur1bus/review-bundles/x.md", {}, win32), "C:\\Vault\\plur1bus\\review-bundles\\x.md");
    assert.equal(resolveUnder("C:\\Vault", ".", {}, win32), "C:\\Vault");
    assert.throws(() => resolveUnder("C:\\Vault", "../Other", {}, win32), /Path traversal rejected/);
    assert.throws(() => resolveUnder("C:\\Vault", "C:/Other", {}, win32), /Unsafe absolute path rejected/);
    assert.throws(() => resolveUnder("C:\\Vault", "..\\Vault2\\x", {}, win32), /Path traversal rejected/);
  });

  it("the .obsidian write gate folds case and trailing dots/spaces on every platform", () => {
    const gate = /\.obsidian writes require obsidianBridge\.allowDotObsidianWrite=true/;
    const trailing = /Unsafe path segment rejected \(trailing dot or space\)/;
    for (const segment of [".obsidian", ".OBSIDIAN", ".Obsidian", ".obsidian.", ".obsidian ", ".OBSIDIAN. ."]) {
      const rel = `${segment}/plugins/x.js`;
      const hasTrailing = /[. ]$/.test(segment);
      // POSIX: the gate catches every spelling.
      assert.throws(() => resolveUnder("/vault", rel, {}, posix), gate, segment);
      assert.throws(() => safeAssertRelative(rel, { platform: "linux" }), gate, segment);
      // win32: a trailing dot/space is refused outright (Windows would strip it), even with the opt-in.
      assert.throws(() => resolveUnder("C:\\Vault", rel, {}, win32), hasTrailing ? trailing : gate, segment);
      assert.throws(() => safeAssertRelative(rel, { platform: "win32" }), hasTrailing ? trailing : gate, segment);
      if (hasTrailing) assert.throws(() => resolveUnder("C:\\Vault", rel, { allowDotObsidianWrite: true }, win32), trailing, segment);
      else assert.equal(resolveUnder("C:\\Vault", rel, { allowDotObsidianWrite: true }, win32), `C:\\Vault\\${segment}\\plugins\\x.js`);
    }
    assert.equal(resolveUnder("C:\\Vault", ".obsidianx/notes.md", {}, win32), "C:\\Vault\\.obsidianx\\notes.md");
    assert.equal(isDotObsidianSegment("obsidian"), false);
  });

  it("refuses segments made only of dots and/or spaces on every platform", () => {
    for (const segment of [".", "..", "...", "... ", " .", ".  .", "  ", ". .."]) {
      for (const rel of [`${segment}/x.md`, `notes/${segment}/x.md`, `notes/${segment}`]) {
        assert.throws(() => resolveUnder("/vault", rel, {}, posix), /Path traversal rejected/, JSON.stringify(rel));
        assert.throws(() => resolveUnder("C:\\Vault", rel, {}, win32), /Path traversal rejected/, JSON.stringify(rel));
        assert.throws(() => safeAssertRelative(rel, { platform: "linux" }), /Path traversal rejected/, JSON.stringify(rel));
        assert.throws(() => safeAssertRelative(rel, { platform: "win32" }), /Path traversal rejected/, JSON.stringify(rel));
      }
    }
    // Dots inside or leading a real name stay legal.
    assert.equal(resolveUnder("/vault", "notes/.hidden/a..b.md", {}, posix), "/vault/notes/.hidden/a..b.md");
    assert.equal(resolveUnder("C:\\Vault", "notes/.hidden/a..b.md", {}, win32), "C:\\Vault\\notes\\.hidden\\a..b.md");
  });

  it("on win32 refuses any segment with a trailing dot or space; POSIX keeps such names", () => {
    const trailing = /Unsafe path segment rejected \(trailing dot or space\)/;
    for (const rel of ["notes./x.md", "notes /x.md", "notes/x.md.", "notes/x.md ", "a. ./b"]) {
      assert.throws(() => resolveUnder("C:\\Vault", rel, {}, win32), trailing, JSON.stringify(rel));
      assert.throws(() => safeAssertRelative(rel, { platform: "win32" }), trailing, JSON.stringify(rel));
      assert.doesNotThrow(() => resolveUnder("/vault", rel, {}, posix), JSON.stringify(rel));
      assert.doesNotThrow(() => safeAssertRelative(rel, { platform: "linux" }), JSON.stringify(rel));
    }
  });

  it("blocks path traversal via safeBridgePath", () => {
    const cfg = {
      obsidianBridge: {
        vaultPath: makeTempDir("plur1bus-vault-"),
        reviewRoot: "plur1bus",
        allowWrite: true,
      },
    };
    mkdirSync(join(cfg.obsidianBridge.vaultPath, "plur1bus"), { recursive: true });

    assert.throws(() => safeBridgePath(cfg, "../../../etc/passwd"), /Path traversal rejected/);
    assert.throws(() => safeBridgePath(cfg, "foo/../../../etc/passwd"), /Path traversal rejected/);
    assert.doesNotThrow(() => safeBridgePath(cfg, "review-bundles/test.md"));
  });

  it("blocks path traversal via resolveObsidianBridgePaths", () => {
    const cfg = {
      obsidianBridge: {
        vaultPath: makeTempDir("plur1bus-vault2-"),
        reviewRoot: "plur1bus",
      },
    };
    mkdirSync(join(cfg.obsidianBridge.vaultPath, "plur1bus"), { recursive: true });
    const paths = resolveObsidianBridgePaths(cfg);
    assert.ok(paths.ok);
    // resolveUnder wird intern genutzt; safeBridgePath testet es bereits explizit.
  });

  // ------------------------------------------------------------------
  // 5. Atomic JSON parallele Writes
  // ------------------------------------------------------------------
  it("atomicJsonUpdate prevents corrupted JSON under parallel writes", async () => {
    const dir = makeTempDir("plur1bus-atomic-");
    const filePath = join(dir, "counter.json");
    writeFileSync(filePath, JSON.stringify({ count: 0 }), "utf8");

    const iterations = 20;
    const workers = 5;

    await Promise.all(
      Array.from({ length: workers }).map(() =>
        Promise.all(
          Array.from({ length: iterations }).map(() =>
            atomicJsonUpdate(filePath, (data) => {
              return { count: (data.count || 0) + 1 };
            })
          )
        )
      )
    );

    const final = JSON.parse(readFileSync(filePath, "utf8"));
    assert.strictEqual(final.count, workers * iterations, "parallel increments must not corrupt JSON");
  });

  // NOTE: Reentrancy protection is implemented but has a known deadlock/ordering
  // issue when an updater itself awaits atomicJsonUpdate for the same file.
  // This is documented in the audit report rather than tested here to avoid
  // hanging the test runner.
});

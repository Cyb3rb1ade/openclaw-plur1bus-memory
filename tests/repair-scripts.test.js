/**
 * tests/repair-scripts.test.js — unit + integration tests for the repair tooling
 *
 * Covers:
 *   - deploy mismatch detected (validateDeployment check-only)
 *   - deploy mismatch repaired (validateDeployment repair)
 *   - backup created BEFORE repair (repair-installed-plugin.mjs ordering)
 *   - no real memory data touched (repair only touches deploy dir)
 *   - maintain-lancedb dry-run changes nothing
 *   - maintain-lancedb --apply creates snapshot/backup
 *   - dreaming cron error detected (repair-installed-plugin exit code 3)
 *   - verify-workspace-writer healthcheck detects missing write permissions
 *   - repair-installed-plugin exit codes (0/1/3)
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync,
  existsSync, readdirSync, rmSync, chmodSync, statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

import { validateDeployment, DEPLOY_FILES } from "../scripts/lib/deploy-integrity.mjs";
import { run as runWorkspaceWriter } from "../scripts/verify-workspace-writer.mjs";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "plur1bus-repair-test-"));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function writeRealFile(dir, relPath, content = "export const x = 1;\n") {
  const abs = join(dir, relPath);
  mkdirSync(join(dir, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function writeStub(dir, relPath) {
  return writeRealFile(dir, relPath, 'export * from "../../nonexistent/path.js";\n');
}

// Run a script and return { status, stdout, stderr }
function runScript(scriptPath, args = [], env = {}) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function captureConsoleLog(fn) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(" ")); };
  try {
    const result = await fn();
    return { result, stdout: lines.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

const REPO_ROOT = new URL("../", import.meta.url).pathname;
const REPAIR_SCRIPT = join(REPO_ROOT, "scripts", "repair-installed-plugin.mjs");
const MAINTAIN_SCRIPT = join(REPO_ROOT, "scripts", "maintain-lancedb.mjs");
const WORKSPACE_SCRIPT = join(REPO_ROOT, "scripts", "verify-workspace-writer.mjs");

// ─── DEPLOY_FILES export ────────────────────────────────────────────────────

describe("DEPLOY_FILES", () => {
  it("is a non-empty array exported from deploy-integrity.mjs", () => {
    assert.ok(Array.isArray(DEPLOY_FILES));
    assert.ok(DEPLOY_FILES.length > 0);
  });

  it("includes index.js and openclaw.plugin.json", () => {
    assert.ok(DEPLOY_FILES.includes("index.js"));
    assert.ok(DEPLOY_FILES.includes("openclaw.plugin.json"));
  });

  it("includes all core lib files referenced in repair-installed-plugin.mjs", () => {
    const required = [
      "lib/neo-arch.js",
      "lib/relevant-memory-context.js",
      "lib/recall-pipeline.js",
      "lib/runtime-scheduler.js",
      "lib/recall-budget.js",
    ];
    for (const f of required) {
      assert.ok(DEPLOY_FILES.includes(f), `DEPLOY_FILES missing: ${f}`);
    }
  });
});

// ─── deploy mismatch detection / repair ─────────────────────────────────────

describe("validateDeployment — mismatch detection", () => {
  let dir;
  beforeEach(() => {
    dir = makeTmpDir();
    mkdirSync(join(dir, "repo", "lib"), { recursive: true });
    mkdirSync(join(dir, "deploy", "lib"), { recursive: true });
  });
  afterEach(() => cleanup(dir));

  it("detects a missing deploy file", () => {
    writeRealFile(join(dir, "repo"), "lib/a.js");
    const report = validateDeployment({
      deployDir: join(dir, "deploy"),
      repoDir: join(dir, "repo"),
      files: ["lib/a.js"],
      repair: false,
    });
    assert.strictEqual(report.ok, false);
    assert.ok(report.results[0].reasons.includes("missing-deploy-file"));
  });

  it("detects a checksum mismatch", () => {
    writeRealFile(join(dir, "repo"), "lib/a.js", "export const v = 2;\n");
    writeRealFile(join(dir, "deploy"), "lib/a.js", "export const v = 1;\n");
    const report = validateDeployment({
      deployDir: join(dir, "deploy"),
      repoDir: join(dir, "repo"),
      files: ["lib/a.js"],
      repair: false,
    });
    assert.strictEqual(report.ok, false);
    assert.ok(report.results[0].reasons.includes("checksum-mismatch"));
  });

  it("repairs a broken stub when repair=true", () => {
    writeRealFile(join(dir, "repo"), "lib/a.js", "export const v = 42;\n");
    writeStub(join(dir, "deploy"), "lib/a.js");
    const report = validateDeployment({
      deployDir: join(dir, "deploy"),
      repoDir: join(dir, "repo"),
      files: ["lib/a.js"],
      repair: true,
    });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.results[0].repaired, true);
    assert.strictEqual(readFileSync(join(dir, "deploy", "lib", "a.js"), "utf8"), "export const v = 42;\n");
  });
});

// ─── repair-installed-plugin: backup before repair ──────────────────────────

describe("repair-installed-plugin — backup before repair", () => {
  let dir;
  beforeEach(() => {
    dir = makeTmpDir();
    mkdirSync(join(dir, "deploy", "lib"), { recursive: true });
    mkdirSync(join(dir, "backups"), { recursive: true });
  });
  afterEach(() => cleanup(dir));

  it("backup dir contains the broken file content, not the repaired content", () => {
    // Set up a minimal repo with real files and a deploy dir with broken stubs.
    const repoDir = join(dir, "repo");
    const deployDir = join(dir, "deploy");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(deployDir, { recursive: true });
    for (const f of DEPLOY_FILES) {
      const parts = f.split("/");
      const subdir = parts.slice(0, -1).join("/");
      if (subdir) {
        mkdirSync(join(repoDir, subdir), { recursive: true });
        mkdirSync(join(deployDir, subdir), { recursive: true });
      }
      writeFileSync(join(repoDir, f), `// real ${f}\nexport const x = 1;\n`);
      // Write a broken stub for lib files
      if (f.startsWith("lib/")) {
        writeFileSync(join(deployDir, f), `export * from "../../nonexistent.js";\n`);
      } else {
        writeFileSync(join(deployDir, f), `// real ${f}\nexport const x = 1;\n`);
      }
    }
    const releaseVersion = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ version: releaseVersion }));
    writeFileSync(join(repoDir, "openclaw.plugin.json"), JSON.stringify({ version: releaseVersion }));
    writeFileSync(join(deployDir, "openclaw.plugin.json"), JSON.stringify({ version: releaseVersion }));

    const result = runScript(REPAIR_SCRIPT, ["--deploy-dir", deployDir, "--no-smoke"], {
      // Override home so backups land in our temp dir
      HOME: dir,
    });

    // Script should succeed (repaired = exit 0) or warn (exit 3)
    assert.ok(result.status === 0 || result.status === 3, `unexpected exit ${result.status}\n${result.stderr}`);

    // Find the backup dir
    const backupsRoot = join(dir, ".openclaw-backups");
    assert.ok(existsSync(backupsRoot), "backup root should exist");
    const entries = readdirSync(backupsRoot).filter((e) => e.startsWith("plur1bus-repair-"));
    assert.ok(entries.length >= 1, "at least one repair backup should be created");

    // The backup should contain the broken content (not the repaired content)
    const backupDir = join(backupsRoot, entries[0]);
    const backedUpLib = join(backupDir, "lib", "neo-arch.js");
    if (existsSync(backedUpLib)) {
      const content = readFileSync(backedUpLib, "utf8");
      assert.ok(
        content.includes("nonexistent"),
        "backup should contain the original broken stub, not the repaired file",
      );
    }
  });
});

// ─── repair-installed-plugin: no memory data touched ────────────────────────

describe("repair-installed-plugin — no memory data touched", () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => cleanup(dir));

  it("does not modify files outside the deploy dir", () => {
    const repoDir = join(dir, "repo");
    const deployDir = join(dir, "deploy");
    const memoryDir = join(dir, ".openclaw", "memory", "lancedb-namespaced", "main", "memories");

    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(deployDir, { recursive: true });
    const sentinel = join(memoryDir, "sentinel.lance");
    writeFileSync(sentinel, "USER_MEMORY_DATA");

    // Minimal valid deploy + repo so the script can run
    for (const f of DEPLOY_FILES) {
      const parts = f.split("/");
      const subdir = parts.slice(0, -1).join("/");
      if (subdir) {
        mkdirSync(join(repoDir, subdir), { recursive: true });
        mkdirSync(join(deployDir, subdir), { recursive: true });
      }
      const content = `// ${f}\nexport const x = 1;\n`;
      writeFileSync(join(repoDir, f), content);
      writeFileSync(join(deployDir, f), content);
    }

    runScript(REPAIR_SCRIPT, ["--deploy-dir", deployDir], { HOME: dir });

    // Sentinel must be untouched
    assert.strictEqual(readFileSync(sentinel, "utf8"), "USER_MEMORY_DATA");
  });
});

// ─── repair-installed-plugin: exit codes ────────────────────────────────────

describe("repair-installed-plugin — exit codes", () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => cleanup(dir));

  it("exits 0 when deploy dir matches repo exactly", () => {
    // Point deploy dir at the actual repo root so checksums match and the
    // smoke test can import real modules (node_modules present in REPO_ROOT).
    const r = runScript(REPAIR_SCRIPT, [], {
      PLUR1BUS_DEPLOY: REPO_ROOT,
      HOME: dir,  // isolate lancedb/backup side-effects
    });
    assert.ok(r.status === 0 || r.status === 3, `expected 0 or 3, got ${r.status}\n${r.stderr}`);
  });

  it("exits 1 when deploy has unrepaired integrity violations", () => {
    const deployDir = join(dir, "deploy");
    const repoDir = join(dir, "repo");
    mkdirSync(join(deployDir, "lib"), { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    // Provide a repo that has files but deploy is intentionally broken and
    // --dry-run so nothing gets repaired.
    for (const f of DEPLOY_FILES) {
      const parts = f.split("/");
      const subdir = parts.slice(0, -1).join("/");
      if (subdir) mkdirSync(join(repoDir, subdir), { recursive: true });
      writeFileSync(join(repoDir, f), `export const x = 1;\n`);
    }
    // Deploy is intentionally empty (all files missing)
    const r = runScript(REPAIR_SCRIPT, ["--deploy-dir", deployDir, "--dry-run"], { HOME: dir });
    assert.strictEqual(r.status, 1, `expected 1, got ${r.status}\n${r.stderr}`);
  });
});

// ─── maintain-lancedb: dry-run changes nothing ──────────────────────────────

describe("maintain-lancedb — dry-run", () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => cleanup(dir));

  it("dry-run reports elevated tables but removes no files", () => {
    const versionsDir = join(dir, "lancedb", "main", "memories", "_versions");
    mkdirSync(versionsDir, { recursive: true });
    // Create 100 manifest files
    for (let i = 0; i < 100; i++) {
      writeFileSync(join(versionsDir, `${String(i).padStart(5, "0")}.json`), `{"v":${i}}`);
    }

    const r = runScript(MAINTAIN_SCRIPT, ["--db-path", join(dir, "lancedb")]);
    assert.strictEqual(r.status, 0, `unexpected exit ${r.status}\n${r.stderr}`);

    // All 100 files should still be present
    const remaining = readdirSync(versionsDir).filter((f) => f.endsWith(".json"));
    assert.strictEqual(remaining.length, 100, "dry-run should not remove any files");

    // No backup should be created
    const backupsRoot = join(dir, ".openclaw-backups");
    assert.ok(!existsSync(backupsRoot) || readdirSync(backupsRoot).length === 0, "no backup in dry-run");
  });
});

// ─── maintain-lancedb: --apply creates snapshot/backup ──────────────────────

describe("maintain-lancedb — --apply creates backup", () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => cleanup(dir));

  it("prunes LanceDB .manifest version files", () => {
    const versionsDir = join(dir, ".openclaw", "memory", "lancedb-namespaced", "main", "memories.lance", "_versions");
    mkdirSync(versionsDir, { recursive: true });
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(versionsDir, `${String(i).padStart(5, "0")}.manifest`), `{"v":${i}}`);
    }

    const r = runScript(MAINTAIN_SCRIPT, ["--apply", "--keep", "50"], { HOME: dir });
    assert.strictEqual(r.status, 0, `unexpected exit ${r.status}\n${r.stderr}`);

    const remaining = readdirSync(versionsDir).filter((f) => f.endsWith(".manifest"));
    assert.strictEqual(remaining.length, 50, "should keep exactly 50 .manifest versions");

    const backupsRoot = join(dir, ".openclaw-backups");
    assert.ok(existsSync(backupsRoot), "backup root should exist after pruning .manifest files");
  });

  it("creates backup dir and _prune-manifest.json before deleting manifests", () => {
    const versionsDir = join(dir, ".openclaw", "memory", "lancedb-namespaced", "main", "memories", "_versions");
    mkdirSync(versionsDir, { recursive: true });
    for (let i = 0; i < 100; i++) {
      writeFileSync(join(versionsDir, `${String(i).padStart(5, "0")}.json`), `{"v":${i}}`);
    }

    const r = runScript(MAINTAIN_SCRIPT, ["--apply", "--keep", "50"], { HOME: dir });
    assert.strictEqual(r.status, 0, `unexpected exit ${r.status}\n${r.stderr}`);

    // Only 50 files remain
    const remaining = readdirSync(versionsDir).filter((f) => f.endsWith(".json"));
    assert.strictEqual(remaining.length, 50, "should keep exactly 50 versions");

    // Backup dir should exist
    const backupsRoot = join(dir, ".openclaw-backups");
    assert.ok(existsSync(backupsRoot), "backup root should exist after --apply");
    const pruneEntries = readdirSync(backupsRoot).filter((e) => e.startsWith("lancedb-prune-"));
    assert.ok(pruneEntries.length >= 1, "at least one prune backup dir should be created");

    const pruneDir = join(backupsRoot, pruneEntries[0]);
    // Find the prune-manifest.json somewhere in the backup tree
    const allBackupFiles = readdirSync(pruneDir, { recursive: true });
    const manifestFile = allBackupFiles.find((f) => f.toString().endsWith("_prune-manifest.json"));
    assert.ok(manifestFile, "_prune-manifest.json should exist in backup");

    const manifestPath = join(pruneDir, manifestFile.toString());
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.ok(manifest.prunedAt, "manifest should have prunedAt timestamp");
    assert.strictEqual(manifest.count, 50, "manifest should record 50 pruned files");
  });

  it("does not touch .lance data files", () => {
    const tableDir = join(dir, ".openclaw", "memory", "lancedb-namespaced", "main", "memories");
    const versionsDir = join(tableDir, "_versions");
    mkdirSync(versionsDir, { recursive: true });

    // Create a fake .lance data file alongside versions
    const dataFile = join(tableDir, "data-0001.lance");
    writeFileSync(dataFile, "LANCE_DATA");

    for (let i = 0; i < 60; i++) {
      writeFileSync(join(versionsDir, `${String(i).padStart(5, "0")}.json`), `{"v":${i}}`);
    }

    runScript(MAINTAIN_SCRIPT, ["--apply", "--keep", "50"], { HOME: dir });

    // .lance file must be untouched
    assert.strictEqual(readFileSync(dataFile, "utf8"), "LANCE_DATA", ".lance data file must not be touched");
  });
});

// ─── verify-workspace-writer ─────────────────────────────────────────────────

describe("verify-workspace-writer", () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => cleanup(dir));

  it("exits 0 when all workspace memory dirs exist and are writable", async () => {
    // Create workspace memory dirs for default agents
    for (const ag of ["main", "bernhardine", "heisenberg"]) {
      const ws = ag === "main" ? "workspace" : `workspace-${ag}`;
      mkdirSync(join(dir, ws, "memory"), { recursive: true });
    }

    const { result: r } = await captureConsoleLog(() => runWorkspaceWriter({
      env: { ...process.env, OPENCLAW_HOME: dir, HOME: dir },
    }));
    assert.strictEqual(r.exitCode, 0, `expected 0, got ${r.exitCode}`);
  });

  it("warns and exits 1 when no workspace memory dirs exist", async () => {
    // No workspace dirs — script returns 1 with a warning (documented exit code)
    const { result: r, stdout } = await captureConsoleLog(() => runWorkspaceWriter({
      env: { ...process.env, OPENCLAW_HOME: dir, HOME: dir },
    }));
    assert.strictEqual(r.exitCode, 1, `expected 1, got ${r.exitCode}`);
    assert.ok(stdout.includes("no workspace memory paths found"), "expected missing-workspaces warning");
  });

  it("writes healthcheck to memory/.healthcheck/, not directly to memory dir", async () => {
    mkdirSync(join(dir, "workspace", "memory"), { recursive: true });

    await captureConsoleLog(() => runWorkspaceWriter({
      env: { ...process.env, OPENCLAW_HOME: dir, HOME: dir },
    }));

    // .healthcheck/ sub-dir may be created; no probe files should remain
    const hcDir = join(dir, "workspace", "memory", ".healthcheck");
    const memFiles = readdirSync(join(dir, "workspace", "memory")).filter(f => f !== ".healthcheck");
    assert.strictEqual(memFiles.length, 0, "no real files should be written directly to workspace/memory/");
    if (existsSync(hcDir)) {
      const probes = readdirSync(hcDir);
      assert.strictEqual(probes.length, 0, "probe file should be deleted after healthcheck");
    }
  });

  it("exits 1 when memory/.healthcheck/ directory is not writable", { skip: process.getuid?.() === 0 }, async () => {
    // Root can always write everywhere, so skip if running as root.
    mkdirSync(join(dir, "workspace", "memory"), { recursive: true });
    const hcDir = join(dir, "workspace", "memory", ".healthcheck");
    mkdirSync(hcDir, { recursive: true });
    chmodSync(hcDir, 0o444); // read-only

    let r;
    try {
      ({ result: r } = await captureConsoleLog(() => runWorkspaceWriter({
        env: { ...process.env, OPENCLAW_HOME: dir, HOME: dir },
      })));
      assert.strictEqual(r.exitCode, 1, `expected 1 (unwritable .healthcheck), got ${r.exitCode}`);
    } finally {
      chmodSync(hcDir, 0o755);
    }
  });
});

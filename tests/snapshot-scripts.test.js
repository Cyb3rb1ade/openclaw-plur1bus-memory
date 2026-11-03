import { strict as assert } from "node:assert";
import { execSyncBounded } from "./helpers/run-sync.js";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { makeTempDir } from "./helpers/temp-dir.js";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL("../scripts/", import.meta.url));

// scripts/ is gitignored (operator-local helper scripts), so on a clean clone
// these scripts are absent. Skip rather than fail when they aren't present.
const SCRIPTS_PRESENT =
  existsSync(join(SCRIPT_DIR, "backup-snapshot.sh")) &&
  existsSync(join(SCRIPT_DIR, "restore-snapshot.sh"));
// engine-windows:posix-only — these are bash operator scripts. execSync runs
// a command through cmd.exe on win32, and cmd.exe cannot execute a .sh: the
// call returns at once with no output and no snapshot (Windows run tc3, all 7
// tests). Until the URL fix (fileURLToPath) SCRIPTS_PRESENT was false on
// Windows, so these tests were skipped there by accident.
const SKIP = !SCRIPTS_PRESENT
  ? { skip: "scripts/*.sh not present (scripts/ is gitignored)" }
  : process.platform === "win32"
    ? { skip: "engine-windows:posix-only (bash operator scripts; cmd.exe cannot execute a .sh)" }
    : {};

function makeTempOpenclawHome() {
  const dir = makeTempDir("plur1bus-snapshot-test-");
  return dir;
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function runShell(command, options = {}) {
  try {
    return execSyncBounded(command, options);
  } catch (err) {
    if (err.code === "EPERM" && err.status === 0) {
      return err.stdout ?? "";
    }
    throw err;
  }
}

test("backup creates snapshot with manifest and skips missing optional paths", SKIP, () => {
  const home = makeTempOpenclawHome();
  try {
    // Create only some of the backup paths
    mkdirSync(join(home, "memory", "lancedb-namespaced"), { recursive: true });
    writeFileSync(join(home, "memory", "lancedb-namespaced", "test.db"), "data");

    const out = runShell(`"${SCRIPT_DIR}/backup-snapshot.sh"`, {
      env: { ...process.env, OPENCLAW_HOME: home },
      encoding: "utf8",
    });

    assert.ok(out.includes("Saved:"), "report should show saved count");
    assert.ok(out.includes("Skipped:"), "report should show skipped count");

    // Find the created snapshot directory
    const snapshotsDir = join(home, ".snapshots");
    assert.ok(existsSync(snapshotsDir), "snapshots dir should exist");

    const entries = readdirSync(snapshotsDir);
    assert.equal(entries.length, 1, "one snapshot should be created");

    const snapshotPath = join(snapshotsDir, entries[0]);
    assert.ok(existsSync(join(snapshotPath, "manifest.json")), "manifest should exist");

    const manifest = JSON.parse(readFileSync(join(snapshotPath, "manifest.json"), "utf8"));
    assert.ok(manifest.createdAt, "manifest should have createdAt");
    assert.ok(manifest.totalSizeBytes >= 4, "manifest should have size");

    // The created file should be in the snapshot
    assert.ok(existsSync(join(snapshotPath, "memory", "lancedb-namespaced", "test.db")), "db file should be backed up");
  } finally {
    cleanup(home);
  }
});

test("backup skips symlinks", SKIP, () => {
  const home = makeTempOpenclawHome();
  try {
    mkdirSync(join(home, "memory", "lancedb-namespaced"), { recursive: true });
    writeFileSync(join(home, "memory", "lancedb-namespaced", "real.db"), "data");
    symlinkSync(
      join(home, "memory", "lancedb-namespaced", "real.db"),
      join(home, "memory", "lancedb-namespaced", "link.db")
    );

    runShell(`"${SCRIPT_DIR}/backup-snapshot.sh"`, {
      env: { ...process.env, OPENCLAW_HOME: home },
      encoding: "utf8",
    });

    const snapshotsDir = join(home, ".snapshots");
    const entries = readdirSync(snapshotsDir);
    const snapshotPath = join(snapshotsDir, entries[0]);

    assert.ok(existsSync(join(snapshotPath, "memory", "lancedb-namespaced", "real.db")), "real file should be backed up");
    assert.ok(!existsSync(join(snapshotPath, "memory", "lancedb-namespaced", "link.db")), "symlink should NOT be backed up");
  } finally {
    cleanup(home);
  }
});

test("restore dry-run by default", SKIP, () => {
  const home = makeTempOpenclawHome();
  try {
    // Create a snapshot
    mkdirSync(join(home, "memory", "lancedb-namespaced"), { recursive: true });
    writeFileSync(join(home, "memory", "lancedb-namespaced", "old.db"), "old");

    runShell(`"${SCRIPT_DIR}/backup-snapshot.sh"`, {
      env: { ...process.env, OPENCLAW_HOME: home },
      encoding: "utf8",
    });

    const snapshotsDir = join(home, ".snapshots");
    const entries = readdirSync(snapshotsDir);
    const snapshotPath = join(snapshotsDir, entries[0]);

    // Modify the original
    writeFileSync(join(home, "memory", "lancedb-namespaced", "old.db"), "modified");

    // Dry-run restore
    const out = runShell(`"${SCRIPT_DIR}/restore-snapshot.sh" "${snapshotPath}"`, {
      env: { ...process.env, OPENCLAW_HOME: home },
      encoding: "utf8",
    });

    assert.ok(out.includes("DRY-RUN"), "should indicate dry-run mode");
    assert.ok(out.includes("[WOULD RESTORE]"), "should show what would be restored");

    // Original should still be modified
    const content = readFileSync(join(home, "memory", "lancedb-namespaced", "old.db"), "utf8");
    assert.equal(content, "modified", "dry-run should not modify files");
  } finally {
    cleanup(home);
  }
});

test("restore with --confirm restores files", SKIP, () => {
  const home = makeTempOpenclawHome();
  try {
    mkdirSync(join(home, "memory", "lancedb-namespaced"), { recursive: true });
    writeFileSync(join(home, "memory", "lancedb-namespaced", "old.db"), "original");

    runShell(`"${SCRIPT_DIR}/backup-snapshot.sh"`, {
      env: { ...process.env, OPENCLAW_HOME: home },
      encoding: "utf8",
    });

    const snapshotsDir = join(home, ".snapshots");
    const entries = readdirSync(snapshotsDir);
    const snapshotPath = join(snapshotsDir, entries[0]);

    // Modify original
    writeFileSync(join(home, "memory", "lancedb-namespaced", "old.db"), "modified");

    // Live restore
    runShell(`"${SCRIPT_DIR}/restore-snapshot.sh" --confirm "${snapshotPath}"`, {
      env: { ...process.env, OPENCLAW_HOME: home },
      encoding: "utf8",
    });

    const content = readFileSync(join(home, "memory", "lancedb-namespaced", "old.db"), "utf8");
    assert.equal(content, "original", "restore should revert to snapshot state");
  } finally {
    cleanup(home);
  }
});

test("restore creates safety backup before live restore", SKIP, () => {
  const home = makeTempOpenclawHome();
  try {
    mkdirSync(join(home, "memory", "lancedb-namespaced"), { recursive: true });
    writeFileSync(join(home, "memory", "lancedb-namespaced", "old.db"), "original");

    runShell(`"${SCRIPT_DIR}/backup-snapshot.sh"`, {
      env: { ...process.env, OPENCLAW_HOME: home },
      encoding: "utf8",
    });

    const snapshotsDir = join(home, ".snapshots");
    const entries = readdirSync(snapshotsDir);
    const snapshotPath = join(snapshotsDir, entries[0]);

    // Modify original
    writeFileSync(join(home, "memory", "lancedb-namespaced", "old.db"), "modified");

    // Live restore
    runShell(`"${SCRIPT_DIR}/restore-snapshot.sh" --confirm "${snapshotPath}"`, {
      env: { ...process.env, OPENCLAW_HOME: home },
      encoding: "utf8",
    });

    // Safety backup should exist
    const allEntries = readdirSync(snapshotsDir);
    const safetyEntries = allEntries.filter(e => e.startsWith("pre-restore-safety-"));
    assert.ok(safetyEntries.length >= 1, "safety backup should be created");

    const safetyPath = join(snapshotsDir, safetyEntries[0]);
    const safetyContent = readFileSync(join(safetyPath, "memory", "lancedb-namespaced", "old.db"), "utf8");
    assert.equal(safetyContent, "modified", "safety backup should contain pre-restore state");
  } finally {
    cleanup(home);
  }
});

test("restore rejects invalid snapshot path", SKIP, () => {
  const home = makeTempOpenclawHome();
  try {
    // Create a directory outside the snapshots root
    const evilDir = makeTempDir("plur1bus-evil-");
    writeFileSync(join(evilDir, "manifest.json"), "{}");

    let threw = false;
    try {
      runShell(`"${SCRIPT_DIR}/restore-snapshot.sh" "${evilDir}"`, {
        env: { ...process.env, OPENCLAW_HOME: home },
        encoding: "utf8",
      });
    } catch (e) {
      threw = true;
      assert.ok(e.stdout.includes("invalid snapshot path") || e.stderr.includes("invalid snapshot path") || e.message.includes("exit status"), "should reject invalid path");
    }
    assert.ok(threw, "should throw for invalid snapshot path");
  } finally {
    cleanup(home);
  }
});

test("restore rejects snapshot without manifest", SKIP, () => {
  const home = makeTempOpenclawHome();
  try {
    const snapshotsDir = join(home, ".snapshots");
    mkdirSync(snapshotsDir, { recursive: true });
    const badSnapshot = join(snapshotsDir, "bad-snapshot");
    mkdirSync(badSnapshot, { recursive: true });

    let threw = false;
    try {
      runShell(`"${SCRIPT_DIR}/restore-snapshot.sh" "${badSnapshot}"`, {
        env: { ...process.env, OPENCLAW_HOME: home },
        encoding: "utf8",
      });
    } catch (e) {
      threw = true;
      assert.ok(e.stdout.includes("manifest.json missing") || e.stderr.includes("manifest.json missing"), "should reject missing manifest");
    }
    assert.ok(threw, "should throw for snapshot without manifest");
  } finally {
    cleanup(home);
  }
});

// Engine audit snapshot 2: run-state.json and merge-proposals.jsonl live in the
// workspace (lib/metrics.js, lib/jobs/memory-compaction.js), not under memory/.
function writeWorkspaceFiles(workspace, runState, proposals) {
  mkdirSync(join(workspace, ".adaptive-learning"), { recursive: true });
  writeFileSync(join(workspace, "run-state.json"), runState);
  writeFileSync(join(workspace, ".adaptive-learning", "merge-proposals.jsonl"), proposals);
}

function backupOnce(home, extraEnv = {}) {
  runShell(`"${SCRIPT_DIR}/backup-snapshot.sh"`, { env: { ...process.env, OPENCLAW_HOME: home, ...extraEnv }, encoding: "utf8" });
  const snapshotsDir = join(home, ".snapshots");
  return join(snapshotsDir, readdirSync(snapshotsDir).find((e) => e.startsWith("plur1bus-")));
}

test("backup saves the workspace run-state and merge proposals, not the wrong memory/ copies", SKIP, () => {
  const home = makeTempOpenclawHome();
  try {
    mkdirSync(join(home, "memory", "lancedb-namespaced"), { recursive: true });
    writeFileSync(join(home, "memory", "lancedb-namespaced", "test.db"), "data");
    writeFileSync(join(home, "memory", "run-state.json"), "{\"stale\":true}");
    writeWorkspaceFiles(join(home, "workspace"), "{\"real\":1}", "{\"p\":1}\n");

    const snapshotPath = backupOnce(home);
    assert.equal(readFileSync(join(snapshotPath, "workspace", "run-state.json"), "utf8"), "{\"real\":1}");
    assert.equal(readFileSync(join(snapshotPath, "workspace", ".adaptive-learning", "merge-proposals.jsonl"), "utf8"), "{\"p\":1}\n");
    assert.ok(!existsSync(join(snapshotPath, "memory", "run-state.json")), "the memory/ lookalike is not what the engine writes");
  } finally {
    cleanup(home);
  }
});

test("restore --confirm puts the workspace files back", SKIP, () => {
  const home = makeTempOpenclawHome();
  try {
    mkdirSync(join(home, "memory", "lancedb-namespaced"), { recursive: true });
    writeFileSync(join(home, "memory", "lancedb-namespaced", "old.db"), "original");
    const workspace = join(home, "workspace");
    writeWorkspaceFiles(workspace, "{\"gen\":1}", "{\"gen\":1}\n");
    const snapshotPath = backupOnce(home);

    writeWorkspaceFiles(workspace, "{\"gen\":2}", "{\"gen\":2}\n");
    const out = runShell(`"${SCRIPT_DIR}/restore-snapshot.sh" --confirm "${snapshotPath}"`, {
      env: { ...process.env, OPENCLAW_HOME: home },
      encoding: "utf8",
    });
    assert.ok(out.includes("[RESTORED] workspace/run-state.json"), out);
    assert.equal(readFileSync(join(workspace, "run-state.json"), "utf8"), "{\"gen\":1}");
    assert.equal(readFileSync(join(workspace, ".adaptive-learning", "merge-proposals.jsonl"), "utf8"), "{\"gen\":1}\n");

    // the safety copy holds what was there before the restore
    const safety = readdirSync(join(home, ".snapshots")).find((e) => e.startsWith("pre-restore-safety-"));
    assert.equal(readFileSync(join(home, ".snapshots", safety, "workspace", "run-state.json"), "utf8"), "{\"gen\":2}");
  } finally {
    cleanup(home);
  }
});

test("a workspace outside OPENCLAW_HOME is saved and restored through OPENCLAW_WORKSPACE_DIR, and only its own files", SKIP, () => {
  const home = makeTempOpenclawHome();
  const outside = makeTempDir("plur1bus-snapshot-ws-");
  try {
    mkdirSync(join(home, "memory", "lancedb-namespaced"), { recursive: true });
    writeFileSync(join(home, "memory", "lancedb-namespaced", "old.db"), "original");
    writeWorkspaceFiles(outside, "{\"ws\":1}", "{\"ws\":1}\n");
    writeFileSync(join(outside, "SECRET.md"), "never copied");
    const env = { ...process.env, OPENCLAW_HOME: home, OPENCLAW_WORKSPACE_DIR: outside };
    const snapshotPath = backupOnce(home, { OPENCLAW_WORKSPACE_DIR: outside });
    assert.equal(readFileSync(join(snapshotPath, "workspace", "run-state.json"), "utf8"), "{\"ws\":1}");
    assert.ok(!existsSync(join(snapshotPath, "workspace", "SECRET.md")));

    writeWorkspaceFiles(outside, "{\"ws\":2}", "{\"ws\":2}\n");
    runShell(`"${SCRIPT_DIR}/restore-snapshot.sh" --confirm "${snapshotPath}"`, { env, encoding: "utf8" });
    assert.equal(readFileSync(join(outside, "run-state.json"), "utf8"), "{\"ws\":1}");
    assert.equal(readFileSync(join(outside, ".adaptive-learning", "merge-proposals.jsonl"), "utf8"), "{\"ws\":1}\n");
  } finally {
    cleanup(home);
    cleanup(outside);
  }
});

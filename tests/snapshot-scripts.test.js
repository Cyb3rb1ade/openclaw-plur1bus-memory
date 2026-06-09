import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const SCRIPT_DIR = new URL("../scripts/", import.meta.url).pathname;

// scripts/ is gitignored (operator-local helper scripts), so on a clean clone
// these scripts are absent. Skip rather than fail when they aren't present.
const SCRIPTS_PRESENT =
  existsSync(join(SCRIPT_DIR, "backup-snapshot.sh")) &&
  existsSync(join(SCRIPT_DIR, "restore-snapshot.sh"));
const SKIP = SCRIPTS_PRESENT
  ? {}
  : { skip: "scripts/*.sh not present (scripts/ is gitignored)" };

function makeTempOpenclawHome() {
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-snapshot-test-"));
  return dir;
}

function cleanup(dir) {
  try {
    execSync(`rm -rf "${dir}"`, { shell: true });
  } catch {
    // best effort
  }
}

test("backup creates snapshot with manifest and skips missing optional paths", SKIP, () => {
  const home = makeTempOpenclawHome();
  try {
    // Create only some of the backup paths
    mkdirSync(join(home, "memory", "lancedb-namespaced"), { recursive: true });
    writeFileSync(join(home, "memory", "lancedb-namespaced", "test.db"), "data");

    const out = execSync(`"${SCRIPT_DIR}/backup-snapshot.sh"`, {
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

    execSync(`"${SCRIPT_DIR}/backup-snapshot.sh"`, {
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

    execSync(`"${SCRIPT_DIR}/backup-snapshot.sh"`, {
      env: { ...process.env, OPENCLAW_HOME: home },
      encoding: "utf8",
    });

    const snapshotsDir = join(home, ".snapshots");
    const entries = readdirSync(snapshotsDir);
    const snapshotPath = join(snapshotsDir, entries[0]);

    // Modify the original
    writeFileSync(join(home, "memory", "lancedb-namespaced", "old.db"), "modified");

    // Dry-run restore
    const out = execSync(`"${SCRIPT_DIR}/restore-snapshot.sh" "${snapshotPath}"`, {
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

    execSync(`"${SCRIPT_DIR}/backup-snapshot.sh"`, {
      env: { ...process.env, OPENCLAW_HOME: home },
      encoding: "utf8",
    });

    const snapshotsDir = join(home, ".snapshots");
    const entries = readdirSync(snapshotsDir);
    const snapshotPath = join(snapshotsDir, entries[0]);

    // Modify original
    writeFileSync(join(home, "memory", "lancedb-namespaced", "old.db"), "modified");

    // Live restore
    execSync(`"${SCRIPT_DIR}/restore-snapshot.sh" --confirm "${snapshotPath}"`, {
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

    execSync(`"${SCRIPT_DIR}/backup-snapshot.sh"`, {
      env: { ...process.env, OPENCLAW_HOME: home },
      encoding: "utf8",
    });

    const snapshotsDir = join(home, ".snapshots");
    const entries = readdirSync(snapshotsDir);
    const snapshotPath = join(snapshotsDir, entries[0]);

    // Modify original
    writeFileSync(join(home, "memory", "lancedb-namespaced", "old.db"), "modified");

    // Live restore
    execSync(`"${SCRIPT_DIR}/restore-snapshot.sh" --confirm "${snapshotPath}"`, {
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
    const evilDir = mkdtempSync(join(tmpdir(), "plur1bus-evil-"));
    writeFileSync(join(evilDir, "manifest.json"), "{}");

    let threw = false;
    try {
      execSync(`"${SCRIPT_DIR}/restore-snapshot.sh" "${evilDir}"`, {
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
      execSync(`"${SCRIPT_DIR}/restore-snapshot.sh" "${badSnapshot}"`, {
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

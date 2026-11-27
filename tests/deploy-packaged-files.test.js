// tests/deploy-packaged-files.test.js
//
// Regression: the deploy repair path only reconciled DEPLOY_FILES (code). A
// production install of v7.20.2 had byte-identical code but October-era
// CHANGELOG.md, docs/configuration.md and emotional-state-injector/index.js,
// and was missing four docs that package.json `files` ships. Nothing of that
// is loaded at runtime, but the installed folder no longer matched the
// release.
//
// The advisory tier (listAuxiliaryPackagedFiles + syncAuxiliaryFiles) derives
// the extra files from package.json `files`, refreshes stale/missing ones with
// an archive before every overwrite, never deletes, and never changes the exit
// code of verify-plugin-deploy.mjs / repair-installed-plugin.mjs.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEPLOY_FILES,
  describeAuxiliaryReport,
  listAuxiliaryPackagedFiles,
  listPackagedFiles,
  repairBackupRoot,
  syncAuxiliaryFiles,
} from "../scripts/lib/deploy-integrity.mjs";
import { makeTempDir } from "./helpers/temp-dir.js";
import { spawnSyncBounded } from "./helpers/run-sync.js";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const VERIFY_SCRIPT = join(REPO_ROOT, "scripts", "verify-plugin-deploy.mjs");
const REPAIR_SCRIPT = join(REPO_ROOT, "scripts", "repair-installed-plugin.mjs");

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function read(root, rel) {
  return readFileSync(join(root, rel), "utf8");
}

function makeFixture() {
  const dir = makeTempDir("plur1bus-packaged-files-");
  const repoDir = join(dir, "repo");
  const deployDir = join(dir, "deploy");
  const backupDir = join(dir, "backup");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(deployDir, { recursive: true });
  write(repoDir, "package.json", JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    main: "./index.js",
    files: ["index.js", "docs/runbooks/", "docs/configuration.md", "CHANGELOG.md", "README.md"],
  }));
  write(repoDir, "index.js", "export default 1;\n");
  write(repoDir, "CHANGELOG.md", "# Changelog\n\n## 7.20.2\n");
  write(repoDir, "README.md", "# Readme\n");
  write(repoDir, "docs/configuration.md", "new configuration\n");
  write(repoDir, "docs/runbooks/recall-comparison.md", "runbook\n");
  return { dir, repoDir, deployDir, backupDir };
}

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((candidate) => candidate && /npm-cli\.js$/.test(candidate) && existsSync(candidate)) ?? null;
}

describe("listPackagedFiles", () => {
  it("matches the file list npm pack ships for this package", { skip: !npmCliPath() && "npm-cli.js not found" }, () => {
    const result = spawnSyncBounded(process.execPath, [npmCliPath(), "pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const npmFiles = JSON.parse(result.stdout)[0].files.map((f) => f.path).sort();
    const derived = listPackagedFiles(REPO_ROOT);
    assert.deepEqual(derived.errors, []);
    assert.deepEqual(derived.files, npmFiles);
  });

  it("walks directory entries, keeps file entries and adds npm's always-included root files", () => {
    const { repoDir } = makeFixture();
    write(repoDir, "LICENSE", "MIT\n");
    write(repoDir, "docs/runbooks/.DS_Store", "junk");
    write(repoDir, "docs/runbooks/node_modules/x.js", "junk");
    write(repoDir, "docs/other.md", "not shipped\n");
    write(repoDir, "OPERATOR-NOTES.md", "not shipped\n");

    const { files, errors } = listPackagedFiles(repoDir);
    assert.deepEqual(errors, []);
    assert.deepEqual(files, [
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "docs/configuration.md",
      "docs/runbooks/recall-comparison.md",
      "index.js",
      "package.json",
    ]);
  });

  it("reports glob and escaping entries instead of guessing, and skips missing entries like npm", () => {
    const { repoDir } = makeFixture();
    write(repoDir, "package.json", JSON.stringify({ files: ["docs/*.md", "../outside.md", "docs/missing.md", "README.md"] }));
    const { files, errors } = listPackagedFiles(repoDir);
    assert.deepEqual(files, ["README.md", "package.json"]);
    assert.deepEqual(errors, ["unsupported-files-entry:docs/*.md", "files-entry-escapes:../outside.md"]);
  });

  it("returns an empty list with a note when package.json has no files field", () => {
    const { repoDir } = makeFixture();
    write(repoDir, "package.json", JSON.stringify({ version: "1.0.0" }));
    assert.deepEqual(listPackagedFiles(repoDir), { files: [], errors: ["package-files-missing"] });
  });
});

describe("listAuxiliaryPackagedFiles", () => {
  it("covers the packaged docs, changelog, README and auxiliary extension but no DEPLOY_FILES entry", () => {
    const { files, errors } = listAuxiliaryPackagedFiles(REPO_ROOT);
    assert.deepEqual(errors, []);
    for (const expected of [
      "CHANGELOG.md",
      "README.md",
      "LICENSE",
      "docs/configuration.md",
      ".openclaw/extensions/emotional-state-injector/index.js",
    ]) {
      assert.ok(files.includes(expected), `advisory tier misses ${expected}`);
    }
    assert.ok(files.some((f) => f.startsWith("docs/runbooks/")), "advisory tier misses docs/runbooks/");
    assert.ok(files.some((f) => f.startsWith("docs/audits/")), "advisory tier misses docs/audits/");
    const strict = new Set(DEPLOY_FILES);
    assert.deepEqual(files.filter((f) => strict.has(f)), []);
  });
});

describe("syncAuxiliaryFiles", () => {
  let fx;
  beforeEach(() => {
    fx = makeFixture();
    for (const rel of ["CHANGELOG.md", "README.md", "docs/configuration.md", "docs/runbooks/recall-comparison.md"]) {
      write(fx.deployDir, rel, read(fx.repoDir, rel));
    }
  });

  const files = () => listAuxiliaryPackagedFiles(fx.repoDir, ["index.js", "package.json"]).files;

  it("reports a stale doc file in check mode without writing anything", () => {
    write(fx.deployDir, "CHANGELOG.md", "# Changelog\n\n## 7.12.0 (October)\n");
    const report = syncAuxiliaryFiles({ ...fx, files: files() });
    assert.equal(report.ok, false);
    assert.deepEqual(report.results.find((r) => r.file === "CHANGELOG.md"), { file: "CHANGELOG.md", status: "stale" });
    assert.match(read(fx.deployDir, "CHANGELOG.md"), /October/);
    assert.equal(existsSync(fx.backupDir), false);
  });

  it("refreshes a stale doc file after archiving the deployed version", () => {
    write(fx.deployDir, "docs/configuration.md", "october configuration\n");
    const report = syncAuxiliaryFiles({ ...fx, files: files(), refresh: true });
    assert.equal(report.ok, true);
    const result = report.results.find((r) => r.file === "docs/configuration.md");
    assert.equal(result.status, "refreshed");
    assert.equal(result.reason, "stale");
    assert.equal(read(fx.deployDir, "docs/configuration.md"), "new configuration\n");
    assert.equal(readFileSync(result.backupPath, "utf8"), "october configuration\n");
    assert.equal(result.backupPath, join(fx.backupDir, "docs", "configuration.md"));
  });

  it("restores a missing doc file, creating its directory, without needing a backup", () => {
    rmSync(join(fx.deployDir, "docs", "runbooks"), { recursive: true, force: true });
    const report = syncAuxiliaryFiles({ ...fx, files: files(), refresh: true, backupDir: null });
    assert.equal(report.ok, true);
    const result = report.results.find((r) => r.file === "docs/runbooks/recall-comparison.md");
    assert.deepEqual(result, { file: "docs/runbooks/recall-comparison.md", status: "refreshed", reason: "missing" });
    assert.equal(read(fx.deployDir, "docs/runbooks/recall-comparison.md"), "runbook\n");
  });

  it("preserves the source file mode on refresh", { skip: process.platform === "win32" && "POSIX modes" }, () => {
    write(fx.repoDir, "docs/runbooks/tool.sh", "#!/bin/sh\n");
    chmodSync(join(fx.repoDir, "docs/runbooks/tool.sh"), 0o755);
    syncAuxiliaryFiles({ ...fx, files: files(), refresh: true });
    assert.equal(statSync(join(fx.deployDir, "docs/runbooks/tool.sh")).mode & 0o777, 0o755);
  });

  it("writes nothing in dry-run mode", () => {
    write(fx.deployDir, "README.md", "old readme\n");
    rmSync(join(fx.deployDir, "docs", "configuration.md"));
    const report = syncAuxiliaryFiles({ ...fx, files: files(), refresh: true, dryRun: true });
    assert.equal(report.ok, false);
    assert.deepEqual(report.results.filter((r) => r.status !== "current"), [
      { file: "README.md", status: "stale", reason: "dry-run" },
      { file: "docs/configuration.md", status: "missing", reason: "dry-run" },
    ]);
    assert.equal(read(fx.deployDir, "README.md"), "old readme\n");
    assert.equal(existsSync(join(fx.deployDir, "docs", "configuration.md")), false);
    assert.equal(existsSync(fx.backupDir), false);
  });

  it("never deletes operator files outside the package file list", () => {
    write(fx.deployDir, "OPERATOR-NOTES.md", "mine\n");
    write(fx.deployDir, "docs/runbooks/local-only.md", "mine too\n");
    write(fx.deployDir, "README.md", "old readme\n");
    syncAuxiliaryFiles({ ...fx, files: files(), refresh: true });
    assert.equal(read(fx.deployDir, "OPERATOR-NOTES.md"), "mine\n");
    assert.equal(read(fx.deployDir, "docs/runbooks/local-only.md"), "mine too\n");
    assert.equal(read(fx.deployDir, "README.md"), "# Readme\n");
  });

  it("does not overwrite a stale file it cannot archive first", () => {
    write(fx.deployDir, "README.md", "old readme\n");
    const noBackup = syncAuxiliaryFiles({ ...fx, files: files(), refresh: true, backupDir: null });
    assert.deepEqual(noBackup.results.find((r) => r.file === "README.md"),
      { file: "README.md", status: "stale", reason: "no-backup-dir" });

    // An archive slot from earlier in the same run with other content must
    // not be silently reused: that would lose this version.
    write(fx.backupDir, "README.md", "a different archived version\n");
    const occupied = syncAuxiliaryFiles({ ...fx, files: files(), refresh: true });
    assert.deepEqual(occupied.results.find((r) => r.file === "README.md"),
      { file: "README.md", status: "stale", reason: "backup-failed" });
    assert.equal(read(fx.deployDir, "README.md"), "old readme\n");
    assert.equal(read(fx.backupDir, "README.md"), "a different archived version\n");
  });

  it("never writes through a symlink an operator placed in the deploy dir", (t) => {
    const outside = write(fx.dir, "outside/target.md", "outside content\n");
    rmSync(join(fx.deployDir, "README.md"));
    try {
      symlinkSync(outside, join(fx.deployDir, "README.md"));
    } catch {
      t.skip("symlinks not permitted on this runner");
      return;
    }
    const report = syncAuxiliaryFiles({ ...fx, files: files(), refresh: true });
    assert.deepEqual(report.results.find((r) => r.file === "README.md"),
      { file: "README.md", status: "skipped", reason: "deploy-path-not-regular-file" });
    assert.equal(readFileSync(outside, "utf8"), "outside content\n");
  });

  it("never writes below a directory symlink that leaves the deploy dir", (t) => {
    const outsideDir = join(fx.dir, "outside-docs");
    mkdirSync(outsideDir, { recursive: true });
    rmSync(join(fx.deployDir, "docs"), { recursive: true, force: true });
    try {
      symlinkSync(outsideDir, join(fx.deployDir, "docs"), "junction");
    } catch {
      t.skip("symlinks not permitted on this runner");
      return;
    }
    const report = syncAuxiliaryFiles({ ...fx, files: files(), refresh: true });
    for (const file of ["docs/configuration.md", "docs/runbooks/recall-comparison.md"]) {
      assert.deepEqual(report.results.find((r) => r.file === file),
        { file, status: "skipped", reason: "deploy-path-escapes" });
    }
    assert.deepEqual(readdirSync(outsideDir), []);
  });

  it("skips files whose source is missing instead of failing", () => {
    const report = syncAuxiliaryFiles({ ...fx, files: ["docs/not-in-source.md"], refresh: true });
    assert.deepEqual(report.results, [{ file: "docs/not-in-source.md", status: "skipped", reason: "missing-repo-source" }]);
  });

  it("describes drift as advisory", () => {
    write(fx.deployDir, "CHANGELOG.md", "old\n");
    const lines = describeAuxiliaryReport(syncAuxiliaryFiles({ ...fx, files: files() }), ["package-files-missing"]);
    assert.deepEqual(lines, [
      "NOTE    package file list: package-files-missing",
      "STALE   CHANGELOG.md",
      "3/4 packaged files current (advisory: never fails the check)",
    ]);
  });
});

describe("repairBackupRoot", () => {
  it("uses second resolution so two runs in one minute get separate archives", () => {
    const a = repairBackupRoot({ home: "/h", now: new Date("2026-11-21T15:09:12.345Z") });
    const b = repairBackupRoot({ home: "/h", now: new Date("2026-11-21T15:09:48.001Z") });
    assert.equal(a, join("/h", ".openclaw-backups", "plur1bus-repair-20261121T150912Z"));
    assert.notEqual(a, b);
  });
});

// ── CLI: a real deploy copy with a stale and a missing doc ─────────────────

function makeDeployCopy() {
  const dir = makeTempDir("plur1bus-packaged-cli-");
  const deployDir = join(dir, "deploy");
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  for (const rel of listPackagedFiles(REPO_ROOT).files) {
    mkdirSync(dirname(join(deployDir, rel)), { recursive: true });
    copyFileSync(join(REPO_ROOT, rel), join(deployDir, rel));
  }
  // The smoke test imports index.js: resolve dependencies from this checkout.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(deployDir, "node_modules"), "junction");
  const docs = listAuxiliaryPackagedFiles(REPO_ROOT).files;
  const missingDoc = docs.find((f) => f.startsWith("docs/runbooks/"));
  write(deployDir, "CHANGELOG.md", "# Changelog\n\n## October-era release\n");
  rmSync(join(deployDir, missingDoc));
  return { dir, deployDir, home, missingDoc };
}

function run(script, args, home, cwd = REPO_ROOT) {
  const r = spawnSyncBounded(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function backups(home) {
  const root = join(home, ".openclaw-backups");
  return existsSync(root) ? readdirSync(root).map((name) => join(root, name)) : [];
}

describe("verify-plugin-deploy.mjs — packaged files", () => {
  it("check-only reports a stale and a missing doc but still passes", () => {
    const { deployDir, home, missingDoc } = makeDeployCopy();
    const r = run(VERIFY_SCRIPT, ["--repo-dir", REPO_ROOT, "--deploy-dir", deployDir], home);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /STALE {3}CHANGELOG\.md/);
    assert.ok(r.stdout.includes(`MISSING ${missingDoc}`), r.stdout);
    assert.match(r.stdout, /\[deploy-integrity\] PASS/);
    assert.match(read(deployDir, "CHANGELOG.md"), /October-era/);
    assert.deepEqual(backups(home), []);
  });

  it("--repair refreshes both, archives the stale one and keeps operator files", () => {
    const { deployDir, home, missingDoc } = makeDeployCopy();
    write(deployDir, "OPERATOR-NOTES.md", "mine\n");
    const r = run(VERIFY_SCRIPT, ["--repair", "--repo-dir", REPO_ROOT, "--deploy-dir", deployDir], home);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /FIXED {3}CHANGELOG\.md {2}\(stale\)/);
    assert.equal(read(deployDir, "CHANGELOG.md"), read(REPO_ROOT, "CHANGELOG.md"));
    assert.equal(read(deployDir, missingDoc), read(REPO_ROOT, missingDoc));
    assert.equal(read(deployDir, "OPERATOR-NOTES.md"), "mine\n");
    const [backupDir] = backups(home);
    assert.ok(backupDir, "an archive directory must exist");
    assert.match(read(backupDir, "CHANGELOG.md"), /October-era/);
  });

  it("--repair leaves docs alone when the strict tier rejects the source release", () => {
    const { deployDir, home, missingDoc } = makeDeployCopy();
    const r = run(VERIFY_SCRIPT, [
      "--repair", "--expected-version", "0.0.0-not-this-release", "--repo-dir", REPO_ROOT, "--deploy-dir", deployDir,
    ], home);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /refresh skipped: strict deploy-integrity check failed/);
    assert.match(read(deployDir, "CHANGELOG.md"), /October-era/);
    assert.equal(existsSync(join(deployDir, missingDoc)), false);
  });
});

describe("repair-installed-plugin.mjs — packaged files", () => {
  it("refreshes a stale and a missing doc, archives first, exit code unaffected", () => {
    const { deployDir, home, missingDoc } = makeDeployCopy();
    const r = run(REPAIR_SCRIPT, ["--deploy-dir", deployDir, "--no-smoke"], home);
    assert.ok(r.status === 0 || r.status === 3, `unexpected exit ${r.status}\n${r.stdout}${r.stderr}`);
    assert.equal(read(deployDir, "CHANGELOG.md"), read(REPO_ROOT, "CHANGELOG.md"));
    assert.equal(read(deployDir, missingDoc), read(REPO_ROOT, missingDoc));
    const [backupDir] = backups(home);
    assert.ok(backupDir, "an archive directory must exist");
    assert.match(read(backupDir, "CHANGELOG.md"), /October-era/);
    assert.match(r.stdout, /Packaged files: {4}✓ current/);
  });

  it("dry-run reports the drift and changes nothing", () => {
    const { deployDir, home, missingDoc } = makeDeployCopy();
    const r = run(REPAIR_SCRIPT, ["--deploy-dir", deployDir, "--no-smoke", "--dry-run"], home);
    assert.ok(r.status === 0 || r.status === 3, `unexpected exit ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /STALE {3}CHANGELOG\.md {2}\(dry-run\)/);
    assert.match(r.stdout, /Packaged files: {4}⚠ drift \(advisory\)/);
    assert.match(read(deployDir, "CHANGELOG.md"), /October-era/);
    assert.equal(existsSync(join(deployDir, missingDoc)), false);
    assert.deepEqual(backups(home), []);
  });
});

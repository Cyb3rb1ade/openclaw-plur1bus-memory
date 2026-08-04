import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as lancedb from "@lancedb/lancedb";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..");
const MAINTAIN_SCRIPT = join(REPO_ROOT, "scripts", "maintain-lancedb.mjs");
const MIGRATE_SCRIPT = join(REPO_ROOT, "scripts", "migrate-missing-columns.mjs");
const REPAIR_SCRIPT = join(REPO_ROOT, "scripts", "repair-installed-plugin.mjs");
const DEPLOY_GUARD = join(REPO_ROOT, "scripts", "protect-plur1bus-deploy.sh");
const DEPLOY_CHECKER = join(REPO_ROOT, "scripts", "lib", "deploy-integrity.mjs");
const REINDEX_SCRIPT = join(REPO_ROOT, "scripts", "reindex-provider.mjs");
const DREAMING_CRON_ID = "12345678-1234-1234-1234-123456789abc";

function makeTempDir(prefix) {
  // realpathSync: macOS tmpdir is a symlink (/var -> /private/var) and the
  // production code resolves real paths, so expectations must match.
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function runNode(script, args = [], { env = {}, cwd = REPO_ROOT, timeout = 30_000 } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout,
  });
  return {
    ...result,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function writeExecutable(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

function writeManifests(versionsDir, count, extension = ".manifest") {
  mkdirSync(versionsDir, { recursive: true });
  for (let index = 0; index < count; index++) {
    const name = `${String(index).padStart(5, "0")}${extension}`;
    writeFileSync(join(versionsDir, name), JSON.stringify({ index }));
  }
}

function snapshotTree(root) {
  const snapshot = new Map();
  const visit = (current, relative = ".") => {
    const stat = lstatSync(current);
    const record = {
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      type: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
    };
    if (stat.isFile()) record.content = readFileSync(current, "utf8");
    snapshot.set(relative, record);
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      visit(join(current, entry.name), relative === "." ? entry.name : join(relative, entry.name));
    }
  };
  visit(root);
  return [...snapshot.entries()];
}

async function createLegacyMemoriesDb(dbPath, id) {
  mkdirSync(dbPath, { recursive: true });
  const db = await lancedb.connect(dbPath);
  await db.createTable("memories", [{
    id,
    text: `legacy-${id}`,
    vector: new Float32Array([0.1, 0.2, 0.3, 0.4]),
    importance: 0.5,
    category: "fact",
    createdAt: 1,
  }], { mode: "overwrite" });
  await db.close();
}

async function readDbState(dbPath) {
  const db = await lancedb.connect(dbPath);
  const table = await db.openTable("memories");
  const schema = await table.schema();
  const rows = await table.query().toArray();
  await db.close();
  return { fields: new Set(schema.fields.map((field) => field.name)), rows };
}

function installFakeOpenClaw(binDir) {
  writeExecutable(join(binDir, "openclaw"), "#!/bin/sh\nexit 1\n");
}

function installDreamingCronOpenClaw(binDir) {
  writeExecutable(join(binDir, "openclaw"), `#!/bin/sh
printf '%s\\n' "$*" >> "$PLUR1BUS_OPENCLAW_CALL_LOG"
if [ "$1" = "cron" ] && [ "$2" = "list" ]; then
  printf '%s\\n' "${DREAMING_CRON_ID} Memory Dreaming Promotion error"
  exit 0
fi
if [ "$1" = "cron" ] && [ "$2" = "run" ]; then
  exit 0
fi
exit 1
`);
}

function makeElevatedHome(root, count = 501) {
  const versionsDir = join(root, ".openclaw", "memory", "lancedb-namespaced", "main", "memories.lance", "_versions");
  writeManifests(versionsDir, count);
  return versionsDir;
}

function installGnuCompatShims(binDir) {
  // scripts/protect-plur1bus-deploy.sh is written for GNU userland
  // (`stat -c`, `realpath -e/--`); macOS ships BSD stat/realpath without
  // those flags. Shim the two GNU-isms so the tests exercise the guard's
  // logic instead of host tool availability.
  writeExecutable(join(binDir, "stat"), `#!/bin/sh
if [ "x$1" = "x-c" ]; then
  fmt="$2"
  shift 2
  [ "x$1" = "x--" ] && shift
  exec /usr/bin/stat -f "$fmt" "$@"
fi
exec /usr/bin/stat "$@"
`);
  writeExecutable(join(binDir, "realpath"), `#!/bin/sh
must_exist=0
if [ "x$1" = "x-e" ]; then
  must_exist=1
  shift
fi
[ "x$1" = "x--" ] && shift
if [ "$must_exist" = 1 ] && [ ! -e "$1" ]; then
  exit 1
fi
exec /bin/realpath "$1"
`);
}

function copyDeployGuard(root, checkerMode = "valid") {
  const scriptPath = join(root, "repo", "scripts", "protect-plur1bus-deploy.sh");
  const checkerPath = join(root, "repo", "scripts", "lib", "deploy-integrity.mjs");
  mkdirSync(dirname(scriptPath), { recursive: true });
  copyFileSync(DEPLOY_GUARD, scriptPath);
  chmodSync(scriptPath, 0o755);
  if (checkerMode === "valid") {
    mkdirSync(dirname(checkerPath), { recursive: true });
    copyFileSync(DEPLOY_CHECKER, checkerPath);
  } else if (checkerMode === "broken") {
    mkdirSync(dirname(checkerPath), { recursive: true });
    writeFileSync(checkerPath, "export const detectBrokenStub = ;\n");
  } else if (checkerMode === "symlink") {
    mkdirSync(dirname(checkerPath), { recursive: true });
    symlinkSync(DEPLOY_CHECKER, checkerPath);
  }
  return { scriptPath, checkerPath };
}

function makeDeployFixture({ checkerMode = "valid", sourceContent, deployContent }) {
  const root = makeTempDir("plur1bus-b9-deploy-");
  const { scriptPath } = copyDeployGuard(root, checkerMode);
  const sourceDir = join(root, "source");
  const deployDir = join(root, "deploy");
  const sourceFile = join(sourceDir, "lib", "neo-arch.js");
  const deployFile = join(deployDir, "lib", "neo-arch.js");
  mkdirSync(dirname(sourceFile), { recursive: true });
  mkdirSync(dirname(deployFile), { recursive: true });
  writeFileSync(sourceFile, sourceContent);
  writeFileSync(deployFile, deployContent);
  const compatBinDir = join(root, "compat-bin");
  installGnuCompatShims(compatBinDir);
  return {
    root,
    scriptPath,
    sourceDir,
    deployDir,
    sourceFile,
    deployFile,
    compatBinDir,
    logPath: join(root, "protect.log"),
    backupRoot: join(root, "backups"),
  };
}

function runDeployGuard(fixture, env = {}) {
  const { PATH: envPath, ...restEnv } = env;
  const result = spawnSync("bash", [fixture.scriptPath], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: join(fixture.root, "home"),
      OPENCLAW_HOME: join(fixture.root, "home", ".openclaw"),
      PLUR1BUS_SRC: fixture.sourceDir,
      PLUR1BUS_DEPLOY: fixture.deployDir,
      PLUR1BUS_LOG: fixture.logPath,
      PLUR1BUS_BACKUP_DIR: fixture.backupRoot,
      PLUR1BUS_NO_RESTART: "1",
      ...restEnv,
      PATH: `${fixture.compatBinDir}:${envPath ?? process.env.PATH}`,
    },
    timeout: 30_000,
  });
  return {
    ...result,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    log: existsSync(fixture.logPath) ? readFileSync(fixture.logPath, "utf8") : "",
  };
}

// scripts/protect-plur1bus-deploy.sh requires bash >= 4 (associative arrays,
// `declare -A`); runDeployGuard invokes `bash` resolved from PATH, so probe
// exactly that interpreter. macOS ships bash 3.2, where the full-restore-path
// tests below cannot run — on Linux (bash 4+) they execute unchanged.
const requiresModernBash = (() => {
  const probe = spawnSync("bash", ["-c", 'printf "%s" "$BASH_VERSINFO"'], { encoding: "utf8" });
  const major = Number.parseInt(probe.stdout ?? "", 10);
  return major >= 4
    ? {}
    : { skip: "protect-plur1bus-deploy.sh requires bash >= 4 (associative arrays); not available on this host" };
})();

describe("B9 maintain-lancedb retention boundary", () => {
  const invalidKeepCases = [
    { label: "negative", value: "-100" },
    { label: "zero", value: "0" },
    { label: "negative zero", value: "-0" },
    { label: "fraction", value: "1.5" },
    { label: "NaN", value: "NaN" },
    { label: "infinity", value: "Infinity" },
    { label: "numeric prefix", value: "10garbage" },
    { label: "exponent notation", value: "1e2" },
    { label: "above the documented 100000 limit", value: "100001" },
  ];

  for (const { label, value } of invalidKeepCases) {
    it(`rejects ${label} --keep before planning or mutation`, () => {
      const root = makeTempDir("plur1bus-b9-keep-");
      try {
        const base = join(root, "db");
        const versionsDir = join(base, "main", "memories.lance", "_versions");
        writeManifests(versionsDir, 4);
        const before = snapshotTree(base);

        const result = runNode(MAINTAIN_SCRIPT, ["--apply", "--keep", value, "--db-path", base], {
          env: { HOME: root },
        });

        assert.equal(result.status, 1, result.output);
        assert.match(result.stderr, /--keep/i);
        assert.deepEqual(snapshotTree(base), before, "invalid retention must leave contents and mtimes unchanged");
        assert.equal(existsSync(join(root, ".openclaw-backups")), false, "invalid retention must not create a backup");
        assert.doesNotMatch(result.stdout, /Tables scanned|would prune|pruning/i);
      } finally {
        removeTempDir(root);
      }
    });
  }

  it("rejects a missing --keep value before planning or mutation", () => {
    const root = makeTempDir("plur1bus-b9-keep-missing-");
    try {
      const base = join(root, "db");
      const versionsDir = join(base, "main", "memories.lance", "_versions");
      writeManifests(versionsDir, 4);
      const before = snapshotTree(base);
      const result = runNode(MAINTAIN_SCRIPT, ["--db-path", base, "--apply", "--keep"], { env: { HOME: root } });

      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, /--keep/i);
      assert.deepEqual(snapshotTree(base), before);
      assert.equal(existsSync(join(root, ".openclaw-backups")), false);
    } finally {
      removeTempDir(root);
    }
  });

  it("rejects invalid --keep=value before planning or mutation", () => {
    const root = makeTempDir("plur1bus-b9-keep-equals-invalid-");
    try {
      const base = join(root, "db");
      const versionsDir = join(base, "main", "memories.lance", "_versions");
      writeManifests(versionsDir, 60);
      const before = snapshotTree(base);

      const result = runNode(MAINTAIN_SCRIPT, ["--apply", "--keep=-100", "--db-path", base], {
        env: { HOME: root },
      });

      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, /--keep must be a positive decimal integer between 1 and 100000/i);
      assert.deepEqual(snapshotTree(base), before);
      assert.equal(existsSync(join(root, ".openclaw-backups")), false);
      assert.doesNotMatch(result.stdout, /Tables scanned|would prune|pruning|backup root/i);
    } finally {
      removeTempDir(root);
    }
  });

  it("accepts valid --keep=value through strict retention parsing", () => {
    const root = makeTempDir("plur1bus-b9-keep-equals-valid-");
    try {
      const base = join(root, "db");
      const versionsDir = join(base, "main", "memories.lance", "_versions");
      writeManifests(versionsDir, 5);

      const result = runNode(MAINTAIN_SCRIPT, ["--db-path", base, "--apply", "--keep=3"], {
        env: { HOME: root },
      });

      assert.equal(result.status, 0, result.output);
      assert.equal(readdirSync(versionsDir).filter((name) => name.endsWith(".manifest")).length, 3);
      assert.match(result.stdout, /keep=3/);
      assert.match(result.stdout, /verified[^\n]*3|3[^\n]*verified/i);
      assert.ok(readdirSync(join(root, ".openclaw-backups"), { recursive: true })
        .map(String).some((name) => name.endsWith("_prune-manifest.json")));
    } finally {
      removeTempDir(root);
    }
  });

  it("rejects unknown arguments before planning or mutation", () => {
    const root = makeTempDir("plur1bus-b9-unknown-argument-");
    try {
      const base = join(root, "db");
      const versionsDir = join(base, "main", "memories.lance", "_versions");
      writeManifests(versionsDir, 5);
      const before = snapshotTree(base);

      const result = runNode(
        MAINTAIN_SCRIPT,
        ["--db-path", base, "--apply", "--keep", "3", "--typo"],
        { env: { HOME: root } },
      );

      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, /Unknown argument: --typo/);
      assert.deepEqual(snapshotTree(base), before);
      assert.equal(existsSync(join(root, ".openclaw-backups")), false);
      assert.doesNotMatch(result.stdout, /Tables scanned|would prune|pruning|backup root/i);
    } finally {
      removeTempDir(root);
    }
  });

  it("rejects undocumented --db-path=value before discovery", () => {
    const root = makeTempDir("plur1bus-b9-db-path-equals-");
    try {
      const base = join(root, "db");
      const versionsDir = join(base, "main", "memories.lance", "_versions");
      writeManifests(versionsDir, 5);
      const before = snapshotTree(base);

      const result = runNode(
        MAINTAIN_SCRIPT,
        ["--apply", "--keep", "3", `--db-path=${base}`],
        { env: { HOME: root } },
      );

      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, /Unknown argument: --db-path=/);
      assert.deepEqual(snapshotTree(base), before);
      assert.equal(existsSync(join(root, ".openclaw-backups")), false);
      assert.doesNotMatch(result.stdout, /Tables scanned|would prune|pruning|backup root/i);
    } finally {
      removeTempDir(root);
    }
  });

  it("keeps a valid positive value, backs up first, and reports the verified end state", () => {
    const root = makeTempDir("plur1bus-b9-keep-valid-");
    try {
      const base = join(root, "db");
      const versionsDir = join(base, "main", "memories.lance", "_versions");
      writeManifests(versionsDir, 5);
      const result = runNode(MAINTAIN_SCRIPT, ["--db-path", base, "--apply", "--keep", "3"], { env: { HOME: root } });

      assert.equal(result.status, 0, result.output);
      assert.equal(readdirSync(versionsDir).filter((name) => name.endsWith(".manifest")).length, 3);
      assert.match(result.stdout, /verified[^\n]*3|3[^\n]*verified/i);
      const backupRoot = join(root, ".openclaw-backups");
      const backupFiles = readdirSync(backupRoot, { recursive: true }).map(String);
      assert.ok(backupFiles.some((name) => name.endsWith("_prune-manifest.json")));
    } finally {
      removeTempDir(root);
    }
  });

  it("preserves file and directory mtimes during a dry-run", () => {
    const root = makeTempDir("plur1bus-b9-keep-dry-");
    try {
      const base = join(root, "db");
      const versionsDir = join(base, "main", "memories.lance", "_versions");
      writeManifests(versionsDir, 5);
      const before = snapshotTree(base);
      const result = runNode(MAINTAIN_SCRIPT, ["--db-path", base, "--keep", "3"], { env: { HOME: root } });

      assert.equal(result.status, 0, result.output);
      assert.deepEqual(snapshotTree(base), before);
      assert.equal(existsSync(join(root, ".openclaw-backups")), false);
    } finally {
      removeTempDir(root);
    }
  });

  it("rejects an _versions symlink without touching its external target", () => {
    const root = makeTempDir("plur1bus-b9-versions-link-");
    try {
      const base = join(root, "db");
      const tableDir = join(base, "main", "memories.lance");
      const external = join(root, "external-versions");
      mkdirSync(tableDir, { recursive: true });
      writeManifests(external, 4);
      symlinkSync(external, join(tableDir, "_versions"));
      const before = snapshotTree(external);

      const result = runNode(MAINTAIN_SCRIPT, ["--db-path", base, "--apply", "--keep", "2"], { env: { HOME: root } });

      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, /symlink|contain|unsafe/i);
      assert.deepEqual(snapshotTree(external), before);
      assert.equal(existsSync(join(root, ".openclaw-backups")), false);
    } finally {
      removeTempDir(root);
    }
  });

  it("rejects an invalid agent directory before pruning any target", () => {
    const root = makeTempDir("plur1bus-b9-agent-id-");
    try {
      const base = join(root, "db");
      const safeVersions = join(base, "main", "memories.lance", "_versions");
      const unsafeVersions = join(base, "bad..agent", "memories.lance", "_versions");
      writeManifests(safeVersions, 4);
      writeManifests(unsafeVersions, 4);
      const before = snapshotTree(base);

      const result = runNode(MAINTAIN_SCRIPT, ["--db-path", base, "--apply", "--keep", "2"], { env: { HOME: root } });

      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, /agent|unsafe|invalid/i);
      assert.deepEqual(snapshotTree(base), before);
      assert.equal(existsSync(join(root, ".openclaw-backups")), false);
    } finally {
      removeTempDir(root);
    }
  });
});

describe("B9 repair-installed-plugin maintenance verification", () => {
  it("keeps --dry-run non-mutating when maintenance is requested", () => {
    const root = makeTempDir("plur1bus-b9-repair-dry-");
    try {
      const versionsDir = makeElevatedHome(root);
      const binDir = join(root, "bin");
      installFakeOpenClaw(binDir);
      const before = snapshotTree(join(root, ".openclaw"));
      const result = runNode(REPAIR_SCRIPT, ["--dry-run", "--maintain-lancedb", "--no-smoke"], {
        env: { HOME: root, PATH: `${binDir}:${process.env.PATH}`, PLUR1BUS_DEPLOY: REPO_ROOT },
      });

      assert.equal(result.status, 3, result.output);
      assert.deepEqual(snapshotTree(join(root, ".openclaw")), before);
      assert.equal(readdirSync(versionsDir).filter((name) => name.endsWith(".manifest")).length, 501);
      assert.equal(existsSync(join(root, ".openclaw-backups")), false);
      assert.match(result.stdout, /dry-run|would run|würde/i);
    } finally {
      removeTempDir(root);
    }
  });

  it("lists but never runs an errored cron during --dry-run --run-cron", () => {
    const root = makeTempDir("plur1bus-b9-repair-cron-dry-");
    try {
      const binDir = join(root, "bin");
      const callLog = join(root, "openclaw-calls.log");
      installDreamingCronOpenClaw(binDir);

      const result = runNode(REPAIR_SCRIPT, ["--dry-run", "--run-cron", "--no-smoke"], {
        env: {
          HOME: root,
          PATH: `${binDir}:${process.env.PATH}`,
          PLUR1BUS_DEPLOY: REPO_ROOT,
          PLUR1BUS_OPENCLAW_CALL_LOG: callLog,
        },
      });

      assert.ok(existsSync(callLog), result.output);
      assert.deepEqual(readFileSync(callLog, "utf8").trim().split("\n"), ["cron list"], result.output);
      assert.equal(result.status, 3, result.output);
      assert.match(result.stdout, /dry-run[^\n]*would|would[^\n]*cron run/i);
    } finally {
      removeTempDir(root);
    }
  });

  it("still runs an errored cron when --run-cron is applying", () => {
    const root = makeTempDir("plur1bus-b9-repair-cron-apply-");
    try {
      const binDir = join(root, "bin");
      const callLog = join(root, "openclaw-calls.log");
      installDreamingCronOpenClaw(binDir);

      const result = runNode(REPAIR_SCRIPT, ["--run-cron", "--no-smoke"], {
        env: {
          HOME: root,
          PATH: `${binDir}:${process.env.PATH}`,
          PLUR1BUS_DEPLOY: REPO_ROOT,
          PLUR1BUS_OPENCLAW_CALL_LOG: callLog,
        },
      });

      assert.equal(result.status, 3, result.output);
      assert.deepEqual(readFileSync(callLog, "utf8").trim().split("\n"), [
        "cron list",
        `cron run ${DREAMING_CRON_ID}`,
      ]);
      assert.match(result.stdout, /Cron triggered/i);
    } finally {
      removeTempDir(root);
    }
  });

  it("re-diagnoses after successful maintenance and reports the verified healthy state", () => {
    const root = makeTempDir("plur1bus-b9-repair-ok-");
    try {
      const versionsDir = makeElevatedHome(root);
      const binDir = join(root, "bin");
      installFakeOpenClaw(binDir);
      const result = runNode(REPAIR_SCRIPT, ["--maintain-lancedb", "--no-smoke"], {
        env: {
          HOME: root,
          PATH: `${binDir}:${process.env.PATH}`,
          PLUR1BUS_DEPLOY: REPO_ROOT,
        },
        timeout: 60_000,
      });

      assert.equal(result.status, 0, result.output);
      assert.equal(readdirSync(versionsDir).filter((name) => name.endsWith(".manifest")).length, 50);
      assert.match(result.stdout, /LanceDB versions:\s+✓ OK/);
    } finally {
      removeTempDir(root);
    }
  });

  it("propagates a nonzero maintenance child exit", () => {
    const root = makeTempDir("plur1bus-b9-repair-exit-");
    try {
      const versionsDir = makeElevatedHome(root);
      const binDir = join(root, "bin");
      installFakeOpenClaw(binDir);
      writeExecutable(join(binDir, "node"), "#!/bin/sh\nexit 17\n");
      const result = runNode(REPAIR_SCRIPT, ["--maintain-lancedb", "--no-smoke"], {
        env: { HOME: root, PATH: `${binDir}:${process.env.PATH}`, PLUR1BUS_DEPLOY: REPO_ROOT },
      });

      assert.equal(result.status, 2, result.output);
      assert.match(result.output, /maintenance|maintain-lancedb/i);
      assert.match(result.output, /17/);
      assert.equal(readdirSync(versionsDir).filter((name) => name.endsWith(".manifest")).length, 501);
    } finally {
      removeTempDir(root);
    }
  });

  it("propagates a signalled maintenance child", () => {
    const root = makeTempDir("plur1bus-b9-repair-signal-");
    try {
      makeElevatedHome(root);
      const binDir = join(root, "bin");
      installFakeOpenClaw(binDir);
      writeExecutable(join(binDir, "node"), "#!/bin/sh\nkill -TERM $$\n");
      const result = runNode(REPAIR_SCRIPT, ["--maintain-lancedb", "--no-smoke"], {
        env: { HOME: root, PATH: `${binDir}:${process.env.PATH}`, PLUR1BUS_DEPLOY: REPO_ROOT },
      });

      assert.equal(result.status, 2, result.output);
      assert.match(result.output, /SIGTERM|signal/i);
    } finally {
      removeTempDir(root);
    }
  });

  it("rejects timeout result tuples without weakening the production timeout", () => {
    const root = makeTempDir("plur1bus-b9-repair-timeout-");
    try {
      const binDir = join(root, "bin");
      installFakeOpenClaw(binDir);
      const probe = `
        process.argv = [process.execPath, "import-probe", "--no-smoke", "--deploy-dir", ${JSON.stringify(REPO_ROOT)}];
        const { assertSuccessfulMaintenanceResult } = await import(${JSON.stringify(pathToFileURL(REPAIR_SCRIPT).href)});
        const timeout = Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" });
        assertSuccessfulMaintenanceResult({ status: 0, signal: null, error: undefined });
        try {
          assertSuccessfulMaintenanceResult({ status: null, signal: "SIGTERM", error: timeout });
          process.exitCode = 9;
        } catch (error) {
          if (!/ETIMEDOUT|timed out|timeout/i.test(error.message)) process.exitCode = 8;
          else console.log("TIMEOUT_REJECTED");
        }
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          PATH: `${binDir}:${process.env.PATH}`,
          PLUR1BUS_DEPLOY: REPO_ROOT,
        },
        timeout: 30_000,
      });

      assert.equal(result.status, 0, `${result.stdout ?? ""}${result.stderr ?? ""}`);
      assert.match(result.stdout ?? "", /TIMEOUT_REJECTED/);
    } finally {
      removeTempDir(root);
    }
  });
});

describe("B9 migrate-missing-columns per-agent selection", () => {
  it("enumerates and migrates every valid agent DB by default", async () => {
    const root = makeTempDir("plur1bus-b9-migrate-multi-");
    try {
      const base = join(root, ".openclaw", "memory", "lancedb-namespaced");
      const alpha = join(base, "alpha");
      const beta = join(base, "beta_2");
      await createLegacyMemoriesDb(alpha, "alpha-row");
      await createLegacyMemoriesDb(beta, "beta-row");

      const result = runNode(MIGRATE_SCRIPT, [], { env: { HOME: root }, timeout: 60_000 });

      assert.equal(result.status, 0, result.output);
      for (const [agent, path, id] of [["alpha", alpha, "alpha-row"], ["beta_2", beta, "beta-row"]]) {
        const state = await readDbState(path);
        assert.ok(state.fields.has("workspaceKey"), `${agent} must be migrated`);
        assert.deepEqual(state.rows.map((row) => row.id), [id], `${agent} rows must be preserved`);
        assert.match(result.stdout, new RegExp(agent));
        assert.match(result.stdout, new RegExp(`${agent}[^\\n]*(verified|verifiziert)|verified[^\\n]*${agent}|verifiziert[^\\n]*${agent}`, "i"));
      }
    } finally {
      removeTempDir(root);
    }
  });

  it("continues after a missing memories table and exits nonzero after reporting every target", async () => {
    const root = makeTempDir("plur1bus-b9-migrate-partial-");
    try {
      const base = join(root, ".openclaw", "memory", "lancedb-namespaced");
      const good = join(base, "good");
      const missing = join(base, "missing");
      await createLegacyMemoriesDb(good, "good-row");
      mkdirSync(missing, { recursive: true });

      const result = runNode(MIGRATE_SCRIPT, [], { env: { HOME: root }, timeout: 60_000 });

      assert.equal(result.status, 1, result.output);
      assert.ok((await readDbState(good)).fields.has("workspaceKey"));
      assert.match(result.output, /good/);
      assert.match(result.output, /missing/);
      assert.match(result.output, /Tabelle 'memories'|table 'memories'/i);
    } finally {
      removeTempDir(root);
    }
  });

  it("rejects an enumerated symlink target, continues safe agents, and does not migrate outside the base", async () => {
    const root = makeTempDir("plur1bus-b9-migrate-link-");
    try {
      const base = join(root, ".openclaw", "memory", "lancedb-namespaced");
      const safe = join(base, "safe");
      const external = join(root, "external-agent");
      await createLegacyMemoriesDb(safe, "safe-row");
      await createLegacyMemoriesDb(external, "external-row");
      symlinkSync(external, join(base, "linked"));

      const result = runNode(MIGRATE_SCRIPT, [], { env: { HOME: root }, timeout: 60_000 });

      assert.equal(result.status, 1, result.output);
      assert.ok((await readDbState(safe)).fields.has("workspaceKey"), "safe agent should still migrate");
      assert.equal((await readDbState(external)).fields.has("workspaceKey"), false, "symlink target must stay untouched");
      assert.match(result.output, /linked/);
      assert.match(result.output, /symlink|unsafe|contain/i);
    } finally {
      removeTempDir(root);
    }
  });

  it("preserves explicit single-DB path support", async () => {
    const root = makeTempDir("plur1bus-b9-migrate-explicit-");
    try {
      const dbPath = join(root, "custom-db");
      await createLegacyMemoriesDb(dbPath, "custom-row");

      const result = runNode(MIGRATE_SCRIPT, [dbPath], { env: { HOME: root }, timeout: 60_000 });

      assert.equal(result.status, 0, result.output);
      const state = await readDbState(dbPath);
      assert.ok(state.fields.has("workspaceKey"));
      assert.deepEqual(state.rows.map((row) => row.id), ["custom-row"]);
    } finally {
      removeTempDir(root);
    }
  });
});

describe("B9 protect-plur1bus-deploy fail-closed checker", () => {
  const safeSource = "export const isInjectedContextText = 'new';\n";
  const oldDeploy = "export const isInjectedContextText = 'old';\n";

  for (const checkerMode of ["missing", "broken", "symlink"]) {
    it(`fails before backup or restore when the repository-relative checker is ${checkerMode}`, () => {
      const fixture = makeDeployFixture({ checkerMode, sourceContent: safeSource, deployContent: oldDeploy });
      try {
        const result = runDeployGuard(fixture);

        assert.equal(result.status, 1, `${result.stdout}${result.stderr}\n${result.log}`);
        assert.equal(readFileSync(fixture.deployFile, "utf8"), oldDeploy);
        assert.equal(existsSync(fixture.backupRoot), false, "checker preflight must finish before backup");
        assert.match(result.log, /checker|integrity/i);
      } finally {
        removeTempDir(fixture.root);
      }
    });
  }

  it("preserves installed-guard repair via the checker in the canonical source repository", requiresModernBash, () => {
    const fixture = makeDeployFixture({ checkerMode: "missing", sourceContent: safeSource, deployContent: oldDeploy });
    try {
      const sourceChecker = join(fixture.sourceDir, "scripts", "lib", "deploy-integrity.mjs");
      mkdirSync(dirname(sourceChecker), { recursive: true });
      copyFileSync(DEPLOY_CHECKER, sourceChecker);

      const result = runDeployGuard(fixture);

      assert.equal(result.status, 0, `${result.stdout}${result.stderr}\n${result.log}`);
      assert.equal(readFileSync(fixture.deployFile, "utf8"), safeSource);
      assert.match(result.log, /verified|restore complete/i);
    } finally {
      removeTempDir(fixture.root);
    }
  });

  it("fails before backup when a candidate source is a broken re-export stub", requiresModernBash, () => {
    const brokenSource = 'export * from "../../missing/neo-arch.js";\n';
    const fixture = makeDeployFixture({ checkerMode: "valid", sourceContent: brokenSource, deployContent: oldDeploy });
    try {
      const result = runDeployGuard(fixture);

      assert.equal(result.status, 1, `${result.stdout}${result.stderr}\n${result.log}`);
      assert.equal(readFileSync(fixture.deployFile, "utf8"), oldDeploy);
      assert.equal(existsSync(fixture.backupRoot), false);
      assert.match(result.log, /broken|stub|refus/i);
    } finally {
      removeTempDir(fixture.root);
    }
  });

  it("rejects symlinked optional metadata before backup or restore", () => {
    const fixture = makeDeployFixture({ checkerMode: "valid", sourceContent: safeSource, deployContent: oldDeploy });
    try {
      const externalPackage = join(fixture.root, "external-package.json");
      const sourcePackage = join(fixture.sourceDir, "package.json");
      const deployPackage = join(fixture.deployDir, "package.json");
      writeFileSync(externalPackage, '{"version":"unsafe"}\n');
      writeFileSync(deployPackage, '{"version":"deployed"}\n');
      symlinkSync(externalPackage, sourcePackage);

      const result = runDeployGuard(fixture);

      assert.equal(result.status, 1, `${result.stdout}${result.stderr}\n${result.log}`);
      assert.equal(lstatSync(deployPackage).isSymbolicLink(), false);
      assert.equal(readFileSync(deployPackage, "utf8"), '{"version":"deployed"}\n');
      assert.equal(readFileSync(fixture.deployFile, "utf8"), oldDeploy);
      assert.equal(existsSync(fixture.backupRoot), false, "metadata preflight must finish before backup");
      assert.match(result.log, /unsafe source candidate|refus/i);
    } finally {
      removeTempDir(fixture.root);
    }
  });

  for (const linkKind of ["relative", "absolute"]) {
    it(`rejects a ${linkKind} symlinked source parent before backup or restore`, () => {
      const fixture = makeDeployFixture({ checkerMode: "valid", sourceContent: safeSource, deployContent: oldDeploy });
      try {
        const externalLib = join(fixture.root, "external-lib");
        mkdirSync(externalLib, { recursive: true });
        writeFileSync(join(externalLib, "neo-arch.js"), "export const isInjectedContextText = 'external-source';\n");
        rmSync(join(fixture.sourceDir, "lib"), { recursive: true, force: true });
        symlinkSync(
          linkKind === "relative" ? "../external-lib" : externalLib,
          join(fixture.sourceDir, "lib"),
          "dir",
        );

        const result = runDeployGuard(fixture);

        assert.equal(result.status, 1, `${result.stdout}${result.stderr}\n${result.log}`);
        assert.equal(readFileSync(fixture.deployFile, "utf8"), oldDeploy);
        assert.equal(existsSync(fixture.backupRoot), false);
        assert.match(result.log, /unsafe source candidate|symlink component|canonical source root/i);
      } finally {
        removeTempDir(fixture.root);
      }
    });
  }

  it("rejects a broken symlinked source parent instead of treating the candidate as missing", () => {
    const fixture = makeDeployFixture({ checkerMode: "valid", sourceContent: safeSource, deployContent: oldDeploy });
    try {
      rmSync(join(fixture.sourceDir, "lib"), { recursive: true, force: true });
      symlinkSync("../missing-external-lib", join(fixture.sourceDir, "lib"), "dir");

      const result = runDeployGuard(fixture);

      assert.equal(result.status, 1, `${result.stdout}${result.stderr}\n${result.log}`);
      assert.equal(readFileSync(fixture.deployFile, "utf8"), oldDeploy);
      assert.equal(existsSync(fixture.backupRoot), false);
      assert.match(result.log, /unsafe source candidate|symlink component/i);
    } finally {
      removeTempDir(fixture.root);
    }
  });

  it("accepts a canonical source reached through a source-root symlink", requiresModernBash, () => {
    const fixture = makeDeployFixture({ checkerMode: "valid", sourceContent: safeSource, deployContent: oldDeploy });
    try {
      const sourceAlias = join(fixture.root, "source-alias");
      symlinkSync(fixture.sourceDir, sourceAlias, "dir");
      const result = runDeployGuard(fixture, { PLUR1BUS_SRC: sourceAlias });

      assert.equal(result.status, 0, `${result.stdout}${result.stderr}\n${result.log}`);
      assert.equal(readFileSync(fixture.deployFile, "utf8"), safeSource);
      assert.match(result.log, /verified|restore complete/i);
    } finally {
      removeTempDir(fixture.root);
    }
  });

  it("rejects a broken source-root symlink before backup or restore", () => {
    const fixture = makeDeployFixture({ checkerMode: "valid", sourceContent: safeSource, deployContent: oldDeploy });
    try {
      const brokenAlias = join(fixture.root, "broken-source-alias");
      symlinkSync(join(fixture.root, "missing-source-root"), brokenAlias, "dir");
      const result = runDeployGuard(fixture, { PLUR1BUS_SRC: brokenAlias });

      assert.equal(result.status, 1, `${result.stdout}${result.stderr}\n${result.log}`);
      assert.equal(readFileSync(fixture.deployFile, "utf8"), oldDeploy);
      assert.equal(existsSync(fixture.backupRoot), false);
      assert.match(result.log, /source missing/i);
    } finally {
      removeTempDir(fixture.root);
    }
  });

  it("revalidates a source-parent swap after backup and before the first restore copy", requiresModernBash, () => {
    const fixture = makeDeployFixture({ checkerMode: "valid", sourceContent: safeSource, deployContent: oldDeploy });
    try {
      const externalLib = join(fixture.root, "external-lib");
      const binDir = join(fixture.root, "bin");
      mkdirSync(externalLib, { recursive: true });
      writeFileSync(join(externalLib, "neo-arch.js"), "export const isInjectedContextText = 'external-after-preflight';\n");
      writeExecutable(join(binDir, "cp"), `#!/usr/bin/env bash
set -euo pipefail
if [ ! -e "$PLUR1BUS_SWAP_DONE" ]; then
  mv -- "$PLUR1BUS_SWAP_PARENT" "$PLUR1BUS_SWAP_ORIGINAL"
  ln -s -- "$PLUR1BUS_SWAP_TARGET" "$PLUR1BUS_SWAP_PARENT"
  : > "$PLUR1BUS_SWAP_DONE"
fi
exec /bin/cp "$@"
`);

      const sourceLib = join(fixture.sourceDir, "lib");
      const result = runDeployGuard(fixture, {
        PATH: `${binDir}:${process.env.PATH}`,
        PLUR1BUS_SWAP_DONE: join(fixture.root, "swap.done"),
        PLUR1BUS_SWAP_PARENT: sourceLib,
        PLUR1BUS_SWAP_ORIGINAL: join(fixture.sourceDir, "lib.preflight"),
        PLUR1BUS_SWAP_TARGET: externalLib,
      });

      assert.equal(result.status, 1, `${result.stdout}${result.stderr}\n${result.log}`);
      assert.equal(readFileSync(fixture.deployFile, "utf8"), oldDeploy);
      assert.equal(existsSync(fixture.backupRoot), true, "the preflight passed before the backup-time swap");
      assert.match(result.log, /changed after preflight|unsafe source candidate|symlink component/i);
    } finally {
      removeTempDir(fixture.root);
    }
  });

  it("rejects a regular source replacement after preflight and before restore copy", requiresModernBash, () => {
    const fixture = makeDeployFixture({ checkerMode: "valid", sourceContent: safeSource, deployContent: oldDeploy });
    try {
      const binDir = join(fixture.root, "bin");
      const replacement = join(fixture.root, "replacement-neo-arch.js");
      writeFileSync(replacement, "export const isInjectedContextText = 'replacement-after-preflight';\n");
      writeExecutable(join(binDir, "cp"), `#!/usr/bin/env bash
set -euo pipefail
if [ ! -e "$PLUR1BUS_SWAP_DONE" ]; then
  mv -- "$PLUR1BUS_REPLACEMENT" "$PLUR1BUS_SWAP_FILE"
  : > "$PLUR1BUS_SWAP_DONE"
fi
exec /bin/cp "$@"
`);

      const result = runDeployGuard(fixture, {
        PATH: `${binDir}:${process.env.PATH}`,
        PLUR1BUS_SWAP_DONE: join(fixture.root, "swap.done"),
        PLUR1BUS_REPLACEMENT: replacement,
        PLUR1BUS_SWAP_FILE: fixture.sourceFile,
      });

      assert.equal(result.status, 1, `${result.stdout}${result.stderr}\n${result.log}`);
      assert.equal(readFileSync(fixture.deployFile, "utf8"), oldDeploy);
      assert.equal(existsSync(fixture.backupRoot), true);
      assert.match(result.log, /source candidate changed after preflight/i);
    } finally {
      removeTempDir(fixture.root);
    }
  });

  it("fails verified restore when copy reports success without changing the deploy", requiresModernBash, () => {
    const fixture = makeDeployFixture({ checkerMode: "valid", sourceContent: safeSource, deployContent: oldDeploy });
    try {
      const binDir = join(fixture.root, "bin");
      writeExecutable(join(binDir, "cp"), "#!/bin/sh\nexit 0\n");
      const result = runDeployGuard(fixture, { PATH: `${binDir}:${process.env.PATH}` });

      assert.equal(result.status, 1, `${result.stdout}${result.stderr}\n${result.log}`);
      assert.equal(readFileSync(fixture.deployFile, "utf8"), oldDeploy);
      assert.match(result.log, /hash|verify|mismatch|restore failed/i);
    } finally {
      removeTempDir(fixture.root);
    }
  });

  it("backs up drift, restores a legitimate source, verifies hashes, and honors restart suppression", requiresModernBash, () => {
    const fixture = makeDeployFixture({ checkerMode: "valid", sourceContent: safeSource, deployContent: oldDeploy });
    try {
      const metadata = [
        ["openclaw.plugin.json", '{"version":"2.0.0"}\n', '{"version":"1.0.0"}\n'],
        ["lib/jobs/daily-consolidation.js", "export const dailyConsolidation = 'new';\n", "export const dailyConsolidation = 'old';\n"],
        ["package.json", '{"version":"2.0.0"}\n', '{"version":"1.0.0"}\n'],
        ["README.md", "new readme\n", "old readme\n"],
        ["LICENSE", "new license\n", null],
      ];
      for (const [name, sourceValue, deployValue] of metadata) {
        mkdirSync(dirname(join(fixture.sourceDir, name)), { recursive: true });
        writeFileSync(join(fixture.sourceDir, name), sourceValue);
        if (deployValue !== null) {
          mkdirSync(dirname(join(fixture.deployDir, name)), { recursive: true });
          writeFileSync(join(fixture.deployDir, name), deployValue);
        }
      }

      const result = runDeployGuard(fixture);

      assert.equal(result.status, 0, `${result.stdout}${result.stderr}\n${result.log}`);
      assert.equal(readFileSync(fixture.deployFile, "utf8"), safeSource);
      for (const [name, sourceValue] of metadata) {
        assert.equal(readFileSync(join(fixture.deployDir, name), "utf8"), sourceValue, `${name} must be restored`);
      }
      assert.match(result.log, /backed up drifted deploy/i);
      assert.match(result.log, /verified|restore complete/i);
      assert.match(result.log, /restart suppressed/i);
      const backupFiles = readdirSync(fixture.backupRoot, { recursive: true }).map(String);
      const backedUpNeo = backupFiles.find((name) => name.endsWith(join("lib", "neo-arch.js")));
      assert.ok(backedUpNeo, "backup must contain the pre-restore file");
      const backupPath = join(fixture.backupRoot, backedUpNeo);
      assert.equal(readFileSync(backupPath, "utf8"), oldDeploy);
      const backedUpPackage = backupFiles.find((name) => name.endsWith("package.json"));
      assert.ok(backedUpPackage, "backup must contain the pre-restore package metadata");
      assert.equal(readFileSync(join(fixture.backupRoot, backedUpPackage), "utf8"), '{"version":"1.0.0"}\n');
      assert.ok(statSync(backupPath).mtimeMs <= statSync(fixture.deployFile).mtimeMs || readFileSync(backupPath, "utf8") === oldDeploy);
    } finally {
      removeTempDir(fixture.root);
    }
  });
});

describe("B9 reindex-provider preservation", () => {
  it("keeps --apply visibly unsupported and creates no report or data path", () => {
    const root = makeTempDir("plur1bus-b9-reindex-");
    try {
      const result = runNode(REINDEX_SCRIPT, [
        "--agent", "main",
        "--from", "lancedb-namespaced",
        "--to", "lancedb-local",
        "--apply",
      ], { env: { HOME: root } });

      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, /--apply.*nicht implementiert|not implemented/i);
      assert.equal(existsSync(join(root, ".openclaw")), false);
    } finally {
      removeTempDir(root);
    }
  });
});

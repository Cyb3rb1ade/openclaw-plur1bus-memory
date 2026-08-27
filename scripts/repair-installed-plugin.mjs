#!/usr/bin/env node
/**
 * repair-installed-plugin.mjs — unified doctor/repair for the deployed PLUR1BUS extension.
 *
 * Runs after `openclaw plugins update` or whenever the deployed extension may have drifted
 * from the repo source. Detects and fixes:
 *   1. Deploy-integrity drift (index.js, lib/*.js, openclaw.plugin.json)
 *   2. LanceDB manifest-version explosion (diagnosis only unless --maintain-lancedb)
 *   3. Dreaming-cron error state (diagnosis only unless --run-cron)
 *
 * Usage:
 *   node scripts/repair-installed-plugin.mjs [options]
 *   npm run repair
 *
 * Options:
 *   --dry-run           Show what would be done without changing anything
 *   --maintain-lancedb  Also prune LanceDB versions (to 50) where elevated
 *   --run-cron          Also trigger the Dreaming Promotion cron if status=error
 *   --deploy-dir DIR    Override auto-detected deploy directory
 *   --expected-version  Explicitly authorize repair from this release version
 *   --help              Show this help
 *
 * Exit codes:
 *   0  All checks passed (or repaired successfully)
 *   1  Unresolved deploy-integrity violations remain
 *   2  Unexpected error
 *   3  Warnings only — integrity OK but LanceDB elevated or Dreaming cron in error state
 */

import { existsSync, readFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateDeployment, smokeTestExports, DEPLOY_FILES } from "./lib/deploy-integrity.mjs";
import { findDeployDir } from "./lib/find-deploy-dir.mjs";

const SMOKE_EXPECTATIONS = [
  { file: "lib/neo-arch.js",                exports: ["buildNeoWorkspaceAliases", "isInjectedContextText"] },
  { file: "lib/relevant-memory-context.js", exports: ["formatRelevantMemoriesContext"] },
  { file: "lib/memory-merge-safety.js",     exports: ["isSafeDuplicate", "normalizeMemoryText"] },
  { file: "lib/contradiction-detector.js",  exports: ["ContradictionDetector"] },
  { file: "lib/recall-pipeline.js",         exports: ["runRecallPipeline", "computeUseAssociative"] },
];

function parseArgs(argv) {
  const opts = { dryRun: false, maintainLancedb: false, runCron: false, deployDir: null, expectedVersion: null, noSmoke: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run")           opts.dryRun = true;
    else if (a === "--maintain-lancedb") opts.maintainLancedb = true;
    else if (a === "--run-cron")     opts.runCron = true;
    else if (a === "--deploy-dir")   opts.deployDir = argv[++i];
    else if (a === "--expected-version") opts.expectedVersion = argv[++i];
    else if (a === "--no-smoke")     opts.noSmoke = true;
    else if (a === "--help")         opts.help = true;
  }
  return opts;
}

function backupDeployDir(deployDir, files) {
  const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const backupRoot = join(homedir(), ".openclaw-backups", `plur1bus-repair-${ts}`);
  mkdirSync(backupRoot, { recursive: true });
  for (const f of files) {
    const src = join(deployDir, f);
    if (existsSync(src)) {
      const dst = join(backupRoot, f);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
  return backupRoot;
}

function section(title) {
  console.log(`\n${"─".repeat(60)}\n  ${title}\n${"─".repeat(60)}`);
}

function diagnoseLancedb() {
  const base = join(homedir(), ".openclaw", "memory", "lancedb-namespaced");
  if (!existsSync(base)) {
    console.log("  ✓ No LanceDB data directory found");
    return true;
  }
  let ok = true;
  const agentDirs = readdirSync(base, { withFileTypes: true })
    .filter((entry) => (
      entry.isDirectory()
      && !entry.isSymbolicLink()
      && (
        existsSync(join(base, entry.name, "memories.lance"))
        || existsSync(join(base, entry.name, "memories"))
      )
    ))
    .map((entry) => entry.name);
  if (agentDirs.length === 0) { console.log("  ✓ LanceDB base exists but is empty"); return true; }

  for (const agent of agentDirs) {
    const tables = readdirSync(join(base, agent), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
    for (const table of tables) {
      const versionsDir = join(base, agent, table, "_versions");
      if (!existsSync(versionsDir)) continue;
      const count = readdirSync(versionsDir).length;
      const status = count > 1500 ? "CRITICAL" : count > 500 ? "WARN" : "ok";
      const icon = status === "ok" ? "✓" : "✗";
      console.log(`  ${icon} ${agent}/${table}: ${count} manifest versions  [${status}]`);
      if (status !== "ok") {
        ok = false;
        console.log(`    → node scripts/maintain-lancedb.mjs --apply`);
      }
    }
  }
  return ok;
}

function diagnoseDreamingCron({ runRequested, mutationAllowed }) {
  let cronOutput = "";
  const cronList = spawnSync("openclaw", ["cron", "list"], { encoding: "utf8", timeout: 10000 });
  if (cronList.status !== 0 || cronList.error) {
    console.log("  ⚠ openclaw cron list not available — skipping");
    return true;
  }
  cronOutput = cronList.stdout ?? "";
  const dreaming = cronOutput.split("\n")
    .find((l) => l.toLowerCase().includes("memory dreaming") || l.toLowerCase().includes("dreaming promotion"));
  if (!dreaming) { console.log("  ✓ Dreaming Promotion cron not configured"); return true; }

  const hasError = /error|failed|timed.?out/i.test(dreaming);
  if (!hasError) { console.log("  ✓ Dreaming Promotion cron: no error"); return true; }

  const idMatch = dreaming.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  const cronId = idMatch?.[0];
  console.log(`  ✗ Dreaming Promotion cron status=error`);
  if (cronId && runRequested) {
    if (!mutationAllowed) {
      console.log(`  dry-run: would trigger openclaw cron run ${cronId}; no cron started`);
    } else {
      console.log(`  → Triggering: openclaw cron run ${cronId}`);
      const r = spawnSync("openclaw", ["cron", "run", cronId], { encoding: "utf8", timeout: 30000 });
      if (r.status === 0) { console.log("  ✓ Cron triggered"); }
      else { console.log(`  ✗ Trigger failed: ${r.stderr?.trim()}`); }
    }
  } else if (cronId) {
    console.log(`    → node scripts/repair-dreaming-cron.mjs --run`);
    console.log(`    → openclaw cron run ${cronId}`);
  }
  return false;
}

/**
 * Rejects every failed spawnSync outcome from maintain-lancedb.
 * @param {{status: number|null, signal?: string|null, error?: Error}} result
 * @returns {void}
 */
export function assertSuccessfulMaintenanceResult(result) {
  if (result?.error) {
    const code = result.error.code ? ` ${result.error.code}` : "";
    throw new Error(`maintain-lancedb maintenance child failed${code}: ${result.error.message}`);
  }
  if (result?.signal) {
    throw new Error(`maintain-lancedb maintenance child terminated by signal ${result.signal}`);
  }
  if (result?.status !== 0) {
    const status = result?.status === null || result?.status === undefined ? "unknown" : result.status;
    throw new Error(`maintain-lancedb maintenance child exited with status ${status}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node scripts/repair-installed-plugin.mjs [--dry-run] [--maintain-lancedb] [--run-cron] [--deploy-dir DIR] [--expected-version VERSION]");
    return 0;
  }

  const repoDir = resolve(process.cwd());
  const deployDir = resolve(opts.deployDir ?? findDeployDir(repoDir));
  const mutationAllowed = !opts.dryRun;

  console.log("PLUR1BUS Repair");
  console.log(`  repo:    ${repoDir}`);
  console.log(`  deploy:  ${deployDir}`);
  console.log(`  mode:    ${opts.dryRun ? "dry-run (no changes)" : "repair"}`);

  if (!existsSync(deployDir)) {
    console.error(`\n✗ Deploy directory not found: ${deployDir}`);
    console.error("  Set PLUR1BUS_DEPLOY or pass --deploy-dir");
    return 1;
  }

  // 1. Deploy integrity
  section("1/3  Deploy integrity");

  // Check-only pass first so we know whether a backup is needed before any
  // files are modified.
  const checkReport = validateDeployment({
    deployDir,
    repoDir,
    files: DEPLOY_FILES,
    repair: true,
    dryRun: true,
    expectedVersion: opts.expectedVersion,
  });
  const hasViolations = !checkReport.ok;
  if (hasViolations && mutationAllowed) {
    const backupDir = backupDeployDir(deployDir, DEPLOY_FILES);
    console.log(`  backup → ${backupDir}`);
  }

  // Repair pass (no-op in dry-run).
  const report = validateDeployment({
    deployDir,
    repoDir,
    files: DEPLOY_FILES,
    repair: true,
    dryRun: !mutationAllowed,
    expectedVersion: opts.expectedVersion,
  });
  if (!report.preflight.ok) {
    console.log(`  preflight: FAIL (${report.preflight.reasons.join(", ")})`);
  }
  for (const r of report.results) {
    const icon = r.ok || r.repaired ? "✓" : "✗";
    const label = r.ok ? "OK   " : r.repaired ? "FIXED" : "FAIL ";
    const detail = r.repaired ? ` (was: ${r.reasons.join(", ")})` : r.reasons.length ? ` (${r.reasons.join(", ")})` : "";
    console.log(`  ${icon} ${label} ${r.file}${detail}`);
  }

  let smokeOk = true;
  if (!opts.noSmoke) {
    const smokeExpectations = SMOKE_EXPECTATIONS.map(({ file, exports: ex }) => ({
      filePath: resolve(deployDir, file), exports: ex,
    }));
    const smoke = await smokeTestExports(smokeExpectations);
    console.log("\n  smoke test:");
    for (const r of smoke.results) {
      const icon = r.ok ? "✓" : "✗";
      const detail = r.importError ? " (import failed)" : r.missing.length ? ` (missing: ${r.missing.join(", ")})` : "";
      console.log(`  ${icon} ${r.filePath.replace(deployDir + "/", "")}${detail}`);
    }
    smokeOk = smoke.ok;
  } else {
    console.log("\n  smoke test: skipped (--no-smoke)");
  }
  const integrityOk = report.ok && smokeOk;
  console.log(`\n  ${integrityOk ? "✓ PASS" : "✗ FAIL"} deploy integrity`);

  // 2. LanceDB
  section("2/3  LanceDB manifest versions");
  let lancedbOk = diagnoseLancedb();
  if (opts.maintainLancedb && !lancedbOk) {
    if (!mutationAllowed) {
      console.log("  dry-run: would run maintain-lancedb --apply; no maintenance started");
    } else {
      const maintenance = spawnSync("node", ["scripts/maintain-lancedb.mjs", "--apply"], {
        stdio: "inherit",
        timeout: 120000,
      });
      assertSuccessfulMaintenanceResult(maintenance);
      console.log("\n  Verifying LanceDB state after maintenance:");
      lancedbOk = diagnoseLancedb();
    }
  }

  // 3. Dreaming cron
  section("3/3  Dreaming Promotion cron");
  const cronOk = diagnoseDreamingCron({ runRequested: opts.runCron, mutationAllowed });

  // Summary
  section("Summary");
  console.log(`  Deploy integrity:  ${integrityOk ? "✓ OK" : "✗ FAIL"}`);
  console.log(`  LanceDB versions:  ${lancedbOk ? "✓ OK" : "⚠ elevated"}`);
  console.log(`  Dreaming cron:     ${cronOk ? "✓ OK" : "⚠ error state"}`);
  console.log("");

  if (!integrityOk || !lancedbOk || !cronOk) {
    console.log("  Restart gateway after repairs:");
    console.log("    systemctl --user restart openclaw-gateway.service");
  } else {
    console.log("  ✓ All checks passed — no action needed.");
  }

  if (!integrityOk) return 1;
  if (!lancedbOk || !cronOk) return 3;
  return 0;
}

const isDirectExecution = process.argv[1]
  ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  : false;

if (isDirectExecution) {
  try {
    process.exitCode = await main();
  } catch (err) {
    console.error("repair-installed-plugin:", err);
    process.exitCode = 2;
  }
}

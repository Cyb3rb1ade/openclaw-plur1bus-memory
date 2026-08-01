#!/usr/bin/env node
// verify-plugin-deploy.mjs — deploy-integrity check for the memory-lancedb-namespaced
// plugin (a.k.a. plur1bus). Run after any repo->extension sync or OpenClaw update,
// before the gateway is (re)started.
//
// Background: on 2026-06-16, lib/neo-arch.js and lib/relevant-memory-context.js in
// the deployed extension were silently overwritten with broken re-export stubs
// (`export * from "../../lib/X.js"`, a path that only resolves inside the repo
// tree, not in the standalone deploy dir). The plugin failed to register on the
// next gateway restart. Root cause + writeup:
// docs/superpowers/plans/2026-06-16-installer-deploy-integrity-followup.md
//
// Usage:
//   node scripts/verify-plugin-deploy.mjs [--repair] [--dry-run] [--repo-dir DIR] [--deploy-dir DIR]
//
// Exit code 0 = healthy (or successfully repaired). Non-zero = unresolved violations.

import { resolve } from "node:path";
import { validateDeployment, smokeTestExports, DEPLOY_FILES } from "./lib/deploy-integrity.mjs";
import { findDeployDir } from "./lib/find-deploy-dir.mjs";

// Named exports confirmed to exist in the real files (no guessing).
const EXPORT_EXPECTATIONS = [
  { file: "index.js", exports: ["default"] },
  { file: "lib/neo-arch.js", exports: ["buildNeoWorkspaceAliases", "isInjectedContextText"] },
  { file: "lib/relevant-memory-context.js", exports: ["formatRelevantMemoriesContext"] },
  { file: "lib/memory-merge-safety.js", exports: ["isSafeDuplicate", "normalizeMemoryText"] },
  { file: "lib/contradiction-detector.js", exports: ["ContradictionDetector"] },
  { file: "lib/recall-pipeline.js", exports: ["runRecallPipeline", "computeUseAssociative"] },
];

function parseArgs(argv) {
  const opts = { repair: false, dryRun: false, repoDir: process.cwd(), deployDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repair") opts.repair = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--repo-dir") opts.repoDir = argv[++i];
    else if (arg === "--deploy-dir") opts.deployDir = argv[++i];
  }
  if (!opts.deployDir) {
    opts.deployDir = findDeployDir(opts.repoDir);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const deployDir = resolve(opts.deployDir);
  const repoDir = resolve(opts.repoDir);

  console.log(`[deploy-integrity] repo:   ${repoDir}`);
  console.log(`[deploy-integrity] deploy: ${deployDir}`);
  console.log(`[deploy-integrity] mode:   ${opts.repair ? (opts.dryRun ? "repair (dry-run)" : "repair") : "check-only"}`);
  console.log("");

  const report = validateDeployment({
    deployDir,
    repoDir,
    files: DEPLOY_FILES,
    repair: opts.repair,
    dryRun: opts.dryRun,
  });

  for (const r of report.results) {
    if (r.ok) {
      console.log(`  OK    ${r.file}`);
    } else if (r.repaired) {
      console.log(`  FIXED ${r.file}  (was: ${r.reasons.join(", ") || "pre-repair"})`);
    } else {
      console.log(`  FAIL  ${r.file}  (${r.reasons.join(", ")})`);
    }
  }

  const smokeExpectations = EXPORT_EXPECTATIONS.map(({ file, exports }) => ({
    filePath: resolve(deployDir, file),
    exports,
  }));
  const smoke = await smokeTestExports(smokeExpectations);

  console.log("");
  console.log("[deploy-integrity] smoke test (real imports):");
  for (const r of smoke.results) {
    if (r.ok) {
      console.log(`  OK    ${r.filePath}`);
    } else if (r.importError) {
      console.log(`  FAIL  ${r.filePath}  (import failed)`);
    } else {
      console.log(`  FAIL  ${r.filePath}  (missing exports: ${r.missing.join(", ")})`);
    }
  }

  const ok = report.ok && smoke.ok;
  console.log("");
  console.log(ok ? "[deploy-integrity] PASS" : "[deploy-integrity] FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("[deploy-integrity] unexpected error:", err);
  process.exit(1);
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectBrokenStub,
  validateFile,
  repairFile,
  validateDeployment,
  DEPLOY_FILES,
} from "../scripts/lib/deploy-integrity.mjs";
import * as deployIntegrity from "../scripts/lib/deploy-integrity.mjs";

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deploy-integrity-test-"));
  mkdirSync(join(dir, "repo", "lib"), { recursive: true });
  mkdirSync(join(dir, "deploy", "lib"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("detectBrokenStub", () => {
  it("flags a re-export stub whose target does not exist", () => {
    const filePath = join(dir, "deploy", "lib", "neo-arch.js");
    writeFileSync(filePath, 'export * from "../../lib/neo-arch.js";\n');
    const result = detectBrokenStub(filePath);
    assert.strictEqual(result.isReexportOnly, true);
    assert.strictEqual(result.isBroken, true);
    assert.strictEqual(result.targets.length, 1);
    assert.strictEqual(result.targets[0].exists, false);
  });

  it("accepts a real implementation file as not broken", () => {
    const filePath = join(dir, "deploy", "lib", "neo-arch.js");
    writeFileSync(
      filePath,
      'export function buildNeoWorkspaceAliases() { return {}; }\nexport const NEO_CATEGORIES = ["a"];\n',
    );
    const result = detectBrokenStub(filePath);
    assert.strictEqual(result.isReexportOnly, false);
    assert.strictEqual(result.isBroken, false);
  });

  it("accepts a re-export whose target file actually exists", () => {
    mkdirSync(join(dir, "deploy", "outer", "lib"), { recursive: true });
    writeFileSync(join(dir, "deploy", "lib", "real.js"), "export const x = 1;\n");
    const filePath = join(dir, "deploy", "outer", "lib", "shim.js");
    writeFileSync(filePath, 'export * from "../../lib/real.js";\n');
    const result = detectBrokenStub(filePath);
    assert.strictEqual(result.isReexportOnly, true);
    assert.strictEqual(result.isBroken, false);
    assert.strictEqual(result.targets[0].exists, true);
  });

  it("flags named re-export (export { x } from ...) with a missing target", () => {
    const filePath = join(dir, "deploy", "lib", "shim2.js");
    writeFileSync(filePath, 'export { formatRelevantMemoriesContext } from "../../lib/relevant-memory-context.js";\n');
    const result = detectBrokenStub(filePath);
    assert.strictEqual(result.isReexportOnly, true);
    assert.strictEqual(result.isBroken, true);
  });
});

describe("validateFile", () => {
  it("fails when the deployed file is missing", () => {
    const deployPath = join(dir, "deploy", "lib", "missing.js");
    const repoPath = join(dir, "repo", "lib", "missing.js");
    writeFileSync(repoPath, "export const x = 1;\n");
    const result = validateFile({ deployPath, repoPath });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.includes("missing-deploy-file"));
  });

  it("fails when the deployed file is a broken re-export stub", () => {
    const deployPath = join(dir, "deploy", "lib", "neo-arch.js");
    const repoPath = join(dir, "repo", "lib", "neo-arch.js");
    writeFileSync(repoPath, "export function buildNeoWorkspaceAliases() {}\n");
    writeFileSync(deployPath, 'export * from "../../lib/neo-arch.js";\n');
    const result = validateFile({ deployPath, repoPath });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.includes("broken-stub"));
  });

  it("fails when the deployed file checksum does not match the repo source", () => {
    const deployPath = join(dir, "deploy", "lib", "score.js");
    const repoPath = join(dir, "repo", "lib", "score.js");
    writeFileSync(repoPath, "export const score = 2;\n");
    writeFileSync(deployPath, "export const score = 1;\n");
    const result = validateFile({ deployPath, repoPath });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.includes("checksum-mismatch"));
  });

  it("passes when the deployed file matches the repo source exactly", () => {
    const deployPath = join(dir, "deploy", "lib", "score.js");
    const repoPath = join(dir, "repo", "lib", "score.js");
    writeFileSync(repoPath, "export const score = 2;\n");
    writeFileSync(deployPath, "export const score = 2;\n");
    const result = validateFile({ deployPath, repoPath });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.reasons, []);
  });
});

describe("repairFile", () => {
  it("copies the repo source over the broken deployed file", () => {
    const deployPath = join(dir, "deploy", "lib", "neo-arch.js");
    const repoPath = join(dir, "repo", "lib", "neo-arch.js");
    writeFileSync(repoPath, "export function buildNeoWorkspaceAliases() {}\n");
    writeFileSync(deployPath, 'export * from "../../lib/neo-arch.js";\n');

    const result = repairFile({ deployPath, repoPath, dryRun: false });

    assert.strictEqual(result.repaired, true);
    assert.strictEqual(readFileSync(deployPath, "utf8"), readFileSync(repoPath, "utf8"));
  });

  it("does not modify anything in dry-run mode", () => {
    const deployPath = join(dir, "deploy", "lib", "neo-arch.js");
    const repoPath = join(dir, "repo", "lib", "neo-arch.js");
    writeFileSync(repoPath, "export function buildNeoWorkspaceAliases() {}\n");
    writeFileSync(deployPath, 'export * from "../../lib/neo-arch.js";\n');

    const result = repairFile({ deployPath, repoPath, dryRun: true });

    assert.strictEqual(result.repaired, false);
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(readFileSync(deployPath, "utf8"), 'export * from "../../lib/neo-arch.js";\n');
  });

  it("creates missing parent directories before copying", () => {
    const deployPath = join(dir, "deploy", "lib", "jobs", "nested.js");
    const repoPath = join(dir, "repo", "lib", "jobs", "nested.js");
    mkdirSync(join(dir, "repo", "lib", "jobs"), { recursive: true });
    writeFileSync(repoPath, "export const ok = true;\n");

    const result = repairFile({ deployPath, repoPath, dryRun: false });

    assert.strictEqual(result.repaired, true);
    assert.ok(existsSync(deployPath));
  });
});

describe("validateDeployment", () => {
  it("reports failure when a critical file is missing, without repair", () => {
    writeFileSync(join(dir, "repo", "lib", "a.js"), "export const a = 1;\n");
    const report = validateDeployment({
      deployDir: join(dir, "deploy"),
      repoDir: join(dir, "repo"),
      files: ["lib/a.js"],
      repair: false,
      dryRun: false,
    });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.results[0].ok, false);
    assert.ok(report.results[0].reasons.includes("missing-deploy-file"));
    assert.strictEqual(report.results[0].repaired, false);
  });

  it("auto-repairs a broken stub when repair=true", () => {
    writeFileSync(join(dir, "repo", "lib", "a.js"), "export const a = 1;\n");
    writeFileSync(join(dir, "deploy", "lib", "a.js"), 'export * from "../../lib/a.js";\n');

    const report = validateDeployment({
      deployDir: join(dir, "deploy"),
      repoDir: join(dir, "repo"),
      files: ["lib/a.js"],
      repair: true,
      dryRun: false,
    });

    assert.strictEqual(report.results[0].repaired, true);
    assert.strictEqual(readFileSync(join(dir, "deploy", "lib", "a.js"), "utf8"), "export const a = 1;\n");
    assert.strictEqual(report.ok, true);
  });

  it("dry-run reports violations but writes nothing", () => {
    writeFileSync(join(dir, "repo", "lib", "a.js"), "export const a = 1;\n");
    writeFileSync(join(dir, "deploy", "lib", "a.js"), 'export * from "../../lib/a.js";\n');

    const report = validateDeployment({
      deployDir: join(dir, "deploy"),
      repoDir: join(dir, "repo"),
      files: ["lib/a.js"],
      repair: true,
      dryRun: true,
    });

    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.results[0].repaired, false);
    assert.strictEqual(
      readFileSync(join(dir, "deploy", "lib", "a.js"), "utf8"),
      'export * from "../../lib/a.js";\n',
    );
  });

  it("passes when every file matches the repo source", () => {
    writeFileSync(join(dir, "repo", "lib", "a.js"), "export const a = 1;\n");
    writeFileSync(join(dir, "deploy", "lib", "a.js"), "export const a = 1;\n");

    const report = validateDeployment({
      deployDir: join(dir, "deploy"),
      repoDir: join(dir, "repo"),
      files: ["lib/a.js"],
      repair: false,
      dryRun: false,
    });

    assert.strictEqual(report.ok, true);
  });
});

// ── DEPLOY_FILES coverage regression ──────────────────────────────────────────
// These tests guard against new lib imports in index.js being silently absent
// from the deploy manifest, which would prevent repair from fixing them.

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");

describe("DEPLOY_FILES coverage", () => {
  it("contains every reachable relative runtime import from index.js", () => {
    assert.strictEqual(typeof deployIntegrity.collectRelativeImports, "function");
    const reachable = deployIntegrity.collectRelativeImports("index.js", REPO_ROOT);
    const missing = reachable.filter((file) => !DEPLOY_FILES.includes(file));
    assert.deepStrictEqual(missing, [], `reachable runtime files missing from DEPLOY_FILES: ${missing.join(", ")}`);
  });

  it("discovers transitive relative runtime imports", () => {
    writeFileSync(join(dir, "repo", "index.js"), 'import "./lib/a.js";\nexport default {};\n');
    writeFileSync(join(dir, "repo", "lib", "a.js"), 'export { b } from "./b.js";\n');
    writeFileSync(join(dir, "repo", "lib", "b.js"), "export const b = true;\n");

    assert.strictEqual(typeof deployIntegrity.collectRelativeImports, "function");
    assert.deepStrictEqual(
      deployIntegrity.collectRelativeImports("index.js", join(dir, "repo")),
      ["index.js", "lib/a.js", "lib/b.js"],
    );
  });

  it("contains the shared LLM router runtime module", () => {
    assert.ok(DEPLOY_FILES.includes("lib/llm-router.js"));
  });

  it("contains the LLM result cache runtime module", () => {
    assert.ok(DEPLOY_FILES.includes("lib/llm-result-cache.js"));
  });

  it("contains all v6.7.0 critical new runtime modules", () => {
    const v670Critical = [
      "lib/temporal-context.js",
      "lib/temporal-filter.js",
      "lib/session-time.js",
      "lib/setup/feature-profiles.js",
      "lib/multi-namespace-pool.js",
      "lib/namespace-config.js",
      "lib/providers/factory.js",
      "lib/providers/dimension-guard.js",
      "lib/providers/config-normalize.js",
    ];
    const missing = v670Critical.filter((f) => !DEPLOY_FILES.includes(f));
    assert.deepStrictEqual(missing, [], `v6.7.0 critical files missing from DEPLOY_FILES: ${missing.join(", ")}`);
  });

  it("contains the feature-cron bootstrap runtime files", () => {
    const featureCronRuntime = [
      "lib/setup/feature-cron-plan.js",
      "scripts/setup-feature-crons.mjs",
      "scripts/lib/openclaw-cli.mjs",
      "scripts/lib/find-deploy-dir.mjs",
      "patches/apply-cron-plugin-direct-dispatch.mjs",
    ];
    const missing = featureCronRuntime.filter((f) => !DEPLOY_FILES.includes(f));
    assert.deepStrictEqual(missing, [], `feature-cron runtime files missing from DEPLOY_FILES: ${missing.join(", ")}`);
  });

  it("every file in DEPLOY_FILES exists on disk in the repo", () => {
    const missing = DEPLOY_FILES.filter((f) => !existsSync(join(REPO_ROOT, f)));
    assert.deepStrictEqual(missing, [], `DEPLOY_FILES lists files that do not exist on disk: ${missing.join(", ")}`);
  });

  it("all direct lib/ imports in index.js are covered by DEPLOY_FILES", () => {
    const indexSrc = readFileSync(join(REPO_ROOT, "index.js"), "utf8");
    const deploySet = new Set(DEPLOY_FILES);
    // Match all from "./lib/..." import paths
    const importMatches = [...indexSrc.matchAll(/from ["']\.(\/lib\/[^"']+)["']/g)];
    const imports = [...new Set(importMatches.map((m) => m[1].slice(1)))]; // strip leading "."
    const uncovered = imports.filter((f) => !deploySet.has(f));
    assert.deepStrictEqual(
      uncovered,
      [],
      `index.js imports lib modules not in DEPLOY_FILES — add them or add to an explicit exclusion list:\n  ${uncovered.join("\n  ")}`
    );
  });
});

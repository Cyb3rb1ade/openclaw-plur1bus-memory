import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectBrokenStub,
  validateFile,
  repairFile,
  validateDeployment,
} from "../scripts/lib/deploy-integrity.mjs";

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

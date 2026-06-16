import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { smokeTestExports } from "../scripts/lib/deploy-integrity.mjs";

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "installer-stub-guard-test-"));
  mkdirSync(join(dir, "lib"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("smokeTestExports", () => {
  it("passes when every expected export is present and the right kind", async () => {
    const filePath = join(dir, "lib", "neo-arch.js");
    writeFileSync(
      filePath,
      'export function buildNeoWorkspaceAliases() { return {}; }\nexport function isInjectedContextText() { return false; }\n',
    );

    const report = await smokeTestExports([
      { filePath, exports: ["buildNeoWorkspaceAliases", "isInjectedContextText"] },
    ]);

    assert.strictEqual(report.ok, true);
    assert.deepStrictEqual(report.results[0].missing, []);
  });

  it("fails when an expected export is missing", async () => {
    const filePath = join(dir, "lib", "neo-arch.js");
    writeFileSync(filePath, "export function somethingElse() {}\n");

    const report = await smokeTestExports([
      { filePath, exports: ["buildNeoWorkspaceAliases"] },
    ]);

    assert.strictEqual(report.ok, false);
    assert.deepStrictEqual(report.results[0].missing, ["buildNeoWorkspaceAliases"]);
  });

  it("fails (not throws) when the module cannot be imported at all", async () => {
    const filePath = join(dir, "lib", "broken-syntax.js");
    writeFileSync(filePath, "export function oops( {\n");

    const report = await smokeTestExports([
      { filePath, exports: ["anything"] },
    ]);

    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.results[0].importError, true);
  });

  it("reports a broken re-export stub as a smoke-test failure, not just missing-export", async () => {
    const filePath = join(dir, "lib", "neo-arch.js");
    writeFileSync(filePath, 'export * from "../../lib/neo-arch.js";\n');

    const report = await smokeTestExports([
      { filePath, exports: ["buildNeoWorkspaceAliases"] },
    ]);

    assert.strictEqual(report.ok, false);
  });
});

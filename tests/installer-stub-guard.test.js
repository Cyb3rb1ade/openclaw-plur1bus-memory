import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { smokeTestExports } from "../scripts/lib/deploy-integrity.mjs";

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "installer-stub-guard-test-"));
  mkdirSync(join(dir, "lib"), { recursive: true });
});

describe("install-memory-system non-interactive guard", () => {
  it("supports non-interactive defaults and writes the PLUR1BUS start notice", () => {
    const script = readFileSync(join(process.cwd(), "scripts", "install-memory-system.sh"), "utf8");
    assert.match(script, /--accept-defaults/);
    assert.match(script, /--non-interactive/);
    assert.match(script, /NON_INTERACTIVE=1/);
    assert.match(script, /plur1bus-pending-notice\.json/);
    assert.match(script, /\+\+\+ PLUR1BUS — Make your agent yours! \+\+\+/);
    assert.match(script, /\/plur1bus start/);
  });

  it("wires update feature detection through an install ledger and masked key prompts", () => {
    const script = readFileSync(join(process.cwd(), "scripts", "install-memory-system.sh"), "utf8");
    assert.match(script, /installer-config\.mjs/);
    assert.match(script, /plur1bus-install-log\.jsonl/);
    assert.match(script, /Feature-Update-Modus/);
    assert.match(script, /enable-all/);
    assert.match(script, /prompt_secret OPENAI_KEY/);
    assert.match(script, /prompt_secret COHERE_KEY/);
    assert.match(script, /ActiveMemory installieren\? yes=ja, no=nein" "yes"/);
    assert.match(script, /Dry-run: LanceDB-Dimensionen wurden nicht live geprüft/);
  });
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

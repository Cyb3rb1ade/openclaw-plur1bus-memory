import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(TEST_DIR, "..", "scripts", "embed-promoted-memories.mjs");
const tempDirs = [];

function makeRuntimeFixture() {
  const home = mkdtempSync(join(tmpdir(), "plur1bus-reindex-cli-"));
  tempDirs.push(home);
  const workspace = join(home, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "MEMORY.md"), [
    "<!-- openclaw-memory-promotion:fixture-marker -->",
    "- Fixture promoted memory text for testing",
  ].join("\n"));
  writeFileSync(join(home, "openclaw.json"), JSON.stringify({
    agents: { list: [{ id: "main", workspace }] },
    plugins: { entries: { "memory-lancedb-namespaced": { config: {} } } },
  }));
  let output = "";
  let errors = "";
  return {
    home,
    runtime: {
      openclawHome: home,
      stdout: { write: (chunk) => { output += chunk; } },
      stderr: { write: (chunk) => { errors += chunk; } },
    },
    output: () => output,
    errors: () => errors,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

async function loadScript() {
  assert.ok(existsSync(SCRIPT_PATH), "scripts/embed-promoted-memories.mjs must exist");
  return import(`${pathToFileURL(SCRIPT_PATH).href}?test=${Date.now()}-${Math.random()}`);
}

describe("embed-promoted-memories CLI", () => {
  it("is exposed as a dry-run npm maintenance command", () => {
    const pkg = JSON.parse(readFileSync(join(TEST_DIR, "..", "package.json"), "utf8"));
    assert.strictEqual(pkg.scripts["reindex-promotions"], "node scripts/embed-promoted-memories.mjs --dry-run");
  });

  it("defaults to dry-run and accepts an explicit apply", async () => {
    const { parseArgs } = await loadScript();
    assert.deepStrictEqual(parseArgs([]), { apply: false, dryRun: true, json: false, agents: [] });
    assert.deepStrictEqual(parseArgs(["--apply", "--json", "--agent", "main"]), {
      apply: true,
      dryRun: false,
      json: true,
      agents: ["main"],
    });
  });

  it("rejects conflicting modes, missing agent values, and unknown flags", async () => {
    const { parseArgs } = await loadScript();
    assert.throws(() => parseArgs(["--dry-run", "--apply"]), /cannot be combined/);
    assert.throws(() => parseArgs(["--agent"]), /requires a value/);
    assert.throws(() => parseArgs(["--unknown"]), /unknown argument/);
  });

  it("accepts explicit home/plugin roots without changing the dry-run default", async () => {
    const { parseArgs } = await loadScript();
    assert.deepStrictEqual(parseArgs(["--openclaw-home", "/safe/home", "--plugin-dir", "/safe/plugin"]), {
      apply: false,
      dryRun: true,
      json: false,
      agents: [],
      openclawHome: "/safe/home",
      pluginDir: "/safe/plugin",
    });
  });

  it("runs a JSON dry-run without constructing provider or database dependencies", async () => {
    const { runCli } = await loadScript();
    const fixture = makeRuntimeFixture();
    let called = false;
    fixture.runtime.createEmbedder = async () => { called = true; };
    fixture.runtime.createMemoryDb = () => { called = true; };
    const code = await runCli(["--json"], fixture.runtime);
    assert.strictEqual(code, 0);
    assert.strictEqual(called, false);
    assert.deepStrictEqual(JSON.parse(fixture.output()).counts, { planned: 1, inserted: 0, skipped: 0, failed: 0 });
  });

  it("uses injected apply dependencies and redacts credential-shaped failures", async () => {
    const { runCli } = await loadScript();
    const fixture = makeRuntimeFixture();
    fixture.runtime.createEmbedder = async () => ({
      dimensions: 3,
      embed: async () => { throw new Error("Bearer very-secret-token"); },
    });
    fixture.runtime.createMemoryDb = () => ({
      getById: async () => null,
      store: async () => {},
      shutdown: async () => {},
    });
    const code = await runCli(["--apply", "--json"], fixture.runtime);
    assert.strictEqual(code, 1);
    assert.doesNotMatch(fixture.output() + fixture.errors(), /very-secret-token/);
  });
});

import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(TEST_DIR, "..", "scripts", "embed-promoted-memories.mjs");
const tempDirs = [];

function makeRuntimeFixture() {
  // realpathSync: macOS tmpdir is a symlink (/var -> /private/var) and the
  // production code resolves real paths, so expectations must match.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-reindex-cli-")));
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
      loadConfig: async () => JSON.parse(readFileSync(join(home, "openclaw.json"), "utf8")),
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

  it("returns usage exit 2 without a stack for invalid CLI arguments", async () => {
    const { runCli } = await loadScript();
    const fixture = makeRuntimeFixture();
    const code = await runCli(["--unknown"], fixture.runtime);
    assert.strictEqual(code, 2);
    assert.match(fixture.errors(), /unknown argument/);
    assert.doesNotMatch(fixture.errors(), /\n\s+at /);
  });

  it("loads the effective gateway config instead of parsing openclaw.json", async () => {
    const { runCli } = await loadScript();
    const fixture = makeRuntimeFixture();
    writeFileSync(join(fixture.home, "openclaw.json"), "{ invalid json5 source }");
    fixture.runtime.loadConfig = async () => ({
      agents: { list: [{ id: "main", workspace: join(fixture.home, "workspace") }] },
      plugins: { entries: { "memory-lancedb-namespaced": { config: {} } } },
    });
    const code = await runCli(["--json"], fixture.runtime);
    assert.strictEqual(code, 0);
  });

  it("binds config CLI calls to the selected OpenClaw home", async () => {
    const { runCli } = await loadScript();
    const fixture = makeRuntimeFixture();
    delete fixture.runtime.loadConfig;
    const calls = [];
    fixture.runtime.openclawImpl = (args, _timeout, options) => {
      calls.push({
        args,
        home: options?.env?.OPENCLAW_HOME,
        stateDir: options?.env?.OPENCLAW_STATE_DIR,
      });
      if (args[2] === "agents") {
        return { ok: true, stdout: JSON.stringify({ list: [{ id: "main", workspace: join(fixture.home, "workspace") }] }) };
      }
      return { ok: true, stdout: JSON.stringify({ embedding: {} }) };
    };
    const code = await runCli(["--json", "--openclaw-home", fixture.home], fixture.runtime);
    assert.strictEqual(code, 0);
    assert.strictEqual(calls.length, 2);
    assert.ok(calls.every((call) => call.home === dirname(fixture.home)));
    assert.ok(calls.every((call) => call.stateDir === fixture.home));
  });

  it("never forwards redaction sentinels into the embedding provider config", async () => {
    const { sanitizeEffectivePluginConfig } = await loadScript();
    assert.deepStrictEqual(sanitizeEffectivePluginConfig({ embedding: {
      provider: "openai", apiKey: "__OPENCLAW_REDACTED__", apiKeyEnv: "__OPENCLAW_REDACTED__",
    } }), { embedding: { provider: "openai" } });
    assert.deepStrictEqual(sanitizeEffectivePluginConfig({ embedding: {
      provider: "openai", apiKeyEnv: "__OPENCLAW_REDACTED__",
    } }, "PLUR1BUS_OPENAI_API_KEY"), {
      embedding: { provider: "openai", apiKeyEnv: "PLUR1BUS_OPENAI_API_KEY" },
    });
  });

  it("restores a custom redacted embedding env binding from authored config before apply", async () => {
    const { runCli } = await loadScript();
    const fixture = makeRuntimeFixture();
    delete fixture.runtime.loadConfig;
    writeFileSync(join(fixture.home, "openclaw.json"), JSON.stringify({
      plugins: { entries: { "memory-lancedb-namespaced": { config: { embedding: {
        apiKeyEnv: "PLUR1BUS_OPENAI_API_KEY",
      } } } } },
    }));
    let providerConfig = null;
    fixture.runtime.openclawImpl = (args) => {
      const path = args[2];
      if (path === "agents") return {
        ok: true,
        stdout: JSON.stringify({ list: [{ id: "main", workspace: join(fixture.home, "workspace") }] }),
      };
      return { ok: true, stdout: JSON.stringify({ embedding: {
        provider: "openai",
        apiKeyEnv: "__OPENCLAW_REDACTED__",
      } }) };
    };
    fixture.runtime.createEmbedder = async (config) => {
      providerConfig = config;
      return { dimensions: 3, embed: async () => [0.1, 0.2, 0.3] };
    };
    fixture.runtime.createMemoryDb = () => ({
      getById: async () => ({ id: "already-there" }),
      shutdown: async () => {},
    });
    const code = await runCli(["--apply", "--json"], fixture.runtime);
    assert.strictEqual(code, 0);
    assert.strictEqual(providerConfig.embedding.apiKeyEnv, "PLUR1BUS_OPENAI_API_KEY");
  });

  it("rejects a still-redacted env binding and reports the explicit override", async () => {
    const { runCli } = await loadScript();
    const fixture = makeRuntimeFixture();
    delete fixture.runtime.loadConfig;
    fixture.runtime.openclawImpl = (args) => {
      if (args[2] === "agents") return {
        ok: true,
        stdout: JSON.stringify({ list: [{ id: "main", workspace: join(fixture.home, "workspace") }] }),
      };
      return { ok: true, stdout: JSON.stringify({ embedding: {
        provider: "openai",
        apiKeyEnv: "__OPENCLAW_REDACTED__",
      } }) };
    };
    const code = await runCli(["--apply"], fixture.runtime);
    assert.strictEqual(code, 1);
    assert.match(fixture.errors(), /--embedding-api-key-env/);
  });

  it("uses an explicit embedding env binding when authored config is unavailable", async () => {
    const { parseArgs, runCli } = await loadScript();
    assert.throws(
      () => parseArgs(["--embedding-api-key-env", "__OPENCLAW_REDACTED__"]),
      /valid environment variable name/,
    );
    const fixture = makeRuntimeFixture();
    delete fixture.runtime.loadConfig;
    let providerConfig = null;
    fixture.runtime.openclawImpl = (args) => {
      if (args[2] === "agents") return {
        ok: true,
        stdout: JSON.stringify({ list: [{ id: "main", workspace: join(fixture.home, "workspace") }] }),
      };
      return { ok: true, stdout: JSON.stringify({ embedding: {
        provider: "openai",
        apiKeyEnv: "__OPENCLAW_REDACTED__",
      } }) };
    };
    fixture.runtime.createEmbedder = async (config) => {
      providerConfig = config;
      return { dimensions: 3, embed: async () => [0.1, 0.2, 0.3] };
    };
    fixture.runtime.createMemoryDb = () => ({
      getById: async () => ({ id: "already-there" }),
      shutdown: async () => {},
    });
    const code = await runCli([
      "--apply",
      "--embedding-api-key-env",
      "PLUR1BUS_OPENAI_API_KEY",
    ], fixture.runtime);
    assert.strictEqual(code, 0);
    assert.strictEqual(providerConfig.embedding.apiKeyEnv, "PLUR1BUS_OPENAI_API_KEY");
  });

  it("requires an env override for a redacted literal API key and uses it for apply", async () => {
    const { runCli } = await loadScript();
    const makeLiteralRuntime = (fixture, capture) => ({
      ...fixture.runtime,
      loadConfig: undefined,
      openclawImpl: (args) => {
        if (args[2] === "agents") return {
          ok: true,
          stdout: JSON.stringify({ list: [{ id: "main", workspace: join(fixture.home, "workspace") }] }),
        };
        return { ok: true, stdout: JSON.stringify({ embedding: {
          provider: "openai",
          apiKey: "__OPENCLAW_REDACTED__",
        } }) };
      },
      createEmbedder: async (config) => {
        capture.value = config;
        return { dimensions: 3, embed: async () => [0.1, 0.2, 0.3] };
      },
      createMemoryDb: () => ({
        getById: async () => ({ id: "already-there" }),
        shutdown: async () => {},
      }),
    });

    const rejected = makeRuntimeFixture();
    const rejectedCapture = {};
    const rejectedCode = await runCli(["--apply"], makeLiteralRuntime(rejected, rejectedCapture));
    assert.strictEqual(rejectedCode, 1);
    assert.match(rejected.errors(), /--embedding-api-key-env/);

    const accepted = makeRuntimeFixture();
    const acceptedCapture = {};
    const acceptedCode = await runCli([
      "--apply",
      "--embedding-api-key-env",
      "PLUR1BUS_OPENAI_API_KEY",
    ], makeLiteralRuntime(accepted, acceptedCapture));
    assert.strictEqual(acceptedCode, 0);
    assert.strictEqual(acceptedCapture.value.embedding.apiKey, undefined);
    assert.strictEqual(acceptedCapture.value.embedding.apiKeyEnv, "PLUR1BUS_OPENAI_API_KEY");
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

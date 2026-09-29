// tests/dist-installer-config-validate.test.js — `openclaw config validate` in the installer's compat
// step (Review Focus 3, ruling R-S2; plugin-dist run 36514170524). OpenClaw 2026.8.1 and 2026.9.6 exit 1
// with `{"valid":false,"error":{"message":"file not found"},"path":…}` on a fresh state dir that has no
// openclaw.json yet; that is not an invalid config (there is nothing to validate, and install / config set
// create the file). A present config OpenClaw rejects stays fatal (exit 3, nothing changed), and so does
// every answer the installer cannot read as "missing" — fail closed. Fake `run` functions and the sandbox
// shims only; never a real OpenClaw.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createOpenclawCli } from "../scripts/dist/installer/openclaw-cli.mjs";
import { EXIT } from "../scripts/dist/installer/report.mjs";
import { readState } from "../scripts/dist/installer/state.mjs";
import { createInstallerSandbox, mutatingCalls, runSandboxInstaller } from "./helpers/installer-sandbox.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name, stateDir) => readFileSync(join(REPO, "tests", "fixtures", "openclaw-cli", name), "utf8").replaceAll("<state>", stateDir.replaceAll("\\", "/"));

/** A cli whose only command answers `config validate --json` with `result`. */
function cliAnswering(result, opts = {}) {
  const calls = [];
  const run = async (_bin, args) => {
    calls.push(args);
    assert.deepEqual(args, ["config", "validate", "--json"]);
    return { code: 1, stdout: "", stderr: "", timedOut: false, ...result };
  };
  return { cli: createOpenclawCli({ bin: "openclaw", env: {}, run, ...opts }), calls };
}

describe("plugin installer: config validate (Review Focus 3, R-S2)", () => {
  const stateDir = makeTempDir("plur1bus-cfgvalidate-");

  it("exit 0 is valid", async () => {
    const { cli, calls } = cliAnswering({ code: 0, stdout: fixture("config-validate-valid.json", stateDir) });
    assert.deepEqual(await cli.configValidate(), { ok: true, missing: false, code: 0 });
    assert.equal(calls.length, 1);
  });

  it("a missing config file on a fresh state dir is valid (nothing to validate)", async () => {
    const { cli } = cliAnswering({ stdout: fixture("config-validate-missing.json", stateDir) });
    assert.ok(!existsSync(join(stateDir, "openclaw.json")));
    assert.deepEqual(await cli.configValidate(), { ok: true, missing: true, code: 1 });
  });

  it("a config OpenClaw rejects is invalid", async () => {
    const { cli } = cliAnswering({ stdout: fixture("config-validate-invalid.json", stateDir) });
    assert.deepEqual(await cli.configValidate(), { ok: false, missing: false, code: 1 });
  });

  it("fails closed: 'file not found' while something exists at that path is invalid", async () => {
    const dir = makeTempDir("plur1bus-cfgvalidate-present-");
    mkdirSync(join(dir, "openclaw.json"));
    const { cli } = cliAnswering({ stdout: fixture("config-validate-missing.json", dir) });
    assert.deepEqual(await cli.configValidate(), { ok: false, missing: false, code: 1 });
    const probed = [];
    const { cli: injected } = cliAnswering({ stdout: fixture("config-validate-missing.json", stateDir) }, { pathPresent: (p) => (probed.push(p), true) });
    assert.equal((await injected.configValidate()).ok, false);
    assert.deepEqual(probed, [`${stateDir.replaceAll("\\", "/")}/openclaw.json`]);
  });

  it("fails closed: unparseable output, a relative path, a timeout or a text-only answer is invalid", async () => {
    for (const result of [
      { stdout: "Config file not found: openclaw.json\nCreate one with openclaw onboard or run openclaw doctor --fix.\n" },
      { stdout: '{"ok":false,"error":{"type":"cli_error","message":"file not found"},"valid":false,"path":"openclaw.json"}\n' },
      { stdout: '{"ok":false,"error":{"type":"cli_error","message":"file not found"},"valid":true}\n' },
      { stdout: fixture("config-validate-missing.json", stateDir), code: 124, timedOut: true },
      { stdout: "", stderr: "error: unknown option '--json'", code: 1 },
    ]) {
      const { cli } = cliAnswering(result, { pathPresent: () => false });
      assert.equal((await cli.configValidate()).ok, false, JSON.stringify(result));
    }
  });

  it("a fresh sandbox state dir without openclaw.json installs (plugin-dist run 36514170524)", async () => {
    const sb = createInstallerSandbox();
    assert.ok(!existsSync(join(sb.stateDir, "openclaw.json")));
    const r = await runSandboxInstaller(sb, ["--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.equal(sb.openclawCalls().filter((a) => a.join(" ") === "config validate --json").length, 1);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.steps.find((s) => s.id === "compat")?.status, "ok");
    assert.match(doc.steps.find((s) => s.id === "compat").detail, /no config file yet/);
    assert.ok(!doc.findings?.some((f) => f.id === "config-invalid"), JSON.stringify(doc.findings));
  });

  it("a present, valid openclaw.json installs", async () => {
    const sb = createInstallerSandbox();
    writeFileSync(join(sb.stateDir, "openclaw.json"), "{}\n");
    const r = await runSandboxInstaller(sb, ["--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
  });

  it("OpenClaw claiming 'file not found' while openclaw.json exists stops before any change", async () => {
    const sb = createInstallerSandbox({ scenario: { configValidateSaysMissing: true } });
    mkdirSync(join(sb.stateDir, "openclaw.json"));
    const r = await runSandboxInstaller(sb, ["--json"]);
    assert.equal(r.code, EXIT.INCOMPATIBLE, r.out);
    assert.deepEqual(mutatingCalls(sb.openclawCalls()), []);
    assert.ok(JSON.parse(r.stdout).findings.some((f) => f.id === "config-invalid" && f.fatal));
    assert.match(r.stderr, /openclaw doctor --fix/);
    assert.equal(readState(sb.stateDir), null);
  });
});

// Found by running the fixed installer against a real 2026.8.1 on a fresh state dir (the step after compat in the
// plugin-dist installer leg): before the plugin is discoverable OpenClaw has no schema for its config, so
// `config get plugins.entries.<id>.config.<key>` exits 1 "Unknown config path: …" (2026.8.1 and 2026.9.6; baseDbPath
// and hooks.allowConversationAccess answer "valid but unset"). For the plugin's own config keys that is unset.
describe("plugin installer: config get before the plugin is installed", () => {
  const unknown = (path) => ({ code: 1, stdout: "", stderr: `Unknown config path: ${path}. Run openclaw config schema to inspect valid paths.\n`, timedOut: false });
  const cliFor = (result) => createOpenclawCli({ bin: "openclaw", env: {}, run: async () => result });
  const PC = "plugins.entries.memory-lancedb-namespaced.config";

  it("an unknown plugin config path is unset", async () => {
    for (const path of [`${PC}.embedding.provider`, `${PC}.embedding.model`, `${PC}.modelPreparation.profile`, `${PC}.modelPreparation.acceptNonCommercialLicense`]) {
      assert.deepEqual(await cliFor(unknown(path)).configGet(path), { set: false, value: null }, path);
    }
  });

  it("an unknown path outside the plugin's config still fails", async () => {
    for (const path of ["plugins.slots.memory", "plugins.entries.memory-lancedb-namespaced.hooks.allowConversationAccess"]) {
      await assert.rejects(cliFor(unknown(path)).configGet(path), /config get .* failed \(exit 1\)/, path);
    }
  });

  it("any other failure of a plugin config path still fails", async () => {
    await assert.rejects(cliFor({ code: 1, stdout: "", stderr: "Error: EACCES\n", timedOut: false }).configGet(`${PC}.embedding.provider`), /failed \(exit 1\)/);
  });
});

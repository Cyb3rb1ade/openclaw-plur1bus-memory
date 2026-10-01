// tests/dist-hermes-install.test.js — `install-plugin --host hermes` (HM2 Task 8) against the sandbox's `hermes` and
// `plur1bus` shims only: temp homes, file:// artefacts verified like real ones, never a real Hermes, a real PLUR1BUS
// home or a service manager.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT } from "../scripts/dist/installer/report.mjs";
import { resolveHermesHome, parseHermesVersion } from "../scripts/dist/installer/hermes/detect.mjs";
import { classifyHome, foldProfile, otherBoundHomes, readBinding, readRegistry, registerBinding, registryAdd, BindingConflict } from "../scripts/dist/installer/hermes/binding.mjs";
import { ALLOWED_HERMES_CONFIG_KEYS, createHermesCli, parseMemoryStatus, readSelftestDoc } from "../scripts/dist/installer/hermes/hermes-cli.mjs";
import { planProviderEdit, planProviderUndo, setProviderLine, undoProviderLine } from "../scripts/dist/installer/hermes/config-edit.mjs";
import { plur1busHome, sidecarBinPath } from "../scripts/dist/installer/hermes/sidecar.mjs";
import { pep440Satisfies } from "../scripts/dist/installer/hermes/install.mjs";
import { readHermesState } from "../scripts/dist/installer/hermes/state.mjs";
import { createHermesSandbox, runHermesInstaller, sha256File, TEMPLATE_CONFIG } from "./helpers/hermes-sandbox.js";
import { SANDBOX_ARCH, treeDigest, walkTree } from "./helpers/installer-sandbox.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const MAIN = join(REPO, "scripts", "dist", "installer", "main.mjs");
const HERMES_MODULES = join(REPO, "scripts", "dist", "installer", "hermes");
const FIX = join(HERE, "fixtures");
const run = runHermesInstaller;
const hash8 = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex").slice(0, 8);

/** hermes calls that change something. */
const mutating = (calls) => calls.filter((a) => a[0] === "config" && (a[1] === "set" || a[1] === "unset"));
/** Leftovers a finished or rolled-back run must not leave. */
const strays = (sb) => [...walkTree(sb.home), ...walkTree(sb.root)].filter((p) => /plur1bus\.tmp-\d+$|\.plur1bus-prev-\d+$|\.tmp-\d+$|\.prev-\d+$/.test(p));

function freshCalls(sb, { useClass = "general", acceptNc = false, agentId = "hermes-default" } = {}) {
  const home = sb.plur1busHome;
  return [
    ["hermes", ["--version"]],
    ["hermes", ["config", "get", "memory.provider", "--json"]],
    ["plur1bus", ["--home", home, "--json", "setup", "--profile", "host", "--non-interactive", "--use-class", useClass, ...(acceptNc ? ["--accept-nc-licence"] : []), "--no-service"]],
    ["plur1bus", ["--home", home, "--json", "agent", "list"]],
    ["plur1bus", ["--home", home, "--json", "agent", "create", agentId]],
    ["hermes", ["config", "set", "memory.provider", "plur1bus"]],
    ["hermes", ["config", "get", "memory.provider", "--json"]],
    ["hermes", ["memory", "status"]],
    ["hermes", ["plur1bus", "selftest", "--json"]],
  ];
}
const calls = (sb) => sb.log().filter((e) => e.bin === "hermes" || e.bin === "plur1bus").map((e) => [e.bin, e.argv]);

/** Run the installer in a child process, so the shim can kill it (Review Focus 5). */
function runChild(sb, argv) {
  const code = `import { runInstaller } from ${JSON.stringify(MAIN)};\nprocess.exitCode = await runInstaller(process.argv.slice(1));\n`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code, "--", "--host", "hermes", "--feed-file", sb.feedFile, ...argv], {
    env: { ...sb.env, PLUR1BUS_PLUGIN_TEST_FREE_BYTES: String(64 * 1024 ** 3), PLUR1BUS_SANDBOX_ALLOW_KILL_PARENT: "1" },
    encoding: "utf8",
    timeout: 120_000,
  });
}

function caseSensitiveFs() {
  const d = makeTempDir("hermes-case-");
  writeFileSync(join(d, "a"), "");
  return !existsSync(join(d, "A"));
}

function assertNothingInstalled(sb, before) {
  assert.equal(existsSync(join(sb.hermesHome, "plugins", "plur1bus")), false, "no provider dir");
  assert.equal(existsSync(join(sb.hermesHome, "plur1bus.json")), false, "no binding");
  assert.equal(existsSync(join(sb.hermesHome, ".plur1bus-installer.json")), false, "no state file");
  assert.equal(existsSync(sb.sidecarBin), false, "no sidecar binary");
  assert.equal(existsSync(sb.plur1busHome), false, "no PLUR1BUS home");
  if (before) assert.equal(treeDigest(sb.hermesHome), before, "the Hermes home is unchanged");
  assert.deepEqual(strays(sb), []);
}

describe("hermes installer: install", () => {
  it("fresh install runs detect, setup --profile host, agent create, provider, config set and selftest in order", async () => {
    const sb = createHermesSandbox();
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.deepEqual(calls(sb), freshCalls(sb));
    // every hermes call runs against the resolved home; the provider dir existed before memory.provider named it (R17a)
    for (const e of sb.log().filter((x) => x.bin === "hermes")) assert.equal(e.hermesHome, sb.hermesHome);
    assert.equal(sb.log().find((e) => e.bin === "hermes" && e.argv[1] === "set").providerDir, true);
    const doc = JSON.parse(r.stdout);
    const byId = Object.fromEntries(doc.steps.map((s) => [s.id, s]));
    for (const id of ["feed", "detect", "compat", "licence", "download", "sidecar", "setup", "agent", "provider", "binding", "activate", "verify.memory-status", "verify.selftest"]) {
      assert.equal(byId[id]?.status, "ok", `${id}: ${JSON.stringify(byId[id])}`);
    }
    assert.deepEqual(doc.steps.map((s) => s.id).filter((id) => ["sidecar", "setup", "agent", "provider", "binding", "activate", "verify.selftest"].includes(id)),
      ["sidecar", "setup", "agent", "provider", "binding", "activate", "verify.selftest"]);
    // sidecar binary, provider dir, binding, registry, state
    assert.equal(sha256File(sb.sidecarBin), sha256File(sb.binArtefact));
    const pdir = join(sb.hermesHome, "plugins", "plur1bus");
    const manifest = JSON.parse(readFileSync(join(pdir, "MANIFEST.json"), "utf8"));
    for (const [p, h] of Object.entries(manifest.files)) assert.equal(sha256File(join(pdir, ...p.split("/").slice(1))), h, p);
    const binding = JSON.parse(readFileSync(join(sb.hermesHome, "plur1bus.json"), "utf8"));
    assert.deepEqual(binding, { schema: "plur1bus.hermes-binding/1", version: "0.1.0", installedBy: "plur1bus-plugin-installer", home: sb.plur1busHome, bin: sb.sidecarBin, agentId: "hermes-default", recallHardMs: 600, capture: true });
    if (process.platform !== "win32") assert.equal(statSync(join(sb.hermesHome, "plur1bus.json")).mode & 0o777, 0o600);
    const reg = JSON.parse(readFileSync(join(sb.plur1busHome, "hosts", "hermes-bindings.json"), "utf8"));
    assert.deepEqual(reg, { schema: "plur1bus.hermes-bindings/1", bindings: { "hermes-default": realpathSync.native(sb.hermesHome) } });
    const st = readHermesState(sb.hermesHome);
    assert.equal(st.installedVersion, "0.1.0");
    assert.equal(st.previousProvider, null);
    assert.equal(st.sidecarFresh, true);
    assert.equal(st.inProgress, undefined);
    if (process.platform !== "win32") assert.equal(statSync(join(sb.hermesHome, ".plur1bus-installer.json")).mode & 0o777, 0o600);
    assert.equal(sb.provider(), "plur1bus");
    assert.deepEqual(strays(sb), []);
    // the comments of config.yaml survive (0.21.5's config set; the shim models that)
    assert.match(readFileSync(join(sb.hermesHome, "config.yaml"), "utf8"), /# Memory settings/);
  });

  it("--json prints one plur1bus.plugin-installer/1 document with host hermes", async () => {
    const sb = createHermesSandbox();
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.equal(r.stdout.trim().split("\n").length, 1);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.schema, "plur1bus.plugin-installer/1");
    assert.equal(doc.host, "hermes");
    assert.equal(doc.mode, "install");
    assert.equal(doc.ok, true);
    assert.equal(doc.pluginVersion, "0.1.0");
    assert.equal(doc.agentId, "hermes-default");
    assert.equal(doc.hermes.version, "0.21.5");
    assert.equal(doc.hermes.home, sb.hermesHome);
    assert.equal(doc.sidecar.home, sb.plur1busHome);
    assert.equal(doc.target, `${process.platform === "win32" ? "win" : process.platform}-${SANDBOX_ARCH}`);
    const failed = await run(createHermesSandbox({ scenario: { hermesVersion: "0.20.1" } }), ["--json"]);
    assert.equal(failed.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(failed.stdout).exitCode, EXIT.INCOMPATIBLE);
    const human = await run(createHermesSandbox(), []);
    assert.equal(human.stdout, "");
  });

  it("an existing other provider needs --replace-provider and is restored on rollback", async () => {
    const withHoncho = TEMPLATE_CONFIG.replace("memory:\n", "memory:\n  provider: honcho   # the current provider\n");
    const sb = createHermesSandbox({ configYaml: withHoncho, scenario: { selftestFail: true } });
    mkdirSync(join(sb.hermesHome, "plugins", "honcho"), { recursive: true });
    writeFileSync(join(sb.hermesHome, "plugins", "honcho", "__init__.py"), "# MemoryProvider TEST ONLY\n");
    const r = await run(sb, ["--replace-provider", "--json"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.equal(sb.provider(), "honcho");
    assert.equal(existsSync(join(sb.hermesHome, "plugins", "plur1bus")), false);
    assert.equal(existsSync(join(sb.hermesHome, "plugins", "honcho", "__init__.py")), true);
    assert.equal(existsSync(join(sb.hermesHome, "plur1bus.json")), false);
    // R17a: memory.provider was restored while the plur1bus directory still existed
    const restore = sb.log().find((e) => e.bin === "hermes" && e.argv.join(" ") === "config set memory.provider honcho");
    assert.equal(restore?.providerDir, true);
    assert.deepEqual(strays(sb), []);

    // with success: the previous provider is recorded for uninstall
    const ok = createHermesSandbox({ configYaml: withHoncho });
    const r2 = await run(ok, ["--replace-provider"]);
    assert.equal(r2.code, EXIT.OK, r2.out);
    assert.equal(ok.provider(), "plur1bus");
    assert.equal(readHermesState(ok.hermesHome).previousProvider, "honcho");

    // an interactive yes replaces it too
    const tty = createHermesSandbox({ configYaml: withHoncho });
    const asked = [];
    const r3 = await run(tty, [], { isTTY: true, prompt: async (q) => (asked.push(q), /Replace it/.test(q) ? "y" : "n") });
    assert.equal(r3.code, EXIT.OK, r3.out);
    assert.ok(asked.some((q) => q.includes("honcho")), asked.join("\n"));
  });

  it("non-interactive with another provider exits 2 provider-in-use and changes nothing", async () => {
    const sb = createHermesSandbox({ configYaml: TEMPLATE_CONFIG.replace("memory:\n", "memory:\n  provider: mem0\n") });
    const before = treeDigest(sb.hermesHome);
    const r = await run(sb, ["--json", "--non-interactive"]);
    assert.equal(r.code, EXIT.NEEDS_CHOICE, r.out);
    assert.match(r.out, /provider-in-use: memory\.provider is mem0/);
    assert.match(r.out, /--replace-provider/);
    assert.deepEqual(sb.plur1busCalls(), []);
    assert.deepEqual(mutating(sb.hermesCalls()), []);
    assertNothingInstalled(sb, before);
  });

  it("a full harness home exits 3 harness-present and changes nothing", async () => {
    const sb = createHermesSandbox();
    sb.seedHostSidecar({ profile: null });
    const before = treeDigest(sb.hermesHome);
    const homeBefore = treeDigest(sb.plur1busHome);
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.INCOMPATIBLE, r.out);
    assert.match(r.out, /harness-present/);
    assert.match(r.out, /HM4/);
    assert.deepEqual(sb.plur1busCalls(), []);
    assert.deepEqual(mutating(sb.hermesCalls()), []);
    assert.equal(treeDigest(sb.hermesHome), before);
    assert.equal(treeDigest(sb.plur1busHome), homeBefore);
    assert.deepEqual(JSON.parse(r.stdout).findings.filter((f) => f.fatal).map((f) => f.id), ["harness-present"]);

    // an unreadable manifest is refused, never set up over (HM2-R27)
    const bad = createHermesSandbox();
    mkdirSync(bad.plur1busHome, { recursive: true });
    writeFileSync(join(bad.plur1busHome, "manifest.json"), "{ not json");
    const r2 = await run(bad, []);
    assert.equal(r2.code, EXIT.INCOMPATIBLE, r2.out);
    assert.match(r2.out, /sidecar-manifest-invalid.*1staid repair/s);
    assert.deepEqual(bad.plur1busCalls(), []);
  });

  it("an existing host sidecar is reused and not reinstalled", async () => {
    const sb = createHermesSandbox();
    sb.seedHostSidecar({ version: "0.1.0", useClass: "commercial", agents: { main: {} } });
    const f = structuredClone(sb.feed);
    for (const t of Object.keys(f.hosts.hermes.releases[0].sidecar.binary)) f.hosts.hermes.releases[0].sidecar.binary[t].url = "file:///nonexistent/TEST-ONLY/plur1bus";
    sb.writeFeed(f);
    const binBefore = sha256File(sb.sidecarBin);
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.steps.find((s) => s.id === "sidecar").status, "skipped");
    assert.equal(doc.steps.find((s) => s.id === "licence").status, "skipped");
    assert.equal(doc.sidecar.reused, true);
    assert.equal(sha256File(sb.sidecarBin), binBefore);
    // the recorded use class is passed explicitly (F3), no new licence question
    const setup = sb.plur1busCalls().find((a) => a[3] === "setup");
    assert.deepEqual(setup.slice(3), ["setup", "--profile", "host", "--non-interactive", "--use-class", "commercial", "--no-service"]);
    assert.equal(readHermesState(sb.hermesHome).sidecarFresh, false);

    // an older host sidecar gets the release's binary; the previous one is kept only until the install finished
    const old = createHermesSandbox();
    old.seedHostSidecar({ version: "0.0.9" });
    writeFileSync(old.sidecarBin, "#!/bin/sh\necho old TEST ONLY\n", { mode: 0o755 });
    const r2 = await run(old, []);
    assert.equal(r2.code, EXIT.OK, r2.out);
    assert.equal(sha256File(old.sidecarBin), sha256File(old.binArtefact));
    assert.deepEqual(readdirSync(dirname(old.sidecarBin)), [process.platform === "win32" ? "plur1bus.exe" : "plur1bus"]);

    // F3: an older host sidecar whose binary is replaced still keeps its recorded use class
    const older = createHermesSandbox();
    older.seedHostSidecar({ version: "0.0.9", useClass: "commercial" });
    const r3 = await run(older, ["--json"]);
    assert.equal(r3.code, EXIT.OK, r3.out);
    assert.equal(JSON.parse(r3.stdout).steps.find((s) => s.id === "licence").status, "skipped");
    assert.deepEqual(older.plur1busCalls().find((a) => a[3] === "setup").slice(7, 9), ["--use-class", "commercial"]);
  });

  it("a binary or tarball hash mismatch installs nothing", async () => {
    for (const which of ["provider", "binary"]) {
      const sb = createHermesSandbox();
      const f = structuredClone(sb.feed);
      const rel = f.hosts.hermes.releases[0];
      if (which === "provider") rel.provider.sha256 = "f".repeat(64);
      else for (const t of Object.keys(rel.sidecar.binary)) rel.sidecar.binary[t].sha256 = "e".repeat(64);
      sb.writeFeed(f);
      const before = treeDigest(sb.hermesHome);
      const r = await run(sb, ["--json"]);
      assert.equal(r.code, EXIT.FAILED, `${which}: ${r.out}`);
      assert.match(r.out, /does not match the feed.*nothing was changed/s);
      assert.deepEqual(sb.plur1busCalls(), [], which);
      assert.deepEqual(mutating(sb.hermesCalls()), [], which);
      assertNothingInstalled(sb, before);
    }
  });

  it("a failed selftest restores the provider value, removes the provider dir and a fresh sidecar's service, binary and home", async () => {
    const sb = createHermesSandbox({ scenario: { selftestFail: true } });
    const before = treeDigest(sb.hermesHome);
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.steps.find((s) => s.id === "verify.selftest").status, "failed");
    assert.equal(doc.steps.find((s) => s.id === "rollback").status, "ok");
    assert.equal(sb.provider(), "");
    // memory.provider was restored (unset: there was none) before the directory went (R17a)
    const unset = sb.log().find((e) => e.bin === "hermes" && e.argv.join(" ") === "config unset memory.provider");
    assert.equal(unset?.providerDir, true);
    const p = sb.plur1busCalls().map((a) => a.slice(3).join(" "));
    assert.ok(p.includes("daemon stop") && p.includes("service uninstall"), p.join("\n"));
    assert.ok(p.indexOf("daemon stop") > p.indexOf("agent create hermes-default"));
    assertNothingInstalled(sb, before);
  });

  it("a killed install is completed or rolled back by the next run", { skip: process.platform === "win32" && "POSIX kill of the parent process" }, async () => {
    // A: killed right after `hermes config set` → the next run finishes the install
    const a = createHermesSandbox({ scenario: { killOn: "config set" } });
    const k = runChild(a, []);
    assert.notEqual(k.status, 0, k.stderr);
    assert.ok(a.log().some((e) => e.bin === "kill"), "the shim killed the installer");
    assert.equal(readHermesState(a.hermesHome).inProgress.step, "activate");
    a.setScenario({ killOn: null });
    const r = await run(a, ["--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.match(r.out, /interrupted install at step activate; finishing it/);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.steps.find((s) => s.id === "provider").status, "skipped");
    assert.equal(doc.steps.find((s) => s.id === "sidecar").status, "skipped");
    assert.equal(readHermesState(a.hermesHome).inProgress, undefined);
    assert.equal(readHermesState(a.hermesHome).sidecarFresh, true, "the first attempt's facts are carried");
    assert.equal(a.provider(), "plur1bus");
    assert.deepEqual(strays(a), []);

    // B: the same interruption, then --rollback → nothing of the install is left
    const b = createHermesSandbox({ scenario: { killOn: "config set" } });
    const before = treeDigest(b.hermesHome);
    const k2 = runChild(b, []);
    assert.notEqual(k2.status, 0);
    b.setScenario({ killOn: null });
    const r2 = await run(b, ["--rollback", "--json"]);
    assert.equal(r2.code, EXIT.FAILED, r2.out);
    assert.equal(JSON.parse(r2.stdout).steps.find((s) => s.id === "rollback").status, "ok");
    assert.equal(b.provider(), "");
    assertNothingInstalled(b, before);
    assert.equal(existsSync(join(b.hermesHome, "plugins")), false, "the plugins dir the install created is gone again");

    // --rollback with nothing interrupted changes nothing
    const c = await run(createHermesSandbox(), ["--rollback"]);
    assert.equal(c.code, EXIT.FAILED);
    assert.match(c.out, /nothing to roll back/);
  });

  it("a rollback step that fails exits 4, prints the manual steps and never removes a directory memory.provider still names", async () => {
    const sb = createHermesSandbox({ configYaml: TEMPLATE_CONFIG.replace("memory:\n", "memory:\n  provider: honcho\n"), scenario: { selftestFail: true, configSetFailFor: "honcho" } });
    const r = await run(sb, ["--replace-provider", "--json"]);
    assert.equal(r.code, EXIT.ROLLBACK_FAILED, r.out);
    const doc = JSON.parse(r.stdout);
    assert.ok(doc.manualSteps.includes("hermes config set memory.provider honcho"), JSON.stringify(doc.manualSteps));
    assert.equal(existsSync(join(sb.hermesHome, "plugins", "plur1bus", "__init__.py")), true, "kept while memory.provider names it (R17a)");
    assert.equal(readHermesState(sb.hermesHome).inProgress.step, "rollback-failed");
    // the next run finishes the rollback once Hermes accepts the value again
    sb.setScenario({ configSetFailFor: null, selftestFail: false });
    const again = await run(sb, []);
    assert.equal(again.code, EXIT.FAILED, again.out);
    assert.equal(sb.provider(), "honcho");
    assert.equal(existsSync(join(sb.hermesHome, "plugins", "plur1bus")), false);
  });

  it("--hermes-profile work binds hermes-work", async () => {
    const sb = createHermesSandbox();
    const work = join(sb.hermesRoot, "profiles", "work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "config.yaml"), TEMPLATE_CONFIG);
    const r = await run(sb, ["--hermes-profile", "work", "--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    for (const e of sb.log().filter((x) => x.bin === "hermes")) assert.equal(e.hermesHome, work);
    assert.equal(JSON.parse(readFileSync(join(work, "plur1bus.json"), "utf8")).agentId, "hermes-work");
    assert.equal(existsSync(join(sb.hermesRoot, "plur1bus.json")), false);
    assert.ok(sb.plur1busCalls().some((a) => a.join(" ").endsWith("agent create hermes-work")));
    assert.equal(sb.provider(work), "plur1bus");
    assert.equal(sb.provider(sb.hermesRoot), "");
    const reg = JSON.parse(readFileSync(join(sb.plur1busHome, "hosts", "hermes-bindings.json"), "utf8"));
    assert.equal(reg.bindings["hermes-work"], realpathSync.native(work));
    // a second profile shares the sidecar and adds its own agent
    const r2 = await run(sb, ["--json"]);
    assert.equal(r2.code, EXIT.OK, r2.out);
    const reg2 = JSON.parse(readFileSync(join(sb.plur1busHome, "hosts", "hermes-bindings.json"), "utf8"));
    assert.deepEqual(Object.keys(reg2.bindings).sort(), ["hermes-default", "hermes-work"]);
    assert.equal(JSON.parse(r2.stdout).sidecar.reused, true);
  });

  it("Work and work collide and are refused", { skip: !caseSensitiveFs() && "needs a case-sensitive file system (both directories must exist); the rule itself is in the shared vectors" }, async () => {
    const sb = createHermesSandbox();
    for (const p of ["Work", "work"]) {
      mkdirSync(join(sb.hermesRoot, "profiles", p), { recursive: true });
      writeFileSync(join(sb.hermesRoot, "profiles", p, "config.yaml"), TEMPLATE_CONFIG);
    }
    const first = await run(sb, ["--hermes-profile", "Work"]);
    assert.equal(first.code, EXIT.OK, first.out);
    const workHome = join(sb.hermesRoot, "profiles", "work");
    const before = treeDigest(workHome);
    const n = sb.log().length;
    const r = await run(sb, ["--hermes-profile", "work", "--json"]);
    assert.equal(r.code, EXIT.INCOMPATIBLE, r.out);
    const f = JSON.parse(r.stdout).findings.find((x) => x.id === "agent-id-conflict");
    assert.ok(f, r.out);
    assert.ok(f.detail.includes(join(realpathSync.native(sb.hermesRoot), "profiles", "Work")) && f.detail.includes(join(realpathSync.native(sb.hermesRoot), "profiles", "work")), f.detail);
    assert.deepEqual(sb.log().slice(n).filter((e) => e.bin === "plur1bus"), []);
    assert.equal(treeDigest(workHome), before);
  });

  it("a custom HERMES_HOME binds hermes-home-<hash8> (HM2-R8a)", async () => {
    const root = makeTempDir("plur1bus-hermes-");
    const custom = join(root, "srv", "hermes");
    const sb = createHermesSandbox({ root, hermesHome: custom, hermesHomeEnv: custom });
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    const expected = `hermes-home-${hash8(realpathSync.native(custom))}`;
    assert.equal(JSON.parse(readFileSync(join(custom, "plur1bus.json"), "utf8")).agentId, expected);
    assert.equal(JSON.parse(r.stdout).agentId, expected);
    // --hermes-home overrides HERMES_HOME and detection
    const other = join(root, "other-hermes");
    mkdirSync(other, { recursive: true });
    const r2 = await run(sb, ["--hermes-home", other, "--json"]);
    assert.equal(r2.code, EXIT.OK, r2.out);
    assert.equal(JSON.parse(r2.stdout).hermes.home, other);
    assert.equal(JSON.parse(readFileSync(join(other, "plur1bus.json"), "utf8")).agentId, `hermes-home-${hash8(realpathSync.native(other))}`);
  });

  it("a non-ASCII Hermes and PLUR1BUS home install and verify (Review Focus 3)", async () => {
    const root = join(makeTempDir("plur1bus-hermes-"), "Jürgen A", "İnfo");
    const sb = createHermesSandbox({ root });
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.ok(sb.plur1busHome.includes("Jürgen A"));
    const b = JSON.parse(readFileSync(join(sb.hermesHome, "plur1bus.json"), "utf8"));
    assert.equal(b.home, sb.plur1busHome);
    assert.equal(b.bin, sb.sidecarBin);
    assert.ok(sb.plur1busCalls().every((a) => a[0] === "--home" && a[1] === sb.plur1busHome));
    assert.equal(JSON.parse(r.stdout).steps.find((s) => s.id === "verify.selftest").status, "ok");
    assert.ok(existsSync(join(sb.hermesHome, "plugins", "plur1bus", "__init__.py")));
  });

  it("non-interactive licence passes no --accept-nc-licence; --accept-nc-licence passes it", async () => {
    const ni = createHermesSandbox();
    assert.equal((await run(ni, ["--non-interactive"])).code, EXIT.OK);
    const setup = ni.plur1busCalls().find((a) => a[3] === "setup");
    assert.ok(!setup.includes("--accept-nc-licence"), setup.join(" "));
    assert.equal(setup[setup.indexOf("--use-class") + 1], "general");

    const acc = createHermesSandbox();
    const r = await run(acc, ["--accept-nc-licence", "--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.deepEqual(calls(acc), freshCalls(acc, { acceptNc: true }));
    const lic = JSON.parse(r.stdout).licence;
    assert.equal(lic.accepted.by, "sandbox-user");
    assert.equal(lic.accepted.licence, "CC-BY-NC-4.0");
    assert.equal(readHermesState(acc.hermesHome).licence.accepted.by, "sandbox-user");

    // interactive: "not personal" → the commercial use class (F2), no acceptance
    const com = createHermesSandbox();
    const r2 = await run(com, [], { isTTY: true, prompt: async () => "n" });
    assert.equal(r2.code, EXIT.OK, r2.out);
    const s2 = com.plur1busCalls().find((a) => a[3] === "setup");
    assert.equal(s2[s2.indexOf("--use-class") + 1], "commercial");
    assert.ok(!s2.includes("--accept-nc-licence"));
  });

  it("hermes config set is never called with another key; on 0.21.4 never at all (HM2-R24)", async () => {
    const sb = createHermesSandbox();
    assert.equal((await run(sb, [])).code, EXIT.OK);
    for (const a of sb.hermesCalls().filter((x) => x[0] === "config")) assert.equal(a[2], "memory.provider", a.join(" "));
    assert.deepEqual(ALLOWED_HERMES_CONFIG_KEYS, ["memory.provider"]);
    const cli = createHermesCli({ bin: "/nonexistent/hermes", env: {}, run: async () => { throw new Error("must not run"); } });
    await assert.rejects(cli.configSet("model.provider", "x"), (e) => e.code === "CONFIG_KEY_NOT_ALLOWED");
    await assert.rejects(cli.configGet("memory.nosuchkey"), (e) => e.code === "CONFIG_KEY_NOT_ALLOWED");

    // 0.21.4: a backed-up line edit keeps every comment; a rollback puts the original line back
    const old = createHermesSandbox({ scenario: { hermesVersion: "0.21.4" }, configYaml: TEMPLATE_CONFIG.replace("memory:\n", "memory:\n  provider: ''   # none yet\n") });
    const original = readFileSync(join(old.hermesHome, "config.yaml"), "utf8");
    const r = await run(old, ["--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.deepEqual(mutating(old.hermesCalls()), []);
    const edited = readFileSync(join(old.hermesHome, "config.yaml"), "utf8");
    assert.equal(edited, original.replace("  provider: ''   # none yet", "  provider: plur1bus # none yet"));
    const backups = readdirSync(old.hermesHome).filter((n) => n.startsWith("config.yaml.plur1bus-bak-"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(old.hermesHome, backups[0]), "utf8"), original);
    assert.equal(old.provider(), "plur1bus");

    const failing = createHermesSandbox({ scenario: { hermesVersion: "0.21.4", selftestFail: true } });
    const before = readFileSync(join(failing.hermesHome, "config.yaml"), "utf8");
    assert.equal((await run(failing, [])).code, EXIT.FAILED);
    assert.equal(readFileSync(join(failing.hermesHome, "config.yaml"), "utf8"), before);
    assert.deepEqual(mutating(failing.hermesCalls()), []);

    // a config.yaml the line edit cannot change safely is refused before any change
    const flow = createHermesSandbox({ scenario: { hermesVersion: "0.21.4" }, configYaml: "memory: { provider: honcho }\n" });
    const r3 = await run(flow, []);
    assert.equal(r3.code, EXIT.INCOMPATIBLE, r3.out);
    assert.match(r3.out, /hermes-config-uneditable/);
    assert.deepEqual(flow.plur1busCalls(), []);
  });

  it("the installer never reads .env, and config.yaml only for the 0.21.4 line edit (F30)", async () => {
    // static: no module names .env; only config-edit.mjs names config.yaml; file reads only where allowed
    const allowedReaders = new Set(["state.mjs", "binding.mjs", "provider.mjs", "config-edit.mjs", "detect.mjs", "sidecar.mjs"]);
    for (const name of readdirSync(HERMES_MODULES)) {
      const code = readFileSync(join(HERMES_MODULES, name), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      assert.ok(!/["'`/\\]\.env\b/.test(code), `${name} names .env`);
      if (name !== "config-edit.mjs") assert.ok(!/config\.yaml/.test(code), `${name} names config.yaml`);
      if (!allowedReaders.has(name)) assert.ok(!/\breadFile(Sync)?\b|\bcreateReadStream\b/.test(code), `${name} reads files`);
    }
    // dynamic: a sentinel in .env and in config.yaml never reaches the report, the output or any argv
    const SENTINEL = "sk-TEST-SENTINEL-must-never-appear";
    for (const hermesVersion of ["0.21.5", "0.21.4"]) {
      const sb = createHermesSandbox({ scenario: { hermesVersion }, configYaml: `${TEMPLATE_CONFIG}# api_key: ${SENTINEL}\n` });
      writeFileSync(join(sb.hermesHome, ".env"), `OPENAI_API_KEY=${SENTINEL}\n`);
      const r = await run(sb, ["--json"]);
      assert.equal(r.code, EXIT.OK, r.out);
      assert.ok(!r.out.includes(SENTINEL), hermesVersion);
      assert.ok(!readFileSync(join(sb.root, "argv.log"), "utf8").includes(SENTINEL), hermesVersion);
      assert.equal(readFileSync(join(sb.hermesHome, ".env"), "utf8"), `OPENAI_API_KEY=${SENTINEL}\n`);
    }
  });

  it("unsupported targets exit 3 before any change, with every fatal finding together", async () => {
    const sb = createHermesSandbox({ scenario: { hermesVersion: "0.20.1" } });
    const before = treeDigest(sb.hermesHome);
    const r = await run(sb, ["--json"], { arch: "ia32" });
    assert.equal(r.code, EXIT.INCOMPATIBLE, r.out);
    const ids = JSON.parse(r.stdout).findings.filter((f) => f.fatal).map((f) => f.id);
    assert.deepEqual(ids.sort(), ["hermes-too-old", "unsupported-target"]);
    assert.deepEqual(sb.plur1busCalls(), []);
    assert.deepEqual(mutating(sb.hermesCalls()), []);
    assertNothingInstalled(sb, before);
    // musl Linux is unsupported too
    if (process.platform === "linux") {
      const m = await run(createHermesSandbox(), [], { glibcVersion: null });
      assert.equal(m.code, EXIT.INCOMPATIBLE);
      assert.match(m.out, /unsupported-target/);
    }
  });

  it("no hermes on PATH exits 3 hermes-not-found; a missing profile home exits 3", async () => {
    const sb = createHermesSandbox();
    const env = { ...sb.env, PATH: sb.env.PATH.split(process.platform === "win32" ? ";" : ":").slice(1).join(process.platform === "win32" ? ";" : ":") };
    const r = await run({ ...sb, env }, ["--json"]);
    assert.equal(r.code, EXIT.INCOMPATIBLE, r.out);
    assert.match(r.out, /hermes-not-found/);
    const p = await run(createHermesSandbox(), ["--hermes-profile", "nope"]);
    assert.equal(p.code, EXIT.INCOMPATIBLE, p.out);
    assert.match(p.out, /hermes-home-missing/);
    const bad = await run(createHermesSandbox(), ["--hermes-profile", "../x"]);
    assert.equal(bad.code, EXIT.FAILED);
  });

  it("an unknown vgit version warns and continues; Python outside Hermes' own requires-python is refused (HM2-R22a, R25)", async () => {
    const v = createHermesSandbox({ scenario: { hermesVersion: "vgit" } });
    const r = await run(v, ["--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.match(r.out, /hermes-version-unknown/);
    // HM2-R24a: an unknown version never gets `hermes config set`; the backed-up line edit activates the provider
    assert.deepEqual(mutating(v.hermesCalls()), [], "no hermes config set for an unknown version");
    assert.equal(readHermesState(v.hermesHome).configEdit.method, "line");
    assert.equal(readdirSync(v.hermesHome).filter((n) => n.startsWith("config.yaml.plur1bus-bak-")).length, 1, "a backup is kept");
    assert.match(readFileSync(join(v.hermesHome, "config.yaml"), "utf8"), /^ +provider: plur1bus\s*$/m);

    const py = createHermesSandbox({ scenario: { python: "3.14.1" } });
    const r2 = await run(py, []);
    assert.equal(r2.code, EXIT.INCOMPATIBLE, r2.out);
    assert.match(r2.out, /python-unsupported.*<3\.14/s);
    const py15 = createHermesSandbox({ scenario: { python: "3.14.1" }, requiresPython: ">=3.11,<3.15" });
    assert.equal((await run(py15, [])).code, EXIT.OK);
    assert.equal(pep440Satisfies("3.11.15", ">=3.11,<3.14"), true);
    assert.equal(pep440Satisfies("3.10.9", ">=3.11"), false);
    assert.equal(pep440Satisfies("3.14.0", ">=3.11,<3.14"), false);
    assert.equal(pep440Satisfies("3.12", "~=3.11"), null);
  });

  it("installing over an existing plur1bus install becomes an update (F17)", async () => {
    const sb = createHermesSandbox();
    assert.equal((await run(sb, [])).code, EXIT.OK);
    const n = sb.log().length;
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.match(r.out, /up-to-date/);
    assert.equal(JSON.parse(r.stdout).mode, "update");
    assert.deepEqual(mutating(sb.log().slice(n).filter((e) => e.bin === "hermes").map((e) => e.argv)), []);
    assert.deepEqual(sb.log().slice(n).filter((e) => e.bin === "plur1bus"), []);
    // a newer release needs the update path
    const f = structuredClone(sb.feed);
    f.hosts.hermes.releases[0].version = "0.2.0";
    f.hosts.hermes.releases[0].sidecar.version = "0.2.0";
    f.hosts.hermes.latest = "0.2.0";
    sb.writeFeed(f);
    const r2 = await run(sb, []);
    assert.equal(r2.code, EXIT.NEEDS_CHOICE, r2.out);
    assert.match(r2.out, /--update/);
  });

  it("setup runs with --no-service only under both test variables; a host setup without config.json still binds (R19, T4 carry)", async () => {
    const sb = createHermesSandbox({ scenario: { setupWritesNoConfig: true } });
    delete sb.env.PLUR1BUS_PLUGIN_TEST_NO_SERVICE;
    const r = await run(sb, []);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.ok(!sb.plur1busCalls().find((a) => a[3] === "setup").includes("--no-service"));
    const noTest = createHermesSandbox();
    const env = { ...noTest.env };
    delete env.PLUR1BUS_PLUGIN_INSTALLER_TEST;
    const r2 = await run({ ...noTest, env }, []);
    assert.notEqual(r2.code, EXIT.OK, "file:// artefacts need test mode");
    assert.deepEqual(noTest.plur1busCalls(), []);
  });

  it("a failing setup or agent create rolls back to nothing", async () => {
    for (const scenario of [{ setupExit: 1 }, { agentCreateExit: 1 }]) {
      const sb = createHermesSandbox({ scenario });
      const before = treeDigest(sb.hermesHome);
      const r = await run(sb, []);
      assert.equal(r.code, EXIT.FAILED, r.out);
      assertNothingInstalled(sb, before);
    }
  });

  it("--dry-run changes nothing and --host flags are checked", async () => {
    const sb = createHermesSandbox();
    const before = treeDigest(sb.hermesHome);
    const r = await run(sb, ["--dry-run", "--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.ok(JSON.parse(r.stdout).steps.some((s) => s.status === "planned" && s.id === "activate"));
    assertNothingInstalled(sb, before);
    assert.equal((await run(sb, ["--source", "npm"])).code, EXIT.FAILED);
    assert.equal((await run(sb, ["--uninstall"])).code, EXIT.FAILED);
    assert.equal((await run(sb, ["--hermes-profile", "a", "--hermes-home", sb.hermesHome])).code, EXIT.FAILED);
  });
});

describe("hermes installer: shared rules", () => {
  it("hermes home resolution follows the harness table", () => {
    const { cases } = JSON.parse(readFileSync(join(FIX, "hermes", "hermes-home-vectors.json"), "utf8"));
    assert.ok(cases.length >= 11);
    for (const c of cases) {
      const got = resolveHermesHome({ env: c.env, platform: c.platform, homedir: c.homedir });
      assert.deepEqual({ root: got.root, resolvedFrom: got.resolvedFrom, profile: got.profile }, { root: c.root, resolvedFrom: c.resolvedFrom, profile: c.profile }, JSON.stringify(c));
      const P = c.platform === "win32" ? win32 : posix;
      if (c.profile) {
        assert.equal(P.basename(got.home), c.profile);
        assert.equal(P.basename(P.dirname(got.home)).toLowerCase(), "profiles");
        assert.equal(P.dirname(P.dirname(got.home)), c.root);
      } else {
        assert.equal(got.home, c.root);
      }
    }
    // --hermes-profile is a profile of the resolved root; --hermes-home wins over HERMES_HOME
    assert.equal(resolveHermesHome({ env: {}, platform: "linux", homedir: "/home/u", profile: "work" }).home, "/home/u/.hermes/profiles/work");
    assert.equal(resolveHermesHome({ env: { HERMES_HOME: "/x" }, platform: "linux", homedir: "/home/u", explicit: "~/y" }).home, "/home/u/y");
    // the sidecar paths the harness scripts use
    assert.equal(sidecarBinPath({ platform: "linux", env: { HOME: "/home/u" } }), "/home/u/.local/bin/plur1bus");
    assert.equal(sidecarBinPath({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" } }), "C:\\L\\PLUR1BUS\\bin\\plur1bus.exe");
    assert.equal(sidecarBinPath({ platform: "win32", env: { USERPROFILE: "C:\\Users\\Jürgen A" } }), "C:\\Users\\Jürgen A\\AppData\\Local\\PLUR1BUS\\bin\\plur1bus.exe");
    assert.equal(plur1busHome({ platform: "linux", env: { HOME: "/home/u", PLUR1BUS_HOME: "" } }), "/home/u/.plur1bus", "an empty PLUR1BUS_HOME is unset (HM2-R26)");
    assert.equal(plur1busHome({ platform: "linux", env: { HOME: "/home/u", PLUR1BUS_HOME: "/data/p" } }), "/data/p");
    assert.equal(plur1busHome({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" } }), "C:\\L\\PLUR1BUS");
  });

  it("agent ids and the registry follow the shared binding vectors (F11)", () => {
    const v = JSON.parse(readFileSync(join(FIX, "hermes", "binding-vectors.json"), "utf8"));
    for (const c of v.fold) assert.equal(foldProfile(c.profile), c.agentId, JSON.stringify(c));
    for (const c of v.classify) assert.equal(classifyHome(c.home, c.defaultRoot, c.platform), c.agentId, JSON.stringify(c));
    for (const c of v.registry) {
      let bindings = {};
      for (const step of c.steps) {
        if (step.result === "ok") bindings = registryAdd(bindings, step.agentId, step.home, c.platform);
        else {
          assert.throws(() => registryAdd(bindings, step.agentId, step.home, c.platform), (e) => e instanceof BindingConflict && e.otherHome === step.result.conflict && e.message.includes(step.home), c.name);
        }
      }
      assert.deepEqual(bindings, c.bindings, c.name);
    }
  });

  it("binding and registry readers take the provider's files, ignore unknown keys, and name other bound homes (F12, F4)", () => {
    const pj = (n) => JSON.parse(readFileSync(join(FIX, "hermes", "provider-json", n), "utf8"));
    const hh = makeTempDir("hermes-binding-");
    writeFileSync(join(hh, "plur1bus.json"), JSON.stringify({ ...pj("binding.json"), bindingError: "x", future: { a: 1 } }));
    const b = readBinding(hh);
    assert.deepEqual([b.agentId, b.home, b.version, b.installedBy], ["hermes-work", "/home/u/.plur1bus", "0.1.0", "plur1bus-plugin-installer"]);
    const ph = makeTempDir("hermes-registry-");
    mkdirSync(join(ph, "hosts"));
    writeFileSync(join(ph, "hosts", "hermes-bindings.json"), JSON.stringify({ ...pj("bindings.json"), lost: 0, rejected: 2 }));
    assert.deepEqual(readRegistry(ph), pj("bindings.json").bindings);
    // F4 (Task 9's purge guard): every other Hermes home bound to this sidecar is named
    const reg = makeTempDir("hermes-registry-");
    const a = join(reg, "a");
    const c = join(reg, "c");
    mkdirSync(a);
    mkdirSync(c);
    registerBinding(reg, "hermes-default", a);
    assert.deepEqual(otherBoundHomes(reg, a), []);
    registerBinding(reg, "hermes-work", c);
    assert.deepEqual(otherBoundHomes(reg, a), [{ agentId: "hermes-work", home: realpathSync.native(c) }]);
  });

  it("the line edit removes a config.yaml it created when undone (HM2-R24)", () => {
    const hh = makeTempDir("hermes-config-");
    const { undo } = setProviderLine({ hermesHome: hh, value: "plur1bus" });
    assert.equal(readFileSync(join(hh, "config.yaml"), "utf8"), "memory:\n  provider: plur1bus\n");
    undoProviderLine({ hermesHome: hh, undo, value: "plur1bus" });
    assert.equal(existsSync(join(hh, "config.yaml")), false);
  });

  it("the harness fixtures are byte copies (F11, F12)", () => {
    const src = JSON.parse(readFileSync(join(FIX, "hermes", "SOURCES.json"), "utf8"));
    const harness = process.env.PLUR1BUS_HARNESS_DIR;
    for (const [p, rec] of Object.entries(src.files)) {
      const bytes = readFileSync(join(FIX, ...p.split("/")));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), rec.sha256, p);
      if (harness && existsSync(join(harness, rec.harnessPath))) assert.deepEqual(bytes, readFileSync(join(harness, rec.harnessPath)), `${p} differs from the harness copy`);
    }
    // every fixture file is listed (a new copy needs a record)
    const listed = new Set(Object.keys(src.files));
    for (const d of ["hermes-cli", join("hermes", "provider-json")]) {
      for (const n of readdirSync(join(FIX, d))) assert.ok(listed.has(relative(FIX, join(FIX, d, n)).split("\\").join("/")), `${d}/${n} is not in SOURCES.json`);
    }
  });

  it("readers take the provider's JSON shapes and ignore unknown keys (F12)", () => {
    const ok = JSON.parse(readFileSync(join(FIX, "hermes", "provider-json", "selftest-ok.json"), "utf8"));
    assert.deepEqual(readSelftestDoc(ok).ok, true);
    const extra = { ...ok, lost: 3, rejected: 1, bindingError: null, hermesHome: "<hermes-home>", checks: ok.checks.map((c) => ({ ...c, future: true })) };
    assert.deepEqual(readSelftestDoc(extra), readSelftestDoc(ok));
    const fail = JSON.parse(readFileSync(join(FIX, "hermes", "provider-json", "selftest-fail.json"), "utf8"));
    assert.equal(readSelftestDoc(fail).ok, false);
    assert.equal(readSelftestDoc({ ...ok, schema: "plur1bus.hermes-status/1" }), null);
    assert.equal(readSelftestDoc({ ...ok, checks: [...ok.checks, { id: "x", ok: false }] }).ok, false, "a failed check wins over ok: true");
    const status = readFileSync(join(FIX, "hermes-cli", "memory-status-plur1bus.txt"), "utf8");
    assert.deepEqual(parseMemoryStatus(status), { provider: "plur1bus", available: true });
    assert.deepEqual(parseMemoryStatus(readFileSync(join(FIX, "hermes-cli", "memory-status-unavailable.txt"), "utf8")).available, false);
    assert.deepEqual(parseMemoryStatus("  Provider:  (none — built-in only)\n"), { provider: null, available: null });
    const v = parseHermesVersion(readFileSync(join(FIX, "hermes-cli", "version-min.txt"), "utf8").split("\n").slice(1).join("\n"));
    assert.equal(v.version, "0.21.4");
    assert.equal(v.python, "3.11.15");
    assert.equal(parseHermesVersion("Hermes Agent vgit.16c59d0 (2026.9.24) · upstream 16c59d0e\n").version, null);
  });

  it("the 0.21.4 line edit changes only the provider line and undoes exactly that (HM2-R24)", () => {
    const cases = [
      ["memory:\n  provider: honcho\n  x: 1\n", "memory:\n  provider: plur1bus\n  x: 1\n", "replaced"],
      ["a: 1\r\nmemory:\r\n    enabled: true\r\n", "a: 1\r\nmemory:\r\n    provider: plur1bus\r\n    enabled: true\r\n", "inserted"],
      ["a: 1\n", "a: 1\nmemory:\n  provider: plur1bus\n", "appended"],

      ["memory:  # c\n  provider: \"mem0\" # keep\nb: 2\n", "memory:  # c\n  provider: plur1bus # keep\nb: 2\n", "replaced"],
    ];
    for (const [before, after, kind] of cases) {
      const p = planProviderEdit(before, "plur1bus");
      assert.equal(p.ok, true, before);
      assert.equal(p.text, after, before);
      assert.equal(p.undo.kind, kind);
      assert.equal(planProviderUndo(p.text, p.undo, "plur1bus").text, before, `undo of ${JSON.stringify(before)}`);
    }
    // a file without a final newline gets one
    const nl = planProviderEdit("a: 1", "plur1bus");
    assert.equal(nl.text, "a: 1\nmemory:\n  provider: plur1bus\n");
    assert.equal(planProviderUndo(nl.text, nl.undo, "plur1bus").text, "a: 1\n");
    for (const bad of ["memory: {provider: x}\n", "memory:\n\tprovider: x\n", "memory:\n  provider: x\nmemory:\n  a: 1\n", "a: 1\n---\nmemory: {}\n", "memory:\n  provider: &a x\n", "memory:\n  provider: x\n  provider: y\n"]) {
      assert.equal(planProviderEdit(bad, "plur1bus").ok, false, JSON.stringify(bad));
    }
    assert.equal(planProviderUndo("memory:\n  provider: other\n", { kind: "inserted" }, "plur1bus").ok, false, "a line someone changed since is left alone");
  });
});

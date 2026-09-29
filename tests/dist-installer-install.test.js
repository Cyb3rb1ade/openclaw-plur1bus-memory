// tests/dist-installer-install.test.js — the Node plugin installer (HM1 Task 5) against
// the sandbox's openclaw/node shims only. Never a real OpenClaw, never real credentials.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runInstaller } from "../scripts/dist/installer/main.mjs";
import { resolveOpenclawStateDir } from "../scripts/dist/installer/detect.mjs";
import { ALLOWED_CONFIG_PATHS, createOpenclawCli, defaultRun } from "../scripts/dist/installer/openclaw-cli.mjs";
import { resolveLicence } from "../scripts/dist/installer/licence.mjs";
import { checkCompat, findHarnessHomes } from "../scripts/dist/installer/compat.mjs";
import { whichOnPath } from "../scripts/dist/installer/detect.mjs";
import { EXIT } from "../scripts/dist/installer/report.mjs";
import { readState } from "../scripts/dist/installer/state.mjs";
import { createInstallerSandbox, makeTestFeed, mutatingCalls, runSandboxInstaller, sha256File, sink } from "./helpers/installer-sandbox.js";
import { generateTestKeyPair } from "./helpers/minisign-sign.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const ID = "memory-lancedb-namespaced";
const P = `plugins.entries.${ID}`;
const C = `${P}.config`;
const SLOT = "plugins.slots.memory";
const SECRET = "sk-TEST-DO-NOT-LOG";

const run = runSandboxInstaller;

const mutating = mutatingCalls;

const freshClawhub = (stateDir) => [
  ["--version"],
  ["config", "validate"],
  ["config", "get", `${C}.baseDbPath`],
  ["plugins", "inspect", ID, "--json"],
  ["config", "get", SLOT],
  ["config", "get", `${C}.embedding.provider`],
  ["config", "get", `${C}.modelPreparation.profile`],
  ["config", "get", `${C}.modelPreparation.acceptNonCommercialLicense`],
  ["config", "get", `${C}.embedding.model`],
  ["config", "get", `${P}.hooks.allowConversationAccess`],
  ["plugins", "install", "clawhub:@cyb3rb1ade/plur1bus-memory@7.16.11"],
  ["config", "set", `${C}.modelPreparation.profile`, "e5-multilingual-384"],
  ["config", "set", `${C}.modelPreparation.acceptNonCommercialLicense`, "false"],
  ["config", "set", `${C}.embedding.provider`, "local-transformers"],
  ["config", "set", `${C}.embedding.model`, "intfloat/multilingual-e5-small"],
  ["config", "set", `${P}.hooks.allowConversationAccess`, "true"],
  ["config", "set", SLOT, ID],
  ["plugins", "inspect", ID, "--json"],
  ["gateway", "status", "--json"],
  ["plugins", "inspect", ID, "--runtime", "--json"],
  ["plur1bus", "selftest", "--json", "--state-dir", stateDir],
];

describe("plugin installer: install", () => {
  it("fresh install runs install, sets the slot, runs selftest and verifies integrity", async () => {
    const sb = createInstallerSandbox();
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.deepEqual(sb.openclawCalls(), freshClawhub(sb.stateDir));
    assert.deepEqual(sb.log().filter((e) => e.bin === "node").map((e) => e.argv), [["--version"]]);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.ok, true);
    const byId = Object.fromEntries(doc.steps.map((s) => [s.id, s]));
    for (const id of ["detect", "compat", "install", "licence", "slot", "verify.loaded", "verify.integrity", "verify.selftest", "verify.model"]) {
      assert.equal(byId[id]?.status, "ok", `${id}: ${JSON.stringify(byId[id])}`);
    }
    assert.equal(byId.crons.status, "skipped");
    assert.match(byId.crons.detail, /gateway-start-reconciles/);
    assert.match(r.stderr, /conversation access for capture and recall/);
    const st = readState(sb.stateDir);
    assert.equal(st.schema, 1);
    assert.equal(st.installedVersion, "7.16.11");
    assert.equal(st.source, "clawhub");
    assert.equal(st.previousSlot, null);
    assert.equal(st.inProgress, undefined);
    if (process.platform !== "win32") {
      assert.equal(statSync(join(sb.stateDir, "memory", ".plur1bus-installer.json")).mode & 0o777, 0o600);
    }
    assert.equal(sb.shimState().config[SLOT], ID);
  });

  it("runs the feature cron script with the detected node when a Gateway is running", async () => {
    const sb = createInstallerSandbox({ scenario: { gatewayRunning: true } });
    const r = await run(sb, ["--source", "npm"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.ok(sb.openclawCalls().some((a) => a.join(" ") === "plugins install npm:@cyb3rb1ade/plur1bus-memory@7.16.11 --pin"));
    const cron = sb.log().filter((e) => e.bin === "node" && e.argv[0].endsWith("setup-feature-crons.mjs"));
    assert.equal(cron.length, 1);
    assert.deepEqual(cron[0].argv.slice(1), ["--json"]);
    assert.ok(cron[0].argv[0].startsWith(join(sb.stateDir, "npm", "projects")), cron[0].argv[0]);
  });

  it("PLUR1BUS_SELFTEST_FORCE_FAIL=1 with the test flag fails a fresh install's verify and rolls it back (Task 8 CI seam)", async () => {
    const sb = createInstallerSandbox();
    const r = await run({ ...sb, env: { ...sb.env, PLUR1BUS_SELFTEST_FORCE_FAIL: "1" } }, ["--json"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    const doc = JSON.parse(r.stdout);
    assert.match(doc.steps.find((s) => s.id === "verify.selftest").detail, /forced by PLUR1BUS_SELFTEST_FORCE_FAIL=1/);
    assert.ok(sb.openclawCalls().some((a) => a[0] === "plugins" && a[1] === "uninstall"));
  });

  it("an install whose selftest fails is uninstalled and the previous slot restored, exit 1", async () => {
    const sb = createInstallerSandbox({
      scenario: {
        config: { [SLOT]: "memory-lancedb-stock" },
        selftest: { schema: "plur1bus.selftest/1", ok: false, addons: [], model: { state: "present" }, steps: [], warnings: [], errors: ["store.open failed"] },
      },
    });
    const r = await run(sb, []);
    assert.equal(r.code, EXIT.FAILED, r.out);
    const calls = sb.openclawCalls();
    const u = calls.findIndex((a) => a.join(" ") === `plugins uninstall ${ID} --force`);
    assert.ok(u > 0, JSON.stringify(calls));
    assert.deepEqual(calls[u + 1], ["config", "set", SLOT, "memory-lancedb-stock"]);
    assert.equal(sb.shimState().installed, false);
    assert.equal(sb.shimState().config[SLOT], "memory-lancedb-stock");
    assert.match(r.stderr, /selftest/);
    const st = readState(sb.stateDir);
    assert.equal(st.installedVersion, null);
    assert.equal(st.inProgress, undefined);
  });

  it("a failed rollback exits 4 and prints the manual steps", async () => {
    const sb = createInstallerSandbox({ scenario: { uninstallExit: 1, runtimeImported: false } });
    const r = await run(sb, []);
    assert.equal(r.code, EXIT.ROLLBACK_FAILED, r.out);
    assert.match(r.stderr, /openclaw plugins uninstall memory-lancedb-namespaced --force/);
  });

  it("integrity mismatch against the feed uninstalls and fails", async () => {
    const sb = createInstallerSandbox({ feed: makeTestFeed({ clawpackDigest: "ab".repeat(32) }) });
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.ok(sb.openclawCalls().some((a) => a.join(" ") === `plugins uninstall ${ID} --force`));
    const doc = JSON.parse(r.stdout);
    const integrity = doc.steps.find((s) => s.id === "verify.integrity");
    assert.equal(integrity.status, "failed");
    assert.match(integrity.detail, /clawpackSha256/);
    assert.equal(sb.shimState().installed, false);

    const sb2 = createInstallerSandbox({ scenario: { recordNpmIntegrity: `sha512-${"A".repeat(86)}==` } });
    const r2 = await run(sb2, ["--source", "npm"]);
    assert.equal(r2.code, EXIT.FAILED, r2.out);
    assert.match(r2.stderr, /npmIntegrity/);
    assert.equal(sb2.shimState().installed, false);
  });

  it("an already tracked install switches to update", async () => {
    const sb = createInstallerSandbox({ scenario: { installed: true, installedVersion: "7.16.10" } });
    const r = await run(sb, ["--json"]);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.mode, "update", r.out);
    assert.deepEqual(mutating(sb.openclawCalls()), []);
    const existing = doc.steps.find((s) => s.id === "existing");
    assert.match(existing.detail, /tracked install 7\.16\.10/);

    // without a TTY and without --yes the update needs a choice (Task 6) and changes nothing
    assert.equal(r.code, EXIT.NEEDS_CHOICE, r.out);
    const u = await run(sb, ["--update"]);
    assert.equal(u.code, EXIT.NEEDS_CHOICE, u.out);
    assert.match(u.stderr, /--yes/);
    assert.deepEqual(mutating(sb.openclawCalls()), []);
  });

  it("an untracked extensions dir exits 2 naming --adopt-legacy and changes nothing", async () => {
    const sb = createInstallerSandbox({ scenario: { legacy: true } });
    const legacyDir = join(sb.stateDir, "extensions", ID);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "index.js"), "// legacy deploy\n");
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.NEEDS_CHOICE, r.out);
    assert.match(r.out, /--adopt-legacy/);
    assert.match(r.out, /legacy-deploy/);
    assert.deepEqual(mutating(sb.openclawCalls()), []);
    assert.equal(readFileSync(join(legacyDir, "index.js"), "utf8"), "// legacy deploy\n");
    assert.equal(readState(sb.stateDir), null);
  });

  it("an extensions dir OpenClaw does not report is still a legacy deploy (exit 2)", async () => {
    const sb = createInstallerSandbox();
    mkdirSync(join(sb.stateDir, "extensions", ID), { recursive: true });
    const r = await run(sb, []);
    assert.equal(r.code, EXIT.NEEDS_CHOICE, r.out);
    assert.match(r.stderr, /legacy-deploy.*--adopt-legacy/);
    assert.deepEqual(mutating(sb.openclawCalls()), []);
  });

  it("readonly or invalid config stops before any change", async () => {
    for (const [name, value] of [["OPENCLAW_CONFIG_READONLY", "1"], ["OPENCLAW_NIX_MODE", "1"]]) {
      const sb = createInstallerSandbox({ extraEnv: { [name]: value } });
      const r = await run(sb, ["--json"]);
      assert.equal(r.code, EXIT.INCOMPATIBLE, r.out);
      assert.deepEqual(mutating(sb.openclawCalls()), []);
      const doc = JSON.parse(r.stdout);
      assert.ok(doc.findings.some((f) => f.id === "config-readonly" && f.fatal), JSON.stringify(doc.findings));
      assert.match(r.stderr, name === "OPENCLAW_NIX_MODE" ? /Nix source/ : /external deployment source/);
      assert.equal(readState(sb.stateDir), null);
    }
    const sb = createInstallerSandbox({ scenario: { configValidateExit: 1 } });
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.INCOMPATIBLE, r.out);
    assert.deepEqual(mutating(sb.openclawCalls()), []);
    assert.equal(sb.openclawCalls().filter((a) => a.join(" ") === "config validate").length, 1, "no retry loop");
    assert.match(r.stderr, /openclaw doctor --fix/);
    assert.ok(JSON.parse(r.stdout).findings.some((f) => f.id === "config-invalid"));
  });

  it("state dir resolution follows OpenClaw for profiles, legacy dir, spaces and non-ASCII", async () => {
    const none = () => false;
    const cases = [
      ["linux default", "linux", { HOME: "/home/a" }, none, "/home/a/.openclaw", null, false],
      ["linux OPENCLAW_HOME with space and umlaut", "linux", { HOME: "/home/a", OPENCLAW_HOME: "/tmp/p b/Jürgen" }, none, "/tmp/p b/Jürgen/.openclaw", null, false],
      ["linux profile", "linux", { HOME: "/tmp/p b/Jürgen", OPENCLAW_PROFILE: "work" }, none, "/tmp/p b/Jürgen/.openclaw-work", "work", false],
      ["profile default is no profile", "linux", { HOME: "/home/a", OPENCLAW_PROFILE: "Default" }, none, "/home/a/.openclaw", null, false],
      ["invalid profile name is ignored", "linux", { HOME: "/home/a", OPENCLAW_PROFILE: "../x" }, none, "/home/a/.openclaw", null, false],
      ["state dir wins over profile", "linux", { HOME: "/home/a", OPENCLAW_PROFILE: "work", OPENCLAW_STATE_DIR: "/srv/oc state" }, none, "/srv/oc state", "work", false],
      ["state dir with tilde", "linux", { HOME: "/home/a", OPENCLAW_STATE_DIR: "~/oc" }, none, "/home/a/oc", null, false],
      ["legacy .clawdbot alone", "linux", { HOME: "/home/a" }, (p) => p === "/home/a/.clawdbot", "/home/a/.clawdbot", null, true],
      ["both exist: .openclaw", "linux", { HOME: "/home/a" }, (p) => p === "/home/a/.clawdbot" || p === "/home/a/.openclaw", "/home/a/.openclaw", null, false],
      ["HOME 'undefined' falls through to USERPROFILE", "linux", { HOME: "undefined", USERPROFILE: "/home/b" }, none, "/home/b/.openclaw", null, false],
      ["darwin non-ASCII", "darwin", { HOME: "/Users/Jürgen A" }, none, "/Users/Jürgen A/.openclaw", null, false],
      ["win32 USERPROFILE", "win32", { USERPROFILE: "C:\\Users\\Jürgen A" }, none, "C:\\Users\\Jürgen A\\.openclaw", null, false],
      ["win32 profile", "win32", { USERPROFILE: "C:\\Users\\Jürgen A", OPENCLAW_PROFILE: "work" }, none, "C:\\Users\\Jürgen A\\.openclaw-work", "work", false],
      ["win32 legacy", "win32", { USERPROFILE: "C:\\Users\\a" }, (p) => p === "C:\\Users\\a\\.clawdbot", "C:\\Users\\a\\.clawdbot", null, true],
      ["os.homedir fallback", "linux", {}, none, "/home/fallback/.openclaw", null, false],
    ];
    for (const [name, platform, env, exists, stateDir, profile, legacy] of cases) {
      const r = resolveOpenclawStateDir({ env, platform, homedir: () => (platform === "win32" ? "C:\\Users\\fallback" : "/home/fallback"), exists });
      assert.equal(r.stateDir, stateDir, name);
      assert.equal(r.profile, profile, name);
      assert.equal(r.legacy, legacy, name);
      const sep = platform === "win32" ? "\\" : "/";
      assert.equal(r.configPath, `${stateDir}${sep}openclaw.json`, name);
    }
    assert.equal(resolveOpenclawStateDir({ env: { HOME: "/h", OPENCLAW_CONFIG_PATH: "/etc/oc b.json" }, platform: "linux", homedir: () => "/h", exists: none }).configPath, "/etc/oc b.json");

    const root = join(makeTempDir("plur1bus-installer-ws-"), "p b", "Jürgen");
    const sb = createInstallerSandbox({ root, profile: "work" });
    assert.equal(sb.stateDir, join(root, "home", ".openclaw-work"));
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.stateDir, sb.stateDir);
    assert.equal(readState(sb.stateDir).installedVersion, "7.16.11");
  });

  it("non-interactive licence defaults to E5 and never accepts silently", async () => {
    const sb = createInstallerSandbox();
    const r = await run(sb, ["--non-interactive"]);
    assert.equal(r.code, EXIT.OK, r.out);
    const sets = sb.openclawCalls().filter((a) => a[1] === "set").map((a) => a.slice(2));
    assert.deepEqual(sets.find((s) => s[0] === `${C}.modelPreparation.profile`), [`${C}.modelPreparation.profile`, "e5-multilingual-384"]);
    assert.deepEqual(sets.find((s) => s[0].endsWith("acceptNonCommercialLicense")), [`${C}.modelPreparation.acceptNonCommercialLicense`, "false"], "E5 writes an explicit false (T5-g)");
    assert.ok(!sets.some((s) => s[0].endsWith("acceptNonCommercialLicense") && s[1] === "true"), JSON.stringify(sets));
    assert.equal(readState(sb.stateDir).licence, undefined);

    // a TTY without --non-interactive asks; declining the use class gives E5, nothing accepted
    const asked = [];
    const e5 = await resolveLicence({ interactive: true, acceptNc: false, env: {}, prompt: async (q) => (asked.push(q), "n") });
    assert.equal(e5.profile, "e5-multilingual-384");
    assert.equal(e5.acceptNonCommercialLicense, false);
    assert.equal(asked.length, 1);
    // yes to personal use but no to the licence: still E5
    const e5b = await resolveLicence({ interactive: true, acceptNc: false, env: {}, prompt: async (q) => (/licen[cs]e/i.test(q) ? "no" : "yes") });
    assert.equal(e5b.profile, "e5-multilingual-384");
    assert.equal(e5b.acceptNonCommercialLicense, false);
    // non-interactive never prompts
    const ni = await resolveLicence({ interactive: false, acceptNc: false, env: {}, prompt: async () => { throw new Error("no prompt"); } });
    assert.equal(ni.profile, "e5-multilingual-384");
  });

  it("--accept-nc-licence records who, when, model, revision and licence", async () => {
    const sb = createInstallerSandbox();
    const r = await run(sb, ["--accept-nc-licence", "--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    const calls = sb.openclawCalls();
    assert.ok(calls.some((a) => a.join(" ") === `config set ${C}.modelPreparation.profile jina-v5-nano-768`));
    assert.ok(calls.some((a) => a.join(" ") === `config set ${C}.modelPreparation.acceptNonCommercialLicense true`));
    assert.ok(calls.some((a) => a.join(" ") === `config set ${C}.embedding.model jinaai/jina-embeddings-v5-text-nano-retrieval`));
    const accepted = readState(sb.stateDir).licence;
    assert.equal(accepted.by, "sandbox-user");
    assert.ok(!Number.isNaN(Date.parse(accepted.at)));
    assert.equal(accepted.model, "jinaai/jina-embeddings-v5-text-nano-retrieval");
    assert.equal(accepted.revision, "ac5d898c8d382b17167c33e5c8af644a3519b47d");
    assert.equal(accepted.licence, "CC-BY-NC-4.0");
    assert.deepEqual(JSON.parse(r.stdout).licence.accepted, accepted);

    // the environment alias is honoured too
    const viaEnv = await resolveLicence({ interactive: false, acceptNc: false, env: { PLUR1BUS_ACCEPT_NONCOMMERCIAL_LICENSE: "1", USER: "u" }, prompt: null });
    assert.equal(viaEnv.profile, "jina-v5-nano-768");
    assert.equal(viaEnv.acceptNonCommercialLicense, true);
    assert.equal(viaEnv.accepted.by, "u");
  });

  it("an existing embedding choice is never changed", async () => {
    const sb = createInstallerSandbox({ scenario: { config: { [`${C}.embedding.provider`]: "openai" } } });
    const r = await run(sb, ["--accept-nc-licence"]);
    assert.equal(r.code, EXIT.OK, r.out);
    const sets = sb.openclawCalls().filter((a) => a[1] === "set").map((a) => a[2]);
    assert.deepEqual(sets, [`${P}.hooks.allowConversationAccess`, SLOT]);
  });

  it("a baseDbPath inside a harness home is refused", async () => {
    const root = makeTempDir("plur1bus-installer-hh-");
    const harness = join(root, "harness home");
    mkdirSync(harness, { recursive: true });
    writeFileSync(join(harness, "manifest.json"), "{}\n");
    const sb = createInstallerSandbox({ scenario: { config: { [`${C}.baseDbPath`]: join(harness, "store") } }, extraEnv: { PLUR1BUS_HOME: harness } });
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.INCOMPATIBLE, r.out);
    assert.ok(JSON.parse(r.stdout).findings.some((f) => f.id === "store-inside-harness-home" && f.fatal));
    assert.deepEqual(mutating(sb.openclawCalls()), []);

    // a child named "..foo" is still inside; every candidate home is checked, not just the first
    const other = join(root, "other");
    mkdirSync(join(sb.home, ".plur1bus"), { recursive: true });
    writeFileSync(join(sb.home, ".plur1bus", "manifest.json"), "{}\n");
    const homes = findHarnessHomes({ env: { PLUR1BUS_HOME: harness, HOME: sb.home }, platform: "linux" });
    assert.deepEqual(homes, [harness, join(sb.home, ".plur1bus")]);
    const base = { openclawVersion: "2026.8.1", nodeVersion: "24.21.0", target: { target: "linux-x64", supported: true, detail: "" }, release: sb.feed.hosts.openclaw.releases[0], freeBytes: null, readonlyConfig: null, configValid: true, platform: "linux" };
    assert.ok(checkCompat({ ...base, baseDbPath: join(harness, "..foo"), harnessHomes: homes }).some((f) => f.id === "store-inside-harness-home"));
    assert.ok(checkCompat({ ...base, baseDbPath: join(sb.home, ".plur1bus", "store"), harnessHomes: homes }).some((f) => f.id === "store-inside-harness-home"));
    assert.ok(!checkCompat({ ...base, baseDbPath: join(other, "store"), harnessHomes: homes }).some((f) => f.id === "store-inside-harness-home"));
    assert.ok(!checkCompat({ ...base, baseDbPath: join(root, "harness home-2", "store"), harnessHomes: homes }).some((f) => f.id === "store-inside-harness-home"));

    // a harness home elsewhere only earns a notice
    const sb2 = createInstallerSandbox({ extraEnv: { PLUR1BUS_HOME: harness } });
    const r2 = await run(sb2, []);
    assert.equal(r2.code, EXIT.OK, r2.out);
    assert.match(r2.stderr, /PLUR1BUS harness home/);
  });

  it("--host hermes exits 3 naming HM2", async () => {
    const sb = createInstallerSandbox();
    const r = await run(sb, ["--host", "hermes", "--json"]);
    assert.equal(r.code, EXIT.INCOMPATIBLE, r.out);
    assert.match(r.out, /HM2/);
    assert.match(r.out, /host-not-yet-supported/);
    assert.deepEqual(sb.log(), []);
  });

  it("unsupported targets exit 3 before any change", async () => {
    for (const extra of [{ platform: "linux", arch: "x64", glibcVersion: null }, { platform: "darwin", arch: "x64" }, { platform: "linux", arch: "ia32", glibcVersion: "2.39" }, { platform: "linux", arch: "arm64", glibcVersion: "2.26" }]) {
      const sb = createInstallerSandbox();
      const r = await run(sb, ["--json"], extra);
      assert.equal(r.code, EXIT.INCOMPATIBLE, `${JSON.stringify(extra)}: ${r.out}`);
      assert.ok(JSON.parse(r.stdout).findings.some((f) => f.id === "unsupported-target" && f.fatal), JSON.stringify(extra));
      assert.deepEqual(mutating(sb.openclawCalls()), []);
    }
  });

  it("openclaw too old, an unsupported node and too little disk are refused", async () => {
    const sb = createInstallerSandbox({ scenario: { versionText: "OpenClaw 2026.7.9 (abc1234)\n", nodeVersion: "22.9.0" } });
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.INCOMPATIBLE, r.out);
    const ids = JSON.parse(r.stdout).findings.map((f) => f.id);
    assert.ok(ids.includes("openclaw-too-old") && ids.includes("node-unsupported"), ids.join());
    assert.deepEqual(mutating(sb.openclawCalls()), []);

    const sb2 = createInstallerSandbox();
    const r2 = await run(sb2, ["--json"], { statfs: () => ({ bavail: 100, bsize: 4096 }) });
    assert.equal(r2.code, EXIT.INCOMPATIBLE, r2.out);
    assert.ok(JSON.parse(r2.stdout).findings.some((f) => f.id === "insufficient-disk" && f.fatal));
    assert.deepEqual(mutating(sb2.openclawCalls()), []);
  });

  it("never prints config secrets", async () => {
    const sb = createInstallerSandbox({ scenario: { secrets: { [`${C}.embedding.apiKey`]: SECRET, [`${C}`]: `{"embedding":{"apiKey":"${SECRET}"}}` } } });
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.ok(!r.out.includes(SECRET));
    for (const a of sb.openclawCalls()) {
      if (a[0] === "config" && a[1] === "get") assert.ok(ALLOWED_CONFIG_PATHS.get.includes(a[2]), a.join(" "));
    }
    assert.ok(!JSON.stringify(sb.log()).includes("apiKey"));
  });

  it("configGet refuses a path outside the allow-list", async () => {
    const sb = createInstallerSandbox();
    const cli = createOpenclawCli({ bin: join(sb.binDir, process.platform === "win32" ? "openclaw.cmd" : "openclaw"), env: sb.env, run: defaultRun });
    for (const p of [`${C}.embedding.apiKey`, C, "plugins", "gateway.auth.token", `${C}.baseDbPath.x`, "", "__proto__"]) {
      await assert.rejects(cli.configGet(p), /not in the installer's config allow-list/, p);
    }
    for (const p of [`${C}.embedding.apiKey`, "gateway.auth.token", `${C}.baseDbPath`]) {
      await assert.rejects(cli.configSet(p, "x"), /not in the installer's config allow-list/, p);
    }
    assert.deepEqual(sb.log(), []);
    const got = await cli.configGet(SLOT);
    assert.deepEqual(got, { set: false, value: null });
  });

  it("--json prints exactly one plur1bus.plugin-installer/1 document", async () => {
    const sb = createInstallerSandbox();
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.OK);
    assert.equal(r.stdout.trim().split("\n").length, 1);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.schema, "plur1bus.plugin-installer/1");
    assert.equal(doc.exitCode, 0);
    assert.equal(doc.pluginVersion, "7.16.11");
    assert.ok(r.stderr.length > 0, "human lines go to stderr");

    const failed = await run(createInstallerSandbox(), ["--host", "hermes", "--json"]);
    assert.equal(failed.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(failed.stdout).exitCode, EXIT.INCOMPATIBLE);

    const human = await run(createInstallerSandbox(), []);
    assert.equal(human.stdout, "");
  });

  it("--offline verifies the tarball against the feed before installing it", async () => {
    const root = makeTempDir("plur1bus-installer-off-");
    const tgz = join(root, "plugin b.tgz");
    writeFileSync(tgz, "TEST ONLY tarball bytes");
    const sb = createInstallerSandbox({ feed: makeTestFeed({ tarballSha256: sha256File(tgz) }) });
    const r = await run(sb, ["--offline", tgz]);
    assert.equal(r.code, EXIT.OK, r.out);
    // T8-b: installed from the kept, verified copy, not from the path the person passed
    const kept = join(sb.stateDir, "plur1bus-installer", "artefacts", "7.16.11.tgz");
    assert.ok(sb.openclawCalls().some((a) => a.join("|") === `plugins|install|npm-pack:${kept}|--force|--accept-capabilities`), JSON.stringify(sb.openclawCalls()));
    assert.equal(sha256File(kept), sha256File(tgz));
    assert.deepEqual(readState(sb.stateDir).artefacts, { "7.16.11": { file: kept, sha256: sha256File(tgz) } });

    const bad = createInstallerSandbox();
    const r2 = await run(bad, ["--offline", tgz]);
    assert.equal(r2.code, EXIT.FAILED, r2.out);
    assert.match(r2.stderr, /SHA-256/);
    assert.deepEqual(mutating(bad.openclawCalls()), []);
  });

  it("a signed feed is verified; a bad signature stops before any OpenClaw call", async () => {
    const sb = createInstallerSandbox();
    const key = generateTestKeyPair();
    const feedPath = join(sb.root, "stable.json");
    const bytes = readFileSync(sb.feedFile);
    writeFileSync(feedPath, bytes);
    writeFileSync(`${feedPath}.minisig`, key.sign(bytes));
    const env = { ...sb.env, PLUR1BUS_PLUGIN_FEED: pathToFileURL(feedPath).href, PLUR1BUS_PLUGIN_PUBKEY: key.publicKeyLine };
    const stdout = sink();
    const stderr = sink();
    const opts = { env, platform: process.platform, arch: "x64", glibcVersion: "2.39", isTTY: false, stdout, stderr, statfs: () => ({ bavail: 1 << 20, bsize: 1 << 20 }) };
    assert.equal(await runInstaller(["--dry-run"], opts), EXIT.OK, stderr.text);
    assert.deepEqual(mutating(sb.openclawCalls()), []);

    writeFileSync(`${feedPath}.minisig`, generateTestKeyPair().sign(bytes));
    const before = sb.log().length;
    const e2 = sink();
    assert.equal(await runInstaller([], { ...opts, stderr: e2 }), EXIT.FAILED);
    assert.match(e2.text, /signature/);
    assert.equal(sb.log().length, before);

    // without the test flag a file:// feed is refused
    const e3 = sink();
    const noFlag = { ...env };
    delete noFlag.PLUR1BUS_PLUGIN_INSTALLER_TEST;
    assert.equal(await runInstaller(["--feed", pathToFileURL(feedPath).href], { ...opts, env: noFlag, stderr: e3 }), EXIT.FAILED);
    assert.match(e3.text, /https/);
  });

  it("without a clawpackDigest the verified feed tarball is installed via npm-pack (T5-a)", async () => {
    const bytes = Buffer.from("TEST ONLY release tarball");
    const url = "https://example.invalid/TEST-ONLY/release.tgz";
    const sb = createInstallerSandbox({ feed: makeTestFeed({ clawpackDigest: null, tarballUrl: url, tarballSha256: createHash("sha256").update(bytes).digest("hex") }) });
    const fetched = [];
    let installedFrom = null;
    const fetchImpl = async (u) => {
      fetched.push(String(u));
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
    };
    const r = await run(sb, ["--json"], { fetchImpl });
    assert.equal(r.code, EXIT.OK, r.out);
    assert.deepEqual(fetched, [url]);
    const inst = sb.openclawCalls().find((a) => a[1] === "install");
    assert.equal(inst[2], `npm-pack:${join(sb.stateDir, "plur1bus-installer", "artefacts", "7.16.11.tgz")}`);
    assert.deepEqual(inst.slice(3), ["--force", "--accept-capabilities"]);
    installedFrom = inst[2].slice("npm-pack:".length);
    assert.equal(existsSync(installedFrom), true, "the verified copy is kept for later rollbacks and --offline updates (T8-b)");
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.source, "tarball");
    assert.equal(doc.steps.find((s) => s.id === "verify.integrity").status, "ok");
    assert.equal(readState(sb.stateDir).source, "tarball");

    // a tarball whose bytes do not match the feed is refused before any change
    const sb2 = createInstallerSandbox({ feed: makeTestFeed({ clawpackDigest: null, tarballUrl: url }) });
    const r2 = await run(sb2, [], { fetchImpl });
    assert.equal(r2.code, EXIT.FAILED, r2.out);
    assert.match(r2.stderr, /SHA-256/);
    assert.deepEqual(mutating(sb2.openclawCalls()), []);
  });

  it("explicit --source clawhub without a clawpackDigest refuses before any install (T5-a)", async () => {
    const sb = createInstallerSandbox({ feed: makeTestFeed({ clawpackDigest: null }) });
    const r = await run(sb, ["--source", "clawhub", "--json"], { fetchImpl: async () => { throw new Error("no download"); } });
    assert.equal(r.code, EXIT.INCOMPATIBLE, r.out);
    assert.match(r.out, /clawpack-digest-missing/);
    assert.deepEqual(sb.openclawCalls(), []);

    // with the digest present ClawHub is used, explicit or not
    const sb2 = createInstallerSandbox();
    assert.equal((await run(sb2, ["--source", "clawhub"])).code, EXIT.OK);
    assert.ok(sb2.openclawCalls().some((a) => a.join(" ") === "plugins install clawhub:@cyb3rb1ade/plur1bus-memory@7.16.11"));
  });

  it("rollback restores previous config values and lists keys that were absent (T5-c)", async () => {
    const sb = createInstallerSandbox({
      scenario: {
        config: { [`${C}.modelPreparation.profile`]: "jina-v5-nano-512", [`${P}.hooks.allowConversationAccess`]: "false" },
        selftest: { schema: "plur1bus.selftest/1", ok: false, addons: [], model: { state: "present" }, steps: [], warnings: [], errors: ["boom"] },
      },
    });
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    const calls = sb.openclawCalls().map((a) => a.join(" "));
    const u = calls.indexOf(`plugins uninstall ${ID} --force`);
    const restores = calls.slice(0, u).filter((c) => c.startsWith("config set")).slice(-2);
    assert.deepEqual(restores, [`config set ${P}.hooks.allowConversationAccess false`, `config set ${C}.modelPreparation.profile jina-v5-nano-512`]);
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(doc.rollback.restored, [`${P}.hooks.allowConversationAccess`, `${C}.modelPreparation.profile`]);
    assert.deepEqual(doc.rollback.leftSet, [`${C}.embedding.model`, `${C}.embedding.provider`, `${C}.modelPreparation.acceptNonCommercialLicense`]);
    assert.match(r.stderr, /Left set after the rollback.*embedding\.model/);
    const cfg = sb.shimState().config;
    assert.equal(cfg[`${C}.modelPreparation.profile`], "jina-v5-nano-512");
    assert.equal(cfg[`${P}.hooks.allowConversationAccess`], "false");
  });

  it("an install that fails with nothing installed changes nothing and does not uninstall", async () => {
    const sb = createInstallerSandbox({ scenario: { installExit: 1 } });
    const r = await run(sb, []);
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.ok(!sb.openclawCalls().some((a) => a[1] === "uninstall" || a[1] === "set"));
    const st = readState(sb.stateDir);
    assert.equal(st.installedVersion, null);
    assert.equal(st.inProgress, undefined);
  });

  it("OpenClaw refusing the install as externally managed exits 3 without rollback", async () => {
    const sb = createInstallerSandbox({ scenario: { installReadonly: true } });
    const r = await run(sb, []);
    assert.equal(r.code, EXIT.INCOMPATIBLE, r.out);
    assert.match(r.stderr, /externally managed/);
    assert.ok(!sb.openclawCalls().some((a) => a[1] === "uninstall" || a[1] === "set"));
  });

  it("a failing config set rolls the install back", async () => {
    const sb = createInstallerSandbox({ scenario: { configSetFail: `${P}.hooks.allowConversationAccess` } });
    const r = await run(sb, ["--json"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.ok(sb.openclawCalls().some((a) => a.join(" ") === `plugins uninstall ${ID} --force`));
    assert.equal(sb.shimState().installed, false);
    assert.equal(JSON.parse(r.stdout).steps.find((s) => s.id === "config").status, "failed");
  });

  it("a plugin recorded disabled after the slot is set is enabled", async () => {
    const sb = createInstallerSandbox({ scenario: { recordStatus: "disabled" } });
    const r = await run(sb, []);
    assert.equal(r.code, EXIT.OK, r.out);
    const calls = sb.openclawCalls().map((a) => a.join(" "));
    assert.ok(calls.indexOf(`plugins enable ${ID}`) > calls.indexOf(`config set ${SLOT} ${ID}`));
  });

  it("whichOnPath skips non-executable files on POSIX", { skip: process.platform === "win32" && "POSIX execute bit" }, () => {
    const a = makeTempDir("plur1bus-which-a-");
    const b = makeTempDir("plur1bus-which-b-");
    writeFileSync(join(a, "openclaw"), "#!/bin/sh\n", { mode: 0o644 });
    writeFileSync(join(b, "openclaw"), "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(whichOnPath("openclaw", { env: { PATH: `${a}:${b}` }, platform: "linux" }), join(b, "openclaw"));
    assert.equal(whichOnPath("openclaw", { env: { PATH: a }, platform: "linux" }), null);
  });

  it("defaultRun never uses a shell and enforces its deadline", async () => {
    const dir = makeTempDir("plur1bus-installer-run-");
    const marker = join(dir, "pwned");
    const r = await defaultRun(process.execPath, ["-e", "process.stdout.write(process.argv[1])", `$(touch ${marker}); x`], { env: process.env, timeoutMs: 10_000 });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `$(touch ${marker}); x`);
    assert.equal(existsSync(marker), false);
    const slow = await defaultRun(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { env: process.env, timeoutMs: 200 });
    assert.equal(slow.timedOut, true);
    assert.notEqual(slow.code, 0);
    assert.ok(tmpdir());
  });
});

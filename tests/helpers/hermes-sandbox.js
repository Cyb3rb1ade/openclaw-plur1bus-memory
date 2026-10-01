/**
 * tests/helpers/hermes-sandbox.js — TEST ONLY sandbox for `install-plugin --host hermes`.
 *
 * Builds a temp home (HOME, USERPROFILE, LOCALAPPDATA, XDG_* inside it) with a Hermes home
 * `<home>/.hermes` and puts a `hermes` shim first on PATH (ruling F37: the PATH guard, launchers and
 * Windows environment come from sandbox-common.js, shared with installer-sandbox.js). The shim logs every
 * argv to `<root>/argv.log` and answers like Hermes 0.21.4/0.21.5 from the Task 1 fixtures
 * (tests/fixtures/hermes-cli/) and the Task 5 JSON fixtures (tests/fixtures/hermes/provider-json/),
 * reading and writing only `$HERMES_HOME/config.yaml`'s memory.provider line (0.21.4's `config set`
 * strips every comment, as the real one does).
 *
 * The sidecar "binary" the feed names (a file:// artefact, verified by SHA-256 like the real one) is a
 * POSIX launcher of the `plur1bus` shim; on Windows, where a script cannot be a .exe, `sb.run` hands a
 * `plur1bus.exe` call to the shim through Node. The shim logs its argv and keeps its state where the real
 * sidecar does: `<plur1bus home>/manifest.json` and `config.json`.
 *
 * Scenario keys (`setScenario`): hermesVersion ("0.21.4" | "0.21.5" | "vgit"), python, killOn ("config set"
 * kills the installer after the change; honoured only with PLUR1BUS_SANDBOX_ALLOW_KILL_PARENT=1),
 * providerUnavailable, selftestFail, setupExit, setupWritesNoConfig, sidecarVersion, agentCreateExit,
 * configSetExit, configSetFailFor (fails `config set memory.provider <that value>` only). Nothing here touches a real Hermes, a real PLUR1BUS home or a service manager.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { defaultRun } from "../../scripts/dist/installer/openclaw-cli.mjs";
import { makeTempDir } from "./temp-dir.js";
import { makeTestFeed, SANDBOX_ARCH } from "./installer-sandbox.js";
import { addWindowsEnv, assertShimOnPath, resolveOnPath, sink, writeLauncher } from "./sandbox-common.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const HERMES_FIXTURES = join(HERE, "..", "fixtures", "hermes-cli");
export const HERMES_JSON_FIXTURES = join(HERE, "..", "fixtures", "hermes", "provider-json");
/** The real Task 7 provider tarball (built at harness 257f037). */
export const PROVIDER_TARBALL = join(HERE, "..", "fixtures", "hermes", "plur1bus-hermes-provider-0.1.0.tar.gz");
export const TARGETS = ["linux-x64", "linux-arm64", "darwin-arm64", "win-x64", "win-arm64"];

/** A config.yaml with comments (0.21.4's `config set` would drop them). */
export const TEMPLATE_CONFIG = `# Hermes configuration (TEST ONLY template)
model:
  provider: custom   # the model provider, not the memory one
  default: stub-model

# Memory settings
memory:
  # which external memory provider to use
  memory_enabled: true
`;

const HERMES_SHIM = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SANDBOX = __SANDBOX__;
const FIXTURES = __FIXTURES__;
const JSON_FIXTURES = __JSON_FIXTURES__;
const args = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(join(SANDBOX, "scenario.json"), "utf8"));
const home = process.env.HERMES_HOME || join(process.env.HOME || process.env.USERPROFILE, ".hermes");
// providerDir: whether plugins/plur1bus existed when Hermes was called (HM2-R17a order checks)
appendFileSync(join(SANDBOX, "argv.log"), JSON.stringify({ bin: "hermes", argv: args, hermesHome: process.env.HERMES_HOME ?? null, providerDir: existsSync(join(home, "plugins", "plur1bus")) }) + "\n");
const cfgFile = join(home, "config.yaml");
const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);

function fixture(name) {
  const lines = readFileSync(join(FIXTURES, name), "utf8").split("\n");
  if (lines[0].startsWith("$ ")) lines.shift();
  while (lines.length && (lines[lines.length - 1] === "" || /^\[exit \d+\]$/.test(lines[lines.length - 1]))) lines.pop();
  return lines.join("\n") + "\n";
}
function readProvider() {
  if (!existsSync(cfgFile)) return "";
  const text = readFileSync(cfgFile, "utf8");
  const m = /^memory:[^\n]*\n((?:[ \t][^\n]*\n|[ \t]*\n)*)/m.exec(text.endsWith("\n") ? text : text + "\n");
  if (!m) return "";
  const p = /^[ ]+provider[ ]*:[ ]*['"]?([A-Za-z0-9_.-]*)/m.exec(m[1]);
  return p ? p[1] : "";
}
function writeProvider(value) {
  let text = existsSync(cfgFile) ? readFileSync(cfgFile, "utf8") : "";
  if (scenario.hermesVersion === "0.21.4") text = text.split("\n").filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#.*$/, "")).join("\n");
  const lines = text.split("\n");
  const mi = lines.findIndex((l) => /^memory\s*:/.test(l));
  if (mi < 0) {
    if (value !== null) lines.push("memory:", "  provider: " + value);
  } else {
    let j = mi + 1;
    let found = -1;
    for (; j < lines.length && (lines[j].startsWith(" ") || lines[j].trim() === ""); j++) if (/^ +provider\s*:/.test(lines[j])) found = j;
    if (found >= 0) {
      if (value === null) lines.splice(found, 1);
      else lines[found] = lines[found].replace(/provider\s*:.*$/, "provider: " + value);
    } else if (value !== null) lines.splice(mi + 1, 0, "  provider: " + value);
  }
  writeFileSync(cfgFile, lines.join("\n"));
}
function killIfAsked(step) {
  if (scenario.killOn === step && process.env.PLUR1BUS_SANDBOX_ALLOW_KILL_PARENT === "1") {
    appendFileSync(join(SANDBOX, "argv.log"), JSON.stringify({ bin: "kill", argv: [String(process.ppid)] }) + "\n");
    process.kill(process.ppid, "SIGKILL");
    process.exit(137);
  }
}

if (args[0] === "--version") {
  let text = scenario.hermesVersion === "0.21.4" ? fixture("version-min.txt") : fixture("version-latest.txt");
  if (scenario.hermesVersion === "vgit") text = text.replace(/^Hermes Agent v\S+ \(([^)]*)\)/, "Hermes Agent vgit.16c59d0 (2026.9.24) · upstream 16c59d0e");
  if (scenario.hermesVersion && !["0.21.4", "0.21.5", "vgit"].includes(scenario.hermesVersion)) text = text.replace(/v0\.21\.5/, "v" + scenario.hermesVersion);
  text = text.replace("<install-dir>", join(SANDBOX, "hermes-agent"));
  if (scenario.python) text = text.replace(/Python: \S+/, "Python: " + scenario.python);
  out(text);
  process.exit(0);
}
if (args[0] === "config" && args[1] === "get") {
  if (args[2] !== "memory.provider") { err("Config key not set: " + args[2] + "\n"); process.exit(1); }
  const v = readProvider();
  out(args.includes("--json") ? JSON.stringify(v) + "\n" : v + "\n");
  process.exit(0);
}
if (args[0] === "config" && args[1] === "set") {
  if (scenario.configSetExit || (scenario.configSetFailFor && scenario.configSetFailFor === args[3])) { err("TEST ONLY config set failure\n"); process.exit(scenario.configSetExit || 1); }
  writeProvider(args[3]);
  out("✓ Set " + args[2] + " = " + args[3] + " in " + cfgFile + "\n");
  killIfAsked("config set");
  process.exit(0);
}
if (args[0] === "config" && args[1] === "unset") {
  writeProvider(null);
  out("✓ Unset " + args[2] + " from " + cfgFile + "\n");
  process.exit(0);
}
if (args[0] === "memory" && args[1] === "status") {
  const p = readProvider();
  const lines = ["", "Memory status", "────────────────────────────────────────", "  Built-in (MEMORY.md / USER.md):", "    Memory injection:   enabled ✓"];
  if (!p) lines.push("  Provider:  (none — built-in only)");
  else {
    lines.push("  Provider:  " + p, "");
    const installed = existsSync(join(home, "plugins", p, "__init__.py"));
    lines.push("  Plugin:    " + (installed ? "installed ✓" : "not installed ✗"));
    if (installed) lines.push("  Status:    " + (scenario.providerUnavailable ? "not available ✗" : "available ✓"));
  }
  out(lines.join("\n") + "\n\n");
  process.exit(0);
}
if (args[0] === "plur1bus") {
  const active = readProvider() === "plur1bus" && existsSync(join(home, "plugins", "plur1bus", "__init__.py"));
  if (!active) { err("hermes: 'plur1bus' is not a \x60hermes\x60 command.\nRun \x60hermes --help\x60 to see all commands.\n"); process.exit(2); }
  if (args[1] === "selftest") {
    const bound = existsSync(join(home, "plur1bus.json"));
    const ok = bound && !scenario.selftestFail;
    out(readFileSync(join(JSON_FIXTURES, ok ? "selftest-ok.json" : "selftest-fail.json"), "utf8"));
    process.exit(ok ? 0 : 1);
  }
}
err("hermes: '" + args[0] + "' is not a \x60hermes\x60 command.\n");
process.exit(2);
`;

const PLUR1BUS_SHIM = String.raw`
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const SANDBOX = __SANDBOX__;
const args = process.argv.slice(2);
appendFileSync(join(SANDBOX, "argv.log"), JSON.stringify({ bin: "plur1bus", argv: args }) + "\n");
const scenario = JSON.parse(readFileSync(join(SANDBOX, "scenario.json"), "utf8"));
const out = (doc) => process.stdout.write(JSON.stringify(doc) + "\n");
function fail(code, message, exit = 1) {
  out({ schema: "error/1", error: { code, message } });
  process.exit(exit);
}
if (args[0] === "--version") { process.stdout.write("plur1bus " + (scenario.sidecarVersion ?? "0.1.0") + "\n"); process.exit(0); }
if (args[0] !== "--home" || args[2] !== "--json") fail("E_TEST", "shim: expected --home <dir> --json first", 2);
const home = args[1];
const rest = args.slice(3);
const manifestFile = join(home, "manifest.json");
const configFile = join(home, "config.json");
const readConfig = () => (existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : null);
const writeConfig = (c) => { mkdirSync(home, { recursive: true }); writeFileSync(configFile, JSON.stringify(c, null, 2)); };

if (rest[0] === "setup") {
  if (existsSync(manifestFile)) {
    let m;
    try { m = JSON.parse(readFileSync(manifestFile, "utf8")); } catch { fail("E_MANIFEST_INVALID", "manifest-invalid: run 1staid repair"); }
    if ((m.profile ?? "full") !== "host") fail("E_PROFILE", "profile-change-unsupported");
  }
  if (scenario.setupExit) fail("E_TEST", "TEST ONLY setup failure", scenario.setupExit);
  const useClass = rest[rest.indexOf("--use-class") + 1];
  mkdirSync(join(home, "run"), { recursive: true });
  writeFileSync(manifestFile, JSON.stringify({ schemaVersion: 1, profile: "host", channel: "stable", binary: { version: scenario.sidecarVersion ?? "0.1.0", sha256: null }, modules: [], skills: [] }, null, 2));
  if (!scenario.setupWritesNoConfig) writeConfig({ ...(readConfig() ?? {}), embedding: { useClass }, agents: readConfig()?.agents ?? {} });
  out({ schema: "setup/1", home, target: "test", steps: [{ id: "modules.bundled", status: "skipped", reason: "profile-host" }], manifest: manifestFile, check: { ok: true } });
  process.exit(0);
}
if (rest[0] === "agent" && rest[1] === "list") {
  out({ schema: "agent.list/1", agents: Object.keys(readConfig()?.agents ?? {}).map((agentId) => ({ agentId, open: null, activity: null })), core: "ready" });
  process.exit(0);
}
if (rest[0] === "agent" && rest[1] === "create") {
  if (scenario.agentCreateExit) fail("E_TEST", "TEST ONLY agent create failure", scenario.agentCreateExit);
  const c = readConfig() ?? { agents: {} };
  c.agents = c.agents ?? {};
  if (c.agents[rest[2]]) fail("E_INVALID_PARAMS", "agent " + rest[2] + " already exists");
  c.agents[rest[2]] = { createdAt: "2026-09-30T00:00:00Z" };
  writeConfig(c);
  out({ schema: "agent.create/1", agentId: rest[2], created: true, opened: true });
  process.exit(0);
}
if (rest[0] === "config" && rest[1] === "get") {
  const c = readConfig();
  if (!c) fail("E_CONFIG", "no config.json");
  const value = rest[2].split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), c);
  out({ schema: "config.get/1", key: rest[2], value: value ?? null, restart: "none", tier: "basic" });
  process.exit(0);
}
if (rest[0] === "daemon" && rest[1] === "stop") { out({ schema: "daemon.stop/1", stopped: true }); process.exit(0); }
if (rest[0] === "service" && rest[1] === "uninstall") { out({ schema: "service.uninstall/1", removed: true }); process.exit(0); }
fail("E_TEST", "shim: unknown command " + JSON.stringify(rest), 2);
`;

export const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/**
 * A feed with hosts.hermes (and the fixture openclaw part).
 * @param {{ version?: string, provider?: {url: string, sha256: string}, binary?: {url: string, sha256: string}, binaries?: object,
 *   minHermesVersion?: string, testedHermesVersion?: string, python?: string, windowsNativeBeta?: boolean }} o
 */
export function makeHermesFeed(o) {
  const feed = makeTestFeed();
  const version = o.version ?? "0.1.0";
  feed.hosts.hermes = {
    windowsNativeBeta: o.windowsNativeBeta ?? true,
    latest: version,
    releases: [{
      version,
      provider: o.provider,
      sidecar: { version, binary: o.binaries ?? Object.fromEntries(TARGETS.map((t) => [t, o.binary])) },
      minHermesVersion: o.minHermesVersion ?? "0.21.4",
      testedHermesVersion: o.testedHermesVersion ?? "0.21.5",
      python: o.python ?? ">=3.11",
      security: false,
      notes: { de: "TEST ONLY", en: "TEST ONLY" },
    }],
  };
  return feed;
}

/**
 * @param {{ root?: string, scenario?: object, hermesHome?: string|null, configYaml?: string|null, hermesHomeEnv?: string, extraEnv?: object,
 *   noHermesHome?: boolean, requiresPython?: string|null }} [opts]
 */
export function createHermesSandbox(opts = {}) {
  const root = opts.root ?? makeTempDir("plur1bus-hermes-");
  mkdirSync(root, { recursive: true });
  const home = join(root, "home");
  const binDir = join(root, "bin");
  const art = join(root, "artefacts");
  for (const d of [home, binDir, art, join(home, ".config"), join(home, ".local", "share")]) mkdirSync(d, { recursive: true });
  const hermesRoot = join(home, ".hermes");
  const hermesHome = opts.hermesHome ?? hermesRoot;
  if (!opts.noHermesHome) {
    mkdirSync(hermesHome, { recursive: true });
    if (opts.configYaml !== null) writeFileSync(join(hermesHome, "config.yaml"), opts.configYaml ?? TEMPLATE_CONFIG);
  }
  // Hermes' own checkout: pyproject.toml's requires-python (HM2-R25)
  mkdirSync(join(root, "hermes-agent"), { recursive: true });
  if (opts.requiresPython !== null) writeFileSync(join(root, "hermes-agent", "pyproject.toml"), `[project]\nname = "hermes-agent"\nrequires-python = "${opts.requiresPython ?? ">=3.11,<3.14"}"\n`);

  const q = (s) => JSON.stringify(s);
  writeFileSync(join(binDir, "hermes-shim.mjs"), HERMES_SHIM.replace("__SANDBOX__", q(root)).replace("__FIXTURES__", q(HERMES_FIXTURES)).replace("__JSON_FIXTURES__", q(HERMES_JSON_FIXTURES)));
  writeLauncher(binDir, "hermes", "hermes-shim.mjs");
  const plur1busShim = join(root, "plur1bus-shim.cjs");
  writeFileSync(plur1busShim, PLUR1BUS_SHIM.replace("__SANDBOX__", q(root)));
  // the sidecar "binary" artefact
  const binArtefact = join(art, "plur1bus-sidecar");
  writeFileSync(binArtefact, `#!/bin/sh\nexec "${process.execPath}" "${plur1busShim}" "$@"\n`, { mode: 0o755 });
  const tarball = join(art, basename(PROVIDER_TARBALL));
  copyFileSync(PROVIDER_TARBALL, tarball);

  const scenario = { hermesVersion: "0.21.5", ...(opts.scenario ?? {}) };
  const scenarioPath = join(root, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2));
  writeFileSync(join(root, "argv.log"), "");

  const feed = makeHermesFeed({
    provider: { url: pathToFileURL(tarball).href, sha256: sha256File(tarball) },
    binary: { url: pathToFileURL(binArtefact).href, sha256: sha256File(binArtefact) },
    ...(opts.feed ?? {}),
  });
  const feedFile = join(root, "feed.json");
  writeFileSync(feedFile, JSON.stringify(feed, null, 2));

  const env = {
    PATH: [binDir, "/usr/bin", "/bin"].join(delimiter),
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    USER: "sandbox-user",
    PLUR1BUS_PLUGIN_INSTALLER_TEST: "1",
    PLUR1BUS_PLUGIN_TEST_NO_SERVICE: "1",
    ...(opts.hermesHomeEnv ? { HERMES_HOME: opts.hermesHomeEnv } : {}),
    ...(opts.extraEnv ?? {}),
  };
  addWindowsEnv(env, binDir);
  assertShimOnPath("hermes", env, binDir, "hermes-sandbox");
  if (resolveOnPath("plur1bus", env.PATH)) throw new Error("hermes-sandbox: a plur1bus binary is on PATH");

  const plur1busHome = process.platform === "win32" ? join(env.LOCALAPPDATA, "PLUR1BUS") : join(home, ".plur1bus");
  const sidecarBin = process.platform === "win32" ? join(env.LOCALAPPDATA, "PLUR1BUS", "bin", "plur1bus.exe") : join(home, ".local", "bin", "plur1bus");
  /** On Windows a script cannot be plur1bus.exe: hand the call to the shim through Node. */
  const run = (file, args, o) => (process.platform === "win32" && /plur1bus\.exe$/i.test(file) ? defaultRun(process.execPath, [plur1busShim, ...args], o) : defaultRun(file, args, o));

  return {
    root, home, binDir, hermesRoot, hermesHome, plur1busHome, sidecarBin, feed, feedFile, env, run, tarball, binArtefact, plur1busShim,
    log() {
      return readFileSync(join(root, "argv.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    hermesCalls() {
      return this.log().filter((e) => e.bin === "hermes").map((e) => e.argv);
    },
    plur1busCalls() {
      return this.log().filter((e) => e.bin === "plur1bus").map((e) => e.argv);
    },
    setScenario(patch) {
      const cur = JSON.parse(readFileSync(scenarioPath, "utf8"));
      writeFileSync(scenarioPath, JSON.stringify({ ...cur, ...patch }, null, 2));
    },
    writeFeed(f) {
      writeFileSync(feedFile, JSON.stringify(f, null, 2));
    },
    /** memory.provider as the shim reads it. */
    provider(h = hermesHome) {
      const f = join(h, "config.yaml");
      if (!existsSync(f)) return "";
      const m = /^memory:[^\n]*\n((?:[ \t][^\n]*\n|[ \t]*\n)*)/m.exec(`${readFileSync(f, "utf8")}\n`);
      const p = m ? /^[ ]+provider[ ]*:[ ]*['"]?([A-Za-z0-9_.-]*)/m.exec(m[1]) : null;
      return p ? p[1] : "";
    },
    /** Install a host sidecar as a previous run would have left it. */
    seedHostSidecar({ version = "0.1.0", useClass = "commercial", agents = {}, profile = "host" } = {}) {
      mkdirSync(plur1busHome, { recursive: true });
      const manifest = { schemaVersion: 1, binary: { version, sha256: null }, modules: [], skills: [] };
      if (profile) manifest.profile = profile;
      writeFileSync(join(plur1busHome, "manifest.json"), JSON.stringify(manifest));
      writeFileSync(join(plur1busHome, "config.json"), JSON.stringify({ embedding: { useClass }, agents }));
      mkdirSync(dirname(sidecarBin), { recursive: true });
      copyFileSync(binArtefact, sidecarBin);
    },
  };
}

/**
 * Run the installer in-process with --host hermes (never a TTY unless `extra.isTTY`; a prompt fails the test unless
 * `extra.prompt` is given; free space is stubbed).
 */
export async function runHermesInstaller(sb, argv, extra = {}) {
  const { runInstaller } = await import("../../scripts/dist/installer/main.mjs");
  const stdout = sink();
  const stderr = sink();
  const code = await runInstaller(["--host", "hermes", "--feed-file", sb.feedFile, ...argv], {
    env: sb.env,
    platform: process.platform,
    arch: SANDBOX_ARCH,
    glibcVersion: "2.39",
    isTTY: false,
    statfs: () => ({ bavail: 1 << 20, bsize: 1 << 20 }),
    prompt: async () => {
      throw new Error("prompt must not be called");
    },
    run: sb.run,
    stdout,
    stderr,
    ...extra,
  });
  return { code, stdout: stdout.text, stderr: stderr.text, out: stdout.text + stderr.text };
}

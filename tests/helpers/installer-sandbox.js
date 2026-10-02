/**
 * tests/helpers/installer-sandbox.js — TEST ONLY sandbox for the plugin installer.
 *
 * Builds a temp home and OpenClaw state dir and puts `openclaw` and `node`
 * shims first on PATH. The `openclaw` shim appends every argv to a JSON-lines
 * log and answers from the Task 1 fixtures (tests/fixtures/openclaw-cli/),
 * keeping a small state file (installed or not, config values it was told to
 * set). It never runs a real OpenClaw and never sees real credentials.
 *
 * The `openclaw` shim has the shape of install-cli.sh's wrapper
 * (`exec "<node>" "<entry>" "$@"`), so the installer's node detection finds the
 * `node` shim next to it. The `node` shim answers `--version` and the feature
 * cron script and hands anything else (the openclaw shim itself) to the real
 * Node in-process.
 *
 * A `crontab` shim (POSIX) answers only `-l`, from `<root>/crontab.txt`
 * (`setCrontab()`), and logs its argv, so the HM1-R9 guard probe never reads or
 * edits a real crontab. Task 6 scenario keys: `failVersions` (runtime import
 * fails for these versions), `installExitVersions`, `mutateStore` (a store dir
 * the "new version" writes into on install), `killParentOnInstall` (kills the
 * installer process; honoured only with PLUR1BUS_SANDBOX_ALLOW_KILL_PARENT=1, set
 * by the child-process test), and a legacy deploy that is visible only while
 * `<state>/extensions/memory-lancedb-namespaced` exists; `recordDigestsMissingFor` drops
 * the install record's npmIntegrity/clawpackSha256 for these versions.
 * `config validate` reports a missing config file on a fresh sandbox (as real
 * OpenClaw does), `configValidateExit` makes it reject the config, and
 * `configValidateSaysMissing` makes it claim "file not found" regardless.
 *
 * `createInstallerSandbox()` throws if the `openclaw` that PATH resolves is not
 * its own shim (global constraint "never touch a real OpenClaw installation").
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./temp-dir.js";
import { addWindowsEnv, assertShimOnPath, sink, writeLauncher } from "./sandbox-common.js";

export { sink };

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "..", "fixtures", "openclaw-cli");

/** Install record digests of the Task 1 fixtures (tarball integrity / ClawPack sha256). */
export const FIXTURE_NPM_INTEGRITY = JSON.parse(readFileSync(join(FIXTURES, "inspect-installed.json"), "utf8")).install.npmIntegrity;
export const FIXTURE_CLAWPACK_SHA256 = JSON.parse(readFileSync(join(FIXTURES, "inspect-installed-clawhub.json"), "utf8")).install.clawpackSha256;

const OPENCLAW_SHIM = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SANDBOX = process.env.PLUR1BUS_SANDBOX_ROOT_FOR_SHIM || __SANDBOX__;
const FIXTURES = __FIXTURES__;
const PLUGIN = "memory-lancedb-namespaced";
const SLOT = "plugins.slots.memory";
const args = process.argv.slice(2);
appendFileSync(join(SANDBOX, "argv.log"), JSON.stringify({ bin: "openclaw", argv: args }) + "\n");

const scenario = JSON.parse(readFileSync(join(SANDBOX, "scenario.json"), "utf8"));
const statePath = join(SANDBOX, "shim-state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { installed: false, config: {} };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);
const stateDir = process.env.OPENCLAW_STATE_DIR || scenario.stateDir;

function fixtureText(name) {
  return readFileSync(join(FIXTURES, name), "utf8").replaceAll("<at>", "@");
}
function mapStrings(v) {
  if (typeof v === "string") return v.replaceAll("<at>", "@").replaceAll("<state>", stateDir);
  if (Array.isArray(v)) return v.map(mapStrings);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x)]));
  return v;
}
function fixtureJson(name) {
  return mapStrings(JSON.parse(readFileSync(join(FIXTURES, name), "utf8")));
}
function done(code) {
  save();
  process.exit(code);
}
const has = (flag) => args.includes(flag);
// a legacy (untracked) deploy is visible only while its directory exists (HM1-R9 adoption renames it)
const legacyPresent = Boolean(scenario.legacy) && existsSync(join(stateDir, "extensions", PLUGIN));
const failing = (v) => (scenario.failVersions ?? []).includes(v);

if (args[0] === "--version") {
  out(scenario.versionText ?? fixtureText(scenario.openclawVersion === "latest" ? "version-latest.txt" : "version-2026.8.1.txt"));
  done(0);
}

// Like 2026.8.1 and 2026.9.6 (fixtures config-validate-*.json, captured from real runs): exit 1 with
// "file not found" while <state>/openclaw.json does not exist yet (a fresh state dir; any install or
// config set creates it), exit 1 "config is invalid" for a config OpenClaw rejects, exit 0 otherwise.
if (args[0] === "config" && args[1] === "validate") {
  const cfgFile = join(stateDir, "openclaw.json");
  const cfgPresent = existsSync(cfgFile) || state.installed || legacyPresent || Object.keys(state.config).length > 0;
  if (scenario.configValidateExit) {
    if (has("--json")) out(JSON.stringify(fixtureJson("config-validate-invalid.json"), null, 2) + "\n");
    else err("OpenClaw config is invalid: " + cfgFile + "\nRun: openclaw doctor --fix\n");
    done(scenario.configValidateExit);
  }
  if (scenario.configValidateSaysMissing || !cfgPresent) {
    if (has("--json")) out(JSON.stringify(fixtureJson("config-validate-missing.json")) + "\n");
    else out("Config file not found: " + cfgFile + "\nCreate one with openclaw onboard or run openclaw doctor --fix.\n");
    done(1);
  }
  out(has("--json") ? JSON.stringify(fixtureJson("config-validate-valid.json")) + "\n" : "Config valid\n");
  done(0);
}

if (args[0] === "config" && args[1] === "get") {
  const path = args[2];
  if (scenario.secrets && path in scenario.secrets) {
    out(scenario.secrets[path] + "\n");
    done(0);
  }
  if (path in state.config) {
    out(String(state.config[path]) + "\n");
    done(0);
  }
  // Like 2026.8.1 and 2026.9.6: no schema for the plugin's config until the plugin is discoverable (baseDbPath is known).
  if (path.startsWith("plugins.entries." + PLUGIN + ".config.") && path !== "plugins.entries." + PLUGIN + ".config.baseDbPath" && !state.installed && !legacyPresent) {
    err("Unknown config path: " + path + ". Run openclaw config schema to inspect valid paths.\n");
    done(1);
  }
  err("Config path is valid but unset: " + path + " (runtime default applies)\n");
  done(1);
}

if (args[0] === "config" && args[1] === "set") {
  const [path, value] = [args[2], args[3]];
  if (scenario.readonlyEnforced && process.env.OPENCLAW_CONFIG_READONLY === "1") {
    err("Config is externally managed (OPENCLAW_CONFIG_READONLY=1), so OpenClaw treats openclaw.json as immutable.\n");
    done(1);
  }
  if (path === SLOT && value === PLUGIN && !state.installed && !legacyPresent) {
    err("Config validation failed: plugins.slots.memory: plugin not found: " + PLUGIN + "\n");
    done(1);
  }
  if (scenario.configSetFail && scenario.configSetFail === path) {
    err("TEST ONLY config set failure\n");
    done(1);
  }
  state.config[path] = value;
  out("Updated " + path + ". Change will apply without restarting the gateway.\n");
  done(0);
}

if (args[0] === "plugins" && args[1] === "inspect") {
  if (state.installed) {
    const j = fixtureJson(state.source === "clawhub" ? "inspect-installed-clawhub.json" : has("--runtime") ? "inspect-runtime-loaded.json" : "inspect-installed.json");
    j.install.version = state.version;
    j.install.spec = state.source === "clawhub" ? "clawhub:@cyb3rb1ade/plur1bus-memory@" + state.version : "@cyb3rb1ade/plur1bus-memory@" + state.version;
    if (scenario.recordNpmIntegrity) j.install.npmIntegrity = scenario.recordNpmIntegrity;
    if (scenario.recordNpmIntegrityByVersion?.[state.version]) j.install.npmIntegrity = scenario.recordNpmIntegrityByVersion[state.version];
    if (scenario.recordClawpackSha256) j.install.clawpackSha256 = scenario.recordClawpackSha256;
    if (!has("--runtime") && scenario.recordStatus) j.plugin.status = scenario.recordStatus;
    if (has("--runtime")) {
      j.plugin.imported = failing(state.version) ? false : (scenario.runtimeImported ?? true);
      j.plugin.status = scenario.runtimeStatus ?? "loaded";
    }
    if (state.sourcePath) j.install.sourcePath = state.sourcePath;
    if ((scenario.recordDigestsMissingFor ?? []).includes(state.version)) {
      delete j.install.npmIntegrity;
      delete j.install.clawpackSha256;
    }
    out(JSON.stringify(j, null, 2) + "\n");
    done(0);
  }
  if (legacyPresent) {
    out(JSON.stringify(fixtureJson("inspect-legacy-untracked.json"), null, 2) + "\n");
    done(0);
  }
  out(fixtureText("inspect-not-installed.json"));
  done(1);
}

if (args[0] === "plugins" && args[1] === "install") {
  const locator = args[2];
  if (scenario.readonlyEnforced && process.env.OPENCLAW_CONFIG_READONLY === "1") {
    err("Config is externally managed (OPENCLAW_CONFIG_READONLY=1), so OpenClaw treats openclaw.json as immutable.\n");
    done(1);
  }
  if (scenario.installReadonly) {
    err("Config is externally managed (OPENCLAW_CONFIG_READONLY=1), so OpenClaw treats openclaw.json as immutable.\n");
    done(1);
  }
  if (scenario.installExit) {
    err("TEST ONLY install failure\n");
    done(scenario.installExit);
  }
  let m;
  let version = null;
  if ((m = /^clawhub:@cyb3rb1ade\/plur1bus-memory@(.+)$/.exec(locator)) || (m = /^npm:@cyb3rb1ade\/plur1bus-memory@(.+)$/.exec(locator))) version = m[1];
  else if (locator.startsWith("npm-pack:")) version = (/cyb3rb1ade-plur1bus-memory-([0-9][^/\\]*)\.tgz$/.exec(locator) ?? /[\\/]artefacts[\\/]([0-9][^/\\]*)\.tgz$/.exec(locator) ?? [])[1] ?? scenario.packVersion;
  if ((scenario.installExitVersions ?? []).includes(version)) {
    err("TEST ONLY install failure for " + version + "\n");
    done(1);
  }
  // TEST ONLY: a new plugin version that writes into the store before anything else happens
  if (scenario.mutateStore && version !== state.version && existsSync(scenario.mutateStore)) {
    writeFileSync(join(scenario.mutateStore, "written-by-" + version + ".txt"), "TEST ONLY\n");
  }
  // TEST ONLY: the installer process itself is killed while OpenClaw installs (Review Focus 5)
  if (scenario.killParentOnInstall && process.env.PLUR1BUS_SANDBOX_ALLOW_KILL_PARENT === "1") {
    appendFileSync(join(SANDBOX, "argv.log"), JSON.stringify({ bin: "kill", argv: [String(process.ppid)] }) + "\n");
    process.kill(process.ppid, "SIGKILL");
    done(137);
  }
  if ((m = /^clawhub:@cyb3rb1ade\/plur1bus-memory@(.+)$/.exec(locator))) Object.assign(state, { source: "clawhub", version: m[1], sourcePath: undefined });
  else if ((m = /^npm:@cyb3rb1ade\/plur1bus-memory@(.+)$/.exec(locator))) Object.assign(state, { source: "npm", version: m[1], sourcePath: undefined });
  else if (locator.startsWith("npm-pack:")) Object.assign(state, { source: "npm", version, sourcePath: locator.slice("npm-pack:".length) });
  else {
    err("shim: unexpected locator " + locator + "\n");
    done(2);
  }
  state.installed = true;
  out("Installed plugin " + PLUGIN + "\n");
  done(0);
}

if (args[0] === "plugins" && args[1] === "uninstall") {
  if (scenario.uninstallExit) {
    // OpenClaw's generic failure block (src/cli/failure-output.ts): title, Reason, then three hint lines
    err("[openclaw] Command failed\n[openclaw] Reason: TEST ONLY uninstall failure\n[openclaw] Debug: set OPENCLAW_DEBUG=1 to include the stack trace.\n[openclaw] Try: openclaw doctor\n[openclaw] Help: openclaw --help\n");
    done(scenario.uninstallExit);
  }
  state.installed = false;
  if (state.config[SLOT] === PLUGIN) state.config[SLOT] = "memory-core";
  out("Uninstalled " + PLUGIN + "\n");
  done(0);
}

if (args[0] === "plugins" && args[1] === "enable") {
  out("Enabled " + args[2] + "\n");
  done(0);
}

if (args[0] === "gateway" && args[1] === "status") {
  if (scenario.gatewayAmbiguous) {
    err("gateway status: could not inspect the service\n");
    done(1);
  }
  const j = fixtureJson("gateway-status-stopped.json");
  if (scenario.gatewayRunning) j.rpc.ok = true;
  out(JSON.stringify(j, null, 2) + "\n");
  done(0);
}

if (args[0] === "plur1bus" && args[1] === "selftest") {
  const report = scenario.selftest ?? {
    schema: "plur1bus.selftest/1", ok: true, pluginVersion: state.version, node: "24.21.0", target: "linux-x64",
    addons: [{ name: "@lancedb/lancedb", ok: true }, { name: "onnxruntime-node", ok: true }, { name: "sharp", ok: true }],
    model: { profile: "e5-multilingual-384", revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3", state: has("--download-models") ? "downloaded" : "present" },
    steps: [{ id: "store.open", ok: true, ms: 3 }], harnessHome: null, warnings: [], errors: [],
  };
  out(JSON.stringify(report) + "\n");
  done(report.ok ? 0 : 1);
}

err("shim: unknown command " + JSON.stringify(args) + "\n");
done(2);
`;

const NODE_SHIM = String.raw`
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SANDBOX = __SANDBOX__;
const target = process.argv[2] ?? "";
if (target.endsWith("openclaw-shim.mjs")) {
  process.argv.splice(1, 1);
  await import(pathToFileURL(target).href);
} else {
  const args = process.argv.slice(2);
  appendFileSync(join(SANDBOX, "argv.log"), JSON.stringify({ bin: "node", argv: args }) + "\n");
  const scenario = JSON.parse(readFileSync(join(SANDBOX, "scenario.json"), "utf8"));
  if (args[0] === "--version") {
    process.stdout.write("v" + (scenario.nodeVersion ?? "24.21.0") + "\n");
    process.exit(0);
  }
  if (target.endsWith("setup-feature-crons.mjs")) {
    process.stdout.write(JSON.stringify({ ok: true, warnings: scenario.cronWarnings ?? [] }) + "\n");
    process.exit(0);
  }
  process.stderr.write("node shim: unexpected " + JSON.stringify(args) + "\n");
  process.exit(2);
}
`;

/**
 * A minimal valid plur1bus.plugin-feed/1 for the fixtures (TEST ONLY URLs).
 * @param {{ version?: string, clawpackDigest?: string|null, integrity?: string, tarballSha256?: string, tarballUrl?: string, minGatewayVersion?: string, node?: string, windowsNativeBeta?: boolean }} [o]
 */
export function makeTestFeed(o = {}) {
  const versions = o.versions ?? [o.version ?? "7.16.11"];
  const zero = (n) => String(n).padStart(64, "0");
  const releases = versions.map((version) => makeTestRelease(version, o));
  const version = versions[0];
  return {
    schema: "plur1bus.plugin-feed/1",
    channel: "stable",
    generatedAt: "2026-09-29T00:00:00.000Z",
    installer: { version, url: "https://example.invalid/TEST-ONLY/plur1bus-plugin-installer.mjs", sha256: zero(1) },
    bootstrap: {
      sh: { url: "https://example.invalid/TEST-ONLY/install-plugin.sh", sha256: zero(2) },
      ps1: { url: "https://example.invalid/TEST-ONLY/install-plugin.ps1", sha256: zero(3) },
    },
    hosts: { openclaw: { windowsNativeBeta: o.windowsNativeBeta ?? true, latest: version, releases } },
  };
}

/**
 * One feed release; `o.tarballs[version]` ({ url, sha256 }) and `o.notes[version]` ({ de, en }) override per version.
 * @param {string} version
 * @param {object} o
 */
function makeTestRelease(version, o) {
  const zero = (n) => String(n).padStart(64, "0");
  const t = o.tarballs?.[version] ?? {};
  return {
    version,
    pluginId: "memory-lancedb-namespaced",
    clawhub: `clawhub:@cyb3rb1ade/plur1bus-memory@${version}`,
    npm: `npm:@cyb3rb1ade/plur1bus-memory@${version}`,
    tarball: {
      url: t.url ?? o.tarballUrl ?? `https://example.invalid/TEST-ONLY/cyb3rb1ade-plur1bus-memory-${version}.tgz`,
      sha256: t.sha256 ?? o.tarballSha256 ?? zero(4),
      integrity: o.integrity ?? FIXTURE_NPM_INTEGRITY,
    },
    ...(o.clawpackDigest === null ? {} : { clawpackDigest: o.clawpackDigest ?? FIXTURE_CLAWPACK_SHA256 }),
    compat: { pluginApi: ">=2026.8.1", minGatewayVersion: o.minGatewayVersion ?? "2026.8.1" },
    node: o.node ?? ">=24.16.0 <25 || >=26.1.0",
    security: false,
    notes: o.notes?.[version] ?? { de: "TEST ONLY", en: "TEST ONLY" },
  };
}

/**
 * @param {{ root?: string, profile?: string, scenario?: object, feed?: object, extraEnv?: Record<string,string> }} [opts]
 */
export function createInstallerSandbox(opts = {}) {
  const root = opts.root ?? makeTempDir("plur1bus-installer-");
  mkdirSync(root, { recursive: true });
  const home = join(root, "home");
  const binDir = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const stateDir = opts.profile ? join(home, `.openclaw-${opts.profile}`) : join(root, "state");
  mkdirSync(stateDir, { recursive: true });

  const q = (s) => JSON.stringify(s);
  writeFileSync(join(binDir, "openclaw-shim.mjs"), OPENCLAW_SHIM.replace("__SANDBOX__", q(root)).replace("__FIXTURES__", q(FIXTURES)));
  writeFileSync(join(binDir, "node-shim.mjs"), NODE_SHIM.replace("__SANDBOX__", q(root)));
  writeLauncher(binDir, "node", "node-shim.mjs");
  // the openclaw shim has install-cli.sh's shape (`exec "<node>" "<entry>"`), so node detection finds the node shim
  writeLauncher(binDir, "openclaw", "openclaw-shim.mjs", { via: join(binDir, "node") });
  if (process.platform !== "win32") {
    // `crontab` shim (HM1-R9 guard probe): logs its argv, prints <root>/crontab.txt, never edits anything
    writeFileSync(
      join(binDir, "crontab"),
      `#!/bin/sh\nprintf '{"bin":"crontab","argv":["%s"]}\\n' "$*" >> "${join(root, "argv.log")}"\nif [ "$*" != "-l" ]; then echo "crontab shim: refusing $*" >&2; exit 2; fi\nif [ -f "${join(root, "crontab.txt")}" ]; then cat "${join(root, "crontab.txt")}"; exit 0; fi\necho "no crontab for sandbox-user" >&2\nexit 1\n`,
      { mode: 0o755 },
    );
  }

  const scenario = { stateDir, packVersion: "7.16.11", ...(opts.scenario ?? {}) };
  const scenarioPath = join(root, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2));
  writeFileSync(join(root, "argv.log"), "");
  if (scenario.config) writeFileSync(join(root, "shim-state.json"), JSON.stringify({ installed: Boolean(scenario.installed), source: scenario.installedSource ?? "npm", version: scenario.installedVersion ?? "7.16.11", config: scenario.config }));
  else if (scenario.installed) writeFileSync(join(root, "shim-state.json"), JSON.stringify({ installed: true, source: scenario.installedSource ?? "npm", version: scenario.installedVersion ?? "7.16.11", config: {} }));

  const feed = opts.feed ?? makeTestFeed();
  const feedFile = join(root, "feed.json");
  writeFileSync(feedFile, JSON.stringify(feed, null, 2));

  const PATH = [binDir, "/usr/bin", "/bin"].join(delimiter);
  const env = {
    PATH,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData", "Local"),
    OPENCLAW_HOME: home,
    USER: "sandbox-user",
    PLUR1BUS_PLUGIN_INSTALLER_TEST: "1",
    ...(opts.profile ? { OPENCLAW_PROFILE: opts.profile } : { OPENCLAW_STATE_DIR: stateDir }),
    ...(opts.extraEnv ?? {}),
  };
  // OpenClaw's openclaw.cmd and the shims are .cmd files run through cmd.exe (openclaw-cli.mjs defaultRun), and the
  // .ps1 bootstrap reads the architecture from PROCESSOR_ARCHITECTURE (sandbox-common.js addWindowsEnv).
  addWindowsEnv(env, binDir);
  assertShimOnPath("openclaw", env, binDir, "installer-sandbox");

  return {
    root,
    home,
    stateDir,
    binDir,
    env,
    feed,
    feedFile,
    /** @returns {Array<{bin: string, argv: string[]}>} */
    log() {
      return readFileSync(join(root, "argv.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    /** argv of every `openclaw` call */
    openclawCalls() {
      return this.log().filter((e) => e.bin === "openclaw").map((e) => e.argv);
    },
    shimState() {
      const p = join(root, "shim-state.json");
      return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { installed: false, config: {} };
    },
    setScenario(patch) {
      const cur = JSON.parse(readFileSync(scenarioPath, "utf8"));
      writeFileSync(scenarioPath, JSON.stringify({ ...cur, ...patch }, null, 2));
    },
    /** TEST ONLY crontab listing the `crontab` shim prints (null removes it). */
    setCrontab(text) {
      const p = join(root, "crontab.txt");
      if (text === null) rmSync(p, { force: true });
      else writeFileSync(p, text);
    },
    writeFeed(f) {
      writeFileSync(feedFile, JSON.stringify(f, null, 2));
    },
  };
}

/** SHA-256 hex of a file. */
export function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/**
 * A supported arch for this host's platform: darwin ships arm64 only (D8), so
 * pinning "x64" everywhere made every macOS run a darwin-x64 exit 3.
 */
export const SANDBOX_ARCH = process.platform === "darwin" ? "arm64" : "x64";

/**
 * Run the installer in-process against the sandbox (never a TTY unless `extra.isTTY`;
 * a prompt fails the test unless `extra.prompt` is given; free space is stubbed).
 * @returns {Promise<{ code: number, stdout: string, stderr: string, out: string }>}
 */
export async function runSandboxInstaller(sb, argv, extra = {}) {
  const { runInstaller } = await import("../../scripts/dist/installer/main.mjs");
  const stdout = sink();
  const stderr = extra.stderr ?? sink();
  const code = await runInstaller(["--feed-file", sb.feedFile, ...argv], {
    env: sb.env,
    platform: process.platform,
    arch: SANDBOX_ARCH,
    glibcVersion: "2.39",
    isTTY: false,
    statfs: () => ({ bavail: 1 << 20, bsize: 1 << 20 }),
    prompt: async () => {
      throw new Error("prompt must not be called");
    },
    stdout,
    ...extra,
    stderr,
  });
  return { code, stdout: stdout.text, stderr: stderr.text, out: stdout.text + stderr.text };
}

/** The `openclaw` calls that change something (install/uninstall/update/enable, config set). */
export function mutatingCalls(calls) {
  return calls.filter((a) => (a[0] === "plugins" && ["install", "uninstall", "update", "enable"].includes(a[1])) || (a[0] === "config" && a[1] === "set"));
}

/** Every path below `dir` (depth first); [] when `dir` does not exist. */
export function walkTree(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out.push(p);
    if (e.isDirectory()) out.push(...walkTree(p));
  }
  return out;
}

/** SHA-256 over the relative paths and file contents below `dir`. */
export function treeDigest(dir) {
  const h = createHash("sha256");
  for (const p of walkTree(dir).sort()) {
    h.update(relative(dir, p));
    h.update("\0");
    if (statSync(p).isFile()) h.update(readFileSync(p));
    h.update("\0");
  }
  return h.digest("hex");
}

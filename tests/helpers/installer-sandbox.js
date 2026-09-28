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
 * `createInstallerSandbox()` throws if the `openclaw` that PATH resolves is not
 * its own shim (global constraint "never touch a real OpenClaw installation").
 */

import { accessSync, constants, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./temp-dir.js";

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

if (args[0] === "--version") {
  out(scenario.versionText ?? fixtureText(scenario.openclawVersion === "latest" ? "version-latest.txt" : "version-2026.8.1.txt"));
  done(0);
}

if (args[0] === "config" && args[1] === "validate") {
  if (scenario.configValidateExit) {
    err("Config invalid: TEST ONLY validation failure\nRun: openclaw doctor --fix\n");
    done(scenario.configValidateExit);
  }
  out("Config valid\n");
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
  err("Config path is valid but unset: " + path + " (runtime default applies)\n");
  done(1);
}

if (args[0] === "config" && args[1] === "set") {
  const [path, value] = [args[2], args[3]];
  if (scenario.readonlyEnforced && process.env.OPENCLAW_CONFIG_READONLY === "1") {
    err("Config is externally managed (OPENCLAW_CONFIG_READONLY=1), so OpenClaw treats openclaw.json as immutable.\n");
    done(1);
  }
  if (path === SLOT && value === PLUGIN && !state.installed && !scenario.legacy) {
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
    if (scenario.recordClawpackSha256) j.install.clawpackSha256 = scenario.recordClawpackSha256;
    if (has("--runtime")) {
      j.plugin.imported = scenario.runtimeImported ?? true;
      j.plugin.status = scenario.runtimeStatus ?? "loaded";
    }
    out(JSON.stringify(j, null, 2) + "\n");
    done(0);
  }
  if (scenario.legacy) {
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
  if (scenario.installExit) {
    err("TEST ONLY install failure\n");
    done(scenario.installExit);
  }
  let m;
  if ((m = /^clawhub:@cyb3rb1ade\/plur1bus-memory@(.+)$/.exec(locator))) Object.assign(state, { source: "clawhub", version: m[1] });
  else if ((m = /^npm:@cyb3rb1ade\/plur1bus-memory@(.+)$/.exec(locator))) Object.assign(state, { source: "npm", version: m[1] });
  else if (locator.startsWith("npm-pack:")) Object.assign(state, { source: "npm", version: scenario.packVersion });
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
    err("TEST ONLY uninstall failure\n");
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

/** Find `name` on a PATH string the way the installer does (first executable hit). */
function resolveOnPath(name, pathValue) {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try {
        accessSync(p, constants.X_OK);
        return p;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/**
 * A minimal valid plur1bus.plugin-feed/1 for the fixtures (TEST ONLY URLs).
 * @param {{ version?: string, clawpackDigest?: string|null, integrity?: string, tarballSha256?: string, minGatewayVersion?: string, node?: string, windowsNativeBeta?: boolean }} [o]
 */
export function makeTestFeed(o = {}) {
  const version = o.version ?? "7.16.11";
  const zero = (n) => String(n).padStart(64, "0");
  const release = {
    version,
    pluginId: "memory-lancedb-namespaced",
    clawhub: `clawhub:@cyb3rb1ade/plur1bus-memory@${version}`,
    npm: `npm:@cyb3rb1ade/plur1bus-memory@${version}`,
    tarball: {
      url: `https://example.invalid/TEST-ONLY/cyb3rb1ade-plur1bus-memory-${version}.tgz`,
      sha256: o.tarballSha256 ?? zero(4),
      integrity: o.integrity ?? FIXTURE_NPM_INTEGRITY,
    },
    ...(o.clawpackDigest === null ? {} : { clawpackDigest: o.clawpackDigest ?? FIXTURE_CLAWPACK_SHA256 }),
    compat: { pluginApi: ">=2026.8.1", minGatewayVersion: o.minGatewayVersion ?? "2026.8.1" },
    node: o.node ?? ">=24.16.0 <25 || >=26.1.0",
    security: false,
    notes: { de: "TEST ONLY", en: "TEST ONLY" },
  };
  return {
    schema: "plur1bus.plugin-feed/1",
    channel: "stable",
    generatedAt: "2026-09-29T00:00:00.000Z",
    installer: { version, url: "https://example.invalid/TEST-ONLY/plur1bus-plugin-installer.mjs", sha256: zero(1) },
    bootstrap: {
      sh: { url: "https://example.invalid/TEST-ONLY/install-plugin.sh", sha256: zero(2) },
      ps1: { url: "https://example.invalid/TEST-ONLY/install-plugin.ps1", sha256: zero(3) },
    },
    hosts: { openclaw: { windowsNativeBeta: o.windowsNativeBeta ?? true, latest: version, releases: [release] } },
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
  const real = process.execPath;
  if (process.platform === "win32") {
    writeFileSync(join(binDir, "node.cmd"), `@"${real}" "${join(binDir, "node-shim.mjs")}" %*\r\n`);
    writeFileSync(join(binDir, "openclaw.cmd"), `@"${real}" "${join(binDir, "openclaw-shim.mjs")}" %*\r\n`);
  } else {
    writeFileSync(join(binDir, "node"), `#!/bin/sh\nexec "${real}" "${join(binDir, "node-shim.mjs")}" "$@"\n`, { mode: 0o755 });
    writeFileSync(join(binDir, "openclaw"), `#!/bin/sh\nexec "${join(binDir, "node")}" "${join(binDir, "openclaw-shim.mjs")}" "$@"\n`, { mode: 0o755 });
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
  if (process.platform === "win32") env.PATHEXT = ".COM;.EXE;.BAT;.CMD";

  const resolved = resolveOnPath("openclaw", env.PATH);
  const expected = join(binDir, process.platform === "win32" ? "openclaw.cmd" : "openclaw");
  if (!resolved || realpathSync(resolved) !== realpathSync(expected)) {
    throw new Error(`installer-sandbox: PATH resolves openclaw to ${resolved}, not the sandbox shim ${expected}`);
  }

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
    writeFeed(f) {
      writeFileSync(feedFile, JSON.stringify(f, null, 2));
    },
  };
}

/** SHA-256 hex of a file. */
export function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** Collect a writable's output. */
export function sink() {
  let text = "";
  return { write: (c) => { text += String(c); return true; }, get text() { return text; } };
}

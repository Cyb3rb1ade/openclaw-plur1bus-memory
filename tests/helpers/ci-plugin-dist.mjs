#!/usr/bin/env node
/**
 * tests/helpers/ci-plugin-dist.mjs — the per-leg driver of .github/workflows/plugin-dist.yml (HM1 Task 8, spec A.2).
 *
 * Runs only on disposable CI runners against an OpenClaw the workflow installed under $RUNNER_TEMP (HM1-R11); every
 * subcommand that calls `openclaw` first runs assert-disposable over the child environment and refuses otherwise.
 * OpenClaw is driven through scripts/dist/installer/openclaw-cli.mjs's defaultRun, so on Windows every call goes
 * through the same `cmd.exe /d /v:off /s /c` quoting the installer uses. Nothing reads or prints openclaw.json or a
 * plugin config; `config get` is used for plugins.slots.memory only.
 *
 *   env                     write the disposable locations to $GITHUB_ENV (OPENCLAW_HOME, OPENCLAW_STATE_DIR, OC_*)
 *   facts                   print `FACT <key>: <json>` lines for docs/distribution/openclaw-cli-facts.md
 *   cmd-argv                (win32) check that cmd.exe /v:off passes spaces, `!`, `^`, `&` and non-ASCII unchanged
 *   raw --tgz <v.tgz> | --artefacts <pack dir>   npm-pack install, slot, inspect --runtime (status loaded, imported, no sdk-incompatible,
 *                           CLI root plur1bus), selftest --json --download-models (ok), dot-dir scan check, uninstall
 *   clawhub [--version v | --artefacts d] [--compare-tgz t]   non-TTY ClawHub install without/with --accept-capabilities (T5-b, k);
 *                           informational, exit 0 unless the environment is not disposable
 *   installer --artefacts d --feed-dir f --bootstrap sh|ps1 [--ps powershell|pwsh] [--from installer|raw]
 *             [--from-tgz t] [--skip-forced-failure]
 *                           fresh install (ci.0) → seed 50 rows → digest → forced failing update (exit 1, store
 *                           untouched so not restored, digest equal, version back) → update (exit 0, digest equal, one more snapshot) → bootstrap and
 *                           direct installer print byte-identical --json → (win32) store-inside-harness-home dry run
 *                           → uninstall (store kept)
 *   wsl-setup --distro d --openclaw-version v     install OpenClaw inside WSL under /tmp/plur1bus-ci (C8)
 *   wsl-install --distro d --artefacts d --feed-dir f   install-plugin.ps1 -Target wsl:<d> --offline … → exit 0
 *   wsl-selftest --distro d                        `openclaw plur1bus selftest --json --download-models` → ok
 *
 * Results go to stdout (human lines to stderr) and, when set, to $GITHUB_STEP_SUMMARY. Exit 0, or 1 with the reason.
 */

import { execFile, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { createOpenclawCli, defaultRun, PLUGIN_ID } from "../../scripts/dist/installer/openclaw-cli.mjs";
import { nodeFromLauncher, whichOnPath } from "../../scripts/dist/installer/detect.mjs";
import { listSnapshots } from "../../lib/snapshot/store-snapshot.js";
import { assertDisposable } from "./assert-disposable.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WIN = process.platform === "win32";
const SLOT = "plugins.slots.memory";
const C = `plugins.entries.${PLUGIN_ID}.config`;
const LINUX_ROOT = "/tmp/plur1bus-ci";

class Failed extends Error {}

const say = (m) => process.stderr.write(`ci-plugin-dist: ${m}\n`);
const summary = (md) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
};
const facts = [];
function fact(key, value) {
  facts.push([key, value]);
  process.stdout.write(`FACT ${key}: ${JSON.stringify(value)}\n`);
}
function check(cond, msg) {
  if (!cond) throw new Failed(msg);
  say(`ok: ${msg}`);
}
const tail = (t, n = 12) => String(t ?? "").split(/\r?\n/).filter(Boolean).slice(-n).join("\n");
const lastJsonLine = (t) => {
  const line = String(t ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).reverse().find((l) => l.startsWith("{"));
  try {
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
};
const parseDoc = (buf) => {
  try {
    return JSON.parse(Buffer.isBuffer(buf) ? buf.toString("utf8") : buf);
  } catch {
    return null;
  }
};

/** A JSON document on stdout, tolerating log lines before it; null when there is none. */
function parseListing(stdout) {
  const t = String(stdout ?? "");
  const direct = parseDoc(t);
  if (direct !== null) return direct;
  const i = t.search(/^[[{]/m);
  return i >= 0 ? parseDoc(t.slice(i)) : null;
}

/** Run a program with raw stdout bytes; never rejects. */
function runBytes(file, args, { env, timeoutMs = 3_600_000, input } = {}) {
  if (input !== undefined) {
    const r = spawnSync(file, args, { env, input, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    return Promise.resolve({ code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? Buffer.alloc(0), stderr: String(r.stderr ?? "") + (r.error ? `\n${r.error.message}` : "") });
  }
  return new Promise((done) => {
    execFile(file, args, { env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 256 * 1024 * 1024, encoding: "buffer", windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : err.code === "ENOENT" ? 127 : 1) : 0;
      done({ code, stdout: stdout ?? Buffer.alloc(0), stderr: String(stderr ?? "") });
    });
  });
}

/**
 * seed-store.mjs / store-digest.mjs in a child process. They load the installed plugin's native @lancedb/lancedb
 * binary; in this long-lived driver process that .node file stayed mapped until the job ended, and Windows cannot
 * delete a loaded module, so `openclaw plugins uninstall` (one fs.rm of the plugin's npm project dir, no retries)
 * failed at the last step of every Windows installer leg (run 36518766808). A child unloads it when it exits.
 */
async function helperChild(script, args) {
  const r = await runBytes(process.execPath, [join(REPO, "tests", "helpers", script), ...args], { env: process.env, timeoutMs: 900_000 });
  const doc = lastJsonLine(r.stdout.toString("utf8"));
  if (r.code !== 0 || !doc) throw new Failed(`${script} ${args.join(" ")} → exit ${r.code}: ${tail(r.stderr, 8)}`);
  return doc;
}
const seedStore = ({ stateDir, baseDbPath, pluginDir, count }) =>
  helperChild("seed-store.mjs", ["--state-dir", stateDir, "--base-db-path", baseDbPath, "--plugin-dir", pluginDir, "--count", String(count)]);
const storeDigest = ({ baseDbPath, pluginDir }) => helperChild("store-digest.mjs", ["--base-db-path", baseDbPath, ...(pluginDir ? ["--plugin-dir", pluginDir] : [])]);

/** Relative paths under `root` (depth-first, at most `max`), plus every native `.node` file found. */
function listTree(root, max = 200) {
  const entries = [];
  const nodeFiles = [];
  let total = 0;
  const walk = (dir, rel) => {
    let list;
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      entries.push(`${rel || "."}: ${err.code ?? err.message}`);
      return;
    }
    for (const e of list) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      total++;
      if (entries.length < max) entries.push(e.isDirectory() ? `${r}/` : r);
      if (e.isFile() && e.name.endsWith(".node")) nodeFiles.push(r);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(join(dir, e.name), r);
    }
  };
  if (existsSync(root)) walk(root, "");
  return { root, exists: existsSync(root), total, entries, nodeFiles };
}

/** The child environment for one disposable OpenClaw instance. */
function instanceEnv(stateDir, extra = {}) {
  const env = { ...process.env, ...extra };
  if (stateDir) env.OPENCLAW_STATE_DIR = resolve(stateDir);
  if (!WIN) env.HOME = env.OPENCLAW_HOME; // install-cli.sh and the plugin's default store follow HOME (fact sheet step 1)
  const d = assertDisposable({ env, vars: WIN ? [] : ["HOME"] });
  if (!d.ok) throw new Failed(`not a disposable OpenClaw instance (HM1-R11): ${d.errors.join("; ")}`);
  return env;
}

function openclaw(env) {
  const bin = whichOnPath("openclaw", { env });
  if (!bin) throw new Failed("openclaw is not on PATH");
  const call = async (args, timeoutMs = 1_800_000) => {
    const r = await defaultRun(bin, args, { env, timeoutMs });
    say(`openclaw ${args.join(" ")} → exit ${r.code}${r.timedOut ? " (deadline)" : ""}`);
    return r;
  };
  return { bin, call, cli: createOpenclawCli({ bin, env }) };
}

async function inspectJson(oc, runtime = false) {
  const r = await oc.call(["plugins", "inspect", PLUGIN_ID, ...(runtime ? ["--runtime"] : []), "--json"]);
  return { code: r.code, json: parseDoc(r.stdout), text: `${r.stdout}\n${r.stderr}` };
}

async function ensureSlot(oc) {
  const g = await oc.call(["config", "get", SLOT]);
  const value = g.code === 0 ? String(g.stdout).trim() : null;
  if (value !== PLUGIN_ID) {
    const s = await oc.call(["config", "set", SLOT, PLUGIN_ID]);
    check(s.code === 0, `config set ${SLOT} ${PLUGIN_ID} (${tail(s.stderr || s.stdout, 3)})`);
  }
  return value;
}

// ─── env ────────────────────────────────────────────────────────────────────
function cmdEnv() {
  const root = process.env.RUNNER_TEMP;
  if (!root) throw new Failed("RUNNER_TEMP is not set (this subcommand runs in GitHub Actions only)");
  const loc = {
    OPENCLAW_HOME: join(root, "oc-home"),
    OPENCLAW_STATE_DIR: join(root, "oc-state"),
    OC_STATE_RAW: join(root, "oc-state-raw"),
    OC_STATE_CLAWHUB: join(root, "oc-state-clawhub"),
    OC_FEED_DIR: join(root, "oc-feed"),
    OC_WORK: join(root, "oc-work"),
  };
  for (const p of Object.values(loc)) mkdirSync(p, { recursive: true });
  const lines = Object.entries(loc).map(([k, v]) => `${k}=${v}`).join("\n");
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${lines}\n`);
  process.stdout.write(`${lines}\n`);
}

// ─── facts ──────────────────────────────────────────────────────────────────
async function cmdFacts() {
  const env = instanceEnv(process.env.OPENCLAW_STATE_DIR);
  const oc = openclaw(env);
  fact("host", { platform: process.platform, arch: process.arch, node: process.version });
  fact("openclaw.bin", { path: oc.bin, real: safe(() => realpathSync(oc.bin)) });
  if (!WIN) {
    const head = safe(() => readFileSync(realpathSync(oc.bin), "utf8").split("\n").slice(0, 6).join("\n"));
    const prefix = dirname(dirname(oc.bin));
    fact("posix.wrapper", { head, nodeFromLauncher: nodeFromLauncher(oc.bin), toolsNodeSymlink: safe(() => readlinkSync(join(prefix, "tools", "node"))) });
  } else {
    const dir = dirname(oc.bin);
    const shims = safe(() => readdirSync(dir).filter((n) => /^openclaw(\.|$)/i.test(n))) ?? [];
    const cmdFile = shims.find((n) => /\.cmd$/i.test(n));
    fact("win32.shims", { dir, shims, cmd: cmdFile ? safe(() => readFileSync(join(dir, cmdFile), "utf8")) : null });
    const node = whichOnPath("node", { env });
    fact("win32.node", { onPath: node, portableNode: existsSync(join(env.LOCALAPPDATA ?? "", "OpenClaw", "deps", "portable-node")) });
  }
  const v = await oc.call(["--version"], 60_000);
  fact("openclaw.version", { exit: v.code, stdout: String(v.stdout).trim() });
  const gs = await oc.call(["gateway", "status", "--json"], 120_000);
  const j = parseDoc(gs.stdout);
  fact("gateway.status", {
    exit: gs.code,
    rpcOk: j?.rpc?.ok ?? null,
    connectFailure: j?.rpc?.connectFailure ?? null,
    rpcError: typeof j?.rpc?.error === "string" ? j.rpc.error.slice(0, 120) : null,
    portStatus: j?.port?.status ?? null,
    serviceLoaded: j?.service?.loaded ?? null,
    installerVerdict: await oc.cli.gatewayStatus(),
  });
  // Review Focus 3 / R-S2 (run 36514170524): on the fresh state dir the installer leg uses, openclaw.json does not
  // exist yet; `config validate --json` then exits 1 "file not found", which the installer treats as valid. Seen on
  // linux-x64 locally for 2026.8.1 and 2026.9.6; this line answers it for every leg. Only valid, error.message and
  // path are printed, never the issues list.
  const cv = await oc.call(["config", "validate", "--json"], 120_000);
  const cvj = parseListing(cv.stdout);
  const cfgPath = typeof cvj?.path === "string" ? cvj.path : null;
  fact("config.validate.fresh", {
    exit: cv.code,
    valid: cvj?.valid ?? null,
    error: typeof cvj?.error?.message === "string" ? cvj.error.message.slice(0, 60) : null,
    pathIsStateDirConfig: cfgPath !== null && resolve(cfgPath) === resolve(env.OPENCLAW_STATE_DIR, "openclaw.json"),
    configFilePresent: cfgPath !== null && existsSync(cfgPath),
    installerVerdict: await oc.cli.configValidate(),
  });
  summary(`### OpenClaw facts (${process.platform}-${process.arch})\n\n\`\`\`\n${facts.map(([k, x]) => `${k}: ${JSON.stringify(x)}`).join("\n")}\n\`\`\`\n`);
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

// ─── cmd-argv (win32) ───────────────────────────────────────────────────────
async function cmdArgv() {
  if (!WIN) return say("cmd-argv: not win32, nothing to check");
  const dir = join(process.env.RUNNER_TEMP ?? process.env.TEMP, "cmd argv probe");
  mkdirSync(dir, { recursive: true });
  const probe = join(dir, "argv-echo.cmd");
  // the same shape as npm's cmd-shim: forward %* to node
  writeFileSync(probe, `@ECHO off\r\n"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" -- %*\r\n`);
  const argv = ["a b", "x!y!", "caret^", "amp&ersand", "J\u00fcrgen A", "trailing\\", "(paren)", "C:\\Users\\J\u00fcrgen A\\.openclaw"];
  const r = await defaultRun(probe, argv, { env: process.env, timeoutMs: 60_000 });
  const got = parseDoc(r.stdout);
  fact("win32.cmdArgv", { exit: r.code, sent: argv, got });
  check(r.code === 0 && JSON.stringify(got) === JSON.stringify(argv), `cmd.exe /d /v:off /s /c passes every argument unchanged (got ${JSON.stringify(got)})`);
  const refused = await defaultRun(probe, ["100%"], { env: process.env, timeoutMs: 60_000 });
  check(refused.code === 126, "an argument with % is refused before cmd.exe sees it");
}

// ─── raw ────────────────────────────────────────────────────────────────────
async function cmdRaw({ tgz, stateDir }) {
  const env = instanceEnv(stateDir ?? process.env.OC_STATE_RAW);
  const oc = openclaw(env);
  const res = { tgz: resolve(tgz) };
  const v = await oc.call(["--version"], 60_000);
  res.openclaw = String(v.stdout).trim();

  const ins = await oc.call(["plugins", "install", `npm-pack:${resolve(tgz)}`, "--force", "--accept-capabilities"]);
  check(ins.code === 0, `plugins install npm-pack:<tgz> --force --accept-capabilities (${tail(ins.stderr || ins.stdout, 4)})`);
  const slotBefore = await ensureSlot(oc);
  fact("raw.slotAfterInstall", slotBefore);

  const t0 = Date.now();
  const rt = await inspectJson(oc, true);
  res.inspectRuntimeMs = Date.now() - t0;
  const p = rt.json?.plugin;
  const diags = [...(rt.json?.diagnostics ?? []), ...(p?.diagnostics ?? [])];
  const incompatible = diags.some((d) => d?.code === "sdk-incompatible" || /sdk-incompatible/.test(String(d?.message ?? "")));
  const roots = (rt.json?.cliCommands ?? p?.cliCommands ?? []).map((c) => (typeof c === "string" ? c : c?.name));
  res.inspect = { exit: rt.code, status: p?.status, imported: p?.imported, version: rt.json?.install?.version, source: rt.json?.install?.source, artifactKind: rt.json?.install?.artifactKind, cliCommands: roots, incompatible };
  fact("raw.inspectRuntime", res.inspect);
  check(rt.code === 0 && p?.status === "loaded" && p?.imported === true, `inspect --runtime: /plugin/status loaded and /plugin/imported true (got ${p?.status}, ${p?.imported})`);
  check(!incompatible, "no sdk-incompatible diagnostic");
  check(roots.includes("plur1bus"), `CLI root plur1bus registered (${roots.join(", ")})`);

  const t1 = Date.now();
  const st = await oc.call(["plur1bus", "selftest", "--json", "--download-models"], 3_600_000);
  const rep = lastJsonLine(st.stdout);
  res.selftest = { exit: st.code, wallMs: Date.now() - t1, ok: rep?.ok, model: rep?.model, steps: rep?.steps, addons: rep?.addons, warnings: rep?.warnings, errors: rep?.errors };
  if (!(st.code === 0 && rep?.ok === true)) {
    say(`selftest failed; addons (spec A.2 step 3):\n${JSON.stringify(rep?.addons ?? null, null, 2)}\nstderr:\n${tail(st.stderr, 40)}`);
  }
  check(st.code === 0 && rep?.ok === true, `openclaw plur1bus selftest --json --download-models → ok true (errors: ${JSON.stringify(rep?.errors ?? null)})`);

  // Dot-dirs under extensions are not scanned (legacy adoption keeps `.plur1bus-legacy-<ts>`, HM1-R9).
  const installPath = rt.json?.install?.installPath;
  const dot = join(env.OPENCLAW_STATE_DIR, "extensions", ".plur1bus-legacy-20260101T000000Z");
  mkdirSync(dot, { recursive: true });
  for (const f of ["openclaw.plugin.json", "package.json", "index.js"]) copyFileSync(join(installPath, f), join(dot, f)); // copies, never hard links (R-S8)
  const list = await oc.call(["plugins", "list", "--json"]);
  const again = await inspectJson(oc, false);
  const listing = parseListing(list.stdout);
  const realListing = list.code === 0 && listing !== null && JSON.stringify(listing).includes(`"${PLUGIN_ID}"`);
  const text = `${list.stdout}\n${list.stderr}\n${again.text}`;
  const diagMessages = [...(again.json?.diagnostics ?? []), ...(again.json?.plugin?.diagnostics ?? [])].map((d) => String(d?.message ?? d?.code ?? ""));
  const duplicate = new RegExp(`duplicate[^\\n]*${PLUGIN_ID}|${PLUGIN_ID}[^\\n]*duplicate`, "i").test(text) || diagMessages.some((m) => /duplicate/i.test(m));
  const mentioned = text.includes(".plur1bus-legacy-");
  const scanned = realListing ? mentioned || duplicate : "unknown";
  fact("dotDirScanned", { scanned, listExit: list.code, realListing, mentioned, duplicate, inspectExit: again.code, rootDir: again.json?.plugin?.rootDir ?? null });
  check(realListing, `plugins list --json gives a real listing that names ${PLUGIN_ID} (exit ${list.code}; ${tail(list.stderr || list.stdout, 2)}); without it the dot-dir question stays unknown`);
  check(scanned === false && again.code === 0 && again.json?.install != null, "OpenClaw does not scan <state>/extensions/.plur1bus-legacy-<ts> (no mention and no duplicate-id diagnostic in plugins list/inspect, the tracked install stays)");
  rmSync(dot, { recursive: true, force: true });

  const un = await oc.call(["plugins", "uninstall", PLUGIN_ID, "--force"]);
  check(un.code === 0, "plugins uninstall memory-lancedb-namespaced --force");

  const stepMs = (rep.steps ?? []).map((s) => `${s.id} ${s.skipped ? `skipped (${s.skipped})` : `${s.ms} ms`}`).join(", ");
  summary([
    `### Raw path — ${process.platform}-${process.arch}, ${res.openclaw}`,
    "",
    `| check | result |`,
    `|---|---|`,
    `| install npm-pack | exit 0, slot after install: ${slotBefore ?? "unset"} |`,
    `| inspect --runtime | ${p.status}, imported ${p.imported}, ${res.inspectRuntimeMs} ms, roots ${roots.join(" ")} |`,
    `| selftest --download-models | ok, ${res.selftest.wallMs} ms wall; model ${rep.model?.state}; ${stepMs} |`,
    `| addons | ${(rep.addons ?? []).map((a) => `${a.name} ${a.ok ? "ok" : "FAILED"}${a.package ? ` (${a.package})` : ""}`).join(", ")} |`,
    `| dot-dir scanned | ${scanned} |`,
    "",
  ].join("\n"));
  process.stdout.write(`${JSON.stringify(res)}\n`);
}

// ─── clawhub (informational) ────────────────────────────────────────────────
async function cmdClawhub({ version: asked, artefacts, compareTgz, stateDir }) {
  // default: the version this run packed (pack.json); the nightly job passes the release's version
  const version = asked ?? (artefacts ? JSON.parse(readFileSync(join(resolve(artefacts), "pack.json"), "utf8")).version : null);
  if (!version) throw new Failed("clawhub needs --version or --artefacts (pack.json)");
  const env = instanceEnv(stateDir ?? process.env.OC_STATE_CLAWHUB);
  const oc = openclaw(env);
  const spec = `clawhub:@cyb3rb1ade/plur1bus-memory@${version}`;
  const a = await oc.call(["plugins", "install", spec, "--force"]);
  fact("clawhub.nonTtyWithoutAccept", { exit: a.code, tail: tail(`${a.stdout}\n${a.stderr}`, 4) });
  const b = await oc.call(["plugins", "install", spec, "--force", "--accept-capabilities"]);
  fact("clawhub.nonTtyWithAccept", { exit: b.code, tail: tail(`${b.stdout}\n${b.stderr}`, 4) });
  if (b.code === 0) {
    const i = await inspectJson(oc, false);
    const rec = i.json?.install ?? {};
    const out = { source: rec.source, version: rec.version, npmIntegrity: rec.npmIntegrity, clawpackSha256: rec.clawpackSha256, installPath: rec.installPath };
    if (compareTgz) {
      const { createHash } = await import("node:crypto");
      const bytes = readFileSync(compareTgz);
      out.releaseTgzIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
      out.releaseTgzSha256 = createHash("sha256").update(bytes).digest("hex");
      out.npmIntegrityEqualsRelease = out.npmIntegrity === out.releaseTgzIntegrity;
    }
    fact("clawhub.installRecord", out);
    await oc.call(["plugins", "uninstall", PLUGIN_ID, "--force"]);
  }
  summary(`### ClawHub non-TTY (${process.platform}-${process.arch})\n\n\`\`\`\n${facts.map(([k, x]) => `${k}: ${JSON.stringify(x)}`).join("\n")}\n\`\`\`\n`);
}

// ─── installer end-to-end ───────────────────────────────────────────────────
async function cmdInstaller(o) {
  const artefacts = resolve(o.artefacts);
  const pack = JSON.parse(readFileSync(join(artefacts, "pack.json"), "utf8"));
  const feedDir = resolve(o["feed-dir"]);
  const feedFile = join(feedDir, "stable.json");
  const feed = JSON.parse(readFileSync(feedFile, "utf8"));
  const pubkey = readFileSync(join(feedDir, "pubkey.txt"), "utf8").trim();
  const env = instanceEnv(o["state-dir"] ?? process.env.OPENCLAW_STATE_DIR, {
    PLUR1BUS_PLUGIN_INSTALLER_TEST: "1",
    PLUR1BUS_PLUGIN_FEED: pathToFileURL(feedFile).href,
    PLUR1BUS_PLUGIN_PUBKEY: pubkey,
  });
  delete env.PLUR1BUS_SELFTEST_FORCE_FAIL;
  const oc = openclaw(env);
  const stateDir = env.OPENCLAW_STATE_DIR;
  const fromTgz = resolve(o["from-tgz"] ?? join(artefacts, pack.ciTgz));
  const toTgz = join(artefacts, pack.tgz);
  const fromVersion = feed.hosts.openclaw.releases.find((r) => r.tarball.url === pathToFileURL(fromTgz).href)?.version ?? (o["from-tgz"] ? null : pack.ciVersion);
  const toVersion = pack.version;
  if (!fromVersion) throw new Failed(`${fromTgz} is not a release of the CI feed`);
  if (fromVersion === toVersion) throw new Failed(`nothing to upgrade: the start version ${fromVersion} equals the pack version`);
  const bundle = join(artefacts, "plur1bus-plugin-installer.mjs");
  const psExe = o.ps === "pwsh" ? "pwsh" : "powershell.exe";
  const rows = [];
  const row = (k, v) => rows.push(`| ${k} | ${v} |`);

  const bootstrap = async (args, extra = {}, exe = psExe) => {
    const e = { ...env, ...extra };
    const r = o.bootstrap === "ps1"
      // -Target native: deterministic on runners whose WSL may list distros (the WSL path has its own job)
      ? await runBytes(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(artefacts, "install-plugin.ps1"), "-Target", "native", ...args], { env: e })
      : await runBytes("sh", [join(artefacts, "install-plugin.sh"), ...args], { env: e });
    say(`${o.bootstrap === "ps1" ? exe : "sh"} install-plugin ${args.join(" ")} → exit ${r.code}`);
    process.stderr.write(`${tail(r.stderr, 60)}\n`);
    return { ...r, doc: parseDoc(r.stdout) };
  };
  const direct = async (args, extra = {}) => {
    const r = await runBytes(process.execPath, [bundle, "--feed-file", feedFile, ...args], { env: { ...env, ...extra } });
    say(`node plur1bus-plugin-installer.mjs ${args.join(" ")} → exit ${r.code}`);
    return { ...r, doc: parseDoc(r.stdout) };
  };
  const version = async () => (await inspectJson(oc, false)).json?.install?.version ?? null;
  const snapshots = async () => (await listSnapshots({ stateDir })).filter((s) => s.kind === "snapshot").length;
  const stepOf = (doc, id) => doc?.steps?.find((s) => s.id === id);

  // 1. fresh install of the start version
  if (o.from === "raw") {
    const ins = await oc.call(["plugins", "install", `npm-pack:${fromTgz}`, "--force", "--accept-capabilities"]);
    check(ins.code === 0, `raw install of ${fromVersion} (${tail(ins.stderr || ins.stdout, 3)})`);
    await ensureSlot(oc);
    row(`raw install ${fromVersion}`, "exit 0");
  } else {
    const r = await bootstrap(["--offline", fromTgz, "--version", fromVersion, "--non-interactive", "--json"]);
    fact("installer.fresh.compat", { exit: r.code, compat: stepOf(r.doc, "compat") ?? null, findings: r.doc?.findings?.map((f) => f.id) ?? null });
    check(r.code === 0 && r.doc?.ok === true, `fresh install-plugin --offline <${fromVersion}> --non-interactive --json → exit 0 (got ${r.code}: ${JSON.stringify(r.doc?.steps?.filter((s) => s.status === "failed") ?? null)})`);
    row(`fresh install ${fromVersion}`, `exit 0 (${r.doc.steps.map((s) => `${s.id}:${s.status}`).join(" ")})`);
  }
  check((await version()) === fromVersion, `install record version ${fromVersion}`);

  // 2. a store inside the disposable state dir, 50 synthetic rows, digest
  const baseDbPath = join(stateDir, "memory", "lancedb-namespaced");
  const cfg = await oc.call(["config", "set", `${C}.baseDbPath`, baseDbPath.replaceAll("\\", "/")]);
  check(cfg.code === 0, `config set ${C}.baseDbPath to a store inside the state dir`);
  const installPath = (await inspectJson(oc, false)).json?.install?.installPath;
  const seeded = await seedStore({ stateDir, baseDbPath, pluginDir: installPath, count: 50 });
  check(seeded.rows === 50, "seeded 50 synthetic memories with the installed plugin's own MemoryDB and @lancedb/lancedb");
  const d0 = await storeDigest({ baseDbPath, pluginDir: installPath });
  check(d0.rows === 50, `digest before: ${d0.rows} rows, ${d0.sha256.slice(0, 16)}…`);
  row("store before", `${d0.rows} rows, sha256 ${d0.sha256.slice(0, 16)}…`);
  const snaps0 = await snapshots();

  // 3. forced failing verify (PLUR1BUS_SELFTEST_FORCE_FAIL=1, honoured only with the test flag) → rollback, exit 1
  if (!o["skip-forced-failure"]) {
    const f = await bootstrap(["--update", "--offline", toTgz, "--yes", "--json"], { PLUR1BUS_SELFTEST_FORCE_FAIL: "1" });
    check(f.code === 1, `forced failing update exits 1 (got ${f.code}; manual steps: ${JSON.stringify(f.doc?.manualSteps ?? null)})`);
    check(stepOf(f.doc, "verify.selftest")?.status === "failed" && stepOf(f.doc, "rollback")?.status === "ok", "verify.selftest failed and the rollback finished");
    const df = await storeDigest({ baseDbPath, pluginDir: (await inspectJson(oc, false)).json?.install?.installPath });
    check(df.rows === d0.rows && df.sha256 === d0.sha256, `digest after the rolled-back update equals before (${df.rows} rows)`);
    // HM1-R-F2: `plugins install --force` never writes to the store, so the rollback finds it untouched and does not
    // restore it (no Gateway gate, nothing replaced); a restore here, or a .pre-restore-* copy, would mean it changed.
    const restoreStep = stepOf(f.doc, "restore");
    const preRestores = safe(() => readdirSync(dirname(baseDbPath)).filter((n) => n.startsWith(`${basename(baseDbPath)}.pre-restore-`))) ?? [];
    fact("installer.forcedFailureRestore", { restore: restoreStep ?? null, compare: stepOf(f.doc, "restore.compare") ?? null, preRestores });
    check(restoreStep?.status === "skipped" && /untouched/.test(restoreStep.detail ?? ""), `the rollback found the store untouched and did not restore it (restore: ${JSON.stringify(restoreStep ?? null)})`);
    check(preRestores.length === 0, `no .pre-restore-* copy beside the store (${preRestores.join(", ") || "none"})`);
    check((await version()) === fromVersion, `the rollback reinstalled ${fromVersion}`);
    check((await snapshots()) === snaps0 + 1, "the failed update left exactly one snapshot");
    // T8-b: the tarball a later rollback or --offline update will use is the installer's kept copy
    const kept = join(stateDir, "plur1bus-installer", "artefacts", `${fromVersion}.tgz`);
    const recorded = safe(() => JSON.parse(readFileSync(join(stateDir, "memory", ".plur1bus-installer.json"), "utf8")).artefacts?.[fromVersion]?.file);
    const recordPath = (await inspectJson(oc, false)).json?.install?.sourcePath ?? null;
    fact("installer.keptArtefact", { kept, exists: existsSync(kept), recorded, openclawSourcePath: recordPath });
    check(existsSync(kept) && recorded === kept, `the installer keeps ${fromVersion} at plur1bus-installer/artefacts/${fromVersion}.tgz and records it in its state`);
    row("forced failing update", `exit 1, rollback ok, store untouched (not restored), digest equal, version ${fromVersion}`);
  }

  // 4. the real update, --offline (T8-b: the rollback copy of the start version is kept by the installer)
  const snaps1 = await snapshots();
  const u = await bootstrap(["--update", "--offline", toTgz, "--yes", "--json"]);
  check(u.code === 0 && u.doc?.ok === true, `install-plugin --update --offline <${toVersion}> --yes --json → exit 0 (got ${u.code}: ${JSON.stringify(u.doc?.steps?.filter((s) => s.status === "failed") ?? null)})`);
  check((await version()) === toVersion, `install record version ${toVersion}`);
  const newPath = (await inspectJson(oc, false)).json?.install?.installPath;
  const d1 = await storeDigest({ baseDbPath, pluginDir: newPath });
  check(d1.rows === d0.rows && d1.sha256 === d0.sha256, `digest after the update equals before (${d1.rows} rows)`);
  check((await snapshots()) === snaps1 + 1, "the update listed exactly one new snapshot");
  row(`update ${fromVersion} → ${toVersion}`, `exit 0 (--offline), digest equal, snapshots ${snaps1} → ${snaps1 + 1}`);

  // 5. the bootstrap hands the installer's --json stdout through byte for byte
  const ref = await direct(["--update", "--yes", "--json"]);
  check(ref.code === 0 && ref.doc?.ok === true, "direct installer --update (up to date) exits 0");
  const exes = o.bootstrap === "ps1" ? ["powershell.exe", "pwsh"] : ["sh"];
  for (const exe of exes) {
    const b = await bootstrap(["--update", "--yes", "--json"], {}, exe);
    const same = b.code === 0 && Buffer.compare(b.stdout, ref.stdout) === 0;
    fact(`bootstrap.jsonByteIdentical.${exe}`, { same, bootstrapBytes: b.stdout.length, directBytes: ref.stdout.length });
    check(same, `${exe} bootstrap --json stdout is byte-identical to the installer's (${b.stdout.length} vs ${ref.stdout.length} bytes)`);
  }
  row("--json byte-identical", exes.join(", "));

  // 6. win32: store-inside-harness-home with a differently cased path (compat.mjs inside(), win32 branch)
  if (WIN) {
    const home = join(process.env.RUNNER_TEMP, "Plur1bus Home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "manifest.json"), "{}\n");
    const lower = join(home, "store").toLowerCase().replaceAll("\\", "/");
    check((await oc.call(["config", "set", `${C}.baseDbPath`, lower])).code === 0, "config set baseDbPath inside the harness home (lower case)");
    const h = await direct(["--update", "--dry-run", "--yes", "--json"], { PLUR1BUS_HOME: home });
    const found = (h.doc?.findings ?? []).map((x) => x.id);
    fact("win32.insideHarnessHome", { exit: h.code, findings: found });
    check((await oc.call(["config", "set", `${C}.baseDbPath`, baseDbPath.replaceAll("\\", "/")])).code === 0, "config baseDbPath restored");
    rmSync(home, { recursive: true, force: true });
    check(h.code === 3 && found.includes("store-inside-harness-home"), `a lower-cased store path inside the harness home is refused with store-inside-harness-home, exit 3 (got ${h.code}, ${found.join(",")})`);
    row("win32 inside()", "store-inside-harness-home, exit 3");
  }

  // 7. uninstall keeps the store (OPENCLAW_DEBUG=1: a failing openclaw call prints its stack)
  const un = await bootstrap(["--uninstall", "--json"], { OPENCLAW_DEBUG: "1" });
  fact("installer.uninstall", { exit: un.code, uninstall: stepOf(un.doc, "uninstall") ?? null });
  if (un.code !== 0) {
    // what is left of the plugin, and OpenClaw's own full answer to a retry (it leaves the plugin "disabled and
    // tracked so uninstall can be retried" when removing the directory fails)
    const ins = await inspectJson(oc, false);
    const p = ins.json?.install?.installPath ?? newPath ?? "";
    const i = p.lastIndexOf(`${WIN ? "\\" : "/"}node_modules${WIN ? "\\" : "/"}`);
    fact("installer.uninstall.leftovers", { inspectExit: ins.code, installPath: p, status: ins.json?.plugin?.status ?? null, enabled: ins.json?.plugin?.enabled ?? null, tree: listTree(i > 0 ? p.slice(0, i) : p) });
    const again = await defaultRun(oc.bin, ["plugins", "uninstall", PLUGIN_ID, "--force"], { env: { ...env, OPENCLAW_DEBUG: "1" }, timeoutMs: 600_000 });
    process.stderr.write(`openclaw plugins uninstall (OPENCLAW_DEBUG=1) → exit ${again.code}\nstdout:\n${tail(again.stdout, 40)}\nstderr:\n${tail(again.stderr, 80)}\n`);
  }
  check(un.code === 0 && un.doc?.ok === true, `install-plugin --uninstall --json → exit 0 (got ${un.code}: ${stepOf(un.doc, "uninstall")?.detail ?? "no JSON document"})`);
  const d2 = await storeDigest({ baseDbPath });
  check(d2.rows === d0.rows && d2.sha256 === d0.sha256, "the store is still present after --uninstall (digest equal)");
  row("uninstall", "exit 0, store kept");

  const oc0 = String((await oc.call(["--version"], 60_000)).stdout).trim();
  summary([`### Installer path — ${process.platform}-${process.arch}, ${oc0}, ${o.bootstrap === "ps1" ? `install-plugin.ps1 (${psExe})` : "install-plugin.sh"}`, "", "| step | result |", "|---|---|", ...rows, ""].join("\n"));
}

// ─── WSL (windows-2025, non-blocking C8) ────────────────────────────────────
async function cmdWslSetup({ distro, "openclaw-version": ocVersion }) {
  if (!/^[0-9A-Za-z.-]+$/.test(ocVersion ?? "")) throw new Failed(`invalid --openclaw-version ${ocVersion}`);
  const repo = REPO.replaceAll("\\", "/");
  const script = [
    "set -eu",
    // No /D: links: curl refuses drive-letter file:// URLs whatever exists (run 36514170524); install-plugin.sh maps
    // file:///D:/... through wslpath under the test flag.
    `R=${LINUX_ROOT}`,
    'mkdir -p "$R/oc-home" "$R/oc-state"',
    'export HOME="$R/oc-home" OPENCLAW_HOME="$R/oc-home" OPENCLAW_STATE_DIR="$R/oc-state"',
    `curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix "$R/oc" --version ${ocVersion} --json`,
    'ln -sfn "$R/oc/bin/openclaw" /usr/local/bin/openclaw',
    `RUNNER_TEMP="$R" "$R/oc/tools/node/bin/node" "$(wslpath -a '${repo}')/tests/helpers/assert-disposable.mjs" --var HOME`,
    "openclaw --version",
  ].join("\n");
  const r = await runBytes("wsl.exe", ["-d", distro, "-u", "root", "-e", "bash", "-s"], { env: process.env, input: script, timeoutMs: 1_800_000 });
  process.stderr.write(`${tail(r.stderr, 40)}\n${tail(r.stdout.toString("utf8"), 20)}\n`);
  check(r.code === 0, `OpenClaw ${ocVersion} installed inside ${distro} under ${LINUX_ROOT}`);
}

function wslEnv(extra = {}) {
  const env = {
    ...process.env,
    PLUR1BUS_PLUGIN_INSTALLER_TEST: "1",
    OPENCLAW_HOME: `${LINUX_ROOT}/oc-home`,
    OPENCLAW_STATE_DIR: `${LINUX_ROOT}/oc-state`,
    HOME: `${LINUX_ROOT}/oc-home`,
    ...extra,
  };
  const share = ["PLUR1BUS_PLUGIN_INSTALLER_TEST/u", "PLUR1BUS_PLUGIN_PUBKEY/u", "OPENCLAW_HOME/u", "OPENCLAW_STATE_DIR/u", "HOME/u"];
  env.WSLENV = [...(process.env.WSLENV ?? "").split(":").filter(Boolean), ...share].join(":");
  return env;
}

async function cmdWslInstall({ distro, artefacts, "feed-dir": feedDirArg }) {
  const dir = resolve(artefacts);
  const pack = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8"));
  const feedDir = resolve(feedDirArg);
  const env = wslEnv({
    PLUR1BUS_PLUGIN_FEED: pathToFileURL(join(feedDir, "stable.json")).href,
    PLUR1BUS_PLUGIN_PUBKEY: readFileSync(join(feedDir, "pubkey.txt"), "utf8").trim(),
  });
  const args = ["-Target", `wsl:${distro}`, "--offline", join(dir, pack.tgz), "--non-interactive", "--json"];
  const r = await runBytes("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(dir, "install-plugin.ps1"), ...args], { env });
  process.stderr.write(`${tail(r.stderr, 80)}\n`);
  const doc = parseDoc(r.stdout);
  fact("wsl.install", { exit: r.code, ok: doc?.ok ?? null, steps: doc?.steps?.map((s) => `${s.id}:${s.status}`) ?? null, badFileUrl: /Bad file:\/\/ URL/.test(r.stderr) });
  summary(`### WSL install (${distro})\n\nexit ${r.code}; ${doc?.steps?.map((s) => `${s.id}:${s.status}`).join(" ") ?? "(no JSON document)"}\n`);
  check(r.code === 0 && doc?.ok === true, `install-plugin.ps1 -Target wsl:${distro} --offline <tgz> --non-interactive --json → exit 0`);
}

async function cmdWslSelftest({ distro }) {
  const t0 = Date.now();
  const r = await runBytes("wsl.exe", ["-d", distro, "-e", "sh", "-lc", "openclaw plur1bus selftest --json --download-models"], { env: wslEnv(), timeoutMs: 3_600_000 });
  const rep = lastJsonLine(r.stdout.toString("utf8"));
  fact("wsl.selftest", { exit: r.code, wallMs: Date.now() - t0, ok: rep?.ok ?? null, model: rep?.model ?? null, steps: rep?.steps ?? null, addons: rep?.addons ?? null, errors: rep?.errors ?? null });
  summary(`### WSL selftest (${distro})\n\nexit ${r.code}, ok ${rep?.ok}, ${Date.now() - t0} ms; ${(rep?.steps ?? []).map((s) => `${s.id} ${s.skipped ?? `${s.ms} ms`}`).join(", ")}\n`);
  if (rep?.ok !== true) say(`addons: ${JSON.stringify(rep?.addons ?? null)}\n${tail(r.stderr, 40)}`);
  check(r.code === 0 && rep?.ok === true, `wsl.exe -d ${distro} -e sh -lc 'openclaw plur1bus selftest --json --download-models' → ok true`);
}

// ─── main ───────────────────────────────────────────────────────────────────
const OPTIONS = {
  tgz: { type: "string" },
  "state-dir": { type: "string" },
  version: { type: "string" },
  "compare-tgz": { type: "string" },
  artefacts: { type: "string" },
  "feed-dir": { type: "string" },
  bootstrap: { type: "string", default: WIN ? "ps1" : "sh" },
  ps: { type: "string", default: "powershell" },
  from: { type: "string", default: "installer" },
  "from-tgz": { type: "string" },
  "skip-forced-failure": { type: "boolean", default: false },
  distro: { type: "string", default: "Ubuntu-24.04" },
  "openclaw-version": { type: "string" },
};

export async function main(argv) {
  const [sub, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: OPTIONS, strict: true });
  switch (sub) {
    case "env": return cmdEnv();
    case "facts": return cmdFacts();
    case "cmd-argv": return cmdArgv();
    case "raw": {
      const tgz = values.tgz ?? (values.artefacts ? join(resolve(values.artefacts), JSON.parse(readFileSync(join(resolve(values.artefacts), "pack.json"), "utf8")).tgz) : null);
      if (!tgz) throw new Failed("raw needs --tgz or --artefacts");
      return cmdRaw({ tgz, stateDir: values["state-dir"] });
    }
    case "clawhub": return cmdClawhub({ version: values.version, artefacts: values.artefacts, compareTgz: values["compare-tgz"], stateDir: values["state-dir"] });
    case "installer":
      if (!values.artefacts || !values["feed-dir"]) throw new Failed("installer needs --artefacts and --feed-dir");
      if (!["sh", "ps1"].includes(values.bootstrap) || !["installer", "raw"].includes(values.from)) throw new Failed("--bootstrap sh|ps1, --from installer|raw");
      return cmdInstaller(values);
    case "wsl-setup": return cmdWslSetup(values);
    case "wsl-install": return cmdWslInstall(values);
    case "wsl-selftest": return cmdWslSelftest(values);
    default: throw new Failed(`unknown subcommand ${JSON.stringify(sub)} (env|facts|cmd-argv|raw|clawhub|installer|wsl-setup|wsl-install|wsl-selftest)`);
  }
}

if (import.meta.filename && resolve(process.argv[1] ?? "") === import.meta.filename) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`ci-plugin-dist: FAILED: ${err?.message ?? err}\n`);
    summary(`**FAILED:** ${String(err?.message ?? err).replaceAll("|", "\\|")}\n`);
    process.exitCode = 1;
  }
}

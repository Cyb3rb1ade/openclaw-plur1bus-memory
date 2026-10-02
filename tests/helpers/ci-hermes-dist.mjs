#!/usr/bin/env node
/**
 * tests/helpers/ci-hermes-dist.mjs — the Hermes legs of .github/workflows/plugin-dist.yml (HM2 Task 11). CI ONLY: it
 * drives a disposable Hermes installed under $RUNNER_TEMP (HERMES_HOME, PLUR1BUS_HOME; HOME too on POSIX) and refuses
 * to run anywhere else (assert-disposable --host hermes). Every bootstrap run sets PLUR1BUS_PLUGIN_INSTALLER_TEST=1 and
 * PLUR1BUS_PLUGIN_TEST_NO_SERVICE=1, so `plur1bus setup` runs with --no-service and no service manager is touched.
 *
 *   install --artefacts <pack dir> --feed-dir <dir> --hermes-bin <path> [--bootstrap sh|ps1]
 *       memory.provider before → bootstrap `--host hermes --non-interactive --json` → exit 0, ok
 *       → `hermes memory status` names plur1bus → `hermes plur1bus selftest --json` → ok
 *       → the bootstrap again → `up-to-date` → `--uninstall --json` → exit 0, memory.provider back to the value before,
 *       the PLUR1BUS home (and its store, when there was one) still present
 *   wsl-setup --distro d --hermes-commit <sha>      Hermes inside WSL under /tmp/plur1bus-ci-hermes (C8)
 *   wsl-install --distro d --artefacts d --feed-dir f   install-plugin.ps1 -Host hermes -Target wsl:<d> → exit 0
 *   wsl-selftest --distro d                         `hermes plur1bus selftest --json` inside the distro → ok
 *
 * Prints `FACT <name>: <json>` lines and a step summary; exits 1 on the first failed check.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { assertDisposable } from "./assert-disposable.mjs";

const WIN = process.platform === "win32";
const LINUX_ROOT = "/tmp/plur1bus-ci-hermes";

class Failed extends Error {}
const say = (m) => process.stderr.write(`ci-hermes-dist: ${m}\n`);
const fact = (name, v) => process.stdout.write(`FACT ${name}: ${JSON.stringify(v)}\n`);
const summary = (text) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
};
function check(cond, msg) {
  if (!cond) throw new Failed(msg);
  say(`ok: ${msg}`);
}
const tail = (s, n = 30) => String(s ?? "").split(/\r?\n/).slice(-n).join("\n");

/** The last JSON document in `text` (the installer prints exactly one with --json). */
export function lastJson(text) {
  const t = String(text ?? "").trim();
  try {
    return JSON.parse(t);
  } catch {
    // fall through: a JSON line among other output
  }
  for (const line of t.split(/\r?\n/).reverse()) {
    const l = line.trim();
    if (!l.startsWith("{") && !l.startsWith('"')) continue;
    try {
      return JSON.parse(l);
    } catch {
      // keep looking
    }
  }
  return undefined;
}

function run(file, args, { env = process.env, input, timeoutMs = 1_800_000 } = {}) {
  const r = spawnSync(file, args, { env, input, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 << 20, shell: false });
  return { code: r.status, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${r.error ? `\n[spawn: ${r.error.message}]` : ""}` };
}

/** The environment every bootstrap run gets (test seams only; the feed is the CI-signed file:// one). */
export function bootstrapEnv(base, feedDir) {
  return {
    ...base,
    PLUR1BUS_PLUGIN_INSTALLER_TEST: "1",
    PLUR1BUS_PLUGIN_TEST_NO_SERVICE: "1",
    PLUR1BUS_PLUGIN_FEED: pathToFileURL(join(feedDir, "stable.json")).href,
    PLUR1BUS_PLUGIN_PUBKEY: readFileSync(join(feedDir, "pubkey.txt"), "utf8").trim(),
  };
}

function hermesCall(bin, args, env) {
  // a hermes.cmd launcher needs cmd.exe; hermes.exe and POSIX launchers run directly
  if (WIN && /\.cmd$/i.test(bin)) return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${bin}" ${args.join(" ")}`], { env });
  return run(bin, args, { env });
}

function providerValue(bin, env) {
  const r = hermesCall(bin, ["config", "get", "memory.provider", "--json"], env);
  const v = lastJson(r.stdout);
  return r.code === 0 && typeof v === "string" ? v : null;
}

function bootstrap(kind, artefacts, args, env) {
  if (kind === "ps1") {
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(artefacts, "install-plugin.ps1"), "-Host", "hermes", ...args], { env });
  }
  return run("sh", [join(artefacts, "install-plugin.sh"), "--host", "hermes", ...args], { env, input: "" });
}

async function cmdInstall({ artefacts, "feed-dir": feedDirArg, "hermes-bin": hermesBin, bootstrap: kind }) {
  if (!artefacts || !feedDirArg || !hermesBin) throw new Failed("install needs --artefacts, --feed-dir and --hermes-bin");
  const dis = assertDisposable({ host: "hermes", vars: WIN ? [] : ["HOME"] });
  check(dis.ok, `Hermes is disposable here (${dis.errors.join("; ") || JSON.stringify(dis.checked)})`);
  const dir = resolve(artefacts);
  const env = bootstrapEnv(process.env, resolve(feedDirArg));
  const before = providerValue(hermesBin, env);
  check(before !== null, `hermes config get memory.provider reads ${JSON.stringify(before)} before the install`);

  const first = bootstrap(kind, dir, ["--non-interactive", "--json"], env);
  const doc = lastJson(first.stdout);
  fact("hermes.install", { exit: first.code, ok: doc?.ok ?? null, agentId: doc?.agentId ?? null, steps: doc?.steps?.map((s) => `${s.id}:${s.status}`) ?? null });
  summary(`### Hermes install (${kind})\n\nexit ${first.code}; ${doc?.steps?.map((s) => `${s.id}:${s.status}`).join(" ") ?? "(no JSON document)"}\n`);
  if (first.code !== 0) say(tail(first.stderr, 60));
  check(first.code === 0 && doc?.ok === true && doc?.host === "hermes", "bootstrap --host hermes --non-interactive --json → exit 0, ok, host hermes");

  const ms = hermesCall(hermesBin, ["memory", "status"], env);
  fact("hermes.memoryStatus", { exit: ms.code, provider: /Provider:\s+(\S+)/.exec(ms.stdout)?.[1] ?? null });
  check(/^\s*Provider:\s+plur1bus\b/m.test(ms.stdout), "hermes memory status names plur1bus");

  const st = hermesCall(hermesBin, ["plur1bus", "selftest", "--json"], env);
  const self = lastJson(st.stdout);
  fact("hermes.selftest", { exit: st.code, ok: self?.ok ?? null, checks: self?.checks ?? null });
  if (self?.ok !== true) say(tail(st.stderr, 40));
  check(st.code === 0 && self?.ok === true, "hermes plur1bus selftest --json → ok");

  const again = bootstrap(kind, dir, ["--non-interactive", "--json"], env);
  const doc2 = lastJson(again.stdout);
  fact("hermes.reinstall", { exit: again.code, mode: doc2?.mode ?? null, steps: doc2?.steps?.map((s) => `${s.id}:${s.status}`) ?? null });
  check(again.code === 0 && /up-to-date/.test(`${again.stdout}\n${again.stderr}`), "the bootstrap again → up-to-date");

  const home = process.env.PLUR1BUS_HOME;
  const storeBefore = existsSync(join(home, "state", "lancedb"));
  const un = bootstrap(kind, dir, ["--uninstall", "--non-interactive", "--json"], env);
  const doc3 = lastJson(un.stdout);
  fact("hermes.uninstall", { exit: un.code, journal: doc3?.journal ?? null, steps: doc3?.steps?.map((s) => `${s.id}:${s.status}`) ?? null });
  if (un.code !== 0) say(tail(un.stderr, 40));
  check(un.code === 0 && doc3?.ok === true, "--uninstall --json → exit 0");
  const after = providerValue(hermesBin, env);
  check(after === before, `memory.provider is back to ${JSON.stringify(before)} (reads ${JSON.stringify(after)})`);
  check(existsSync(join(home, "manifest.json")), `the PLUR1BUS home ${home} is kept`);
  if (storeBefore) check(existsSync(join(home, "state", "lancedb")), "the store is kept");
  summary(`memory.provider ${JSON.stringify(before)} → plur1bus → ${JSON.stringify(after)}; store ${storeBefore ? "kept" : "(none created)"}\n`);
}

function wslEnv(extra = {}) {
  const env = {
    ...process.env,
    PLUR1BUS_PLUGIN_INSTALLER_TEST: "1",
    PLUR1BUS_PLUGIN_TEST_NO_SERVICE: "1",
    HOME: `${LINUX_ROOT}/home`,
    HERMES_HOME: `${LINUX_ROOT}/hh`,
    PLUR1BUS_HOME: `${LINUX_ROOT}/p1b`,
    PLUR1BUS_ALLOW_TEST_INTERNALS: "1",
    PLUR1BUS_TEST_INTERNALS: "flat-embedder",
    ...extra,
  };
  const share = ["PLUR1BUS_PLUGIN_INSTALLER_TEST/u", "PLUR1BUS_PLUGIN_TEST_NO_SERVICE/u", "PLUR1BUS_PLUGIN_PUBKEY/u", "HOME/u", "HERMES_HOME/u", "PLUR1BUS_HOME/u", "PLUR1BUS_ALLOW_TEST_INTERNALS/u", "PLUR1BUS_TEST_INTERNALS/u"];
  env.WSLENV = [...(process.env.WSLENV ?? "").split(":").filter(Boolean), ...share].join(":");
  return env;
}

async function cmdWslSetup({ distro, "hermes-commit": commit }) {
  if (!/^[0-9a-f]{40}$/.test(String(commit))) throw new Failed("wsl-setup needs --hermes-commit <40-hex sha>");
  const script = [
    "set -eu",
    `R=${LINUX_ROOT}`,
    'mkdir -p "$R/home" "$R/hh" "$R/p1b" "$R/src"',
    'export HOME="$R/home" HERMES_HOME="$R/hh" PLUR1BUS_HOME="$R/p1b"',
    'git -C "$R/src" init -q',
    `for i in 1 2 3 4 5; do git -C "$R/src" fetch -q --depth 1 https://github.com/NousResearch/hermes-agent ${commit} && break; [ "$i" = 5 ] && exit 1; sleep 10; done`,
    `git -C "$R/src" show ${commit}:scripts/install.sh > "$R/hermes-install.sh"`,
    `bash "$R/hermes-install.sh" --branch main --commit ${commit} --force-commit --dir "$R/hermes-agent" --hermes-home "$R/hh" --skip-setup --non-interactive --skip-browser --skip-computer-use --no-skills < /dev/null`,
    'ln -sfn "$R/hermes-agent/venv/bin/hermes" /usr/local/bin/hermes',
    "hermes --version",
  ].join("\n");
  const r = run("wsl.exe", ["-d", distro, "-u", "root", "-e", "bash", "-s"], { env: process.env, input: script });
  process.stderr.write(`${tail(r.stderr, 40)}\n${tail(r.stdout, 20)}\n`);
  check(r.code === 0, `Hermes ${commit.slice(0, 7)} installed inside ${distro} under ${LINUX_ROOT}`);
}

async function cmdWslInstall({ distro, artefacts, "feed-dir": feedDirArg }) {
  const dir = resolve(artefacts);
  const feedDir = resolve(feedDirArg);
  const env = wslEnv({
    PLUR1BUS_PLUGIN_FEED: pathToFileURL(join(feedDir, "stable.json")).href,
    PLUR1BUS_PLUGIN_PUBKEY: readFileSync(join(feedDir, "pubkey.txt"), "utf8").trim(),
  });
  const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(dir, "install-plugin.ps1"), "-Host", "hermes", "-Target", `wsl:${distro}`, "--non-interactive", "--json"], { env });
  process.stderr.write(`${tail(r.stderr, 80)}\n`);
  const doc = lastJson(r.stdout);
  fact("hermes.wsl.install", { exit: r.code, ok: doc?.ok ?? null, steps: doc?.steps?.map((s) => `${s.id}:${s.status}`) ?? null });
  summary(`### Hermes WSL install (${distro})\n\nexit ${r.code}; ${doc?.steps?.map((s) => `${s.id}:${s.status}`).join(" ") ?? "(no JSON document)"}\n`);
  check(r.code === 0 && doc?.ok === true, `install-plugin.ps1 -Host hermes -Target wsl:${distro} --non-interactive --json → exit 0`);
}

async function cmdWslSelftest({ distro }) {
  const r = run("wsl.exe", ["-d", distro, "-e", "sh", "-lc", "hermes plur1bus selftest --json"], { env: wslEnv() });
  const rep = lastJson(r.stdout);
  fact("hermes.wsl.selftest", { exit: r.code, ok: rep?.ok ?? null, checks: rep?.checks ?? null });
  if (rep?.ok !== true) say(tail(r.stderr, 40));
  check(r.code === 0 && rep?.ok === true, `wsl.exe -d ${distro} -e sh -lc 'hermes plur1bus selftest --json' → ok`);
}

const OPTIONS = {
  artefacts: { type: "string" },
  "feed-dir": { type: "string" },
  "hermes-bin": { type: "string" },
  bootstrap: { type: "string", default: WIN ? "ps1" : "sh" },
  distro: { type: "string", default: "Ubuntu-24.04" },
  "hermes-commit": { type: "string" },
};

export async function main(argv) {
  const [sub, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: OPTIONS, strict: true });
  if (!["sh", "ps1"].includes(values.bootstrap)) throw new Failed(`unknown --bootstrap ${values.bootstrap} (sh|ps1)`);
  switch (sub) {
    case "install": return cmdInstall(values);
    case "wsl-setup": return cmdWslSetup(values);
    case "wsl-install": return cmdWslInstall(values);
    case "wsl-selftest": return cmdWslSelftest(values);
    default: throw new Failed(`unknown subcommand ${JSON.stringify(sub)} (install|wsl-setup|wsl-install|wsl-selftest)`);
  }
}

if (import.meta.filename && resolve(process.argv[1] ?? "") === import.meta.filename) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`ci-hermes-dist: ${err instanceof Failed ? "FAILED: " : ""}${err?.message ?? err}\n`);
    process.exitCode = 1;
  }
}


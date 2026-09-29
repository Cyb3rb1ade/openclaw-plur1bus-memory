/**
 * scripts/dist/installer/main.mjs — PLUR1BUS plugin installer for OpenClaw (D87, spec A.3).
 *
 * Order: feed (signature verified unless the bootstrap already did) → detect →
 * compatibility (every fatal finding printed together, exit 3) → existing
 * install (tracked → the update path; untracked → exit 2 `legacy-deploy`) →
 * install (`clawhub:<pkg>@<v>` when the feed carries its ClawPack digest,
 * `npm:<pkg>@<v> --pin`, or `npm-pack:<tgz> --force --accept-capabilities` for
 * --offline or the feed's own tarball, after its SHA-256 matched the feed, T5-a) → licence
 * config (HM1-R10) and `hooks.allowConversationAccess` (R-S1) →
 * `plugins.slots.memory` (R-S5) → enable if recorded disabled → feature crons
 * (HM1-R7) → verify (A.4) → on any failure `plugins uninstall --force`, restore
 * previous config values and the previous slot, exit 1 (4 if that fails; T5-c).
 *
 * Modes (HM1 Task 6): a tracked install, or `--update`, goes to ./update.mjs (snapshot,
 * exact-version reinstall, verify, automatic rollback); `--uninstall [--purge]` to
 * ./uninstall.mjs; `--adopt-legacy` to ./legacy.mjs (HM1-R9). Before any mode, an
 * installer state file with `inProgress` (a run that was killed or lost its network)
 * is reported and continued, or with `--rollback` undone (Review Focus 5).
 *
 * OpenClaw is only ever driven through ./openclaw-cli.mjs; nothing here opens
 * openclaw.json or prints a config value outside the allow-list.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { verifyMinisign } from "../minisign.mjs";
import { validateFeed, PACKAGE_NAME } from "../build-plugin-feed.mjs";
import { checkCompat, currentGlibcVersion, findHarnessHomes, resolveBaseDbPath, resolveTarget } from "./compat.mjs";
import { detectOpenclaw } from "./detect.mjs";
import { PROFILE_MODELS, resolveLicence } from "./licence.mjs";
import { createOpenclawCli, defaultRun, isReadonlyRefusal, PLUGIN_ID, tail } from "./openclaw-cli.mjs";
import { createReport, EXIT, Stop } from "./report.mjs";
import { readState, writeState } from "./state.mjs";
import { verifyInstall } from "./verify.mjs";
import { fetchBytes, runUpdate } from "./update.mjs";
import { runUninstall } from "./uninstall.mjs";
import { runAdoptLegacy } from "./legacy.mjs";
import { READONLY_REMEDY, INVALID_CONFIG_REMEDY } from "./compat.mjs";

export const DEFAULT_FEED_URL = "https://updates.plur1bus.app/plugin/stable.json";
/** Rendered at release time from the plugin repo variables (HM1-R3, Task 10); placeholders refuse. */
export const CHANNEL_PUBLIC_KEYS = Object.freeze({
  stable: "@@PLUR1BUS_PLUGIN_PUBKEY_STABLE@@",
  beta: "@@PLUR1BUS_PLUGIN_PUBKEY_BETA@@",
});

const C = `plugins.entries.${PLUGIN_ID}.config`;
const SLOT = "plugins.slots.memory";
const ALLOW_CONVERSATION = `plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess`;

export const USAGE = `Usage: node plur1bus-plugin-installer.mjs [options]

Installs the PLUR1BUS memory plugin into OpenClaw (plugin id ${PLUGIN_ID}).

  --host openclaw|hermes     host to install into (default openclaw; hermes arrives with HM2)
  --version <v>              plugin version (default: the feed's latest)
  --source clawhub|npm       install source (default: clawhub when the feed carries its ClawPack digest,
                             else the feed's GitHub-Release tarball, verified by SHA-256)
  --offline <tgz>            install a local tarball after its SHA-256 matched the feed
  --feed <url>               signed plugin feed (default ${DEFAULT_FEED_URL})
  --feed-file <path>         feed already verified by the bootstrap
  --accept-nc-licence        accept CC BY-NC 4.0 for Jina v5 Text Nano (also PLUR1BUS_ACCEPT_NONCOMMERCIAL_LICENSE=1)
  --non-interactive          never prompt (licence defaults to E5-small)
  --download-models          let the selftest download the embedding model
  --update                   update a tracked install (store snapshot first, automatic rollback)
  --uninstall [--purge]      uninstall; --purge also deletes the store, the snapshots and the
                             model cache (two confirmations, or --yes-delete-memories)
  --adopt-legacy             adopt a deploy OpenClaw does not track (rsync install)
  --rollback                 undo an interrupted update or adoption instead of finishing it
  --yes                      assume yes where a confirmation is optional (update: Now)
  --dry-run                  check and print the plan, change nothing
  --json                     one plur1bus.plugin-installer/1 document on stdout
  --state-dir <dir>          OpenClaw state dir (sets OPENCLAW_STATE_DIR for OpenClaw)
  --profile <name>           OpenClaw profile (sets OPENCLAW_PROFILE for OpenClaw)
  --lang de|en               release-notes language (default from LANG, else en)
  -h, --help                 this help

Exit codes: 0 ok, 1 failed (rolled back or nothing changed), 2 needs a choice,
3 incompatible host or environment, 4 verification failed and rollback failed.
`;

const OPTIONS = {
  host: { type: "string", default: "openclaw" },
  version: { type: "string" },
  source: { type: "string" },
  offline: { type: "string" },
  feed: { type: "string" },
  "feed-file": { type: "string" },
  "accept-nc-licence": { type: "boolean", default: false },
  "non-interactive": { type: "boolean", default: false },
  "download-models": { type: "boolean", default: false },
  update: { type: "boolean", default: false },
  uninstall: { type: "boolean", default: false },
  purge: { type: "boolean", default: false },
  "yes-delete-memories": { type: "boolean", default: false },
  "adopt-legacy": { type: "boolean", default: false },
  rollback: { type: "boolean", default: false },
  yes: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  "state-dir": { type: "string" },
  profile: { type: "string" },
  lang: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function channelOf(url) {
  return /(^|\/)beta\.json(\?.*)?$/.test(url) ? "beta" : "stable";
}

async function readUrl(url, { testMode, fetchImpl }) {
  if (url.startsWith("file://")) {
    if (!testMode) throw new Stop(EXIT.FAILED, "feed", `feed URL must be https:// (file:// only with PLUR1BUS_PLUGIN_INSTALLER_TEST=1): ${url}`);
    return readFileSync(fileURLToPath(url));
  }
  if (!url.startsWith("https://")) throw new Stop(EXIT.FAILED, "feed", `feed URL must be https://: ${url}`);
  if (typeof fetchImpl !== "function") throw new Stop(EXIT.FAILED, "feed", "no fetch available to download the feed");
  let res;
  try {
    res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw new Stop(EXIT.FAILED, "feed", `download failed: ${url}: ${err?.message ?? err}`);
  }
  if (!res.ok) throw new Stop(EXIT.FAILED, "feed", `download failed: ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Load and validate the feed, verify its minisign signature (unless handed over
 * by the bootstrap as --feed-file), and pick the release.
 */
async function loadFeed({ values, env, testMode, fetchImpl }) {
  let bytes;
  let origin;
  if (values["feed-file"]) {
    origin = values["feed-file"];
    try {
      bytes = readFileSync(values["feed-file"]);
    } catch (err) {
      throw new Stop(EXIT.FAILED, "feed", `cannot read --feed-file ${values["feed-file"]}: ${err.code ?? err.message}`);
    }
  } else {
    const url = values.feed ?? (testMode && env.PLUR1BUS_PLUGIN_FEED ? env.PLUR1BUS_PLUGIN_FEED : DEFAULT_FEED_URL);
    origin = url;
    bytes = await readUrl(url, { testMode, fetchImpl });
    const sig = (await readUrl(`${url}.minisig`, { testMode, fetchImpl })).toString("utf8");
    const channel = channelOf(url);
    const key = testMode && env.PLUR1BUS_PLUGIN_PUBKEY ? env.PLUR1BUS_PLUGIN_PUBKEY : CHANNEL_PUBLIC_KEYS[channel];
    if (!key || key.startsWith("@@")) throw new Stop(EXIT.FAILED, "feed", "this installer build carries no feed public key; run it through install-plugin.sh/.ps1 (which verify the feed) or a released bundle");
    const v = verifyMinisign({ message: bytes, signatureText: sig, publicKey: key });
    if (!v.ok) throw new Stop(EXIT.FAILED, "feed", `feed signature check failed (${v.reason}): ${url}`);
  }
  let feed;
  try {
    feed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Stop(EXIT.FAILED, "feed", `feed is not JSON: ${origin}`);
  }
  const valid = validateFeed(feed, { allowFile: testMode });
  if (!valid.ok) throw new Stop(EXIT.FAILED, "feed", `feed is invalid: ${valid.errors.slice(0, 3).join("; ")}`);
  if (!values["feed-file"] && feed.channel !== channelOf(origin)) throw new Stop(EXIT.FAILED, "feed", `feed channel ${feed.channel} does not match ${origin}`);
  const version = values.version ?? feed.hosts.openclaw.latest;
  const release = feed.hosts.openclaw.releases.find((r) => r.version === version);
  if (!release) throw new Stop(EXIT.FAILED, "feed", `version ${version} is not in the ${feed.channel} feed`);
  return { feed, release };
}

function freeBytesAt(dir, statfs) {
  let d = resolve(dir);
  for (;;) {
    try {
      if (existsSync(d)) {
        const s = statfs(d);
        return Number(s.bavail) * Number(s.bsize);
      }
    } catch {
      return null;
    }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

function defaultPrompt(stderr) {
  return async (question) => {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: stderr });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string,string|undefined>, platform?: string, arch?: string, glibcVersion?: string|null, run?: typeof defaultRun,
 *   fetchImpl?: typeof fetch, prompt?: (q: string) => Promise<string>, isTTY?: boolean, stdout?: {write(s:string):unknown}, stderr?: {write(s:string):unknown},
 *   statfs?: (p: string) => {bavail: number|bigint, bsize: number|bigint}, now?: () => number }} [opts]
 * @returns {Promise<number>} exit code
 */
export async function runInstaller(argv, opts = {}) {
  const {
    env = process.env,
    platform = process.platform,
    arch = process.arch,
    run = defaultRun,
    fetchImpl = globalThis.fetch,
    stdout = process.stdout,
    stderr = process.stderr,
    statfs = statfsSync,
    now = Date.now,
  } = opts;
  const glibcVersion = opts.glibcVersion === undefined ? (platform === process.platform ? currentGlibcVersion() : null) : opts.glibcVersion;
  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);

  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (err) {
    const report = createReport({ json: argv.includes("--json"), stdout, stderr });
    report.step("args", "failed", `${err.message} (see --help)`);
    return report.finish(EXIT.FAILED);
  }
  if (values.help) {
    stdout.write(USAGE);
    return EXIT.OK;
  }

  const report = createReport({ json: values.json, stdout, stderr });
  const mode = values.uninstall ? "uninstall" : values["adopt-legacy"] ? "adopt-legacy" : values.update ? "update" : "install";
  report.set("host", values.host);
  report.set("mode", mode);

  try {
    return await install({ values, mode, report, env, platform, arch, glibcVersion, run, fetchImpl, isTTY, prompt: opts.prompt ?? defaultPrompt(stderr), statfs, now });
  } catch (err) {
    if (err instanceof Stop) {
      report.step(err.id, "failed", err.message);
      return report.finish(err.code);
    }
    report.step("installer", "failed", `unexpected error: ${err?.message ?? err}`);
    return report.finish(EXIT.FAILED);
  }
}

async function install(ctx) {
  const { values, mode, report, env, platform, arch, glibcVersion, run, fetchImpl, isTTY, prompt, statfs, now } = ctx;

  // ── host and flags ────────────────────────────────────────────────────────
  if (values.host === "hermes") throw new Stop(EXIT.INCOMPATIBLE, "host", "host-not-yet-supported: Hermes host mode arrives with HM2; nothing was changed");
  if (values.host !== "openclaw") throw new Stop(EXIT.FAILED, "args", `unknown --host ${JSON.stringify(values.host)} (openclaw|hermes)`);
  if (values.source !== undefined && !["clawhub", "npm"].includes(values.source)) throw new Stop(EXIT.FAILED, "args", `unknown --source ${JSON.stringify(values.source)} (clawhub|npm)`);
  const lang = values.lang ?? (/^de([_.-]|$)/i.test(env.LC_ALL || env.LC_MESSAGES || env.LANG || "") ? "de" : "en");
  if (!["de", "en"].includes(lang)) throw new Stop(EXIT.FAILED, "args", `unknown --lang ${JSON.stringify(values.lang)} (de|en)`);
  if (values.feed && values["feed-file"]) throw new Stop(EXIT.FAILED, "args", "--feed and --feed-file are exclusive");
  if ([values.update, values.uninstall, values["adopt-legacy"]].filter(Boolean).length > 1) throw new Stop(EXIT.FAILED, "args", "--update, --uninstall and --adopt-legacy are exclusive");
  if (values.purge && !values.uninstall) throw new Stop(EXIT.FAILED, "args", "--purge only applies together with --uninstall");
  const testMode = env.PLUR1BUS_PLUGIN_INSTALLER_TEST === "1";

  const childEnv = { ...env };
  if (values["state-dir"]) childEnv.OPENCLAW_STATE_DIR = resolve(values["state-dir"]);
  if (values.profile) childEnv.OPENCLAW_PROFILE = values.profile;

  // ── feed (not needed to uninstall) ────────────────────────────────────────
  let feed = null;
  let release = null;
  const needFeed = async () => {
    ({ feed, release } = await loadFeed({ values, env, testMode, fetchImpl }));
    report.set("pluginVersion", release.version);
    report.step("feed", "ok", `${feed.channel} feed, plugin ${release.version}${values["feed-file"] ? " (verified by the bootstrap)" : " (signature verified)"}`);
  };
  if (mode !== "uninstall") await needFeed();

  // Source (ruling T5-a): the verifiable path wins. Explicit --source is honoured; an explicit
  // ClawHub source without a ClawPack digest in the feed cannot be verified and refuses before
  // any change. Without --source: ClawHub when the digest is present, else the feed's tarball.
  if (release && values.source === "clawhub" && !values.offline && !release.clawpackDigest) {
    throw new Stop(EXIT.INCOMPATIBLE, "source", `clawpack-digest-missing: the feed carries no clawpackDigest for ${release.version}, so a ClawHub install cannot be verified; omit --source (the verified GitHub-Release tarball is used) or pass --source npm; nothing was changed`);
  }
  const source = values.offline ? "offline" : values.source ?? (release?.clawpackDigest ? "clawhub" : "tarball");
  if (release) report.set("source", source);

  // ── detect ────────────────────────────────────────────────────────────────
  const det = await detectOpenclaw({ env: childEnv, platform, run });
  if (!det) throw new Stop(EXIT.INCOMPATIBLE, "detect", "openclaw was not found on PATH; install OpenClaw first (https://docs.openclaw.ai/install)");
  report.set("stateDir", det.stateDir);
  report.set("openclaw", { version: det.version });
  report.set("node", { version: det.node.version });
  report.step("detect", "ok", `OpenClaw ${det.version ?? "(unknown version)"} at ${det.bin}, node ${det.node.version ?? "(not found)"}, state ${det.stateDir}${det.profile ? ` (profile ${det.profile})` : ""}${det.legacy ? " (legacy .clawdbot)" : ""}`);
  if (platform === "win32" && feed?.hosts.openclaw.windowsNativeBeta) report.note("Windows native support is in beta.");
  const cli = createOpenclawCli({ bin: det.bin, env: childEnv, run });

  // ── compatibility (reads only) ────────────────────────────────────────────
  const readonlyConfig = childEnv.OPENCLAW_NIX_MODE === "1" ? "OPENCLAW_NIX_MODE" : childEnv.OPENCLAW_CONFIG_READONLY === "1" ? "OPENCLAW_CONFIG_READONLY" : null;
  const validation = await cli.configValidate();
  let configuredBase = null;
  if (validation.ok) {
    try {
      const g = await cli.configGet(`${C}.baseDbPath`);
      configuredBase = g.set ? g.value : null;
    } catch {
      configuredBase = null;
    }
  }
  const baseDbPath = resolveBaseDbPath({ configured: configuredBase, env: childEnv, platform });
  const harnessHomes = findHarnessHomes({ env: childEnv, platform });
  const target = resolveTarget({ platform, arch, glibcVersion });
  report.set("target", target.target);
  // test seam (PLUR1BUS_PLUGIN_INSTALLER_TEST=1 only): a fixed free-space figure for subprocess tests
  const seamFree = testMode && env.PLUR1BUS_PLUGIN_TEST_FREE_BYTES !== undefined ? Number(env.PLUR1BUS_PLUGIN_TEST_FREE_BYTES) : NaN;
  if (testMode && env.PLUR1BUS_PLUGIN_TEST_FREE_BYTES !== undefined && !(Number.isFinite(seamFree) && seamFree >= 0)) {
    throw new Stop(EXIT.FAILED, "args", `PLUR1BUS_PLUGIN_TEST_FREE_BYTES must be a non-negative number of bytes, got ${JSON.stringify(env.PLUR1BUS_PLUGIN_TEST_FREE_BYTES)}`);
  }
  if (mode === "uninstall" && !release) {
    // uninstalling needs neither the feed nor disk space, only a writable, valid config
    const cfg = [
      ...(readonlyConfig ? [{ id: "config-readonly", fatal: true, detail: READONLY_REMEDY[readonlyConfig] }] : []),
      ...(validation.ok ? [] : [{ id: "config-invalid", fatal: true, detail: INVALID_CONFIG_REMEDY }]),
    ];
    report.set("findings", cfg);
    if (cfg.length) {
      for (const f of cfg) report.note(`  ${f.id}: ${f.detail}`);
      throw new Stop(EXIT.INCOMPATIBLE, "compat", `${cfg.map((f) => f.id).join(", ")}; nothing was changed`);
    }
    report.step("compat", "ok", "config valid and writable");
  }
  const findings = release === null ? [] : checkCompat({
    openclawVersion: det.version,
    nodeVersion: det.node.version,
    target,
    release,
    // test seam (PLUR1BUS_PLUGIN_INSTALLER_TEST=1 only): a fixed free-space figure for subprocess tests
    freeBytes: Number.isFinite(seamFree) ? seamFree : freeBytesAt(det.stateDir, statfs),
    readonlyConfig,
    configValid: validation.ok,
    baseDbPath,
    harnessHomes,
    platform,
  });
  if (release) report.set("findings", findings);
  const fatal = findings.filter((f) => f.fatal);
  if (fatal.length > 0) {
    for (const f of fatal) report.note(`  ${f.id}: ${f.detail}`);
    throw new Stop(EXIT.INCOMPATIBLE, "compat", `${fatal.length} incompatibilit${fatal.length === 1 ? "y" : "ies"} (${fatal.map((f) => f.id).join(", ")}); nothing was changed`);
  }
  if (release) report.step("compat", "ok", `${target.target}, OpenClaw ≥ ${release.compat.minGatewayVersion}, node ${release.node}, config valid`);
  for (const h of harnessHomes) report.note(`Notice: a PLUR1BUS harness home exists at ${h}; OpenClaw host mode and the harness keep separate memories.`);

  // ── offline tarball against the feed ──────────────────────────────────────
  let tgz = null;
  if (values.offline && release) {
    tgz = isAbsolute(values.offline) ? values.offline : resolve(values.offline);
    let digest;
    try {
      digest = sha256(readFileSync(tgz));
    } catch (err) {
      throw new Stop(EXIT.FAILED, "offline", `cannot read ${tgz}: ${err.code ?? err.message}`);
    }
    if (digest !== release.tarball.sha256) throw new Stop(EXIT.FAILED, "offline", `SHA-256 of ${tgz} (${digest.slice(0, 12)}…) does not match the feed (${release.tarball.sha256.slice(0, 12)}…); nothing was changed`);
    report.step("offline", "ok", `tarball SHA-256 matches the feed`);
  }

  // ── an interrupted run first (Review Focus 5) ─────────────────────────────
  let state;
  try {
    state = readState(det.stateDir);
  } catch (err) {
    throw new Stop(EXIT.FAILED, "state", `${err.message}; check the file and move it aside to continue; nothing was changed`);
  }
  const shared = { ...ctx, cli, det, stateDir: det.stateDir, baseDbPath, feed, release, flags: values, state, childEnv, testMode, tgz, lang, source };
  const interrupted = state?.inProgress ?? null;
  if (values.rollback && !interrupted) throw new Stop(EXIT.FAILED, "rollback", "nothing to roll back: no interrupted installer run was found; nothing was changed");
  if (interrupted) {
    const label = describeInterrupted(interrupted);
    if (values["dry-run"]) {
      // T6-d: a dry run never resumes; it says what a real run would do
      report.set("interrupted", { op: interrupted.op, step: interrupted.step });
      report.step("resume", "planned", `${label}: re-running without --dry-run would ${resumePlan(interrupted).continue}; with --rollback it would ${resumePlan(interrupted).rollback}`);
      return report.finish(EXIT.OK);
    }
    if (interrupted.op === "uninstall" && !(mode === "uninstall" && (!interrupted.purge || values.purge))) {
      // T6-d: a destructive step never continues in another mode
      report.set("interrupted", { op: interrupted.op, step: interrupted.step });
      throw new Stop(EXIT.NEEDS_CHOICE, "resume", `${label}; this run (${modeLabel(mode, values)}) does not continue it: re-run with --uninstall${interrupted.purge ? " --purge (the purge asks for its confirmation again)" : ""} to finish it; nothing was changed`);
    }
    const compatible = { install: ["install", "update"], update: ["install", "update"], adopt: ["install", "adopt-legacy"], uninstall: ["uninstall"] }[interrupted.op] ?? [];
    if (!compatible.includes(mode)) report.note(`Note: ${modeLabel(mode, values)} is not run now: the ${label} is handled first; re-run ${modeLabel(mode, values)} afterwards.`);
    if (interrupted.op === "install") {
      const code = await resumeInstall(shared, interrupted);
      if (code !== undefined) return code;
      state = readState(det.stateDir);
      shared.state = state;
    } else {
      if (!feed && interrupted.op !== "uninstall") await needFeed();
      const resumeRelease = interrupted.targetVersion ? (feed?.hosts.openclaw.releases.find((r) => r.version === interrupted.targetVersion) ?? null) : release;
      const rctx = { ...shared, feed, release: resumeRelease, resume: interrupted };
      if (interrupted.op === "update") return runUpdate(rctx);
      if (interrupted.op === "adopt") return runAdoptLegacy(rctx);
      if (interrupted.op === "uninstall") return runUninstall(rctx);
      throw new Stop(EXIT.FAILED, "state", `unknown interrupted operation ${JSON.stringify(interrupted.op)}; nothing was changed`);
    }
  }
  if (mode === "uninstall") return runUninstall(shared);
  if (mode === "adopt-legacy") return runAdoptLegacy(shared);

  // ── existing install? ─────────────────────────────────────────────────────
  const existing = await cli.inspect(PLUGIN_ID);
  if (existing.installed) {
    report.set("mode", "update");
    report.step("existing", mode === "update" ? "ok" : "handover", `tracked install ${existing.json.install.version ?? "(unknown)"} (${existing.json.install.source ?? "?"})${mode === "update" ? "" : " → the update path takes over"}`);
    return runUpdate({ ...shared, state, existing });
  }
  const legacyDir = (platform === "win32" ? win32 : posix).join(det.stateDir, "extensions", PLUGIN_ID);
  if (existing.present || (existing.notFound && existsSync(legacyDir))) {
    const where = existsSync(legacyDir) ? legacyDir : (existing.json?.plugin?.rootDir ?? "an untracked directory");
    throw new Stop(EXIT.NEEDS_CHOICE, "existing", `legacy-deploy: ${PLUGIN_ID} is deployed at ${where} without an OpenClaw install record; re-run with --adopt-legacy to adopt it (the directory and your store are kept); nothing was changed`);
  }
  if (!existing.notFound) throw new Stop(EXIT.FAILED, "existing", `openclaw plugins inspect failed (exit ${existing.code}): ${existing.detail}`);
  if (mode === "update") throw new Stop(EXIT.FAILED, "existing", `${PLUGIN_ID} is not installed; run the installer without --update to install it; nothing was changed`);
  report.step("existing", "ok", "not installed");

  // ── reads for the plan ────────────────────────────────────────────────────
  const prevSlot = await cli.configGet(SLOT);
  const previousSlot = prevSlot.set ? prevSlot.value : null;
  const embeddingProvider = await cli.configGet(`${C}.embedding.provider`);

  // ── licence choice (before any change; applied after install) ─────────────
  let licence = null;
  if (embeddingProvider.set) {
    report.step("licence", "skipped", `existing embedding choice (${embeddingProvider.value}) kept`);
    report.set("licence", { skipped: "existing-embedding-choice" });
  } else {
    licence = await resolveLicence({ interactive: isTTY && !values["non-interactive"], acceptNc: values["accept-nc-licence"], env, prompt, now });
    report.set("licence", licence);
  }

  const npmPack = source === "offline" || source === "tarball";
  const locatorFor = (file) => (npmPack ? `npm-pack:${file}` : source === "npm" ? (release.npm ?? `npm:${PACKAGE_NAME}@${release.version}`) : release.clawhub);
  const installOpts = npmPack ? { force: true, acceptCapabilities: true } : source === "npm" ? { pin: true } : {};

  // Config keys this install will write (closed allow-list) and their previous values (ruling T5-c).
  const plannedKeys = [
    ...(licence ? [`${C}.modelPreparation.profile`, `${C}.modelPreparation.acceptNonCommercialLicense`, `${C}.embedding.provider`, `${C}.embedding.model`] : []),
    ALLOW_CONVERSATION,
  ];

  if (values["dry-run"]) {
    report.step("install", "planned", `openclaw plugins install ${locatorFor(source === "tarball" ? release.tarball.url : tgz)}`);
    if (licence) report.step("licence", "planned", `${licence.profile}${licence.acceptNonCommercialLicense ? " (CC BY-NC 4.0 accepted)" : ""}`);
    report.step("slot", "planned", `${SLOT} = ${PLUGIN_ID}; conversation access for capture and recall enabled`);
    return report.finish(EXIT.OK);
  }

  const previous = new Map();
  for (const key of plannedKeys) {
    if (key === `${C}.embedding.provider`) previous.set(key, embeddingProvider);
    else previous.set(key, await cli.configGet(key));
  }

  // ── the feed's tarball when no ClawPack digest can verify ClawHub (T5-a, T5-f) ──
  let tmpDir = null;
  try {
    if (source === "tarball") {
      const bytes = await fetchBytes(release.tarball.url, { testMode, fetchImpl });
      const digest = sha256(bytes);
      if (digest !== release.tarball.sha256) throw new Stop(EXIT.FAILED, "tarball", `SHA-256 of ${release.tarball.url} (${digest.slice(0, 12)}…) does not match the feed (${release.tarball.sha256.slice(0, 12)}…); nothing was changed`);
      tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-plugin-"));
      tgz = join(tmpDir, `cyb3rb1ade-plur1bus-memory-${release.version}.tgz`);
      writeFileSync(tgz, bytes, { mode: 0o600 });
      report.step("tarball", "ok", `downloaded ${release.tarball.url}; SHA-256 matches the feed (no clawpackDigest for ClawHub)`);
    }
    return await applyInstall({ ...ctx, source, release, det, cli, childEnv, licence, previousSlot, previous, locator: locatorFor(tgz), installOpts, platform });
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function applyInstall(ctx) {
  const { values, report, run, source, release, det, cli, childEnv, licence, previousSlot, previous, locator, installOpts, platform } = ctx;
  // ── install ───────────────────────────────────────────────────────────────
  const base = { previousSlot, installedVersion: null, source };
  writeState(det.stateDir, { ...base, inProgress: { op: "install", step: "install", snapshotId: null, previousVersion: null } });
  const written = [];
  const rb = { cli, det, report, previousSlot, base, previous, written };
  const set = async (key, value) => {
    await cli.configSet(key, value);
    if (!written.includes(key)) written.push(key);
  };

  const inst = await cli.install(locator, installOpts);
  if (inst.code !== 0) {
    const text = `${inst.stderr}\n${inst.stdout}`;
    const after = await cli.inspect(PLUGIN_ID);
    if (after.installed) {
      report.step("install", "failed", `exit ${inst.code}: ${tail(text)}`);
      return rollback(rb);
    }
    writeState(det.stateDir, base);
    if (isReadonlyRefusal(text)) throw new Stop(EXIT.INCOMPATIBLE, "install", `OpenClaw refused: ${tail(text, 2)}`);
    throw new Stop(EXIT.FAILED, "install", `openclaw plugins install ${locator} failed (exit ${inst.code}${inst.timedOut ? ", deadline exceeded" : ""}): ${tail(text)}; nothing was changed`);
  }
  report.step("install", "ok", `openclaw plugins install ${locator}`);

  // ── config (closed allow-list) ────────────────────────────────────────────
  try {
    writeState(det.stateDir, { ...base, inProgress: { op: "install", step: "config", snapshotId: null, previousVersion: null } });
    if (licence) {
      await set(`${C}.modelPreparation.profile`, licence.profile);
      await set(`${C}.modelPreparation.acceptNonCommercialLicense`, licence.acceptNonCommercialLicense ? "true" : "false");
      await set(`${C}.embedding.provider`, "local-transformers");
      await set(`${C}.embedding.model`, PROFILE_MODELS[licence.profile].model);
      report.step("licence", "ok", `${licence.profile} (${PROFILE_MODELS[licence.profile].model})${licence.accepted ? `; CC BY-NC 4.0 accepted by ${licence.accepted.by} at ${licence.accepted.at}` : ""}`);
    }
    await set(ALLOW_CONVERSATION, "true");
    await cli.configSet(SLOT, PLUGIN_ID);
    report.step("slot", "ok", `${SLOT} = ${PLUGIN_ID} (previously ${previousSlot ?? "unset"}); conversation access for capture and recall enabled`);
  } catch (err) {
    report.step("config", "failed", err.message);
    return rollback(rb);
  }

  // ── install record, enable if recorded disabled ───────────────────────────
  const rec = await cli.inspect(PLUGIN_ID);
  if (!rec.installed) {
    report.step("record", "failed", `no install record after install: ${rec.detail}`);
    return rollback(rb);
  }
  const installPath = rec.json.install.installPath;
  if (rec.json.plugin?.status === "disabled") {
    const en = await cli.enable(PLUGIN_ID);
    if (en.code !== 0) {
      report.step("enable", "failed", tail(en.stderr || en.stdout));
      return rollback(rb);
    }
    report.step("enable", "ok", `enabled ${PLUGIN_ID}`);
  }

  // ── feature crons (HM1-R7) ────────────────────────────────────────────────
  const gw = await cli.gatewayStatus();
  if (!gw.running) report.step("crons", "skipped", "gateway-start-reconciles (no running Gateway; the plugin provisions its jobs on the next start)");
  else if (!det.node.bin || !installPath) report.step("crons", "warn", "no node or plugin dir to run setup-feature-crons.mjs; the Gateway reconciles the jobs");
  else {
    const script = `${installPath}${platform === "win32" ? "\\" : "/"}scripts${platform === "win32" ? "\\" : "/"}setup-feature-crons.mjs`;
    const cr = await run(det.node.bin, [script, "--json"], { env: childEnv, timeoutMs: 300_000 });
    let warnings = [];
    try {
      const j = JSON.parse(cr.stdout.trim().split(/\r?\n/).pop() ?? "");
      warnings = Array.isArray(j?.warnings) ? j.warnings.map(String) : [];
    } catch {
      warnings = cr.code === 0 ? [] : [`exit ${cr.code}`];
    }
    report.step("crons", warnings.length || cr.code !== 0 ? "warn" : "ok", warnings.length ? warnings.slice(0, 3).join("; ") : "feature cron jobs provisioned");
  }

  // ── verify ────────────────────────────────────────────────────────────────
  writeState(det.stateDir, { ...base, inProgress: { op: "install", step: "verify", snapshotId: null, previousVersion: null } });
  const checks = await verifyInstall({ cli, release, source, downloadModels: values["download-models"], stateDir: det.stateDir });
  for (const c of checks) report.step(`verify.${c.id}`, c.ok ? (c.warn ? "warn" : "ok") : "failed", c.detail);
  if (checks.some((c) => !c.ok)) return rollback(rb);

  writeState(det.stateDir, { ...base, installedVersion: release.version, ...(licence?.accepted ? { licence: licence.accepted } : {}) });
  report.note(`Installed ${PACKAGE_NAME}@${release.version} into OpenClaw (${det.stateDir}).`);
  report.note(`Conversation access for capture and recall: enabled (${ALLOW_CONVERSATION}).`);
  report.note(gw.running ? "The running Gateway picks the plugin up; if not, run `openclaw gateway restart`." : "The plugin becomes active on the next Gateway start (`openclaw gateway restart`).");
  return report.finish(EXIT.OK);
}

function modeLabel(mode, values) {
  if (mode === "uninstall") return values.purge ? "--uninstall --purge" : "--uninstall";
  if (mode === "install") return "the install";
  return `--${mode}`;
}

/** "interrupted <op> … at step <s>", the line every resume report starts with. */
function describeInterrupted(p) {
  if (p.op === "update") return `interrupted update to ${p.targetVersion} at step ${p.step}`;
  if (p.op === "adopt") return `interrupted adoption of the legacy deploy (${p.targetVersion}) at step ${p.step}`;
  if (p.op === "uninstall") return `interrupted uninstall${p.purge ? " with purge" : ""} at step ${p.step}`;
  return `interrupted install (fresh install) at step ${p.step}`;
}

/** What continuing or rolling back an interrupted run would do (for --dry-run, T6-d). */
function resumePlan(p) {
  const snap = p.snapshotId ? ` and restore the store from snapshot ${p.snapshotId} (only while the Gateway is stopped)` : "";
  if (p.op === "update") {
    return {
      continue: p.step === "snapshot" ? `start the update to ${p.targetVersion} again (nothing had changed)` : p.step.startsWith("rollback") ? `finish the rollback to ${p.previousVersion}${snap}` : `finish the update to ${p.targetVersion} (reinstall it and verify; on failure roll back)`,
      rollback: p.step === "snapshot" ? "only clear the interrupted state (nothing had changed)" : `reinstall ${p.previousVersion}${snap}`,
    };
  }
  if (p.op === "adopt") {
    return {
      continue: p.step.startsWith("rollback") ? `finish putting the legacy deploy back${snap}` : `finish adopting the legacy deploy as ${p.targetVersion}`,
      rollback: `uninstall the tracked plugin, rename ${p.legacyBackup ?? "the kept legacy dir"} back${snap}`,
    };
  }
  if (p.op === "uninstall") {
    return {
      continue: p.purge ? "finish the uninstall and the purge, only under --uninstall --purge after the purge confirmation is given again" : "finish the uninstall, only under --uninstall",
      rollback: "nothing: an uninstall cannot be rolled back",
    };
  }
  return { continue: "remove the partial install and install again", rollback: "remove the partial install and restore the previous memory slot" };
}

/**
 * A fresh install that was interrupted (Review Focus 5): undo what it did (uninstall if
 * OpenClaw recorded it, restore the previous slot), then — unless --rollback — let the
 * caller install again from the start. Returns an exit code to stop, or undefined to go on.
 */
async function resumeInstall(ctx, p) {
  const { cli, report, det, flags, state } = ctx;
  report.step("resume", "info", `interrupted install (fresh install) at step ${p.step}; rolling the partial install back${flags.rollback ? "" : ", then installing again"}`);
  const manual = [];
  const now = await cli.inspect(PLUGIN_ID);
  if (now.installed) {
    const un = await cli.uninstall(PLUGIN_ID);
    if (un.code !== 0) manual.push(`openclaw plugins uninstall ${PLUGIN_ID} --force`);
  }
  const prev = state?.previousSlot ?? null;
  if (prev && prev !== "memory-core" && prev !== PLUGIN_ID) {
    try {
      await cli.configSet(SLOT, prev);
    } catch {
      manual.push(`openclaw config set ${SLOT} ${prev}`);
    }
  }
  if (manual.length) {
    writeState(det.stateDir, { ...state, inProgress: { ...p, step: "rollback-failed" } });
    report.step("rollback", "failed", `manual steps needed: ${manual.join("; ")}`);
    report.set("manualSteps", manual);
    report.note("Rollback failed. Run these commands yourself:");
    for (const m of manual) report.note(`  ${m}`);
    return report.finish(EXIT.ROLLBACK_FAILED);
  }
  writeState(det.stateDir, { previousSlot: prev, installedVersion: null, source: state?.source ?? null });
  report.step("rollback", "ok", `partial install removed${now.installed ? ` (uninstalled ${PLUGIN_ID})` : ""}`);
  if (flags.rollback) return report.finish(EXIT.FAILED);
  return undefined;
}

/**
 * Undo a failed fresh install (ruling T5-c): restore the previous value of every
 * plugin-entry key this run wrote (while the plugin is still installed, so OpenClaw
 * still validates its config), uninstall, then restore the previous slot. Keys that
 * had no previous value stay set (there is no `config unset` route) and are listed.
 */
async function rollback({ cli, det, report, previousSlot, base, previous, written }) {
  const manual = [];
  const leftSet = [];
  const restored = [];
  for (const key of [...written].reverse()) {
    const prev = previous.get(key);
    if (!prev?.set) {
      leftSet.push(key);
      continue;
    }
    try {
      await cli.configSet(key, prev.value);
      restored.push(key);
    } catch {
      manual.push(`openclaw config set ${key} ${prev.value}`);
    }
  }
  const un = await cli.uninstall(PLUGIN_ID);
  if (un.code !== 0) manual.push(`openclaw plugins uninstall ${PLUGIN_ID} --force`);
  const restoreSlot = previousSlot && previousSlot !== "memory-core" && previousSlot !== PLUGIN_ID;
  if (restoreSlot) {
    try {
      await cli.configSet(SLOT, previousSlot);
    } catch {
      manual.push(`openclaw config set ${SLOT} ${previousSlot}`);
    }
  }
  report.set("rollback", { restored, leftSet });
  if (leftSet.length) report.note(`Left set after the rollback (no previous value, no unset route): ${leftSet.join(", ")}`);
  if (manual.length === 0) {
    writeState(det.stateDir, base);
    report.step("rollback", "ok", `uninstalled ${PLUGIN_ID}${restoreSlot ? `, ${SLOT} restored to ${previousSlot}` : ""}${restored.length ? `, ${restored.length} config value(s) restored` : ""}${leftSet.length ? `, ${leftSet.length} key(s) left set` : ""}`);
    return report.finish(EXIT.FAILED);
  }
  try {
    const cur = readState(det.stateDir);
    writeState(det.stateDir, { ...base, ...(cur ?? {}), inProgress: { op: "install", step: "rollback-failed", snapshotId: null, previousVersion: null } });
  } catch {
    // the manual steps below still apply
  }
  report.step("rollback", "failed", `manual steps needed: ${manual.join("; ")}`);
  report.set("manualSteps", manual);
  report.note("Rollback failed. Run these commands yourself:");
  for (const m of manual) report.note(`  ${m}`);
  return report.finish(EXIT.ROLLBACK_FAILED);
}

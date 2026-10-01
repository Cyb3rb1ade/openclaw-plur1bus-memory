/**
 * scripts/dist/installer/hermes/install.mjs — `install-plugin --host hermes` (D87, D88, spec A.3, A.6).
 *
 * Order: detect (none → exit 3 `hermes-not-found`) → an interrupted run first (F19) → compatibility,
 * every fatal finding together, exit 3: target, Hermes ≥ minHermesVersion (a `vgit.<sha>` build is an
 * unknown version: warned, HM2-R22a), Python (feed floor, Hermes' own requires-python, HM2-R25), free
 * disk, `harness-present` (a full PLUR1BUS home, HM2-R10) or an unreadable manifest (HM2-R27), a Hermes
 * home that does not exist, an agent id another Hermes home holds (HM2-R8a), a config.yaml the 0.21.4
 * line edit cannot change (HM2-R24) → an existing plur1bus install goes to the update path (F17) →
 * another active memory provider needs --replace-provider or an interactive yes, else exit 2
 * `provider-in-use` → licence (HM2-R18, F2; a reused sidecar keeps its recorded use class, F3) →
 * downloads, both verified against the signed feed before anything changes → sidecar binary (skipped
 * when a host sidecar is at least the release's version) → `plur1bus setup --profile host` →
 * `agent create` + registry → provider directory → binding file → memory.provider (after the directory
 * exists, HM2-R17a; `hermes config set` only for a parsed version ≥ 0.21.5, else — 0.21.4 or an unknown
 * version — a backed-up line edit, HM2-R24/R24a) → verify
 * (`hermes memory status` names plur1bus, `hermes plur1bus selftest` ok) → on any failure the rollback:
 * memory.provider back first, then the provider directory, the binding, the registry entry and — for a
 * sidecar this run created — daemon stop, service uninstall, binary and home; exit 1 (4 with manual
 * steps when a rollback step fails).
 *
 * Writes (ruling F27): in Hermes only `$HERMES_HOME/plugins/plur1bus/` (+ a transient `plur1bus.tmp-<pid>`
 * and `.plur1bus-prev-<ts>`), `$HERMES_HOME/plur1bus.json`, `$HERMES_HOME/.plur1bus-installer.json`, and
 * memory.provider (through Hermes' CLI, or the one line on 0.21.4 with a `config.yaml.plur1bus-bak-<ts>`);
 * outside Hermes the sidecar binary, the PLUR1BUS home (through `plur1bus setup`) and
 * `<plur1bus home>/hosts/hermes-bindings.json`. Never `.env` or any secret.
 */

import { existsSync, mkdtempSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { compareVersions } from "../../build-plugin-feed.mjs";
import { findHarnessHomes, resolveTarget } from "../compat.mjs";
import { writeFileAtomic } from "../fsutil.mjs";
import { resolveLicence } from "../licence.mjs";
import { EXIT, Stop } from "../report.mjs";
import { fetchBytes } from "../update.mjs";
import { sha256Hex } from "../untar.mjs";
import { selftestForcedToFail } from "../verify.mjs";
import {
  agentIdFor, BindingConflict, bindingPath, checkBinding, INSTALLED_BY, makeBinding, readBinding, registerBinding, removeBinding, unregisterBinding, writeBinding,
} from "./binding.mjs";
import { checkConfigEditable, setProviderLine, undoProviderLine } from "./config-edit.mjs";
import { detectHermes } from "./detect.mjs";
import { BUILTIN_PROVIDER_VALUES, createHermesCli } from "./hermes-cli.mjs";
import { createPlur1busCli, USE_CLASSES } from "./plur1bus-cli.mjs";
import {
  checkProviderDir, dropPreviousProvider, MAX_PROVIDER_BYTES, previousProviderPath, providerDir, PROVIDER_NAME, installProvider, removeStaging, restoreProvider,
} from "./provider.mjs";
import { hermesStatePath, readHermesState, writeHermesState } from "./state.mjs";
import { dropPreviousBin, installSidecar, plur1busHome, readSidecar, restoreSidecarBin, sidecarBinPath } from "./sidecar.mjs";

/** Node runtime + core payload of a host sidecar, one model later, and headroom. */
export const HERMES_REQUIRED_FREE_BYTES = 1024 * 1024 * 1024;
/** `hermes config set` keeps config.yaml's comments from this version on (fact sheet §c). */
export const CONFIG_SET_SAFE_FROM = "0.21.5";
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HM4 = "Hermes on an existing full harness arrives with HM4";

const ZERO_SHA256 = /^0{64}$/;

/** True when the provider or any sidecar binary of `release` carries an all-zero SHA-256 (ruling F31). */
export function hasPlaceholderHash(release) {
  const bins = Object.values(release?.sidecar?.binary ?? {});
  return ZERO_SHA256.test(String(release?.provider?.sha256 ?? "")) || bins.some((b) => ZERO_SHA256.test(String(b?.sha256 ?? "")));
}

const builtin = (v) =>BUILTIN_PROVIDER_VALUES.includes(String(v ?? "").trim().toLowerCase());

/** PEP 440 subset: comma-separated `>=`, `>`, `<=`, `<`, `==`, `!=` over numeric versions. null = cannot tell. */
export function pep440Satisfies(version, spec) {
  const num = (v) => String(v).split(".").map((x) => Number.parseInt(x, 10));
  const cmp = (a, b) => {
    const pa = num(a);
    const pb = num(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  if (!/^\d+(\.\d+)*$/.test(String(version ?? ""))) return null;
  for (const raw of String(spec).split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(>=|<=|==|!=|>|<)\s*(\d+(?:\.\d+)*)(?:\.\*)?$/.exec(raw);
    if (!m) return null;
    const d = cmp(version, m[2]);
    const ok = { ">=": d >= 0, "<=": d <= 0, "==": d === 0, "!=": d !== 0, ">": d > 0, "<": d < 0 }[m[1]];
    if (!ok) return false;
  }
  return true;
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

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * @param {{ flags: object, env: object, platform: string, arch: string, glibcVersion: string|null, rosetta: boolean, run: Function,
 *   fetchImpl: Function, prompt: Function, isTTY: boolean, report: object, feed: object, release: object, testMode: boolean,
 *   statfs: Function, now: () => number, which?: Function, homedir?: string|(() => string), runHermesUpdate?: Function }} ctx
 * @returns {Promise<number>} exit code
 */
export async function runHermesInstall(ctx) {
  const { flags, env, platform, report, feed, release, run, testMode } = ctx;
  const now = ctx.now ?? Date.now;
  if (flags["hermes-profile"] !== undefined && !PROFILE_RE.test(flags["hermes-profile"])) {
    throw new Stop(EXIT.FAILED, "args", `--hermes-profile ${JSON.stringify(flags["hermes-profile"])} is not a Hermes profile name`);
  }
  if (flags["hermes-profile"] !== undefined && flags["hermes-home"] !== undefined) throw new Stop(EXIT.FAILED, "args", "--hermes-profile and --hermes-home are exclusive");
  // F31: a release built from a placeholder lock (an all-zero hash) is never installed outside the test seams
  if (!testMode && hasPlaceholderHash(release)) throw new Stop(EXIT.FAILED, "feed", `the Hermes release ${release.version} carries a placeholder (all-zero) hash; nothing was changed`);

  // ── detect ────────────────────────────────────────────────────────────────
  const det = await detectHermes({ env, platform, run, which: ctx.which, homedir: ctx.homedir, explicitHome: flags["hermes-home"] ?? null, profile: flags["hermes-profile"] ?? null });
  if (!det) throw new Stop(EXIT.INCOMPATIBLE, "detect", "hermes-not-found: no `hermes` launcher on PATH or in its usual places; install Hermes first (https://hermes-agent.nousresearch.com); nothing was changed");
  const hermesHome = det.home;
  report.set("hermes", { version: det.version, versionRaw: det.versionRaw, bin: det.bin, home: hermesHome, root: det.root, profile: det.profile, identity: det.identity, python: det.python });
  report.step("detect", "ok", `Hermes ${det.version ?? `(unknown version: ${det.versionRaw || "no output"})`} at ${det.bin}, home ${hermesHome}${det.profile ? ` (profile ${det.profile})` : ""} [${det.resolvedFrom}]`);
  if (platform === "win32" && feed.hosts.hermes.windowsNativeBeta) report.note("Hermes host mode on native Windows is in beta.");
  const childEnv = { ...env, HERMES_HOME: hermesHome };
  const hermes = createHermesCli({ bin: det.bin, env: childEnv, run, platform });
  const home = plur1busHome({ platform, env, homedir: ctx.homedir });
  const bin = sidecarBinPath({ platform, env, homedir: ctx.homedir });
  const agentId = agentIdFor({ hermesHome, defaultRoot: det.defaultRoot, profile: det.profile, platform });
  report.set("agentId", agentId);

  // ── an interrupted run first (F19) ────────────────────────────────────────
  let state;
  try {
    state = isDir(hermesHome) ? readHermesState(hermesHome) : null;
  } catch (err) {
    throw new Stop(EXIT.FAILED, "state", `${err.message}; check the file and move it aside to continue; nothing was changed`);
  }
  const interrupted = state?.inProgress ?? null;
  if (flags.rollback && !interrupted) throw new Stop(EXIT.FAILED, "rollback", "nothing to roll back: no interrupted installer run was found; nothing was changed");
  if (interrupted) {
    report.set("interrupted", { op: interrupted.op, step: interrupted.step });
    if (flags["dry-run"]) {
      report.step("resume", "planned", `interrupted install at step ${interrupted.step}: re-running without --dry-run would finish it (steps already done are checked and skipped); with --rollback it would undo it`);
      return report.finish(EXIT.OK);
    }
    removeStaging(hermesHome);
    if (flags.rollback || interrupted.step === "rollback-failed") {
      report.step("resume", "info", `interrupted install at step ${interrupted.step}; rolling it back${flags.rollback ? "" : " (re-run the installer afterwards to install again)"}`);
      return rollback({ ...ctx, hermes, hermesHome, s: state, reason: flags.rollback ? "rollback requested" : "finishing a failed rollback" });
    }
    report.step("resume", "info", `interrupted install at step ${interrupted.step}; finishing it (steps already done are checked and skipped)`);
  }
  const resuming = Boolean(interrupted);

  // ── compatibility (reads only) ────────────────────────────────────────────
  const findings = [];
  const target = resolveTarget({ platform, arch: ctx.arch, glibcVersion: ctx.glibcVersion, rosetta: ctx.rosetta });
  report.set("target", target.target);
  if (!target.supported) findings.push({ id: "unsupported-target", fatal: true, detail: target.detail });
  if (!isDir(hermesHome)) {
    findings.push({ id: "hermes-home-missing", fatal: true, detail: `${hermesHome} does not exist; run Hermes once${det.profile ? ` with the profile ${det.profile}` : ""} so it creates its home, then re-run` });
  }
  if (det.version === null) {
    findings.push({ id: "hermes-version-unknown", fatal: false, detail: `\`hermes --version\` names no release version (${det.versionRaw || "no output"}); untested, continuing` });
  } else if (compareVersions(det.version, release.minHermesVersion) < 0) {
    findings.push({ id: "hermes-too-old", fatal: true, detail: `Hermes ${det.version} is older than ${release.minHermesVersion}; run \`hermes update\` first` });
  } else if (compareVersions(det.version, release.testedHermesVersion) > 0) {
    findings.push({ id: "hermes-newer-than-tested", fatal: false, detail: `Hermes ${det.version} is newer than the tested ${release.testedHermesVersion}` });
  }
  if (det.python) {
    const floor = pep440Satisfies(det.python, release.python);
    const hermesOwn = det.requiresPython ? pep440Satisfies(det.python, det.requiresPython) : true;
    if (floor === false || hermesOwn === false) findings.push({ id: "python-unsupported", fatal: true, detail: `Hermes runs Python ${det.python}; the provider needs ${release.python}${det.requiresPython ? ` and Hermes itself ${det.requiresPython}` : ""}` });
  } else {
    findings.push({ id: "python-unknown", fatal: false, detail: "`hermes --version` names no Python version; continuing" });
  }
  const seamFree = testMode && env.PLUR1BUS_PLUGIN_TEST_FREE_BYTES !== undefined ? Number(env.PLUR1BUS_PLUGIN_TEST_FREE_BYTES) : NaN;
  const free = Number.isFinite(seamFree) ? seamFree : freeBytesAt(home, ctx.statfs);
  if (typeof free === "number" && free < HERMES_REQUIRED_FREE_BYTES) {
    findings.push({ id: "insufficient-disk", fatal: true, detail: `${Math.floor(free / 1048576)} MiB free under ${home}, need ${HERMES_REQUIRED_FREE_BYTES / 1048576} MiB` });
  }
  // HM2-R10 / F24: every PLUR1BUS home findHarnessHomes knows, read through its manifest
  let hostSidecar = null;
  for (const h of findHarnessHomes({ env, platform, homedir: ctx.homedir ? () => (typeof ctx.homedir === "function" ? ctx.homedir() : ctx.homedir) : undefined })) {
    const m = readSidecar({ home: h });
    if (!m) continue;
    if (m.invalid) findings.push({ id: "sidecar-manifest-invalid", fatal: true, detail: `${h}/manifest.json is ${m.invalid}; run \`plur1bus --home "${h}" 1staid repair\` (or move the home aside), then re-run` });
    else if (m.profile === "full") findings.push({ id: "harness-present", fatal: true, detail: `a full PLUR1BUS harness is installed at ${h}; ${HM4}` });
    else if (resolve(h) === resolve(home)) hostSidecar = m;
    else report.note(`Notice: another host-mode PLUR1BUS home exists at ${h}; this install uses ${home}.`);
  }
  const homeExisted = existsSync(home);
  const reuseSidecar = Boolean(hostSidecar?.binaryVersion && existsSync(bin) && compareVersions(hostSidecar.binaryVersion, release.sidecar.version) >= 0);
  try {
    checkBinding(home, agentId, hermesHome, platform);
  } catch (err) {
    if (err instanceof BindingConflict) findings.push({ id: "agent-id-conflict", fatal: true, detail: `${err.message}: both fold to ${agentId}; use another profile name` });
    else findings.push({ id: "bindings-registry-invalid", fatal: true, detail: err.message });
  }
  // HM2-R24a: only a parsed version >= 0.21.5 may use `hermes config set`; an unknown one (vgit.<sha>) gets the line edit
  const lineEdit = det.version === null || compareVersions(det.version, CONFIG_SET_SAFE_FROM) < 0;
  if (lineEdit && isDir(hermesHome)) {
    const c = checkConfigEditable(hermesHome);
    if (!c.ok) findings.push({ id: "hermes-config-uneditable", fatal: true, detail: `Hermes ${det.version ?? "(unknown version)"}'s \`config set\` may strip its config file, and the installer cannot edit memory.provider there safely: ${c.reason}; update Hermes (≥ ${CONFIG_SET_SAFE_FROM}) or fix the file, then re-run` });
  }
  const prev = isDir(hermesHome) ? await hermes.configGet("memory.provider") : { ok: true, set: false, value: "" };
  if (!prev.ok) findings.push({ id: "hermes-config-unreadable", fatal: true, detail: `\`hermes config get memory.provider\` failed (exit ${prev.code}): ${prev.detail}` });
  report.set("findings", findings);
  const fatal = findings.filter((f) => f.fatal);
  for (const f of findings.filter((x) => !x.fatal)) report.note(`Warning: ${f.id}: ${f.detail}`);
  if (fatal.length) {
    for (const f of fatal) report.note(`  ${f.id}: ${f.detail}`);
    throw new Stop(EXIT.INCOMPATIBLE, "compat", `${fatal.length} incompatibilit${fatal.length === 1 ? "y" : "ies"} (${fatal.map((f) => f.id).join(", ")}); nothing was changed`);
  }
  report.step("compat", "ok", `${target.target}, Hermes ≥ ${release.minHermesVersion}${det.python ? `, Python ${det.python}` : ""}, ${reuseSidecar ? `host sidecar ${hostSidecar.binaryVersion} reused` : hostSidecar ? `host sidecar ${hostSidecar.binaryVersion ?? "?"} updated to ${release.sidecar.version}` : `new host sidecar ${release.sidecar.version}`}`);

  // the value before any install; a resumed run carries the one its first attempt recorded
  const currentProvider = builtin(prev.value) ? null : prev.value.trim();
  const previousProvider = resuming ? (state.previousProvider ?? null) : currentProvider;

  // ── an existing plur1bus install → the update path (F17) ──────────────────
  const binding = readBinding(hermesHome);
  if (!resuming && currentProvider === PROVIDER_NAME && binding && !binding.invalid && binding.installedBy === INSTALLED_BY && isDir(providerDir(hermesHome))) {
    const installed = state?.installedVersion ?? binding.version;
    report.set("mode", "update");
    report.step("existing", "handover", `plur1bus ${installed ?? "(unknown version)"} is installed in ${hermesHome} → the update path takes over`);
    if (typeof ctx.runHermesUpdate === "function") return ctx.runHermesUpdate({ ...ctx, det, hermes, hermesHome, state, binding });
    if (installed === release.version) {
      report.step("update", "ok", `up-to-date: plur1bus ${installed}`);
      return report.finish(EXIT.OK);
    }
    throw new Stop(EXIT.NEEDS_CHOICE, "existing", `plur1bus ${installed ?? "(unknown version)"} is installed; updating it to ${release.version} needs --update; nothing was changed`);
  }

  // ── another memory provider (Review Focus 5) ──────────────────────────────
  if (currentProvider && currentProvider !== PROVIDER_NAME && !resuming) {
    const interactive = ctx.isTTY && !flags["non-interactive"];
    let ok = flags["replace-provider"] === true;
    if (!ok && interactive && !flags["dry-run"]) {
      const a = await ctx.prompt(`Hermes uses the memory provider ${currentProvider}. Replace it with plur1bus (it is restored on rollback and uninstall)? [y/N] `);
      ok = /^\s*(y|yes|j|ja)\s*$/i.test(String(a ?? ""));
    }
    if (!ok && !flags["dry-run"]) throw new Stop(EXIT.NEEDS_CHOICE, "provider", `provider-in-use: memory.provider is ${currentProvider}; re-run with --replace-provider to replace it (it is restored on rollback and uninstall); nothing was changed`);
    report.step("provider-choice", ok ? "ok" : "planned", `${currentProvider} will be replaced by plur1bus${ok ? "" : " (needs --replace-provider)"}`);
  }

  // ── licence (HM2-R18, F2, F3) ─────────────────────────────────────────────
  let useClass = null;
  let licence = null;
  if (resuming && USE_CLASSES.includes(state.useClass)) {
    useClass = state.useClass;
    licence = state.licence ?? null;
    report.step("licence", "skipped", `use class ${useClass} recorded by the interrupted run`);
  } else if (hostSidecar && existsSync(bin)) {
    // F3: a host sidecar's recorded use class is kept, also when its binary is about to be updated
    const got = await createPlur1busCli({ bin, home, env, run, platform }).configGet("embedding.useClass");
    if (got.set && USE_CLASSES.includes(got.value)) {
      useClass = got.value;
      report.step("licence", "skipped", `the sidecar's recorded use class ${useClass} is kept`);
    }
  }
  if (!useClass) {
    const l = await resolveLicence({
      interactive: ctx.isTTY && !flags["non-interactive"],
      acceptNc: flags["accept-nc-licence"],
      env,
      prompt: ctx.prompt,
      now,
      ncQuestion: "The default PLUR1BUS embedding models are licensed CC-BY-NC-4.0 (non-commercial use only). Accept this licence? [y/N] ",
    });
    useClass = l.useClass;
    licence = { useClass, acceptNonCommercialLicense: l.acceptNonCommercialLicense, ...(l.accepted ? { accepted: { by: l.accepted.by, at: l.accepted.at, licence: l.accepted.licence } } : {}) };
    report.step("licence", "ok", `use class ${useClass}${l.acceptNonCommercialLicense ? `; CC BY-NC 4.0 accepted by ${l.accepted.by} at ${l.accepted.at}` : ""}`);
  }
  const acceptNc = Boolean(licence?.acceptNonCommercialLicense);
  report.set("licence", licence ?? { useClass, kept: true });
  report.set("sidecar", { home, bin, version: reuseSidecar ? hostSidecar.binaryVersion : release.sidecar.version, reused: reuseSidecar });

  if (flags["dry-run"]) {
    report.step("sidecar", "planned", reuseSidecar ? `reuse ${bin} (${hostSidecar.binaryVersion})` : `install ${release.sidecar.binary[target.target]?.url ?? "(no binary)"} → ${bin}`);
    report.step("setup", "planned", `plur1bus --home ${home} setup --profile host --non-interactive --use-class ${useClass}${acceptNc ? " --accept-nc-licence" : ""}`);
    report.step("agent", "planned", `agent ${agentId} bound to ${hermesHome}`);
    report.step("provider", "planned", `${release.provider.url} → ${providerDir(hermesHome)}`);
    report.step("activate", "planned", `memory.provider = plur1bus (previously ${currentProvider ?? "built-in"})${lineEdit ? " by a backed-up line edit (Hermes below ${CONFIG_SET_SAFE_FROM} or of unknown version)" : ""}`);
    return report.finish(EXIT.OK);
  }

  // ── downloads, verified before anything changes ───────────────────────────
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-hermes-"));
  try {
    const tbytes = await fetchBytes(release.provider.url, { testMode, fetchImpl: ctx.fetchImpl, maxBytes: MAX_PROVIDER_BYTES, id: "provider" });
    const tdigest = sha256Hex(tbytes);
    if (tdigest !== release.provider.sha256) throw new Stop(EXIT.FAILED, "provider", `SHA-256 of ${release.provider.url} (${tdigest.slice(0, 12)}…) does not match the feed (${release.provider.sha256.slice(0, 12)}…); nothing was changed`);
    const tarball = join(tmp, `plur1bus-hermes-provider-${release.version}.tar.gz`);
    writeFileSync(tarball, tbytes, { mode: 0o600 });
    report.step("download", "ok", `provider ${release.version}: SHA-256 matches the feed`);

    // s: everything the rollback needs; persisted before each change
    const s = resuming
      ? { ...state, useClass, licence }
      : { previousProvider, plur1busHome: home, bin, agentId, sidecarFresh: !homeExisted, useClass, licence };
    const save = (step) => writeHermesState(hermesHome, { ...s, inProgress: { op: "install", step, version: release.version } });
    const rb = (reason) => rollback({ ...ctx, hermes, hermesHome, s, reason });

    // ── sidecar binary ──────────────────────────────────────────────────────
    save("sidecar");
    if (reuseSidecar) {
      report.step("sidecar", "skipped", `host sidecar ${hostSidecar.binaryVersion} at ${bin} is at least ${release.sidecar.version}`);
    } else {
      try {
        await installSidecar({
          release, target: target.target, bin, fetchImpl: ctx.fetchImpl, testMode, now, platform,
          beforeChange: ({ fresh, previousBin }) => {
            if (!s.sidecarInstalled) Object.assign(s, { binFresh: fresh, previousBin });
            s.sidecarInstalled = true;
            save("sidecar");
          },
        });
      } catch (err) {
        if (err instanceof Stop && !s.sidecarInstalled) {
          if (!resuming) rmSync(hermesStatePath(hermesHome), { force: true });
          throw err;
        }
        report.step("sidecar", "failed", err?.message ?? String(err));
        return rb("sidecar");
      }
      report.step("sidecar", "ok", `${release.sidecar.binary[target.target].url} → ${bin} (SHA-256 matches the feed)`);
    }

    // ── setup --profile host ────────────────────────────────────────────────
    save("setup");
    const p1 = createPlur1busCli({ bin, home, env, run, platform });
    const noService = testMode && env.PLUR1BUS_PLUGIN_TEST_NO_SERVICE === "1";
    const st = await p1.setup({ useClass, acceptNc, noService });
    s.setupRan = true;
    const after = readSidecar({ home });
    if (!st.ok || !after || after.invalid || after.profile !== "host") {
      report.step("setup", "failed", st.ok ? `no host manifest in ${home} after setup` : `plur1bus setup --profile host failed (${st.detail})`);
      return rb("setup");
    }
    report.step("setup", "ok", `plur1bus setup --profile host in ${home} (use class ${useClass}${acceptNc ? ", CC BY-NC 4.0 accepted" : ""}${noService ? ", --no-service" : ""})`);

    // ── agent + registry ────────────────────────────────────────────────────
    save("agent");
    const list = await p1.agentList();
    if (!list.ok) {
      report.step("agent", "failed", `plur1bus agent list failed (${list.detail})`);
      return rb("agent");
    }
    if (!list.ids.includes(agentId)) {
      const c = await p1.agentCreate(agentId);
      if (!c.ok) {
        report.step("agent", "failed", `plur1bus agent create ${agentId} failed (${c.detail})`);
        return rb("agent");
      }
      s.agentCreated = true;
    }
    try {
      const reg = registerBinding(home, agentId, hermesHome, platform);
      if (reg.added) s.registryAdded = true;
    } catch (err) {
      report.step("agent", "failed", err?.message ?? String(err));
      return rb("agent");
    }
    report.step("agent", "ok", `${agentId}${s.agentCreated ? " created" : " exists"} and bound to ${hermesHome}`);

    // ── provider directory ──────────────────────────────────────────────────
    save("provider");
    const pdir = providerDir(hermesHome);
    const already = resuming && s.providerInstalled && existsSync(pdir) && checkProviderDir(pdir, { version: release.version }).ok;
    if (already) {
      report.step("provider", "skipped", `${pdir} already holds provider ${release.version}`);
    } else {
      try {
        if (resuming && s.providerInstalled) rmSync(pdir, { recursive: true, force: true }); // our own partial copy
        if (!s.providerInstalled) {
          s.providerPrev = existsSync(pdir) ? previousProviderPath(hermesHome, now) : null;
          s.pluginsDirCreated = !existsSync(dirname(pdir));
          s.providerInstalled = true;
          save("provider");
        }
        await installProvider({ hermesHome, tarball, sha256: release.provider.sha256, version: release.version, now, previousDirName: s.providerPrev ?? null });
      } catch (err) {
        report.step("provider", "failed", err?.message ?? String(err));
        return rb("provider");
      }
      report.step("provider", "ok", `${pdir} (provider ${release.version}, MANIFEST.json verified)${s.providerPrev ? `; the previous directory is kept until the install finishes` : ""}`);
    }

    // ── binding file ────────────────────────────────────────────────────────
    save("binding");
    try {
      if (!s.bindingWritten) {
        s.bindingPrev = binding && binding.text !== undefined ? binding.text : null;
        s.bindingWritten = true;
        save("binding");
      }
      writeBinding(hermesHome, makeBinding({ home, bin, agentId, version: release.version }));
    } catch (err) {
      report.step("binding", "failed", err?.message ?? String(err));
      return rb("binding");
    }
    report.step("binding", "ok", `${bindingPath(hermesHome)} → agent ${agentId}, home ${home}`);

    // ── memory.provider (HM2-R17a: the directory exists; HM2-R24) ───────────
    save("activate");
    try {
      if (lineEdit) {
        if (!s.configEdit) {
          setProviderLine({
            hermesHome, value: PROVIDER_NAME, now,
            onPlan: ({ backup, undo }) => {
              s.configEdit = { method: "line", backup, undo };
              save("activate");
            },
          });
        } else if ((await hermes.configGet("memory.provider")).value !== PROVIDER_NAME) {
          setProviderLine({ hermesHome, value: PROVIDER_NAME, now, backup: false });
        }
      } else {
        s.configEdit = { method: "cli" };
        save("activate");
        await hermes.configSet("memory.provider", PROVIDER_NAME);
      }
      const check = await hermes.configGet("memory.provider");
      if (check.value !== PROVIDER_NAME) throw new Error(`memory.provider reads ${JSON.stringify(check.value)} after the change`);
    } catch (err) {
      report.step("activate", "failed", err?.message ?? String(err));
      return rb("activate");
    }
    report.step("activate", "ok", `memory.provider = plur1bus (previously ${previousProvider ?? "built-in"})${lineEdit ? `; line edit, backup ${s.configEdit.backup ?? "(no file before)"}` : ""}`);

    // ── verify (read-only, HM2-R23) ─────────────────────────────────────────
    save("verify");
    const ms = await hermes.memoryStatus();
    const msOk = ms.provider === PROVIDER_NAME && ms.available !== false;
    report.step("verify.memory-status", msOk ? "ok" : "failed", ms.detail);
    const forced = selftestForcedToFail({ testMode, env });
    const self = msOk ? await hermes.selftest() : { ok: false, detail: "not run" };
    const selfOk = self.ok && !forced;
    report.step("verify.selftest", selfOk ? "ok" : "failed", forced ? "TEST ONLY: forced to fail" : self.detail);
    if (!msOk || !selfOk) return rb("verify");

    // ── done ────────────────────────────────────────────────────────────────
    dropPreviousBin(s.previousBin);
    dropPreviousProvider(s.providerPrev);
    const final = {
      installedVersion: release.version, previousProvider: s.previousProvider ?? null, plur1busHome: home, bin, agentId,
      sidecarFresh: s.sidecarFresh, agentCreated: s.agentCreated, registryAdded: s.registryAdded, useClass, licence,
      configEdit: s.configEdit ? { method: s.configEdit.method, ...(s.configEdit.backup ? { backup: s.configEdit.backup } : {}) } : undefined,
    };
    writeHermesState(hermesHome, final);
    report.note(`Installed the plur1bus memory provider ${release.version} into Hermes (${hermesHome}); agent ${agentId}, sidecar ${home}.`);
    report.note("The next Hermes session recalls and captures through PLUR1BUS; `hermes plur1bus status` shows the connection.");
    return report.finish(EXIT.OK);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Undo a failed or interrupted install from the recorded state `s` (HM2-R17a order). Exit 1, or 4 with manual steps.
 */
export async function rollback(ctx) {
  const { report, hermes, hermesHome, s, env, run, platform } = ctx;
  const manual = [];
  const done = [];
  const prev = s.previousProvider ?? null;

  // 1. memory.provider first, while our directory still exists (R17a)
  let current = null;
  try {
    current = (await hermes.configGet("memory.provider")).value;
  } catch {
    current = null;
  }
  if (current === PROVIDER_NAME && prev !== PROVIDER_NAME) {
    try {
      if (s.configEdit?.method === "line") {
        undoProviderLine({ hermesHome, undo: s.configEdit.undo, value: PROVIDER_NAME });
      } else if (prev) {
        await hermes.configSet("memory.provider", prev);
      } else {
        await hermes.configUnset("memory.provider");
      }
      const again = (await hermes.configGet("memory.provider")).value;
      if (again === PROVIDER_NAME) throw new Error("still plur1bus");
      done.push(`memory.provider restored to ${prev ?? "built-in"}`);
    } catch (err) {
      manual.push(prev ? `hermes config set memory.provider ${prev}` : "hermes config unset memory.provider");
      if (s.configEdit?.backup) manual.push(`(backup of the Hermes config: ${s.configEdit.backup})`);
      void err;
    }
  }
  const providerStillActive = manual.length > 0;

  // 2. the provider directory (never while memory.provider still names it)
  removeStaging(hermesHome);
  if (s.providerInstalled && !providerStillActive) {
    try {
      await restoreProvider({ hermesHome, previousDir: s.providerPrev ?? null });
      if (s.pluginsDirCreated) {
        try {
          rmdirSync(dirname(providerDir(hermesHome))); // only when still empty
        } catch {
          // Hermes or the user put something there meanwhile: kept
        }
      }
      done.push(s.providerPrev ? "previous provider directory restored" : "provider directory removed");
    } catch {
      manual.push(`remove ${providerDir(hermesHome)}${s.providerPrev ? ` and rename ${s.providerPrev} to ${providerDir(hermesHome)}` : ""}`);
    }
  } else if (s.providerInstalled) {
    manual.push(`after restoring memory.provider: remove ${providerDir(hermesHome)}${s.providerPrev ? ` and rename ${s.providerPrev} back` : ""}`);
  }

  // 3. the binding file
  if (s.bindingWritten) {
    try {
      if (s.bindingPrev) writeFileAtomic(bindingPath(hermesHome), s.bindingPrev);
      else removeBinding(hermesHome);
      done.push(s.bindingPrev ? "previous binding restored" : "binding removed");
    } catch {
      manual.push(`remove ${bindingPath(hermesHome)}`);
    }
  }

  // 4. the registry entry this run added
  if (s.registryAdded && s.plur1busHome && !s.sidecarFresh) {
    try {
      unregisterBinding(s.plur1busHome, s.agentId, hermesHome, platform);
      done.push("registry entry removed");
    } catch {
      manual.push(`remove ${s.agentId} from ${join(s.plur1busHome, "hosts", "hermes-bindings.json")}`);
    }
  }

  // 5. a sidecar this run created: service, binary, home
  if (s.sidecarFresh && s.plur1busHome && s.bin && existsSync(s.bin) && existsSync(s.plur1busHome)) {
    const p1 = createPlur1busCli({ bin: s.bin, home: s.plur1busHome, env, run, platform });
    const ds = await p1.daemonStop();
    const su = await p1.serviceUninstall();
    if (!su.ok) manual.push(`plur1bus --home "${s.plur1busHome}" service uninstall`);
    void ds;
  }
  if (s.sidecarFresh && s.plur1busHome && existsSync(s.plur1busHome)) {
    try {
      rmSync(s.plur1busHome, { recursive: true, force: true });
      done.push(`sidecar home ${s.plur1busHome} removed`);
    } catch {
      manual.push(`remove ${s.plur1busHome}`);
    }
  }
  if (s.sidecarInstalled && s.bin) {
    try {
      const r = restoreSidecarBin({ bin: s.bin, fresh: s.binFresh, previousBin: s.previousBin });
      if (r !== "kept") done.push(r === "restored" ? "previous sidecar binary restored" : "sidecar binary removed");
    } catch {
      manual.push(s.previousBin ? `rename ${s.previousBin} to ${s.bin}` : `remove ${s.bin}`);
    }
  }
  if (s.agentCreated && !s.sidecarFresh) report.note(`Note: the agent ${s.agentId} stays registered in ${s.plur1busHome} (its data is kept); \`plur1bus agent remove ${s.agentId}\` removes it.`);

  report.set("rollback", { reason: ctx.reason, done });
  if (manual.length) {
    writeHermesState(hermesHome, { ...s, inProgress: { op: "install", step: "rollback-failed", version: s.inProgress?.version ?? null } });
    report.step("rollback", "failed", `manual steps needed: ${manual.join("; ")}`);
    report.set("manualSteps", manual);
    report.note("Rollback failed. Do these steps yourself:");
    for (const m of manual) report.note(`  ${m}`);
    return report.finish(EXIT.ROLLBACK_FAILED);
  }
  rmSync(hermesStatePath(hermesHome), { force: true });
  report.step("rollback", "ok", done.length ? done.join("; ") : "nothing had changed");
  return report.finish(EXIT.FAILED);
}

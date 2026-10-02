/**
 * scripts/dist/installer/hermes/update.mjs — `install-plugin --host hermes --update` (HM2 Task 9, D87, D89).
 *
 * Installed version from the binding (`version`, else the state's installedVersion) and the sidecar's manifest
 * (`readSidecar`). Up to date → exit 0. Otherwise the release notes come first (D78), then Now / Later / Skip (TTY;
 * `--yes` = Now; no TTY without `--yes` → exit 2). Hermes ≥ minHermesVersion and a supported target are checked
 * before anything changes, and the provider tarball is verified against the signed feed.
 *
 * Provider-only update (the sidecar is at least the release's): the new provider is staged and renamed into place,
 * the previous directory kept until verify passed. Sidecar update: `daemon stop` → the home's manifest.json and
 * config.json saved byte for byte (`<home>/backups/host-update-home/<ts>/`; config.json may not exist after a host
 * setup, T4) → `createSnapshot({ stateDir: <home>, baseDbPath: <home>/state/lancedb, snapshotsDir:
 * <home>/backups/host-update, label: "pre-<v>" })` (F18) → the pinned binary (previous kept as `<bin>.prev-<ts>`) →
 * `setup --profile host --non-interactive --use-class <recorded>` (F3) → provider → binding → verify.
 *
 * On failure (rollbackUpdate): `daemon stop` → the previous binary back → `setup` with it → `daemon stop` → manifest.json
 * and config.json restored byte for byte (or removed when they did not exist) → the store restored only when it
 * differs from the snapshot (HM1-R-F2; the replaced store is kept as `.pre-restore-*`, never deleted here) →
 * `daemon start` → the previous provider directory and binding back. Exit 1, or 4 with manual steps.
 * memory.provider stays `plur1bus` throughout. An interrupted update is finished by the next run (each step checks
 * and skips what is done) or undone with `--rollback` (F19).
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compareStoreWithSnapshot, createSnapshot, restoreSnapshot, SnapshotError } from "../../../../lib/snapshot/store-snapshot.js";
import { compareVersions } from "../../build-plugin-feed.mjs";
import { resolveTarget } from "../compat.mjs";
import { writeFileAtomic } from "../fsutil.mjs";
import { EXIT, Stop } from "../report.mjs";
import { sha256Hex } from "../untar.mjs";
import { fetchBytes } from "../update.mjs";
import { selftestForcedToFail } from "../verify.mjs";
import { bindingPath, makeBinding, otherBoundHomes, writeBinding } from "./binding.mjs";
import { hermesContext } from "./context.mjs";
import { createPlur1busCli, USE_CLASSES } from "./plur1bus-cli.mjs";
import {
  checkProviderDir, dropPreviousProvider, MAX_PROVIDER_BYTES, previousProviderPath, providerDir, providerDirIsOurs, PROVIDER_NAME, installProvider, removeStaging, restoreProvider,
} from "./provider.mjs";
import { binaryMatches, dropPreviousBin, installSidecar, readSidecar, removeStaleBinTemps, restoreSidecarBin, sidecarBinPath } from "./sidecar.mjs";
import { writeHermesState } from "./state.mjs";

export const HOME_FILES = Object.freeze(["manifest.json", "config.json"]);
export const storePath = (home) => join(home, "state", "lancedb");
export const snapshotsDirOf = (home) => join(home, "backups", "host-update");
export const homeBackupRoot = (home) => join(home, "backups", "host-update-home");

/** The Hermes release notes after `installed` up to `target`, oldest first (D78). */
export function hermesNotesBetween(feed, installed, target, lang) {
  return feed.hosts.hermes.releases
    .filter((r) => (installed === null || compareVersions(r.version, installed) > 0) && compareVersions(r.version, target) <= 0)
    .sort((a, b) => compareVersions(a.version, b.version))
    .map((r) => ({ version: r.version, lang: r.notes?.[lang] ? lang : "en", text: String(r.notes?.[lang] ?? r.notes?.en ?? "").trim(), security: r.security === true }));
}

/** Save `<home>/{manifest,config}.json` byte for byte (with their modes); a missing file is recorded as missing. */
export function saveHomeFiles(home, now = Date.now) {
  const dir = join(homeBackupRoot(home), String(now()));
  mkdirSync(dir, { recursive: true });
  const files = {};
  for (const name of HOME_FILES) {
    const p = join(home, name);
    if (existsSync(p)) {
      copyFileSync(p, join(dir, name));
      files[name] = { mode: statSync(p).mode & 0o777 };
    } else {
      files[name] = null;
    }
  }
  return { dir, files };
}

/** Put the saved files back byte for byte; a file that did not exist before is removed. */
export function restoreHomeFiles(home, backup) {
  for (const name of HOME_FILES) {
    const p = join(home, name);
    const rec = backup.files[name];
    if (rec === null || rec === undefined) {
      rmSync(p, { force: true });
      continue;
    }
    writeFileAtomic(p, readFileSync(join(backup.dir, name)));
    if (process.platform !== "win32") chmodSync(p, rec.mode);
  }
}

async function snapshotStore({ report, home, label, now }) {
  try {
    const snap = await createSnapshot({ stateDir: home, baseDbPath: storePath(home), snapshotsDir: snapshotsDirOf(home), label, now });
    report.step("snapshot", "ok", `${snap.id} (${snap.files} files) under ${snapshotsDirOf(home)}`);
    for (const w of snap.warnings ?? []) report.note(`  snapshot warning: ${w}`);
    return snap.id;
  } catch (err) {
    if (err instanceof SnapshotError && err.reason === "not-found") {
      report.step("snapshot", "skipped", `no store at ${storePath(home)} yet; nothing to snapshot`);
      return null;
    }
    throw err;
  }
}

/** HM1-R-F2: restore only when the live store differs from the snapshot; the replaced store is kept and named. */
async function restoreStore({ report, home, snapshotId, manual, affected = [] }) {
  if (!snapshotId) return;
  const opts = { stateDir: home, baseDbPath: storePath(home), snapshotsDir: snapshotsDirOf(home), id: snapshotId };
  try {
    const cmp = await compareStoreWithSnapshot(opts);
    if (cmp.unchanged) {
      report.step("restore", "skipped", `the store is unchanged since ${snapshotId}`);
      return;
    }
  } catch {
    // unreadable comparison: restore as HM1 does
  }
  try {
    const r = await restoreSnapshot(opts);
    report.step("restore", "ok", `store restored from ${snapshotId}${r.preRestorePath ? `; the replaced store is kept at ${r.preRestorePath}` : ""}`);
    if (r.preRestorePath) {
      report.set("preRestorePath", r.preRestorePath);
      report.note(`The store as it was before the rollback (with anything written after the snapshot${affected.length ? `, including what ${affected.map((o) => `${o.agentId} (${o.home})`).join(", ")} captured meanwhile` : ""}) is kept at ${r.preRestorePath}. Nothing deletes it except \`--uninstall --purge\`; remove it yourself once you no longer need it.`);
    }
  } catch (err) {
    manual.push(`restore the store at ${storePath(home)} from ${join(snapshotsDirOf(home), snapshotId)}${err?.preRestorePath ? ` (the replaced store is at ${err.preRestorePath})` : ""}`);
  }
}

const stripProgress = (s) => {
  const out = { ...s };
  delete out.update;
  delete out.inProgress;
  return out;
};

/**
 * @param {object} ctx main.mjs's context (flags, env, platform, arch, report, feed, release, run, fetchImpl, prompt, isTTY,
 *   testMode, now, lang) plus, from install.mjs, det, hermes, hermesHome, state, binding and `resume`.
 * @returns {Promise<number>}
 */
export async function runHermesUpdate(ctx) {
  const { flags, env, platform, report, feed, run, testMode } = ctx;
  const now = ctx.now ?? Date.now;
  const { det, hermesHome, hermes, state, binding } = await hermesContext(ctx);
  report.set("mode", "update");

  const interrupted = state?.inProgress ?? null;
  if (interrupted && interrupted.op !== "update") {
    throw new Stop(EXIT.NEEDS_CHOICE, "resume", `an interrupted ${interrupted.op} (step ${interrupted.step}) is in ${hermesHome}: re-run ${interrupted.op === "install" ? "the installer without --update to finish it" : `with --${interrupted.op}`}, or with --rollback; nothing was changed`);
  }
  if (!binding || binding.invalid || !state) throw new Stop(EXIT.FAILED, "existing", `plur1bus is not installed in ${hermesHome} (no binding or installer state); run the installer without --update; nothing was changed`);

  const home = binding.home;
  const bin = binding.bin ?? state.bin ?? sidecarBinPath({ platform, env, homedir: ctx.homedir });
  const agentId = binding.agentId;
  const p1 = (b = bin) => createPlur1busCli({ bin: b, home, env, run, platform });

  if (interrupted) {
    report.set("interrupted", { op: "update", step: interrupted.step });
    if (flags["dry-run"]) {
      report.step("resume", "planned", `interrupted update at step ${interrupted.step}: re-running finishes it; --rollback undoes it`);
      return report.finish(EXIT.OK);
    }
    removeStaging(hermesHome);
    removeStaleBinTemps(bin);
    const s = { ...state, update: { ...state.update } };
    if (flags.rollback || interrupted.step === "rollback-failed" || interrupted.step === "rollback") {
      report.step("resume", "info", `interrupted update at step ${interrupted.step}; rolling it back`);
      return rollbackUpdate({ ...ctx, hermes, hermesHome, s, home, bin, reason: flags.rollback ? "rollback requested" : "finishing a failed rollback" });
    }
    const toVersion = s.update.toVersion;
    const release = feed.hosts.hermes.releases.find((r) => r.version === toVersion);
    if (!release) {
      report.step("resume", "info", `interrupted update to ${toVersion}, which the feed no longer carries; rolling it back`);
      return rollbackUpdate({ ...ctx, hermes, hermesHome, s, home, bin, reason: "the target release is gone" });
    }
    report.step("resume", "info", `interrupted update at step ${interrupted.step}; finishing it (steps already done are checked and skipped)`);
    return applyUpdate({ ...ctx, det, hermes, hermesHome, home, bin, agentId, p1, release, s, resuming: true, now });
  }
  if (flags.rollback) throw new Stop(EXIT.FAILED, "rollback", "nothing to roll back: no interrupted installer run was found; nothing was changed");

  const release = ctx.release;
  const installed = binding.version ?? state.installedVersion ?? null;
  const sidecar = readSidecar({ home });
  const sidecarVersion = sidecar && !sidecar.invalid ? sidecar.binaryVersion : null;
  const sidecarUpdate = !existsSync(bin) || !sidecarVersion || compareVersions(sidecarVersion, release.sidecar.version) < 0;
  report.set("installedVersion", installed);
  report.set("sidecarVersion", sidecarVersion);
  if (sidecar?.invalid) throw new Stop(EXIT.INCOMPATIBLE, "compat", `sidecar-manifest-invalid: ${home}/manifest.json is ${sidecar.invalid}; run \`plur1bus --home "${home}" 1staid repair\`; nothing was changed`);
  if (sidecar && sidecar.profile !== "host") throw new Stop(EXIT.INCOMPATIBLE, "compat", `harness-present: ${home} is a full PLUR1BUS harness, not a host sidecar; nothing was changed`);

  const providerCmp = installed === null ? -1 : compareVersions(installed, release.version);
  if (providerCmp === 0 && !sidecarUpdate) {
    report.step("update", "ok", `up-to-date: plur1bus ${installed} (sidecar ${sidecarVersion})`);
    return report.finish(EXIT.OK);
  }
  if (providerCmp > 0) {
    report.step("update", "skipped", `the installed ${installed} is newer than the feed's ${release.version}; nothing to do`);
    return report.finish(EXIT.OK);
  }

  // ── release notes, before anything changes (D78) ─────────────────────────
  const lang = ctx.lang ?? "en";
  const notes = hermesNotesBetween(feed, installed, release.version, lang);
  report.set("releaseNotes", notes.map((n) => ({ version: n.version, lang: n.lang, security: n.security })));
  report.note(`Update available: plur1bus for Hermes ${installed ?? "(unknown)"} → ${release.version}${sidecarUpdate ? ` (sidecar ${sidecarVersion ?? "?"} → ${release.sidecar.version})` : ""}`);
  for (const n of notes) {
    report.note(`── ${n.version}${n.security ? " (security fix)" : ""} ──`);
    for (const l of n.text.split(/\r?\n/)) report.note(`  ${l}`);
  }

  // ── compatibility (reads only) ────────────────────────────────────────────
  const target = resolveTarget({ platform, arch: ctx.arch, glibcVersion: ctx.glibcVersion, rosetta: ctx.rosetta });
  const findings = [];
  if (sidecarUpdate && !target.supported) findings.push(`unsupported-target: ${target.detail}`);
  if (det.version !== null && compareVersions(det.version, release.minHermesVersion) < 0) findings.push(`hermes-too-old: Hermes ${det.version} is older than ${release.minHermesVersion}; run \`hermes update\` first`);
  if (findings.length) throw new Stop(EXIT.INCOMPATIBLE, "compat", `${findings.join("; ")}; nothing was changed`);

  if (flags["dry-run"]) {
    if (sidecarUpdate) {
      report.step("snapshot", "planned", `store at ${storePath(home)} → ${snapshotsDirOf(home)} (pre-${release.version})`);
      report.step("sidecar", "planned", `${release.sidecar.binary[target.target]?.url} → ${bin}`);
      report.step("setup", "planned", `plur1bus --home ${home} setup --profile host --non-interactive`);
    }
    report.step("provider", "planned", `${release.provider.url} → ${providerDir(hermesHome)}`);
    return report.finish(EXIT.OK);
  }

  // a sidecar update stops and changes the core every bound Hermes home uses (T9 review 7)
  let others = [];
  if (sidecarUpdate) {
    try {
      others = otherBoundHomes(home, hermesHome, platform);
    } catch {
      others = [];
    }
    if (others.length) {
      report.note(`The sidecar update also affects the other Hermes homes bound to ${home}: ${others.map((o) => `${o.agentId} (${o.home})`).join(", ")}. Their providers keep working against the new sidecar; run --update in each to update their providers too.`);
      report.set("affectedHomes", others);
    }
  }

  // ── Now / Later / Skip ───────────────────────────────────────────────────
  if (!flags.yes) {
    if (!ctx.isTTY || flags["non-interactive"]) {
      throw new Stop(EXIT.NEEDS_CHOICE, "update", `update ${installed ?? "?"} → ${release.version} needs a choice and there is no TTY to ask: re-run with --update --yes to update now; nothing was changed`);
    }
    const a = String((await ctx.prompt(`Update to ${release.version}? Now / Later / Skip [n/l/s, default l]: `)) ?? "").trim().toLowerCase();
    if (a === "s" || a === "skip") {
      report.step("update", "skipped", `skipped ${release.version}; nothing was changed`);
      return report.finish(EXIT.OK);
    }
    if (a !== "n" && a !== "now") {
      report.step("update", "skipped", "later: run the installer with --update when you are ready; nothing was changed");
      return report.finish(EXIT.OK);
    }
  }

  // F3: the recorded use class goes explicitly to setup
  let useClass = null;
  const got = existsSync(bin) ? await p1().configGet("embedding.useClass") : { set: false };
  if (got.set && USE_CLASSES.includes(got.value)) useClass = got.value;
  else if (USE_CLASSES.includes(state.useClass)) useClass = state.useClass;
  // else unknown: no --use-class at all, so setup keeps whatever it recorded (F3), never an explicit "general"
  const acceptNc = Boolean(state.licence?.acceptNonCommercialLicense);

  const s = {
    ...stripProgress(state),
    update: { fromVersion: installed, toVersion: release.version, sidecarUpdate, useClass, acceptNc, affectedHomes: others },
  };
  return applyUpdate({ ...ctx, det, hermes, hermesHome, home, bin, agentId, p1, release, s, resuming: false, now, target });
}

async function applyUpdate(ctx) {
  const { report, env, hermes, hermesHome, home, bin, agentId, p1, release, s, resuming, testMode, now } = ctx;
  const u = s.update;
  const target = ctx.target ?? resolveTarget({ platform: ctx.platform, arch: ctx.arch, glibcVersion: ctx.glibcVersion, rosetta: ctx.rosetta });
  const save = (step) => writeHermesState(hermesHome, { ...s, inProgress: { op: "update", step, version: u.toVersion } });
  const killAt = (point) => {
    if (testMode && env.PLUR1BUS_PLUGIN_TEST_KILL_AT === point) process.kill(process.pid, "SIGKILL");
  };
  const rb = (reason) => rollbackUpdate({ ...ctx, s, reason });

  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-hermes-"));
  try {
    // the provider tarball, verified before anything changes
    const tbytes = await fetchBytes(release.provider.url, { testMode, fetchImpl: ctx.fetchImpl, maxBytes: MAX_PROVIDER_BYTES, id: "provider" });
    const tdigest = sha256Hex(tbytes);
    if (tdigest !== release.provider.sha256) {
      if (resuming) {
        report.step("download", "failed", "provider SHA-256 does not match the feed");
        return rb("download");
      }
      throw new Stop(EXIT.FAILED, "provider", `SHA-256 of ${release.provider.url} (${tdigest.slice(0, 12)}…) does not match the feed (${release.provider.sha256.slice(0, 12)}…); nothing was changed`);
    }
    const tarball = join(tmp, `plur1bus-hermes-provider-${release.version}.tar.gz`);
    writeFileSync(tarball, tbytes, { mode: 0o600 });
    report.step("download", "ok", `provider ${release.version}: SHA-256 matches the feed`);

    if (u.sidecarUpdate) {
      // ── stop the sidecar ─────────────────────────────────────────────────
      save("stop");
      if (existsSync(bin) && !u.daemonStopped) {
        // what ran before: the rollback restarts only that (T9 review 6)
        const svc = await p1().serviceStatus();
        const ds = await p1().daemonStop();
        u.serviceRegistered = svc.registered === true;
        u.wasRunning = ds.ok ? ds.doc?.wasRunning !== false : true;
        if (!ds.ok) {
          report.step("stop", "failed", `plur1bus daemon stop failed (${ds.detail})`);
          return rb("stop");
        }
      }
      u.daemonStopped = true;
      save("stop");
      killAt("update.daemon-stopped");

      // ── the home's manifest.json and config.json, byte for byte ──────────
      if (!u.homeBackup) {
        u.homeBackup = saveHomeFiles(home, now);
        save("home");
        report.step("home-backup", "ok", `${HOME_FILES.join(", ")} saved to ${u.homeBackup.dir}`);
      }
      killAt("update.home-saved");

      // ── the store snapshot (F18) ─────────────────────────────────────────
      if (!u.snapshotDone) {
        save("snapshot");
        try {
          u.snapshotId = await snapshotStore({ report, home, label: `pre-${u.toVersion}`, now });
        } catch (err) {
          report.step("snapshot", "failed", err?.message ?? String(err));
          return rb("snapshot");
        }
        u.snapshotDone = true;
        save("snapshot");
      }
      killAt("update.snapshotted");

      // ── the pinned binary ────────────────────────────────────────────────
      save("sidecar");
      const binArt = release.sidecar.binary[target.target];
      if (resuming && u.sidecarInstalled && binArt && binaryMatches({ bin, sha256: binArt.sha256 })) {
        report.step("sidecar", "skipped", `${bin} already holds the release's binary (installed by the interrupted run)`);
      } else {
        try {
          await installSidecar({
            release, target: target.target, bin, fetchImpl: ctx.fetchImpl, testMode, now, platform: ctx.platform,
            ownBin: Boolean(resuming && u.sidecarInstalled && (u.binFresh || (u.previousBin && existsSync(u.previousBin)))),
            previousBinName: u.previousBin ?? null,
            onPoint: killAt,
            beforeChange: ({ fresh, previousBin }) => {
              if (!u.sidecarInstalled) Object.assign(u, { binFresh: fresh, previousBin });
              u.sidecarInstalled = true;
              save("sidecar");
            },
          });
        } catch (err) {
          report.step("sidecar", "failed", err?.message ?? String(err));
          return rb("sidecar");
        }
        report.step("sidecar", "ok", `${binArt.url} → ${bin} (SHA-256 matches the feed; the previous binary is kept until the update finishes)`);
      }

      // ── setup --profile host with the new binary ─────────────────────────
      u.setupRan = true;
      save("setup");
      const noService = testMode && env.PLUR1BUS_PLUGIN_TEST_NO_SERVICE === "1";
      const st = await p1().setup({ useClass: u.useClass, acceptNc: u.acceptNc, noService });
      const after = readSidecar({ home });
      if (!st.ok || !after || after.invalid || after.profile !== "host") {
        report.step("setup", "failed", st.ok ? `no host manifest in ${home} after setup` : `plur1bus setup --profile host failed (${st.detail})`);
        return rb("setup");
      }
      report.step("setup", "ok", `plur1bus setup --profile host in ${home} (${u.useClass ? `use class ${u.useClass}, kept` : "the recorded use class kept by setup"})`);
    }

    // ── provider directory ─────────────────────────────────────────────────
    save("provider");
    const pdir = providerDir(hermesHome);
    if (resuming && u.providerInstalled && existsSync(pdir) && checkProviderDir(pdir, { version: release.version }).ok) {
      report.step("provider", "skipped", `${pdir} already holds provider ${release.version}`);
    } else {
      try {
        if (!u.providerInstalled) {
          u.providerPreexisted = existsSync(pdir);
          u.providerPrev = u.providerPreexisted ? previousProviderPath(hermesHome, now) : null;
          u.providerInstalled = true;
          save("provider");
        } else if (existsSync(pdir) && providerDirIsOurs({ preexisted: u.providerPreexisted, previousDir: u.providerPrev })) {
          rmSync(pdir, { recursive: true, force: true }); // our own partial copy
        }
        await installProvider({ hermesHome, tarball, sha256: release.provider.sha256, version: release.version, now, previousDirName: u.providerPrev ?? null, onPoint: killAt });
      } catch (err) {
        report.step("provider", "failed", err?.message ?? String(err));
        return rb("provider");
      }
      report.step("provider", "ok", `${pdir} (provider ${release.version}, MANIFEST.json verified; the previous directory is kept until the update finishes)`);
    }

    // ── binding ────────────────────────────────────────────────────────────
    save("binding");
    try {
      if (!u.bindingWritten) {
        u.bindingPrev = existsSync(bindingPath(hermesHome)) ? readFileSync(bindingPath(hermesHome), "utf8") : null;
        u.bindingWritten = true;
        save("binding");
      }
      killAt("binding.before");
      writeBinding(hermesHome, makeBinding({ home, bin, agentId, version: release.version }));
    } catch (err) {
      report.step("binding", "failed", err?.message ?? String(err));
      return rb("binding");
    }
    report.step("binding", "ok", `${bindingPath(hermesHome)} → version ${release.version}`);

    // ── verify (read-only) ─────────────────────────────────────────────────
    save("verify");
    const ms = await hermes.memoryStatus();
    const msOk = ms.provider === PROVIDER_NAME && ms.available !== false;
    report.step("verify.memory-status", msOk ? "ok" : "failed", ms.detail);
    const forced = selftestForcedToFail({ testMode, env });
    const self = msOk ? await hermes.selftest() : { ok: false, detail: "not run" };
    const selfOk = self.ok && !forced;
    report.step("verify.selftest", selfOk ? "ok" : "failed", forced ? "TEST ONLY: forced to fail" : self.detail);
    if (!msOk || !selfOk) return rb("verify");

    // ── done ───────────────────────────────────────────────────────────────
    dropPreviousBin(u.previousBin);
    dropPreviousProvider(u.providerPrev);
    if (u.homeBackup) rmSync(u.homeBackup.dir, { recursive: true, force: true });
    writeHermesState(hermesHome, { ...stripProgress(s), installedVersion: release.version });
    report.note(`Updated the plur1bus memory provider for Hermes to ${release.version}${u.sidecarUpdate ? ` (sidecar ${release.sidecar.version})` : ""}.`);
    if (u.snapshotId) report.note(`The store snapshot ${u.snapshotId} under ${snapshotsDirOf(home)} is kept (pruned with later snapshots).`);
    return report.finish(EXIT.OK);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Undo an update from its recorded progress `s.update`. Exit 1, or 4 with manual steps (the state then reads
 * `rollback-failed`, and the next run finishes the rollback).
 */
export async function rollbackUpdate(ctx) {
  const { report, env, hermesHome, home, bin, s, run, platform, testMode } = ctx;
  const u = s.update ?? {};
  const manual = [];
  const done = [];
  const p1 = (b = bin) => createPlur1busCli({ bin: b, home, env, run, platform });
  // a killed rollback resumes as a rollback, never as the update (T9 review 4)
  writeHermesState(hermesHome, { ...s, inProgress: { op: "update", step: "rollback", version: u.toVersion ?? null } });
  const killAt = (point) => {
    if (testMode && env.PLUR1BUS_PLUGIN_TEST_KILL_AT === point) process.kill(process.pid, "SIGKILL");
  };
  removeStaging(hermesHome);
  removeStaleBinTemps(bin);

  if (u.sidecarUpdate && u.daemonStopped) {
    // 1. the new binary stops, the previous one comes back and sets its runtime up again
    if (existsSync(bin)) await p1().daemonStop();
    if (u.sidecarInstalled) {
      try {
        const r = restoreSidecarBin({ bin, fresh: u.binFresh, previousBin: u.previousBin });
        if (r !== "kept") done.push(r === "restored" ? "previous sidecar binary restored" : "sidecar binary removed");
      } catch {
        manual.push(u.previousBin ? `rename ${u.previousBin} to ${bin}` : `remove ${bin}`);
      }
    }
    killAt("update.rollback-binary");
    if (u.setupRan && manual.length === 0 && existsSync(bin)) {
      const noService = testMode && env.PLUR1BUS_PLUGIN_TEST_NO_SERVICE === "1";
      const st = await p1().setup({ useClass: u.useClass ?? null, acceptNc: Boolean(u.acceptNc), noService });
      if (st.ok) done.push("setup re-run with the previous binary");
      else manual.push(`plur1bus --home "${home}" setup --profile host --non-interactive${u.useClass ? ` --use-class ${u.useClass}` : ""} (failed: ${st.detail})`);
      await p1().daemonStop();
    }
    // 2. manifest.json and config.json byte for byte
    if (u.homeBackup) {
      try {
        restoreHomeFiles(home, u.homeBackup);
        done.push(`${HOME_FILES.join(" and ")} restored`);
      } catch {
        manual.push(`copy ${HOME_FILES.join(" and ")} back from ${u.homeBackup.dir} to ${home}`);
      }
    }
    // 3. the store, only when it changed (HM1-R-F2)
    await restoreStore({ report, home, snapshotId: u.snapshotId ?? null, manual, affected: u.affectedHomes ?? [] });
    // 4. the sidecar runs again, only when it ran before the update (`daemon start` goes through the registered
    // service when there is one)
    if (existsSync(bin) && u.wasRunning !== false) {
      const ds = await p1().daemonStart();
      if (ds.ok) done.push(u.serviceRegistered ? "sidecar started through its service" : "sidecar daemon started");
      else manual.push(`plur1bus --home "${home}" daemon start`);
    } else if (u.wasRunning === false) {
      done.push("the sidecar stays stopped, as it was before the update");
    }
  }

  // 5. the previous provider directory (memory.provider stays plur1bus: the previous version serves it)
  if (u.providerInstalled) {
    try {
      const r = await restoreProvider({ hermesHome, previousDir: u.providerPrev ?? null, preexisted: Boolean(u.providerPreexisted) });
      if (r === "restored") done.push("previous provider directory restored");
    } catch {
      manual.push(`remove ${providerDir(hermesHome)} and rename ${u.providerPrev} to ${providerDir(hermesHome)}`);
    }
  }
  // 6. the binding
  if (u.bindingWritten && u.bindingPrev) {
    try {
      writeFileAtomic(bindingPath(hermesHome), u.bindingPrev);
      done.push("previous binding restored");
    } catch {
      manual.push(`restore ${bindingPath(hermesHome)}`);
    }
  }

  report.set("rollback", { reason: ctx.reason, done });
  if (manual.length) {
    writeHermesState(hermesHome, { ...s, inProgress: { op: "update", step: "rollback-failed", version: u.toVersion ?? null } });
    report.step("rollback", "failed", `manual steps needed: ${manual.join("; ")}`);
    report.set("manualSteps", manual);
    report.note("Rollback failed. Do these steps yourself:");
    for (const m of manual) report.note(`  ${m}`);
    return report.finish(EXIT.ROLLBACK_FAILED);
  }
  if (u.homeBackup) rmSync(u.homeBackup.dir, { recursive: true, force: true });
  writeHermesState(hermesHome, stripProgress(s));
  report.step("rollback", "ok", done.length ? done.join("; ") : "nothing had changed");
  return report.finish(EXIT.FAILED);
}

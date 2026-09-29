/**
 * scripts/dist/installer/legacy.mjs — adoption of a legacy rsync deploy (ruling HM1-R9,
 * fact g, Review Focus 1).
 *
 * Legacy deploy ⇔ `<stateDir>/extensions/memory-lancedb-namespaced` exists and
 * `plugins inspect --json` shows no `/install` record. Guard ⇔ the file
 * `<stateDir>/scripts/protect-plur1bus-deploy.sh` exists, or (POSIX) an uncommented line
 * of `crontab -l` contains `protect-plur1bus-deploy`. The crontab is only ever listed
 * (through the injectable runner), the matched line is never printed, and the installer
 * never edits it: with a guard, `--adopt-legacy` exits 3 `legacy-deploy-guard` and prints
 * the steps to disable it.
 *
 * Adoption: snapshot → rename the legacy dir to `<stateDir>/extensions/.plur1bus-legacy-<ts>`
 * (kept, never deleted) → `openclaw plugins install <spec> --force --accept-capabilities`
 * → `hooks.allowConversationAccess` (R-S1) and `plugins.slots.memory` (R-S5) → verify →
 * on failure uninstall, rename the legacy dir back, restore the snapshot when the store
 * differs from it (HM1-R-F2; the replaced store is kept at `.pre-restore-*`) and the previous
 * config values. `memory-lancedb-stock` and `plur1bus-release` are never touched. The
 * embedding choice the legacy deploy ran with is never changed (HM1-R10). Every step is
 * written to the installer state first, so an interrupted adoption is continued or, with
 * --rollback, undone by the next run.
 */

import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

import { whichOnPath } from "./detect.mjs";
import { isReadonlyRefusal, PLUGIN_ID, failureSummary } from "./openclaw-cli.mjs";
import { EXIT, Stop } from "./report.mjs";
import { writeState } from "./state.mjs";
import {
  assertOfflineTarball,
  downloadReleaseTarball,
  finishRollbackFailed,
  installSpec,
  manualRestoreLines,
  notePreRestore,
  removeWorkDir,
  restoreStep,
  snapshotStep,
  storeOutcome,
  waitForGatewayStopped,
} from "./update.mjs";
import { renameWithRetry } from "./fsutil.mjs";
import { selftestForcedToFail, verifyInstall } from "./verify.mjs";
import { keepArtefact, pruneArtefacts } from "./artefacts.mjs";

export const GUARD_NAME = "protect-plur1bus-deploy";
const SLOT = "plugins.slots.memory";
const ALLOW_CONVERSATION = `plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess`;

/** join with the separator style of `base` (a win32 state dir keeps backslashes). */
function joinLike(base, ...parts) {
  const p = /\\/.test(base) && !base.startsWith("/") ? win32 : posix;
  return p.join(base, ...parts);
}

export function legacyDirOf(stateDir) {
  return joinLike(stateDir, "extensions", PLUGIN_ID);
}

export function guardFileOf(stateDir) {
  return joinLike(stateDir, "scripts", `${GUARD_NAME}.sh`);
}

/**
 * @param {{ stateDir: string, inspectJson: any, exists?: (p: string) => boolean, crontab?: string|null|(() => string|null) }} a
 * @returns {{ untracked: boolean, guard: boolean, guardSource?: "file"|"crontab" }}
 */
export function detectLegacyDeploy({ stateDir, inspectJson, exists = existsSync, crontab = null }) {
  const tracked = Boolean(inspectJson && typeof inspectJson === "object" && inspectJson.install && typeof inspectJson.install === "object");
  const untracked = exists(legacyDirOf(stateDir)) && !tracked;
  if (exists(guardFileOf(stateDir))) return { untracked, guard: true, guardSource: "file" };
  const text = typeof crontab === "function" ? crontab() : crontab;
  if (typeof text === "string") {
    const hit = text.split(/\r?\n/).some((line) => {
      const t = line.trim();
      return t !== "" && !t.startsWith("#") && t.includes(GUARD_NAME);
    });
    if (hit) return { untracked, guard: true, guardSource: "crontab" };
  }
  return { untracked, guard: false };
}

/**
 * `crontab -l` through the injectable runner (POSIX only); null when there is none.
 * The text stays in memory for the match and is never reported.
 */
export async function readCrontab({ run, env, platform }) {
  if (platform === "win32") return null;
  const bin = whichOnPath("crontab", { env, platform });
  if (!bin) return null;
  const r = await run(bin, ["-l"], { env, timeoutMs: 15_000 });
  return r.code === 0 ? String(r.stdout ?? "") : null;
}

function guardSteps({ report, stateDir, guardSource }) {
  const file = guardFileOf(stateDir);
  report.note(`The deploy guard ${GUARD_NAME}.sh restores ${legacyDirOf(stateDir)} from its release copy every 15 minutes and would silently revert an adoption.`);
  report.note("Disable it, then adopt:");
  report.note(`  1. Run \`crontab -e\` and comment out or delete the line that runs ${GUARD_NAME}.sh (the installer never edits your crontab).`);
  report.note(`  2. ${existsSync(file) ? `Move ${file} out of the way, e.g. rename it to ${GUARD_NAME}.sh.disabled.` : `Make sure no copy of ${GUARD_NAME}.sh remains under ${joinLike(stateDir, "scripts")}.`}`);
  report.note("  3. Re-run the installer with --adopt-legacy.");
  report.set("guard", { source: guardSource });
}

/** `<state>/extensions/.plur1bus-legacy-<ts>`, with `-2`, `-3`… when that name is taken. */
function uniqueBackup(stateDir, ts) {
  const first = joinLike(stateDir, "extensions", `.plur1bus-legacy-${ts}`);
  if (!existsSync(first)) return first;
  for (let k = 2; ; k++) {
    const p = `${first}-${k}`;
    if (!existsSync(p)) return p;
  }
}

function stamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * @param {{ cli: any, report: any, feed: any, release: any, stateDir: string, baseDbPath: string, flags: any, now: () => number,
 *   run: any, childEnv: any, platform: string, testMode?: boolean, fetchImpl?: any, tgz?: string|null, state?: any, resume?: any }} ctx
 * @returns {Promise<number>}
 */
export async function runAdoptLegacy(ctx) {
  const { cli, report, release, stateDir, flags, now } = ctx;
  report.set("mode", "adopt-legacy");
  if (ctx.resume) return resumeAdopt(ctx);

  const existing = await cli.inspect(PLUGIN_ID);
  if (!existing.present && !existing.notFound) throw new Stop(EXIT.FAILED, "existing", `openclaw plugins inspect failed (exit ${existing.code}): ${existing.detail}`);
  if (existing.installed) throw new Stop(EXIT.FAILED, "legacy", `no legacy deploy: ${PLUGIN_ID} is a tracked install (${existing.json.install.version ?? "unknown version"}); use --update; nothing was changed`);
  const crontab = await readCrontab({ run: ctx.run, env: ctx.childEnv, platform: ctx.platform });
  const found = detectLegacyDeploy({ stateDir, inspectJson: existing.present ? existing.json : null, crontab });
  const legacyDir = legacyDirOf(stateDir);
  if (!found.untracked) throw new Stop(EXIT.FAILED, "legacy", `no legacy deploy at ${legacyDir}; nothing to adopt, nothing was changed`);
  if (found.guard) {
    guardSteps({ report, stateDir, guardSource: found.guardSource });
    throw new Stop(EXIT.INCOMPATIBLE, "legacy", `legacy-deploy-guard: ${GUARD_NAME} is active (${found.guardSource === "file" ? guardFileOf(stateDir) : "a line in your crontab"}); nothing was changed`);
  }
  report.step("legacy", "ok", `untracked deploy at ${legacyDir}, no deploy guard`);

  const source = flags.offline ? "offline" : flags.source ?? (release.clawpackDigest ? "clawhub" : "tarball");
  report.set("source", source);
  if (flags["dry-run"]) {
    report.step("snapshot", "planned", `store at ${ctx.baseDbPath}`);
    report.step("rename", "planned", `${legacyDir} → ${joinLike(stateDir, "extensions", ".plur1bus-legacy-<ts>")} (kept)`);
    report.step("install", "planned", `openclaw plugins install <${source} ${release.version}> --force --accept-capabilities`);
    return report.finish(EXIT.OK);
  }

  const previousSlot = await cli.configGet(SLOT);
  const previousAllow = await cli.configGet(ALLOW_CONVERSATION);
  const base = { previousSlot: null, installedVersion: null, source: null };
  let started = false;
  try {
    const target = await adoptSpec(ctx, source);
    const progress = {
      op: "adopt",
      step: "snapshot",
      snapshotId: null,
      targetVersion: release.version,
      source,
      legacyDir,
      legacyBackup: uniqueBackup(stateDir, stamp(now())),
      previousSlot,
      previousAllow,
      written: [],
    };
    started = true;
    return await applyAdopt(ctx, { base, progress, target }, "snapshot");
  } finally {
    if (!started) removeWorkDir(stateDir);
  }
}

async function adoptSpec(ctx, source) {
  const { release } = ctx;
  if (source === "tarball") {
    const d = await downloadReleaseTarball({ release, stateDir: ctx.stateDir, testMode: ctx.testMode, fetchImpl: ctx.fetchImpl });
    ctx.report.step("tarball", "ok", `downloaded ${release.tarball.url}; SHA-256 matches the feed`);
    return installSpec(source, release.version, { file: keepArtefact(ctx.stateDir, release.version, d.file, d.sha256).file });
  }
  if (source === "offline") {
    if (!ctx.tgz) throw new Stop(EXIT.FAILED, "offline", `the adoption installs from a local tarball: re-run with --offline <tgz> of ${release.version}, or with --rollback`);
    assertOfflineTarball(ctx.tgz, release);
    return installSpec(source, release.version, { file: keepArtefact(ctx.stateDir, release.version, ctx.tgz, release.tarball.sha256).file });
  }
  return installSpec(source, release.version, { release });
}

function saver(ctx, plan) {
  return (step) => {
    plan.progress.step = step;
    writeState(ctx.stateDir, { ...plan.base, inProgress: plan.progress });
  };
}

function clear(ctx, plan, extra = {}) {
  writeState(ctx.stateDir, { ...plan.base, ...extra });
  removeWorkDir(ctx.stateDir);
}

async function applyAdopt(ctx, plan, from) {
  const { cli, report, stateDir, baseDbPath, release, now, flags } = ctx;
  const p = plan.progress;
  const save = saver(ctx, plan);
  let step = from;

  if (step === "snapshot") {
    save("snapshot");
    try {
      p.snapshotId = await snapshotStep({ report, stateDir, baseDbPath, label: `pre-adopt-${p.targetVersion}`, pluginVersion: "legacy", now });
    } catch (err) {
      clear(ctx, plan);
      throw err;
    }
    step = "rename";
  }

  if (step === "rename") {
    save("rename");
    if (existsSync(p.legacyDir) && !existsSync(p.legacyBackup)) {
      try {
        renameWithRetry(p.legacyDir, p.legacyBackup);
      } catch (err) {
        clear(ctx, plan);
        throw new Stop(EXIT.FAILED, "rename", `cannot rename ${p.legacyDir} to ${p.legacyBackup}: ${err?.code ?? err?.message}; nothing was changed`);
      }
    }
    report.step("rename", "ok", `legacy deploy kept at ${p.legacyBackup}`);
    step = "install";
  }

  if (step === "install") {
    save("install");
    const r = await cli.install(plan.target.locator, plan.target.opts);
    if (r.code !== 0) {
      const text = `${r.stderr}\n${r.stdout}`;
      report.step("install", "failed", `exit ${r.code}: ${failureSummary(r)}`);
      const after = await cli.inspect(PLUGIN_ID);
      if (!after.installed) {
        // nothing was installed: the legacy plugin never stopped owning the store, so the
        // snapshot is not restored over writes the Gateway made meanwhile
        const code = await rollbackAdopt(ctx, plan, { finish: false, restore: false });
        if (code !== EXIT.FAILED) return code;
        if (isReadonlyRefusal(text)) throw new Stop(EXIT.INCOMPATIBLE, "install", `OpenClaw refused: ${failureSummary(r, 2)}; the legacy deploy is back in place`);
        throw new Stop(EXIT.FAILED, "install", `openclaw plugins install ${plan.target.locator} failed (exit ${r.code}): ${failureSummary(r)}; the legacy deploy is back in place, nothing was changed`);
      }
      return rollbackAdopt(ctx, plan);
    }
    report.step("install", "ok", `openclaw plugins install ${plan.target.locator}`);
    step = "config";
  }

  if (step === "config") {
    save("config");
    try {
      // record the intent first, so an interrupted run knows to restore the previous value
      if (!p.written.includes(ALLOW_CONVERSATION)) p.written.push(ALLOW_CONVERSATION);
      save("config");
      await cli.configSet(ALLOW_CONVERSATION, "true");
      await cli.configSet(SLOT, PLUGIN_ID);
      report.step("slot", "ok", `${SLOT} = ${PLUGIN_ID}; conversation access for capture and recall enabled`);
    } catch (err) {
      report.step("config", "failed", err.message);
      return rollbackAdopt(ctx, plan);
    }
    step = "verify";
  }

  if (step === "verify") {
    save("verify");
    const checks = await verifyInstall({ cli, release, source: p.source, downloadModels: flags["download-models"], stateDir, forceFail: selftestForcedToFail({ testMode: ctx.testMode, env: ctx.childEnv }) });
    for (const c of checks) report.step(`verify.${c.id}`, c.ok ? (c.warn ? "warn" : "ok") : "failed", c.detail);
    if (checks.some((c) => !c.ok)) return rollbackAdopt(ctx, plan);
    const prevSlot = p.previousSlot?.set && p.previousSlot.value !== PLUGIN_ID ? p.previousSlot.value : null;
    clear(ctx, plan, { previousSlot: prevSlot, installedVersion: p.targetVersion, source: p.source });
    pruneArtefacts(ctx.stateDir, [p.targetVersion]);
    report.note(`Adopted the legacy deploy: ${PLUGIN_ID} ${p.targetVersion} is now tracked by OpenClaw.`);
    report.note(`The old deploy is kept at ${p.legacyBackup}; delete it yourself once the adopted plugin runs well. ${joinLike(stateDir, "plur1bus-release")} is no longer needed by the plugin and was left as it is.`);
    report.note("Do not re-enable protect-plur1bus-deploy.sh: it would restore the untracked copy. Restart the Gateway: `openclaw gateway restart`.");
    return report.finish(EXIT.OK);
  }

  if (step === "rollback" || step === "rollback-failed") return rollbackAdopt(ctx, plan);
  throw new Stop(EXIT.FAILED, "resume", `unknown interrupted step ${JSON.stringify(step)}`);
}

/** Undo an adoption: uninstall, rename the legacy dir back, restore the store if it changed (HM1-R-F2) and config. */
async function rollbackAdopt(ctx, plan, { finish = true, restore = true } = {}) {
  const { cli, report, stateDir, baseDbPath } = ctx;
  const p = plan.progress;
  saver(ctx, plan)("rollback");
  const manual = [];

  const now = await cli.inspect(PLUGIN_ID);
  if (now.installed) {
    const un = await cli.uninstall(PLUGIN_ID, { keepFiles: false });
    if (un.code !== 0) manual.push(`openclaw plugins uninstall ${PLUGIN_ID} --force`);
    else report.step("rollback.uninstall", "ok", `uninstalled the tracked ${PLUGIN_ID}`);
  }
  if (existsSync(p.legacyBackup)) {
    if (existsSync(p.legacyDir)) manual.push(`move ${p.legacyDir} aside, then rename ${p.legacyBackup} back to ${p.legacyDir}`);
    else {
      try {
        renameWithRetry(p.legacyBackup, p.legacyDir);
        report.step("rollback.rename", "ok", `legacy deploy back at ${p.legacyDir}`);
      } catch (err) {
        manual.push(`rename ${p.legacyBackup} back to ${p.legacyDir} (${err?.code ?? err?.message})`);
      }
    }
  }
  const restored = await restoreStep({ report, stateDir, baseDbPath, snapshotId: restore ? p.snapshotId : null, gate: () => waitForGatewayStopped(ctx) });
  manual.push(...restored.manual);

  const leftSet = [];
  if (p.written.includes(ALLOW_CONVERSATION)) {
    if (p.previousAllow?.set) {
      try {
        await cli.configSet(ALLOW_CONVERSATION, p.previousAllow.value);
      } catch {
        manual.push(`openclaw config set ${ALLOW_CONVERSATION} ${p.previousAllow.value}`);
      }
    } else leftSet.push(ALLOW_CONVERSATION);
  }
  if (p.previousSlot?.set && p.previousSlot.value !== "memory-core") {
    try {
      await cli.configSet(SLOT, p.previousSlot.value);
    } catch {
      manual.push(`openclaw config set ${SLOT} ${p.previousSlot.value}`);
    }
  }
  if (leftSet.length) report.note(`Left set after the rollback (no previous value, no unset route): ${leftSet.join(", ")}`);
  report.set("rollback", { leftSet });

  if (manual.length === 0) {
    const check = await cli.inspect(PLUGIN_ID);
    if (!(check.present && !check.installed) && existsSync(p.legacyDir)) manual.push(`check the legacy deploy at ${p.legacyDir}: openclaw plugins inspect ${PLUGIN_ID} --json (exit ${check.code})`);
    if (manual.length) manual.push(...manualRestoreLines({ stateDir, baseDbPath, snapshotId: p.snapshotId, preRestorePath: restored.preRestorePath }));
  }

  notePreRestore(report, restored.preRestorePath);
  if (manual.length === 0) {
    clear(ctx, plan);
    report.step("rollback", "ok", `legacy deploy restored at ${p.legacyDir}${restore ? storeOutcome(restored, p.snapshotId) : ""}`);
    return finish ? report.finish(EXIT.FAILED) : EXIT.FAILED;
  }
  p.step = "rollback-failed";
  writeState(stateDir, { ...plan.base, inProgress: p });
  report.note("Re-running the installer with --rollback retries these steps.");
  return finishRollbackFailed(report, [...new Set(manual)]);
}

/** Continue (or with --rollback undo) an adoption a previous run did not finish. */
async function resumeAdopt(ctx) {
  const { report, flags } = ctx;
  const p = ctx.resume;
  report.step("resume", "info", `interrupted adoption of the legacy deploy (${p.targetVersion}) at step ${p.step}; ${flags.rollback ? "rolling it back" : "continuing it"}`);
  const plan = { base: { previousSlot: null, installedVersion: null, source: null }, progress: { written: [], ...p }, target: null };
  if (p.step === "snapshot") {
    clear(ctx, plan);
    if (flags.rollback) {
      report.step("rollback", "ok", "nothing had changed yet");
      return report.finish(EXIT.FAILED);
    }
    return runAdoptLegacy({ ...ctx, resume: null });
  }
  if (flags.rollback || p.step === "rollback" || p.step === "rollback-failed" || !ctx.release) return rollbackAdopt(ctx, plan);
  let from = p.step;
  if (from === "rename" && !existsSync(p.legacyDir) && existsSync(p.legacyBackup)) from = "install";
  if (from === "rename" || from === "install") {
    try {
      plan.target = await adoptSpec(ctx, p.source);
    } catch (err) {
      report.step("resume", "warn", `${err?.message ?? err}; rolling back`);
      return rollbackAdopt(ctx, plan);
    }
  }
  return applyAdopt(ctx, plan, from);
}

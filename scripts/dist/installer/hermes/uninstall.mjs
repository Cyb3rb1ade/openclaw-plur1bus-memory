/**
 * scripts/dist/installer/hermes/uninstall.mjs — `install-plugin --host hermes --uninstall [--purge]` (HM2 Task 9, D89).
 *
 * Every check and confirmation comes before the first change. A `plugins/plur1bus` the installer does not own (no
 * installer state or binding, and no plur1bus provider MANIFEST.json) is refused (exit 2). Then, in HM2-R17a order:
 * memory.provider back to exactly what was there before the install — the install's recorded line-edit undo
 * (`planProviderUndo`: an inserted or appended line removed, the original line restored, a config.yaml the install
 * created removed) while the line still reads `plur1bus`; else `hermes config set <raw previous>|unset` from a parsed
 * 0.21.5; else a line edit to the raw previous value (said so in the output). A value that cannot be read stops the
 * uninstall before any change; a provider the user switched to since is left alone. Backups: one only while the
 * change is in flight; the install's `config.yaml.plur1bus-bak-*` and the uninstall's own go once it is verified.
 * → the provider directory renamed to `plugins/.plur1bus-removed-<ts>`, then deleted → the binding removed → this
 * home's registry entry removed (under the registry lock). The agent, the store and the sidecar stay. The capture
 * journal `$HERMES_HOME/plur1bus/journal.ndjson` stays and its path and entry count are printed (F28).
 *
 * `--purge` additionally deletes the sidecar — only when `<home>/manifest.json` says `profile: "host"`, every agent
 * of `agent list` starts with `hermes-`, and no other Hermes home is bound in `hosts/hermes-bindings.json` (F4;
 * checked before the confirmations and again under the registry lock right before the deletion) — after two
 * interactive confirmations or `--yes-delete-memories` (non-interactive without it → exit 2, nothing changed). After the
 * uninstall steps: `daemon stop` (must succeed) and `service uninstall` outside the lock (they can outlast its
 * 60 s staleness), then under the lock the guard again, `assertHeld`, and the home with its snapshots and any
 * `.pre-restore-*` store copy is deleted; then the binary (and a kept `.prev-*`) and the journal directory
 * `$HERMES_HOME/plur1bus/`. A purge the early guard refuses changes nothing (exit 2, the reason named). A late
 * refusal (another home bound meanwhile, or the lock lost) leaves the provider uninstalled, keeps the home, says how
 * to start the sidecar again, and exits 1; it never asks you to delete the home.
 *
 * An interrupted uninstall is finished by the next `--uninstall` run; `--rollback` undoes it while the provider
 * directory still sits at its `.plur1bus-removed-<ts>` name (after that, only finishing is possible). A purge is never
 * rolled back.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { renameWithRetry, rmTree, writeFileAtomic } from "../fsutil.mjs";
import { EXIT, Stop } from "../report.mjs";
import { bindingPath, INSTALLED_BY, otherBoundHomes, RegistryLockLost, RegistryLockTimeout, registerBinding, removeBinding, unregisterLocked, withRegistryLock } from "./binding.mjs";
import { readProviderLine, setProviderLine, undoProviderLine } from "./config-edit.mjs";
import { hermesContext } from "./context.mjs";
import { usesLineEdit } from "./install.mjs";
import { createPlur1busCli } from "./plur1bus-cli.mjs";
import { pluginsDir, PROVIDER_MANIFEST_SCHEMA, providerDir, PROVIDER_NAME, removeStaging } from "./provider.mjs";
import { readSidecar, sidecarBinPath } from "./sidecar.mjs";
import { hermesStatePath, writeHermesState } from "./state.mjs";

export const journalDir = (hermesHome) => join(hermesHome, "plur1bus");
export const journalPath = (hermesHome) => join(journalDir(hermesHome), "journal.ndjson");

/** Entries in the capture journal (one JSON document per line), or null without a journal. */
export function journalCount(hermesHome) {
  try {
    return readFileSync(journalPath(hermesHome), "utf8").split("\n").filter((l) => l.trim() !== "").length;
  } catch {
    return null;
  }
}

/**
 * Can the sidecar home be purged? (F4: never while another Hermes home is bound; never a full harness; never a home
 * that serves an agent other than a Hermes one.) `agents` = null when they could not be listed.
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function purgeGuard({ home, hermesHome, agents, platform }) {
  const reasons = [];
  const m = readSidecar({ home });
  if (!m) reasons.push(`${home} has no install manifest`);
  else if (m.invalid) reasons.push(`${home}/manifest.json is ${m.invalid}`);
  else if (m.profile !== "host") reasons.push(`${home} is a full PLUR1BUS harness (profile ${m.profile}), not a Hermes host sidecar`);
  if (agents === null) reasons.push("its agents could not be listed (`plur1bus agent list` failed)");
  else {
    const foreign = agents.filter((a) => !a.startsWith("hermes-"));
    if (foreign.length) reasons.push(`it serves agents that are not Hermes ones: ${foreign.join(", ")}`);
  }
  try {
    const others = otherBoundHomes(home, hermesHome, platform);
    if (others.length) reasons.push(`other Hermes homes are bound to it: ${others.map((o) => `${o.agentId} (${o.home})`).join(", ")}`);
  } catch (err) {
    reasons.push(`its bindings registry cannot be read (${err?.message ?? err})`);
  }
  return { ok: reasons.length === 0, reasons };
}

async function setProvider({ hermes, hermesHome, lineEdit, value, now }) {
  if (lineEdit) {
    return setProviderLine({ hermesHome, value: value ?? "", now }).backup;
  }
  if (value) await hermes.configSet("memory.provider", value);
  else await hermes.configUnset("memory.provider");
  return null;
}

/**
 * memory.provider back to what it was before the install (T9 review 1). Returns { how, backup } where `backup` is a
 * line-edit backup this call made (removed by the caller once the value is verified).
 */
async function restoreProviderValue({ hermes, hermesHome, lineEdit, state, previous, now, report }) {
  const undo = state?.configEdit?.method === "line" ? state.configEdit.undo : null;
  if (state?.configEdit?.method === "line" && !undo) report.note("Note: the install recorded no undo for its memory.provider line; it is set to the previous value instead.");
  if (undo) {
    try {
      undoProviderLine({ hermesHome, undo, value: PROVIDER_NAME });
      return { how: `the install's line edit undone (${undo.kind}${undo.created ? ", the config file it created removed" : ""})`, backup: null };
    } catch (err) {
      report.note(`Note: the memory.provider line is not the one the install wrote any more (${err?.message ?? err}); it is set to the previous value instead.`);
    }
  }
  const raw = typeof state?.previousProviderRaw === "string" ? state.previousProviderRaw : (previous ?? "");
  if (!lineEdit) {
    if (raw.trim() === "") await hermes.configUnset("memory.provider");
    else await hermes.configSet("memory.provider", raw.trim());
    return { how: raw.trim() === "" ? "hermes config unset" : `hermes config set ${raw.trim()}`, backup: null };
  }
  const backup = setProvider({ hermes, hermesHome, lineEdit: true, value: raw.trim(), now });
  return { how: `line edit to ${raw.trim() === "" ? '""' : raw.trim()}`, backup: await backup };
}

async function readCurrent({ hermes, hermesHome, lineEdit }) {
  let r = null;
  try {
    r = await hermes.configGet("memory.provider");
  } catch {
    r = null;
  }
  if (r?.ok) return r.value;
  return lineEdit ? readProviderLine(hermesHome) : null;
}

/**
 * @param {object} ctx main.mjs's context (flags, env, platform, report, run, prompt, isTTY, testMode, now) plus,
 *   from install.mjs, det, hermes, hermesHome, state and `resume` (an interrupted uninstall with --rollback).
 * @returns {Promise<number>}
 */
export async function runHermesUninstall(ctx) {
  const { flags, env, platform, report, run, testMode } = ctx;
  const now = ctx.now ?? Date.now;
  const { det, hermesHome, hermes, state, binding } = await hermesContext(ctx);
  report.set("mode", "uninstall");
  const lineEdit = usesLineEdit(det.version);
  const interrupted = state?.inProgress ?? null;
  if (interrupted && interrupted.op !== "uninstall") {
    throw new Stop(EXIT.NEEDS_CHOICE, "resume", `an interrupted ${interrupted.op} (step ${interrupted.step}) is in ${hermesHome}: finish it (re-run ${interrupted.op === "update" ? "with --update" : "the installer"}) or undo it with --rollback first; nothing was changed`);
  }
  if (flags["yes-delete-memories"] && !flags.purge) throw new Stop(EXIT.FAILED, "args", "--yes-delete-memories only applies together with --purge; nothing was changed");
  if (flags.rollback) {
    if (!interrupted) throw new Stop(EXIT.FAILED, "rollback", "nothing to roll back: no interrupted installer run was found; nothing was changed");
    return rollbackUninstall({ ...ctx, hermes, hermesHome, s: state, lineEdit, now });
  }

  const s = interrupted ? { ...state, uninstall: { ...state.uninstall } } : { ...(state ?? {}) };
  const home = s.uninstall?.home ?? binding?.home ?? state?.plur1busHome ?? null;
  const bin = s.uninstall?.bin ?? binding?.bin ?? state?.bin ?? sidecarBinPath({ platform, env, homedir: ctx.homedir });
  const agentId = s.uninstall?.agentId ?? binding?.agentId ?? state?.agentId ?? null;
  const purge = Boolean(flags.purge);
  if (interrupted && interrupted.purge && !purge) {
    throw new Stop(EXIT.NEEDS_CHOICE, "resume", "an interrupted --uninstall --purge is in progress: re-run with --uninstall --purge to finish it (the purge asks for its confirmation again); nothing was changed");
  }
  const ours = Boolean(state) || Boolean(binding && !binding.invalid && binding.installedBy === INSTALLED_BY);
  const dirExists = existsSync(providerDir(hermesHome));
  if (!ours && !interrupted && dirExists && !providerManifestIsOurs(hermesHome)) {
    throw new Stop(EXIT.NEEDS_CHOICE, "provider", `${providerDir(hermesHome)} was not installed by this installer (no installer state, no binding, no plur1bus provider MANIFEST.json); it is left alone — remove it yourself if you no longer need it; nothing was changed`);
  }
  const installed = ours || dirExists || Boolean(binding && !binding.invalid);
  if (!installed && !interrupted && !purge) {
    report.step("uninstall", "ok", `plur1bus is not installed in ${hermesHome}; nothing to do`);
    return report.finish(EXIT.OK);
  }

  // ── every check and confirmation before the first change ─────────────────
  const current = interrupted ? undefined : await readCurrent({ hermes, hermesHome, lineEdit });
  if (current === null) throw new Stop(EXIT.FAILED, "provider", "memory.provider cannot be read (`hermes config get memory.provider` failed); the provider directory it may name is kept (HM2-R17a); nothing was changed");
  const previous = s.uninstall?.previousProvider !== undefined ? s.uninstall.previousProvider : (state?.previousProvider ?? null);

  let p1 = null;
  // a purge whose home removal already started (decided under the lock) only finishes it
  // only a home that is already partly deleted (its manifest gone) skips the guard; an intact one is checked again,
  // since another Hermes home may have bound to it since the interrupted run (T10 review 2)
  const removing = Boolean(interrupted && s.uninstall?.homeRemoveStarted && home && !existsSync(join(home, "manifest.json")));
  if (purge && removing) {
    p1 = createPlur1busCli({ bin, home, env, run, platform });
    report.note(`--purge finishes deleting ${home}, which an earlier run had started to delete.`);
    if (!flags["yes-delete-memories"]) {
      if (!ctx.isTTY || flags["non-interactive"]) throw new Stop(EXIT.NEEDS_CHOICE, "purge", "--purge deletes your memories and needs two confirmations; there is no TTY to ask, so pass --yes-delete-memories to confirm; nothing was changed");
      const first = String((await ctx.prompt(`Type "delete" to finish deleting ${home}: `)) ?? "").trim();
      if (first !== "delete") throw new Stop(EXIT.FAILED, "purge", "not confirmed; nothing was changed");
      const second = String((await ctx.prompt("Really finish the deletion? This cannot be undone. [y/N]: ")) ?? "").trim().toLowerCase();
      if (second !== "y" && second !== "yes") throw new Stop(EXIT.FAILED, "purge", "not confirmed; nothing was changed");
    }
  } else if (purge) {
    if (!home || !existsSync(home)) throw new Stop(EXIT.NEEDS_CHOICE, "purge", "purge-refused: no PLUR1BUS sidecar home is recorded or present; nothing was changed");
    p1 = createPlur1busCli({ bin, home, env, run, platform });
    const list = existsSync(bin) ? await p1.agentList() : { ok: false, ids: [] };
    const guard = purgeGuard({ home, hermesHome, agents: list.ok ? list.ids : null, platform });
    report.set("purgeGuard", guard);
    if (!guard.ok) {
      throw new Stop(EXIT.NEEDS_CHOICE, "purge", `purge-refused: ${guard.reasons.join("; ")}; nothing was changed (\`--uninstall\` without --purge removes the provider and keeps the home)`);
    }
    report.note("--purge permanently deletes:");
    report.note(`  the PLUR1BUS sidecar home ${home} with your memories (the store), its snapshots and any earlier store copy`);
    report.note(`  the sidecar binary ${bin}`);
    const jc = journalCount(hermesHome);
    if (jc !== null) report.note(`  the capture journal ${journalPath(hermesHome)} (${jc} undelivered turn(s))`);
    // a resumed purge asks again: an earlier run's confirmation does not carry over
    if (!flags["yes-delete-memories"]) {
      if (!ctx.isTTY || flags["non-interactive"]) {
        throw new Stop(EXIT.NEEDS_CHOICE, "purge", "--purge deletes your memories and needs two confirmations; there is no TTY to ask, so pass --yes-delete-memories to confirm; nothing was changed");
      }
      const first = String((await ctx.prompt(`Type "delete" to permanently delete your memories at ${home}: `)) ?? "").trim();
      if (first !== "delete") throw new Stop(EXIT.FAILED, "purge", "not confirmed; nothing was changed");
      const second = String((await ctx.prompt("Really delete the sidecar home, its snapshots, the binary and the journal? This cannot be undone. [y/N]: ")) ?? "").trim().toLowerCase();
      if (second !== "y" && second !== "yes") throw new Stop(EXIT.FAILED, "purge", "not confirmed; nothing was changed");
    }
  }

  if (flags["dry-run"]) {
    report.step("provider-value", "planned", `memory.provider → ${previous ?? "built-in"}${lineEdit ? " (backed-up line edit)" : ""}`);
    report.step("provider", "planned", `remove ${providerDir(hermesHome)}`);
    report.step("binding", "planned", `remove ${bindingPath(hermesHome)} and the registry entry ${agentId ?? "?"}`);
    if (purge) report.step("purge", "planned", `daemon stop, service uninstall, remove ${bin} and ${home}`);
    return report.finish(EXIT.OK);
  }

  const un = s.uninstall ?? {};
  Object.assign(un, { home, bin, agentId, previousProvider: previous, purge });
  s.uninstall = un;
  const save = (step) => writeHermesState(hermesHome, { ...s, inProgress: { op: "uninstall", step, purge } });
  const killAt = (point) => {
    if (testMode && env.PLUR1BUS_PLUGIN_TEST_KILL_AT === point) process.kill(process.pid, "SIGKILL");
  };

  // 1. memory.provider back first, while the directory still exists (R17a)
  save("provider-value");
  if (!un.providerValueDone) {
    const cur = await readCurrent({ hermes, hermesHome, lineEdit });
    if (cur === null) {
      report.step("provider-value", "failed", "memory.provider cannot be read; nothing more was changed");
      return finishFailed(report, hermesHome, s, [`check \`hermes config get memory.provider\`; if it is plur1bus: ${previous ? `hermes config set memory.provider ${previous}` : "hermes config unset memory.provider"}`, "then re-run with --uninstall"]);
    }
    if (cur === PROVIDER_NAME) {
      if (un.bindingText === undefined) un.bindingText = existsSync(bindingPath(hermesHome)) ? readFileSync(bindingPath(hermesHome), "utf8") : null;
      let how;
      try {
        const r = await restoreProviderValue({ hermes, hermesHome, lineEdit, state, previous, now, report });
        how = r.how;
        un.valueBackup = r.backup;
        const again = await readCurrent({ hermes, hermesHome, lineEdit: lineEdit || Boolean(state?.configEdit?.undo) });
        if (again === null || again === PROVIDER_NAME) throw new Error(again === null ? "it cannot be read back" : "it still reads plur1bus");
      } catch (err) {
        report.step("provider-value", "failed", err?.message ?? String(err));
        return finishFailed(report, hermesHome, s, [previous ? `hermes config set memory.provider ${previous}` : "hermes config unset memory.provider", "then re-run with --uninstall"]);
      }
      un.restoredFrom = PROVIDER_NAME;
      // verified: this run's own backup and the install's go (one backup only while a change is in flight)
      for (const b of [un.valueBackup, state?.configEdit?.backup]) if (b) rmSync(b, { force: true });
      report.step("provider-value", "ok", `memory.provider = ${previous ?? "built-in"} (${how})`);
    } else {
      report.step("provider-value", "skipped", `memory.provider is ${cur || "built-in"}, not plur1bus; left as it is`);
    }
    un.providerValueDone = true;
    save("provider-value");
  }
  killAt("uninstall.provider-value");

  // 2. the provider directory: renamed aside, then deleted
  save("provider");
  removeStaging(hermesHome);
  const pdir = providerDir(hermesHome);
  if (!un.removedDir && existsSync(pdir)) {
    un.removedDir = join(pluginsDir(hermesHome), `.${PROVIDER_NAME}-removed-${now()}`);
    save("provider");
    try {
      renameWithRetry(pdir, un.removedDir);
    } catch (err) {
      report.step("provider", "failed", err?.message ?? String(err));
      return finishFailed(report, hermesHome, s, [`remove ${pdir}`, "then re-run with --uninstall"]);
    }
    save("provider");
  }
  killAt("uninstall.provider-moved");
  if (un.removedDir && existsSync(un.removedDir)) {
    un.pastNoReturn = true; // from here on --rollback can no longer bring the provider back
    save("provider");
    rmTree(un.removedDir);
  }
  report.step("provider", "ok", `${pdir} removed`);

  // 3. the binding and this home's registry entry
  save("binding");
  if (un.bindingText === undefined) un.bindingText = existsSync(bindingPath(hermesHome)) ? readFileSync(bindingPath(hermesHome), "utf8") : null;
  killAt("uninstall.binding");
  removeBinding(hermesHome);
  let registryLeft = false;
  if (home && agentId && existsSync(home)) {
    try {
      await withRegistryLock(home, ({ assertHeld }) => {
        if (unregisterLocked(home, agentId, hermesHome, platform, assertHeld)) un.unregistered = true;
      });
    } catch (err) {
      registryLeft = true;
      report.note(`Warning: ${agentId} could not be removed from ${join(home, "hosts", "hermes-bindings.json")}: ${err?.message ?? err}`);
    }
  }
  report.step("binding", registryLeft ? "failed" : "ok", `${bindingPath(hermesHome)} removed${un.unregistered ? `; ${agentId} unbound` : ""}`);

  // 4. --purge: the sidecar, under the registry lock (F4: nobody else bound at the moment of deletion)
  const manual = registryLeft ? [`remove ${agentId} from ${join(home, "hosts", "hermes-bindings.json")}`] : [];
  if (purge) {
    save("purge");
    killAt("uninstall.purge");
    // the sidecar stops first, outside the lock (both can outlast the lock's 60 s staleness); the stop must succeed
    if (existsSync(bin) && !removing) {
      const ds = await p1.daemonStop();
      if (!ds.ok) {
        report.step("purge", "failed", `plur1bus daemon stop failed (${ds.detail}); the sidecar home ${home} is kept`);
        return finishFailed(report, hermesHome, s, [`plur1bus --home "${home}" daemon stop`, "then re-run with --uninstall --purge"], "purge");
      }
      const su = await p1.serviceUninstall();
      if (!su.ok) {
        report.step("purge", "failed", `plur1bus service uninstall failed (${su.detail}); the sidecar home ${home} is kept`);
        return finishFailed(report, hermesHome, s, [`plur1bus --home "${home}" service uninstall`, "then re-run with --uninstall --purge"], "purge");
      }
    }
    killAt("uninstall.purge-stopped");
    let refused = null;
    const removeHome = () => {
      un.homeRemoveStarted = true;
      save("purge");
      if (testMode && env.PLUR1BUS_PLUGIN_TEST_FAIL_AT === "purge.rm") throw Object.assign(new Error(`TEST ONLY: EBUSY: resource busy or locked, rmdir '${home}'`), { code: "EBUSY" });
      rmSync(home, { recursive: true, force: true });
    };
    try {
      if (removing) {
        removeHome(); // partly deleted already: decided under the lock by the earlier run, nothing left to check
      } else {
        await withRegistryLock(home, async ({ assertHeld }) => {
          const list = existsSync(bin) ? await p1.agentList() : { ok: false, ids: [] };
          const guard = purgeGuard({ home, hermesHome, agents: list.ok ? list.ids : null, platform });
          if (!guard.ok) {
            refused = guard.reasons;
            return;
          }
          assertHeld();
          removeHome();
        });
      }
    } catch (err) {
      if (err instanceof RegistryLockLost || err instanceof RegistryLockTimeout) {
        refused = [`the bindings registry lock was not ours (${err.message})`];
      } else {
        // a failed deletion (e.g. EBUSY): the purge is unfinished, the state stays at purge for the next run
        report.step("purge", "failed", `deleting ${home} failed: ${err?.message ?? err}`);
        return finishFailed(report, hermesHome, s, [`remove ${home} (${err?.code ?? "error"}: ${err?.message ?? err})`, "then re-run with --uninstall --purge to finish"], "purge");
      }
    }
    if (refused) {
      report.step("purge", "refused", `the sidecar home is kept: ${refused.join("; ")}`);
      report.note(`The purge was refused at the last check: ${refused.join("; ")}. The provider is uninstalled; the sidecar home ${home} is kept.`);
      report.note(`The sidecar was stopped and its service removed for the purge; start it again for the homes that use it: plur1bus --home "${home}" service install && plur1bus --home "${home}" daemon start`);
      rmSync(hermesStatePath(hermesHome), { force: true });
      return report.finish(EXIT.FAILED);
    }
    for (const p of [bin, ...prevBinaries(bin)]) {
      try {
        rmSync(p, { force: true });
      } catch {
        manual.push(`remove ${p}`);
      }
    }
    rmSync(journalDir(hermesHome), { recursive: true, force: true });
    report.step("purge", manual.length ? "failed" : "ok", `${home}, ${bin} and the journal deleted`);
  } else {
    report.note(`The agent ${agentId ?? "?"}, the store and the sidecar in ${home ?? "(unknown)"} are kept.`);
    const jc = journalCount(hermesHome);
    if (jc !== null) report.note(`The capture journal ${journalPath(hermesHome)} is kept (${jc} undelivered turn(s)); --uninstall --purge removes it.`);
    report.set("journal", jc === null ? null : { path: journalPath(hermesHome), entries: jc });
  }

  if (manual.length) return finishFailed(report, hermesHome, s, manual, "purge");
  rmSync(hermesStatePath(hermesHome), { force: true });
  report.note(`Uninstalled the plur1bus memory provider from Hermes (${hermesHome}).`);
  return report.finish(EXIT.OK);
}

/** A provider directory whose MANIFEST.json is a plur1bus provider build (ruling: never delete a directory we do not own). */
function providerManifestIsOurs(hermesHome) {
  try {
    return JSON.parse(readFileSync(join(providerDir(hermesHome), "MANIFEST.json"), "utf8"))?.schema === PROVIDER_MANIFEST_SCHEMA;
  } catch {
    return false;
  }
}

/** `<bin>.prev-<ts>` copies an update kept. */
function prevBinaries(bin) {
  try {
    const base = `${bin.split(/[\\/]/).pop()}.prev-`;
    return readdirSync(dirname(bin)).filter((n) => n.startsWith(base)).map((n) => join(dirname(bin), n));
  } catch {
    return [];
  }
}

function finishFailed(report, hermesHome, s, manual, step = null) {
  writeHermesState(hermesHome, { ...s, inProgress: { op: "uninstall", step: step ?? "failed", purge: Boolean(s.uninstall?.purge) } });
  report.set("manualSteps", manual);
  report.note("The uninstall stopped. Do these steps, then re-run with --uninstall:");
  for (const m of manual) report.note(`  ${m}`);
  return report.finish(EXIT.FAILED);
}

/**
 * Undo an interrupted uninstall while its provider directory still sits at `.plur1bus-removed-<ts>`: directory back
 * first, then memory.provider = plur1bus (R17a), then the binding and the registry entry. A purge or an uninstall
 * past the deletion is not undone (exit 2: finish it with --uninstall).
 */
async function rollbackUninstall(ctx) {
  const { report, hermes, hermesHome, s, lineEdit, now, platform } = ctx;
  const un = s.uninstall ?? {};
  if (un.purge || un.pastNoReturn) {
    throw new Stop(EXIT.NEEDS_CHOICE, "rollback", `the interrupted uninstall${un.purge ? " --purge" : ""} is past the point where it can be undone: re-run with --uninstall${un.purge ? " --purge" : ""} to finish it; nothing was changed`);
  }
  const done = [];
  const manual = [];
  const pdir = providerDir(hermesHome);
  if (un.removedDir && existsSync(un.removedDir) && !existsSync(pdir)) {
    renameWithRetry(un.removedDir, pdir);
    done.push("provider directory restored");
  }
  if (un.restoredFrom === PROVIDER_NAME && existsSync(pdir)) {
    try {
      const bak = await setProvider({ hermes, hermesHome, lineEdit, value: PROVIDER_NAME, now });
      if (bak) rmSync(bak, { force: true }); // verified below by the next run's reads; no backup piles up
      done.push("memory.provider = plur1bus again");
    } catch {
      manual.push("hermes config set memory.provider plur1bus");
    }
  }
  if (un.bindingText && !existsSync(bindingPath(hermesHome))) {
    writeFileAtomic(bindingPath(hermesHome), un.bindingText);
    done.push("binding restored");
  }
  if (un.unregistered && un.home && un.agentId && existsSync(un.home)) {
    try {
      registerBinding(un.home, un.agentId, hermesHome, platform);
      done.push(`${un.agentId} bound again`);
    } catch {
      manual.push(`plur1bus bind for ${un.agentId}`);
    }
  }
  const restored = { ...s };
  delete restored.uninstall;
  delete restored.inProgress;
  if (manual.length) {
    report.set("manualSteps", manual);
    report.step("rollback", "failed", manual.join("; "));
    return report.finish(EXIT.ROLLBACK_FAILED);
  }
  writeHermesState(hermesHome, restored);
  report.step("rollback", "ok", done.length ? done.join("; ") : "nothing had changed");
  return report.finish(EXIT.FAILED);
}

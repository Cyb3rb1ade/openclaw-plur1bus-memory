/**
 * scripts/dist/installer/uninstall.mjs — uninstall and purge (spec A.3 step 7, D89).
 *
 * `openclaw plugins uninstall memory-lancedb-namespaced --force` (removes the plugin's
 * files; OpenClaw resets a memory slot the plugin owned to `memory-core`), then the slot
 * the installer found before its first install is restored when it was not `memory-core`
 * (HM1-R10). The store, the Node snapshots, the bash tool's legacy tarballs, the model
 * cache and the vault are kept.
 *
 * `--purge` additionally deletes the store (the resolved baseDbPath, R-S7), the Node
 * snapshots (`<stateDir>/memory/.snapshots/plur1bus-*`, never the legacy `*.tar.gz`) and
 * the plugin's model cache under the state dir (`<stateDir>/models/plur1bus`), and only
 * after two interactive confirmations or `--yes-delete-memories`; without a TTY and
 * without that flag it exits 2 before any change. Every confirmation is asked before
 * the first change.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

import { listSnapshots } from "../../../lib/snapshot/store-snapshot.js";
import { legacyDirOf } from "./legacy.mjs";
import { PLUGIN_ID, tail } from "./openclaw-cli.mjs";
import { EXIT, Stop } from "./report.mjs";
import { statePath, writeState } from "./state.mjs";
import { removeWorkDir } from "./update.mjs";
import { rmTree, withWinRetry } from "./fsutil.mjs";

const SLOT = "plugins.slots.memory";

/** Refuse to purge a path that is a filesystem root, a home, the state dir or one of their ancestors. */
function assertPurgeable(path, { stateDir, home }) {
  const p = resolve(path);
  const under = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  const guarded = [resolve(stateDir), resolve(home)].filter(Boolean);
  if (parse(p).root === p || guarded.some((g) => under(g, p))) {
    throw new Stop(EXIT.INCOMPATIBLE, "purge", `unsafe-purge-path: refusing to delete ${p} (it is or contains the state dir or the home directory); nothing was changed`);
  }
  return p;
}

async function purgePlan({ stateDir, baseDbPath, home }) {
  const store = assertPurgeable(baseDbPath, { stateDir, home });
  let snapshots = [];
  try {
    snapshots = (await listSnapshots({ stateDir })).filter((s) => s.kind === "snapshot").map((s) => join(stateDir, "memory", ".snapshots", s.id));
  } catch {
    snapshots = [];
  }
  const modelCache = join(stateDir, "models", "plur1bus");
  // the `.pre-restore-*` copies a restore left beside the store are older states of the same memories
  let preRestores = [];
  try {
    const prefix = `${basename(store)}.pre-restore-`;
    preRestores = readdirSync(dirname(store)).filter((n) => n.startsWith(prefix)).map((n) => join(dirname(store), n));
  } catch {
    preRestores = [];
  }
  return { store: existsSync(store) ? store : null, snapshots, preRestores, modelCache: existsSync(modelCache) ? modelCache : null };
}

/**
 * @param {{ cli: any, report: any, stateDir: string, baseDbPath: string, flags: any, prompt: (q: string) => Promise<string>,
 *   isTTY: boolean, state?: any, resume?: any, env?: any, platform?: string }} ctx
 * @returns {Promise<number>}
 */
export async function runUninstall(ctx) {
  const { cli, report, stateDir, baseDbPath, flags, prompt, isTTY, state } = ctx;
  report.set("mode", "uninstall");
  const resume = ctx.resume;
  if (resume) {
    if (flags.rollback) throw new Stop(EXIT.FAILED, "rollback", `an interrupted uninstall (step ${resume.step}) cannot be rolled back; re-run with --uninstall to finish it`);
    report.step("resume", "info", `interrupted uninstall at step ${resume.step}; continuing it`);
  }
  const purge = resume ? Boolean(resume.purge) : flags.purge;
  if (!resume && flags["yes-delete-memories"] && !flags.purge) throw new Stop(EXIT.FAILED, "args", "--yes-delete-memories only applies together with --purge; nothing was changed");

  const existing = await cli.inspect(PLUGIN_ID);
  if (!existing.installed) {
    if (existing.present || existsSync(legacyDirOf(stateDir))) {
      throw new Stop(EXIT.NEEDS_CHOICE, "existing", `legacy-deploy: ${PLUGIN_ID} at ${legacyDirOf(stateDir)} is not tracked by OpenClaw; adopt it with --adopt-legacy first, or remove it by hand; nothing was changed`);
    }
    if (!existing.notFound) throw new Stop(EXIT.FAILED, "existing", `openclaw plugins inspect failed (exit ${existing.code}): ${existing.detail}`);
  }

  // ── every confirmation before the first change ───────────────────────────
  let plan = null;
  if (purge) {
    const home = (ctx.platform === "win32" ? ctx.env?.USERPROFILE : ctx.env?.HOME) || homedir();
    plan = await purgePlan({ stateDir, baseDbPath, home });
    report.set("purge", { store: plan.store, snapshots: plan.snapshots.length, preRestores: plan.preRestores, modelCache: plan.modelCache });
    // a resumed purge asks again (T6-d): an earlier run's confirmation does not carry over
    if (!flags["yes-delete-memories"]) {
      report.note("--purge permanently deletes:");
      report.note(`  your memories (the store) at ${plan.store ?? `${baseDbPath} (not present)`}`);
      report.note(`  ${plan.snapshots.length} snapshot(s) under ${join(stateDir, "memory", ".snapshots")}`);
      for (const p of plan.preRestores) report.note(`  the earlier store copy ${p}`);
      report.note(`  the model cache ${plan.modelCache ?? "(not present)"}`);
      if (!isTTY || flags["non-interactive"]) {
        throw new Stop(EXIT.NEEDS_CHOICE, "purge", "--purge deletes your memories and needs two confirmations; there is no TTY to ask, so pass --yes-delete-memories to confirm; nothing was changed");
      }
      const first = String((await prompt(`Type "delete" to permanently delete your memories at ${plan.store ?? baseDbPath}: `)) ?? "").trim();
      if (first !== "delete") throw new Stop(EXIT.FAILED, "purge", "not confirmed; nothing was changed");
      const second = String((await prompt(`Really delete the store, ${plan.snapshots.length} snapshot(s) and the model cache? This cannot be undone. [y/N]: `)) ?? "").trim().toLowerCase();
      if (second !== "y" && second !== "yes") throw new Stop(EXIT.FAILED, "purge", "not confirmed; nothing was changed");
    }
  }

  if (flags["dry-run"]) {
    report.step("uninstall", "planned", existing.installed ? `openclaw plugins uninstall ${PLUGIN_ID} --force` : "not installed");
    if (plan) report.step("purge", "planned", `store, ${plan.snapshots.length} snapshot(s), model cache`);
    return report.finish(EXIT.OK);
  }
  if (!existing.installed && !purge) {
    report.step("uninstall", "skipped", `${PLUGIN_ID} is not installed; nothing to do`);
    return report.finish(EXIT.OK);
  }

  const base = { previousSlot: state?.previousSlot ?? null, installedVersion: state?.installedVersion ?? null, source: state?.source ?? null, licence: state?.licence };
  const save = (step) => writeState(stateDir, { ...base, inProgress: { op: "uninstall", step, purge, snapshotId: null, previousVersion: base.installedVersion } });

  // ── uninstall ─────────────────────────────────────────────────────────────
  if (existing.installed) {
    save("uninstall");
    const un = await cli.uninstall(PLUGIN_ID, { keepFiles: false });
    if (un.code !== 0) {
      const after = await cli.inspect(PLUGIN_ID);
      writeState(stateDir, base);
      throw new Stop(EXIT.FAILED, "uninstall", `openclaw plugins uninstall ${PLUGIN_ID} failed (exit ${un.code}): ${tail(un.stderr || un.stdout)}; ${after.installed ? "the plugin is still installed and " : ""}nothing was deleted`);
    }
    report.step("uninstall", "ok", `openclaw plugins uninstall ${PLUGIN_ID} --force (version ${existing.json.install.version ?? "?"})`);
  } else report.step("uninstall", "skipped", "not installed");

  // ── previous memory slot ──────────────────────────────────────────────────
  const manual = [];
  save("slot");
  const prev = base.previousSlot;
  if (prev && prev !== "memory-core" && prev !== PLUGIN_ID) {
    try {
      await cli.configSet(SLOT, prev);
      report.step("slot", "ok", `${SLOT} restored to ${prev}`);
    } catch (err) {
      report.step("slot", "failed", err.message);
      manual.push(`openclaw config set ${SLOT} ${prev}`);
    }
  } else report.step("slot", "skipped", `${SLOT} left as OpenClaw reset it${prev ? ` (previously ${prev})` : ""}`);

  // ── purge ─────────────────────────────────────────────────────────────────
  if (plan) {
    save("purge");
    const gone = [];
    for (const p of [plan.store, ...plan.preRestores, ...plan.snapshots, plan.modelCache].filter(Boolean)) {
      try {
        rmTree(p);
        gone.push(p);
      } catch (err) {
        manual.push(`delete ${p} (${err?.code ?? err?.message})`);
      }
    }
    report.step("purge", manual.length ? "warn" : "ok", `deleted ${gone.length} path(s): store, ${plan.preRestores.length} earlier store copy(ies), ${plan.snapshots.length} snapshot(s), model cache`);
  }

  // ── installer state ───────────────────────────────────────────────────────
  removeWorkDir(stateDir);
  if (manual.length) {
    writeState(stateDir, { ...base, installedVersion: null });
    report.set("manualSteps", manual);
    report.note("Finish these steps yourself:");
    for (const m of manual) report.note(`  ${m}`);
    return report.finish(EXIT.FAILED);
  }
  withWinRetry(() => rmSync(statePath(stateDir), { force: true }));
  if (!plan) {
    report.note(`Kept your store at ${baseDbPath}, the snapshots under ${join(stateDir, "memory", ".snapshots")} and the model cache; \`--uninstall --purge\` deletes them.`);
  }
  report.note(`Uninstalled ${PLUGIN_ID}. Restart the Gateway: \`openclaw gateway restart\`.`);
  return report.finish(EXIT.OK);
}

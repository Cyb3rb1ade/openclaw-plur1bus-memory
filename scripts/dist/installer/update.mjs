/**
 * scripts/dist/installer/update.mjs — update of a tracked install with a store snapshot,
 * automatic rollback and resume (spec A.3 step 6, D78, D89, Review Focus 5).
 *
 * Order: installed version from `plugins inspect --json` (/install/version, fact b) →
 * equal → `up-to-date` → release notes of every version after the installed one up to
 * the target in `--lang` → Now / Later / Skip (TTY; `--yes` = Now; no TTY → exit 2) →
 * before any change: the rollback artefact and (tarball source) the target tarball are
 * fetched and verified against the signed feed → state `inProgress` → snapshot
 * `pre-<target>` → `openclaw plugins install <same-source locator>@<target> --force
 * --accept-capabilities` (R-S4: `plugins update` rejects npm:/clawhub: locators) →
 * verify (A.4) → success records the new version; failure reinstalls the previous exact
 * version, compares the live store with the snapshot manifest and restores it only when it
 * differs (HM1-R-F2: an untouched store needs no restore and no stopped Gateway), verifies;
 * exit 1, or 4 with the manual commands when the rollback itself fails. A restore's
 * `.pre-restore-*` copy of the replaced store is kept and named; only `--purge` deletes it.
 *
 * `writeState({ inProgress: { op: "update", step } })` precedes every step, so a killed run
 * is continued (or, with --rollback, undone) by the next one. The steps are `snapshot`,
 * `update`, `verify`, `rollback`, `rollback-failed`. An update never writes config: the
 * plugin's config and slot survive `install --force` (fact f), and an existing embedding
 * choice is never changed (HM1-R10).
 *
 * Old npm generation folders (`…__openclaw-generation__…`) are never deleted, only
 * reported with their size (R-S4). Nothing here is ever hard-linked (R-S8).
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compareVersions, PACKAGE_NAME } from "../build-plugin-feed.mjs";
import { compareStoreWithSnapshot, createSnapshot, restoreSnapshot, SnapshotError } from "../../../lib/snapshot/store-snapshot.js";
import { isReadonlyRefusal, PLUGIN_ID, failureSummary } from "./openclaw-cli.mjs";
import { EXIT, Stop } from "./report.mjs";
import { writeState } from "./state.mjs";
import { selftestForcedToFail, verifyInstall } from "./verify.mjs";
import { keepArtefact, keptArtefact, pruneArtefacts } from "./artefacts.mjs";
import { rmTree, writeFileAtomic } from "./fsutil.mjs";

const ALLOW_CONVERSATION = `plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess`;

/** Upper bound for any tarball the installer downloads itself (the feed carries no size). */
export const MAX_TARBALL_BYTES = 200 * 1024 * 1024;
/** `<stateDir>/memory/<WORK_DIR>` holds downloaded tarballs while an operation is in progress. */
export const WORK_DIR = ".plur1bus-installer-work";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export function workDir(stateDir) {
  return join(stateDir, "memory", WORK_DIR);
}

export function removeWorkDir(stateDir) {
  rmTree(workDir(stateDir));
}

/**
 * Download bytes the installer fetches itself (the feed's tarball, T5-f), capped at
 * `maxBytes` (Content-Length and while streaming). https only; file:// only in test mode.
 */
export async function fetchBytes(url, { testMode, fetchImpl, maxBytes = MAX_TARBALL_BYTES, id = "tarball" }) {
  const tooBig = (n) => new Stop(EXIT.FAILED, id, `${url} is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit (${n} bytes); nothing was changed`);
  if (url.startsWith("file://")) {
    if (!testMode) throw new Stop(EXIT.FAILED, id, `download URL must be https:// (file:// only with PLUR1BUS_PLUGIN_INSTALLER_TEST=1): ${url}`);
    const b = readFileSync(fileURLToPath(url));
    if (b.length > maxBytes) throw tooBig(b.length);
    return b;
  }
  if (!url.startsWith("https://")) throw new Stop(EXIT.FAILED, id, `download URL must be https://: ${url}`);
  if (typeof fetchImpl !== "function") throw new Stop(EXIT.FAILED, id, `no fetch available to download ${url}`);
  let res;
  try {
    res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(900_000) });
  } catch (err) {
    throw new Stop(EXIT.FAILED, id, `download failed: ${url}: ${err?.message ?? err}; nothing was changed`);
  }
  if (!res.ok) throw new Stop(EXIT.FAILED, id, `download failed: ${url}: HTTP ${res.status}; nothing was changed`);
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooBig(declared);
  if (res.body && typeof res.body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) {
        try {
          await res.body.cancel?.();
        } catch {
          // the limit is what matters
        }
        throw tooBig(`> ${maxBytes}`);
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw tooBig(buf.length);
  return buf;
}

/**
 * Fetch a feed release's tarball, check its SHA-256 against the signed feed and write it
 * to the work dir as `cyb3rb1ade-plur1bus-memory-<v>.tgz`.
 */
export async function downloadReleaseTarball({ release, stateDir, testMode, fetchImpl, id = "tarball" }) {
  const bytes = await fetchBytes(release.tarball.url, { testMode, fetchImpl, id });
  const digest = sha256(bytes);
  if (digest !== release.tarball.sha256) throw new Stop(EXIT.FAILED, id, `SHA-256 of ${release.tarball.url} (${digest.slice(0, 12)}…) does not match the feed (${release.tarball.sha256.slice(0, 12)}…); nothing was changed`);
  const file = join(workDir(stateDir), `cyb3rb1ade-plur1bus-memory-${release.version}.tgz`);
  writeFileAtomic(file, bytes);
  return { file, sha256: digest };
}

/** `plugins install` argv for an exact version from `source` (fact e, R-S4). */
export function installSpec(source, version, { release = null, file = null } = {}) {
  if (source === "clawhub") return { locator: release?.clawhub ?? `clawhub:${PACKAGE_NAME}@${version}`, opts: { force: true, acceptCapabilities: true } };
  if (source === "npm") return { locator: release?.npm ?? `npm:${PACKAGE_NAME}@${version}`, opts: { pin: true, force: true, acceptCapabilities: true } };
  if (!file) throw new Error(`installSpec: source ${source} needs a verified tarball`);
  return { locator: `npm-pack:${file}`, opts: { force: true, acceptCapabilities: true } };
}

/** The command a person runs to repeat `spec` by hand. */
export function manualInstallCommand(spec) {
  return `openclaw plugins install ${spec.locator}${spec.opts.pin ? " --pin" : ""}${spec.opts.force ? " --force" : ""}${spec.opts.acceptCapabilities ? " --accept-capabilities" : ""}`;
}

/** Where the tracked install came from: clawhub, npm (registry), tarball or offline (npm-pack). */
export function recordedSource(state, install) {
  if (install?.source === "clawhub") return "clawhub";
  if (state?.source === "tarball" || state?.source === "offline" || state?.source === "npm") return state.source;
  return install?.sourcePath ? "tarball" : "npm";
}

/** Human size. */
export function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function treeBytes(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const name of readdirSync(p)) n += treeBytes(join(p, name));
  return n;
}

/**
 * Old npm generation folders of this plugin next to the current install (fact b):
 * `<state>/npm/projects/cyb3rb1ade-plur1bus-memory-<hash>[__openclaw-generation__g-<hash>]`.
 * Reported, never deleted (R-S4).
 */
export function oldGenerations(installPath) {
  const m = /^(.*[\\/]npm[\\/]projects)[\\/]([^\\/]+)[\\/]/.exec(String(installPath ?? ""));
  if (!m) return { dir: null, folders: [], bytes: 0 };
  const [, projects, current] = m;
  let names = [];
  try {
    names = readdirSync(projects).filter((n) => n.startsWith("cyb3rb1ade-plur1bus-memory-") && n !== current);
  } catch {
    names = [];
  }
  const folders = names.map((n) => join(projects, n));
  return { dir: projects, folders, bytes: folders.reduce((s, f) => s + treeBytes(f), 0) };
}

/** The release notes of every feed version after `installed` up to `target`, oldest first. */
export function notesBetween(feed, installed, target, lang) {
  return feed.hosts.openclaw.releases
    .filter((r) => compareVersions(r.version, installed) > 0 && compareVersions(r.version, target) <= 0)
    .sort((a, b) => compareVersions(a.version, b.version))
    .map((r) => ({ version: r.version, lang: r.notes?.[lang] ? lang : "en", text: String(r.notes?.[lang] ?? r.notes?.en ?? "").trim(), security: r.security === true }));
}

/** Snapshot the store before a change; a missing store is nothing to lose. */
export async function snapshotStep({ report, stateDir, baseDbPath, label, pluginVersion, now }) {
  try {
    const snap = await createSnapshot({ stateDir, baseDbPath, label, pluginVersion, now });
    report.step("snapshot", "ok", `${snap.id} (${snap.files} files, ${formatBytes(snap.bytes)}) under ${join(stateDir, "memory", ".snapshots")}`);
    for (const w of snap.warnings ?? []) report.note(`  snapshot warning: ${w}`);
    return snap.id;
  } catch (err) {
    if (err instanceof SnapshotError && err.reason === "not-found") {
      report.step("snapshot", "skipped", `no store at ${baseDbPath} yet; nothing to snapshot`);
      return null;
    }
    const why = err instanceof SnapshotError ? `${err.reason}: ${err.message}` : String(err?.message ?? err);
    throw new Stop(EXIT.FAILED, "snapshot", `${why}; nothing was changed`);
  }
}

/** Manual recovery lines for a snapshot. */
export function manualRestoreLines({ stateDir, baseDbPath, snapshotId, preRestorePath }) {
  if (!snapshotId) return [];
  const dir = join(stateDir, "memory", ".snapshots", snapshotId);
  return [
    `the pre-change store is in snapshot ${snapshotId}: stop the Gateway, move ${baseDbPath} aside and copy ${join(dir, "store")} to ${baseDbPath}` +
      ` (or: node <plugin dir>/scripts/snapshot-store.mjs restore --state-dir "${stateDir}" --base-db-path "${baseDbPath}" --id ${snapshotId})`,
    ...(preRestorePath ? [`the store as it was before the rollback is kept at ${preRestorePath} (it holds anything written after the snapshot); --uninstall --purge removes it`] : []),
  ];
}

/**
 * T6-e: the store is never restored under a running Gateway. Non-interactive → false;
 * on a TTY the person is asked to stop it and the status is checked again.
 */
export async function waitForGatewayStopped({ cli, isTTY, flags = {}, prompt }) {
  for (let asked = 0; ; asked++) {
    const gw = await cli.gatewayStatus();
    if (!gw.running) return true;
    if (!isTTY || flags["non-interactive"] || typeof prompt !== "function" || asked >= 10) return false;
    const a = String((await prompt('The OpenClaw Gateway is running, and the store is never restored under it. Stop the Gateway (for example `openclaw gateway stop`), then press Enter to check again, or type "abort": ')) ?? "").trim().toLowerCase();
    if (a === "abort") return false;
  }
}

/**
 * HM1-R-F2: compare the live store with the snapshot manifest first; an untouched store is
 * not restored (no Gateway gate, no exit 4). A store that differs (or cannot be compared) is
 * restored from the snapshot, but only once `gate()` (the Gateway check, T6-e) passed; the
 * replaced store is kept at `.pre-restore-*` and never deleted here.
 * Returns { ok, restored, untouched, preRestorePath, manual }.
 */
export async function restoreStep({ report, stateDir, baseDbPath, snapshotId, gate = null }) {
  if (!snapshotId) return { ok: true, restored: false, untouched: false, preRestorePath: null, manual: [] };
  try {
    const cmp = await compareStoreWithSnapshot({ stateDir, baseDbPath, id: snapshotId });
    if (cmp.unchanged) {
      report.step("restore", "skipped", `the store is untouched since snapshot ${snapshotId} (${cmp.detail}); nothing to restore`);
      return { ok: true, restored: false, untouched: true, preRestorePath: null, manual: [] };
    }
    report.step("restore.compare", "info", `the store differs from snapshot ${snapshotId}: ${cmp.detail}; restoring it`);
  } catch (err) {
    report.step("restore.compare", "warn", `could not compare the store with snapshot ${snapshotId} (${err?.reason ?? err?.code ?? "error"}: ${err?.message ?? err}); restoring it`);
  }
  if (gate && !(await gate())) {
    report.step("restore", "failed", `the OpenClaw Gateway is running; the store was not restored from ${snapshotId}`);
    return {
      ok: false,
      restored: false,
      untouched: false,
      preRestorePath: null,
      manual: [`stop the Gateway (for example \`openclaw gateway stop\`, or through its service manager), then re-run the installer with --rollback to restore the store from snapshot ${snapshotId}`],
    };
  }
  try {
    const r = await restoreSnapshot({ stateDir, baseDbPath, id: snapshotId });
    report.step("restore", "ok", `store restored from ${snapshotId}${r.preRestorePath ? `; the replaced store is kept at ${r.preRestorePath}` : ""}`);
    return { ok: true, restored: true, untouched: false, preRestorePath: r.preRestorePath, manual: [] };
  } catch (err) {
    report.step("restore", "failed", `${err?.reason ?? err?.name ?? "error"}: ${err?.message ?? err}`);
    return { ok: false, restored: false, untouched: false, preRestorePath: err?.preRestorePath ?? null, manual: manualRestoreLines({ stateDir, baseDbPath, snapshotId, preRestorePath: err?.preRestorePath ?? null }) };
  }
}

/** Name a kept `.pre-restore-*` copy in the report (HM1-R-F2: kept until an explicit purge). */
export function notePreRestore(report, preRestorePath) {
  if (!preRestorePath) return;
  report.set("preRestorePath", preRestorePath);
  report.note(`The store as it was before the rollback (with anything written after the snapshot) is kept at ${preRestorePath}. Nothing deletes it except \`--uninstall --purge\`; remove it yourself once you no longer need it.`);
}

/** How a rollback treated the store, for its summary line. */
export function storeOutcome(restored, snapshotId) {
  if (!snapshotId) return "";
  if (restored.untouched) return `, store untouched since ${snapshotId} (not restored)`;
  if (restored.restored) return `, store restored from ${snapshotId}`;
  return "";
}

/** Print the manual steps and finish with exit 4. */
export function finishRollbackFailed(report, manual) {
  report.step("rollback", "failed", `manual steps needed: ${manual.join("; ")}`);
  report.set("manualSteps", manual);
  report.note("Rollback failed. Do these steps yourself:");
  for (const m of manual) report.note(`  ${m}`);
  return report.finish(EXIT.ROLLBACK_FAILED);
}

function targetSource({ flags, recorded, release }) {
  if (flags.offline) return "offline";
  if (flags.source) return flags.source;
  if (recorded === "clawhub") return release.clawpackDigest ? "clawhub" : "tarball"; // T5-a: the verifiable path wins
  if (recorded === "npm") return "npm";
  return "tarball";
}

/**
 * The previous exact version, reinstallable without asking the network where possible.
 * npm-pack installs use, in this order: the installer's kept artefact of that version
 * (T8-b; verified against a signed feed when it was installed), the tarball at OpenClaw's
 * recorded sourcePath when it still matches the feed, else the feed's download (not with
 * --offline). Whatever is used is kept as an artefact, so the rolled-back install record
 * points at a file that outlives this run.
 */
async function prepareRollback({ previous, feed, flags, stateDir, testMode, fetchImpl }) {
  const { version, source } = previous;
  if (source === "clawhub" || source === "npm") return { ...installSpec(source, version), file: null, sha256: null };
  const rel = feed.hosts.openclaw.releases.find((r) => r.version === version);
  const kept = keptArtefact(stateDir, version, rel?.tarball?.sha256 ?? null);
  if (kept) return { ...installSpec(source, version, { file: kept.file }), file: kept.file, sha256: kept.sha256 };
  if (!rel) throw new Stop(EXIT.FAILED, "rollback-source", `no-rollback-artefact: the installed ${version} is not in the ${feed.channel} feed, so it could not be reinstalled after a failed update; update with --source clawhub|npm or reinstall by hand; nothing was changed`);
  if (previous.sourcePath && existsSync(previous.sourcePath)) {
    const bytes = readFileSync(previous.sourcePath);
    if (sha256(bytes) === rel.tarball.sha256) {
      const k = keepArtefact(stateDir, version, previous.sourcePath, rel.tarball.sha256);
      return { ...installSpec(source, version, { file: k.file }), file: k.file, sha256: k.sha256 };
    }
  }
  if (flags.offline) throw new Stop(EXIT.FAILED, "rollback-source", `no-rollback-artefact: with --offline the tarball of the installed ${version} must be kept by the installer or still be at its recorded path and match the feed; nothing was changed`);
  const d = await downloadReleaseTarball({ release: rel, stateDir, testMode, fetchImpl, id: "rollback-source" });
  const k = keepArtefact(stateDir, version, d.file, d.sha256);
  return { ...installSpec(source, version, { file: k.file }), file: k.file, sha256: k.sha256 };
}

/** A rollback artefact left by an interrupted run, if it is still intact. */
async function ensureRollback(ctx, progress) {
  const rb = progress.rollback;
  if (rb && (!rb.file || (existsSync(rb.file) && sha256(readFileSync(rb.file)) === rb.sha256))) return rb;
  const fresh = await prepareRollback({ previous: progress.previous, feed: ctx.feed, flags: ctx.flags, stateDir: ctx.stateDir, testMode: ctx.testMode, fetchImpl: ctx.fetchImpl });
  progress.rollback = fresh;
  return fresh;
}

/**
 * The previous version as `verifyInstall` checks it: the digests its own install record
 * carried, else the feed's entry for that version; `lenient` lets a record without any
 * digest pass with a warning instead of failing the rollback (no spurious exit 4).
 */
function previousAsRelease(previous, feed) {
  const rel = feed?.hosts?.openclaw?.releases?.find((r) => r.version === previous.version);
  return {
    version: previous.version,
    tarball: { integrity: previous.npmIntegrity ?? rel?.tarball?.integrity ?? null },
    clawpackDigest: previous.clawpackSha256 ?? rel?.clawpackDigest ?? undefined,
    lenient: true,
  };
}

/**
 * @param {{ cli: any, report: any, feed: any, release: any, stateDir: string, baseDbPath: string, flags: any,
 *   prompt: (q: string) => Promise<string>, now: () => number, isTTY: boolean, existing?: any, state?: any,
 *   resume?: any, lang?: string, testMode?: boolean, fetchImpl?: typeof fetch, tgz?: string|null, consented?: boolean }} ctx
 * @returns {Promise<number>} exit code
 */
export async function runUpdate(ctx) {
  if (ctx.resume) return resumeUpdate(ctx);
  const { cli, report, feed, release, stateDir, flags, prompt, isTTY, existing, state } = ctx;
  const lang = ctx.lang ?? "en";
  const install = existing.json.install;
  const installed = String(install.version ?? "");
  const target = release.version;
  report.set("mode", "update");
  report.set("installedVersion", installed);

  let cmp;
  try {
    cmp = compareVersions(installed, target);
  } catch {
    throw new Stop(EXIT.FAILED, "update", `cannot compare the installed version ${JSON.stringify(installed)} with ${target}; nothing was changed`);
  }
  if (cmp === 0) {
    report.step("update", "ok", `up-to-date: ${PACKAGE_NAME}@${installed}`);
    return report.finish(EXIT.OK);
  }
  if (cmp > 0) {
    report.step("update", "skipped", `the installed ${installed} is newer than the feed's ${target}; nothing to do`);
    return report.finish(EXIT.OK);
  }

  // ── release notes, before anything changes (D78) ─────────────────────────
  const notes = notesBetween(feed, installed, target, lang);
  report.set("releaseNotes", notes.map((n) => ({ version: n.version, lang: n.lang, security: n.security })));
  report.note(`Update available: ${PACKAGE_NAME} ${installed} → ${target}`);
  for (const n of notes) {
    report.note(`── ${n.version}${n.security ? " (security fix)" : ""} ──`);
    for (const l of n.text.split(/\r?\n/)) report.note(`  ${l}`);
  }

  const recorded = recordedSource(state, install);
  const source = targetSource({ flags, recorded, release });
  report.set("source", source);
  // a dry run prints the plan without the consent gate (nothing is changed either way)
  if (flags["dry-run"]) {
    report.step("snapshot", "planned", `store at ${ctx.baseDbPath} → ${join(stateDir, "memory", ".snapshots")} (pre-${target})`);
    report.step("update", "planned", `openclaw plugins install <${source} ${target}> --force --accept-capabilities`);
    return report.finish(EXIT.OK);
  }

  // ── Now / Later / Skip ───────────────────────────────────────────────────
  if (!ctx.consented && !flags.yes) {
    if (!isTTY || flags["non-interactive"]) {
      throw new Stop(EXIT.NEEDS_CHOICE, "update", `update ${installed} → ${target} needs a choice and there is no TTY to ask: re-run with --update --yes to update now; nothing was changed`);
    }
    const a = String((await prompt(`Update to ${target}? Now / Later / Skip [n/l/s, default l]: `)) ?? "").trim().toLowerCase();
    if (a === "s" || a === "skip") {
      report.step("update", "skipped", `skipped ${target}; nothing was changed`);
      return report.finish(EXIT.OK);
    }
    if (a !== "n" && a !== "now") {
      report.step("update", "skipped", `later: run the installer with --update when you are ready; nothing was changed`);
      return report.finish(EXIT.OK);
    }
  }

  const previous = {
    version: installed,
    source: recorded,
    npmIntegrity: install.npmIntegrity ?? null,
    clawpackSha256: install.clawpackSha256 ?? null,
    sourcePath: install.sourcePath ?? null,
  };
  const base = { previousSlot: state?.previousSlot ?? null, installedVersion: installed, source: recorded, licence: state?.licence };
  let started = false;
  try {
    // everything the rollback and the update need is fetched and verified before any change
    const rollback = await prepareRollback({ previous, feed, flags, stateDir, testMode: ctx.testMode, fetchImpl: ctx.fetchImpl });
    report.step("rollback-source", "ok", `previous ${installed} reinstallable (${rollback.file ? `verified tarball kept at ${rollback.file}` : rollback.locator})`);
    const progress = { op: "update", step: "snapshot", snapshotId: null, previousVersion: installed, targetVersion: target, source, previous, rollback };
    const plan = { base, progress, target: await targetSpec(ctx, source, release) };
    started = true;
    return await applyUpdate(ctx, plan, "snapshot");
  } finally {
    if (!started) removeWorkDir(stateDir);
  }
}

async function targetSpec(ctx, source, release) {
  if (source === "tarball") {
    const d = await downloadReleaseTarball({ release, stateDir: ctx.stateDir, testMode: ctx.testMode, fetchImpl: ctx.fetchImpl });
    ctx.report.step("tarball", "ok", `downloaded ${release.tarball.url}; SHA-256 matches the feed`);
    return installSpec(source, release.version, { file: keepArtefact(ctx.stateDir, release.version, d.file, d.sha256).file });
  }
  if (source === "offline") {
    if (!ctx.tgz) throw new Stop(EXIT.FAILED, "offline", `the interrupted update installs from a local tarball: re-run with --offline <tgz> of ${release.version}, or with --rollback`);
    assertOfflineTarball(ctx.tgz, release);
    return installSpec(source, release.version, { file: keepArtefact(ctx.stateDir, release.version, ctx.tgz, release.tarball.sha256).file });
  }
  return installSpec(source, release.version, { release });
}

/** The --offline tarball must match the release actually being installed (a resumed target may differ from the feed's latest). */
export function assertOfflineTarball(file, release) {
  let digest;
  try {
    digest = sha256(readFileSync(file));
  } catch (err) {
    throw new Stop(EXIT.FAILED, "offline", `cannot read ${file}: ${err?.code ?? err?.message}`);
  }
  if (digest !== release.tarball.sha256) throw new Stop(EXIT.FAILED, "offline", `SHA-256 of ${file} (${digest.slice(0, 12)}…) does not match the feed's ${release.version} (${release.tarball.sha256.slice(0, 12)}…)`);
}

function saver(ctx, plan) {
  return (step) => {
    plan.progress.step = step;
    writeState(ctx.stateDir, { ...plan.base, inProgress: plan.progress });
  };
}

function clearProgress(ctx, plan, extra = {}) {
  writeState(ctx.stateDir, { ...plan.base, ...extra });
  removeWorkDir(ctx.stateDir);
}

async function applyUpdate(ctx, plan, from) {
  const { cli, report, stateDir, baseDbPath, release, now, flags } = ctx;
  const save = saver(ctx, plan);
  const { previousVersion: prev, targetVersion: target } = plan.progress;
  let step = from;

  if (step === "snapshot") {
    save("snapshot");
    try {
      plan.progress.snapshotId = await snapshotStep({ report, stateDir, baseDbPath, label: `pre-${target}`, pluginVersion: prev, now });
    } catch (err) {
      clearProgress(ctx, plan);
      throw err;
    }
    step = "update";
  }

  if (step === "update") {
    save("update");
    const r = await cli.install(plan.target.locator, plan.target.opts);
    if (r.code !== 0) {
      const text = `${r.stderr}\n${r.stdout}`;
      const after = await cli.inspect(PLUGIN_ID);
      if (after.installed && after.json.install.version === prev) {
        // OpenClaw refused before replacing anything: the running plugin and its store are untouched
        clearProgress(ctx, plan);
        if (isReadonlyRefusal(text)) throw new Stop(EXIT.INCOMPATIBLE, "update", `OpenClaw refused: ${failureSummary(r, 2)}`);
        throw new Stop(EXIT.FAILED, "update", `openclaw plugins install ${plan.target.locator} failed (exit ${r.code}${r.timedOut ? ", deadline exceeded" : ""}): ${failureSummary(r)}; ${prev} is still installed, nothing was changed`);
      }
      report.step("update", "failed", `exit ${r.code}: ${failureSummary(r)}`);
      return rollbackUpdate(ctx, plan);
    }
    report.step("update", "ok", `openclaw plugins install ${plan.target.locator} (${prev} → ${target})`);
    step = "verify";
  }

  if (step === "verify") {
    save("verify");
    const checks = await verifyInstall({ cli, release, source: plan.progress.source, downloadModels: flags["download-models"], stateDir, forceFail: selftestForcedToFail({ testMode: ctx.testMode, env: ctx.childEnv }) });
    for (const c of checks) report.step(`verify.${c.id}`, c.ok ? (c.warn ? "warn" : "ok") : "failed", c.detail);
    if (checks.some((c) => !c.ok)) return rollbackUpdate(ctx, plan);

    clearProgress(ctx, plan, { installedVersion: target, source: plan.progress.source });
    pruneArtefacts(stateDir, [target, prev]);
    const rec = await cli.inspect(PLUGIN_ID);
    const gens = oldGenerations(rec.installed ? rec.json.install.installPath : null);
    if (gens.folders.length) {
      report.set("oldGenerations", { dir: gens.dir, count: gens.folders.length, bytes: gens.bytes });
      report.note(`Kept ${gens.folders.length} old npm generation folder(s) of the plugin under ${gens.dir} (${formatBytes(gens.bytes)}); the installer never deletes them, remove them yourself once ${target} runs well.`);
    }
    try {
      const allow = await cli.configGet(ALLOW_CONVERSATION);
      if (!allow.set) {
        report.set("conversationAccess", "unset");
        report.note(`Conversation access for capture and recall is not enabled, and an update never changes it. To enable it: openclaw config set ${ALLOW_CONVERSATION} true`);
      }
    } catch {
      // the summary line is advice only
    }
    if (plan.progress.snapshotId) report.note(`The pre-update snapshot ${plan.progress.snapshotId} is kept (the newest 5 are kept).`);
    report.note(`Updated ${PACKAGE_NAME} ${prev} → ${target}. Restart the Gateway to load it: \`openclaw gateway restart\`.`);
    return report.finish(EXIT.OK);
  }

  if (step === "rollback" || step === "rollback-failed") return rollbackUpdate(ctx, plan);
  throw new Stop(EXIT.FAILED, "resume", `unknown interrupted step ${JSON.stringify(step)}; move ${join(stateDir, "memory", ".plur1bus-installer.json")} aside after checking the install`);
}

/**
 * Reinstall the previous exact version, restore the snapshot when the store differs from it
 * (HM1-R-F2), verify. Exit 1, or 4 with manual steps; a `.pre-restore-*` copy is kept.
 */
async function rollbackUpdate(ctx, plan) {
  const { cli, report, stateDir, baseDbPath } = ctx;
  const save = saver(ctx, plan);
  save("rollback");
  const manual = [];
  let rb;
  try {
    rb = await ensureRollback(ctx, plan.progress);
    save("rollback");
  } catch (err) {
    rb = null;
    manual.push(`reinstall ${PACKAGE_NAME}@${plan.progress.previousVersion} (${err?.message ?? err})`);
  }
  if (rb) {
    const r = await cli.install(rb.locator, rb.opts);
    if (r.code !== 0) manual.push(manualInstallCommand(rb));
    else report.step("rollback.reinstall", "ok", `openclaw plugins install ${rb.locator}`);
  }
  const restored = await restoreStep({ report, stateDir, baseDbPath, snapshotId: plan.progress.snapshotId, gate: () => waitForGatewayStopped(ctx) });
  manual.push(...restored.manual);

  if (manual.length === 0) {
    const checks = await verifyInstall({ cli, release: previousAsRelease(plan.progress.previous, ctx.feed), source: plan.progress.previous.source, downloadModels: false, stateDir });
    for (const c of checks) report.step(`rollback.verify.${c.id}`, c.ok ? (c.warn ? "warn" : "ok") : "failed", c.detail);
    if (checks.some((c) => !c.ok)) {
      manual.push(manualInstallCommand(rb));
      manual.push(...manualRestoreLines({ stateDir, baseDbPath, snapshotId: plan.progress.snapshotId, preRestorePath: restored.preRestorePath }));
    }
  }

  notePreRestore(report, restored.preRestorePath);
  if (manual.length === 0) {
    clearProgress(ctx, plan);
    pruneArtefacts(stateDir, [plan.progress.previousVersion, plan.progress.targetVersion]);
    report.step("rollback", "ok", `${PACKAGE_NAME}@${plan.progress.previousVersion} reinstalled${storeOutcome(restored, plan.progress.snapshotId)}`);
    return report.finish(EXIT.FAILED);
  }
  plan.progress.step = "rollback-failed";
  writeState(stateDir, { ...plan.base, inProgress: plan.progress });
  report.note("Re-running the installer with --rollback retries these steps.");
  return finishRollbackFailed(report, [...new Set(manual)]);
}

/** Continue (or with --rollback undo) an update a previous run did not finish (Review Focus 5). */
async function resumeUpdate(ctx) {
  const { report, flags, state, stateDir } = ctx;
  const p = ctx.resume;
  report.set("mode", "update");
  report.step("resume", "info", `interrupted update to ${p.targetVersion} at step ${p.step}; ${flags.rollback ? "rolling it back" : "continuing it"}`);
  const base = { previousSlot: state?.previousSlot ?? null, installedVersion: p.previousVersion, source: p.previous?.source ?? state?.source ?? null, licence: state?.licence };
  const plan = { base, progress: p, target: null };

  if (p.step === "snapshot") {
    // nothing had changed yet (an unfinished snapshot is cleaned by the next createSnapshot)
    clearProgress(ctx, plan);
    if (flags.rollback) {
      report.step("rollback", "ok", "nothing had changed yet");
      return report.finish(EXIT.FAILED);
    }
    const existing = await ctx.cli.inspect(PLUGIN_ID);
    if (!existing.installed || !ctx.release) throw new Stop(EXIT.FAILED, "resume", `cannot continue the update to ${p.targetVersion}; nothing was changed`);
    return runUpdate({ ...ctx, resume: null, existing, state: { ...state, inProgress: undefined }, consented: true });
  }
  if (flags.rollback || p.step === "rollback" || p.step === "rollback-failed") return rollbackUpdate(ctx, plan);
  if (!ctx.release) {
    report.step("resume", "warn", `${p.targetVersion} is no longer in the feed; rolling back`);
    return rollbackUpdate(ctx, plan);
  }
  try {
    if (p.step === "update") plan.target = await targetSpec(ctx, p.source, ctx.release);
  } catch (err) {
    report.step("resume", "warn", `${err?.message ?? err}; rolling back`);
    return rollbackUpdate(ctx, plan);
  }
  return applyUpdate(ctx, plan, p.step);
}

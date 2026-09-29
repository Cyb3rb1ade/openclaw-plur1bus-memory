/**
 * scripts/dist/installer/verify.mjs — post-install checks (spec A.4).
 *
 * loaded    `plugins inspect <id> --runtime --json`: exit 0, /plugin/status "loaded",
 *           /plugin/imported true, no `sdk-incompatible` diagnostic (fact (b)).
 * integrity the fresh install record against the signed feed: /install/version equals
 *           the release; /install/source "clawhub" → /install/clawpackSha256 equals the
 *           feed's clawpackDigest (R-S6), otherwise /install/npmIntegrity equals the
 *           feed's tarball integrity (fact (b), HM1-R15).
 * selftest  `openclaw plur1bus selftest --json --state-dir <stateDir>` (schema plur1bus.selftest/1, Task 2): ok.
 * model     the selftest's model.state: present/downloaded ok, missing → warning (HM1-R6).
 *
 * Test seam (HM1 Task 8 CI): with PLUR1BUS_PLUGIN_INSTALLER_TEST=1 and PLUR1BUS_SELFTEST_FORCE_FAIL=1
 * the selftest check of a new version fails after the real selftest ran, so CI can drive a real
 * rollback on a real OpenClaw; a rollback's own verify (`release.lenient`) is never forced.
 */

import { PLUGIN_ID } from "./openclaw-cli.mjs";

export const SELFTEST_SCHEMA = "plur1bus.selftest/1";
export const FORCE_FAIL_ENV = "PLUR1BUS_SELFTEST_FORCE_FAIL";

/** Whether the forced-failure test seam is on: only together with the installer test flag. */
export function selftestForcedToFail({ testMode, env }) {
  return testMode === true && env?.[FORCE_FAIL_ENV] === "1";
}

/** Compare the install record with the release; returns { ok, detail }. */
export function checkIntegrity(install, release) {
  if (!install || typeof install !== "object") return { ok: false, detail: "no install record after install" };
  if (install.version !== release.version) return { ok: false, detail: `install record version ${install.version} ≠ feed ${release.version}` };
  if (release.lenient) {
    // a rollback target described by its old install record: missing digests warn, never fail
    const field = install.source === "clawhub" ? "clawpackSha256" : "npmIntegrity";
    const expected = install.source === "clawhub" ? release.clawpackDigest : release.tarball?.integrity;
    if (install[field] == null || !expected) return { ok: true, warn: true, detail: `no ${field} to compare for ${release.version} (the install record or the feed lacks it); integrity not checked` };
  }
  if (install.source === "clawhub") {
    if (!release.clawpackDigest) return { ok: false, detail: `the feed has no clawpackDigest for ${release.version}; cannot verify a ClawHub install (use --source npm or --offline)` };
    return install.clawpackSha256 === release.clawpackDigest
      ? { ok: true, detail: `clawpackSha256 ${release.clawpackDigest.slice(0, 12)}… matches the feed` }
      : { ok: false, detail: `clawpackSha256 ${String(install.clawpackSha256).slice(0, 12)}… ≠ feed clawpackDigest ${release.clawpackDigest.slice(0, 12)}…` };
  }
  return install.npmIntegrity === release.tarball.integrity
    ? { ok: true, detail: `npmIntegrity ${String(release.tarball.integrity).slice(0, 19)}… matches the feed` }
    : { ok: false, detail: `npmIntegrity ${String(install.npmIntegrity).slice(0, 19)}… ≠ feed ${String(release.tarball?.integrity).slice(0, 19)}…` };
}

/**
 * @param {{ cli: ReturnType<typeof import("./openclaw-cli.mjs").createOpenclawCli>, release: any, source: string, downloadModels?: boolean, stateDir?: string, forceFail?: boolean }} a
 * @returns {Promise<Array<{ id: "loaded"|"integrity"|"selftest"|"model", ok: boolean, warn?: boolean, detail: string }>>}
 */
export async function verifyInstall({ cli, release, source, downloadModels = false, stateDir, forceFail = false }) {
  const checks = [];
  const rt = await cli.inspect(PLUGIN_ID, { runtime: true });
  const plugin = rt.json?.plugin;
  const incompatible = (rt.json?.diagnostics ?? []).some((d) => d?.code === "sdk-incompatible" || /sdk-incompatible/.test(String(d?.message ?? "")));
  if (!rt.present) checks.push({ id: "loaded", ok: false, detail: `plugins inspect --runtime failed (exit ${rt.code}): ${rt.detail}` });
  else if (plugin?.status !== "loaded" || plugin?.imported !== true || incompatible) {
    checks.push({ id: "loaded", ok: false, detail: `status ${plugin?.status}, imported ${plugin?.imported}${incompatible ? ", sdk-incompatible" : ""}${plugin?.error ? `: ${String(plugin.error).slice(0, 200)}` : ""}` });
  } else checks.push({ id: "loaded", ok: true, detail: `loaded and imported (${source})` });

  const integ = checkIntegrity(rt.present ? rt.json.install : null, release);
  checks.push({ id: "integrity", ...integ });

  const st = await cli.selftest({ downloadModels, stateDir });
  const rep = st.report;
  if (!rep || rep.schema !== SELFTEST_SCHEMA) {
    checks.push({ id: "selftest", ok: false, detail: `no ${SELFTEST_SCHEMA} report (exit ${st.code})${st.detail ? `: ${st.detail}` : ""}` });
    checks.push({ id: "model", ok: true, warn: true, detail: "unknown (no selftest report)" });
    return checks;
  }
  if (forceFail && release?.lenient !== true) checks.push({ id: "selftest", ok: false, detail: `selftest failed: forced by ${FORCE_FAIL_ENV}=1 (test seam; the real selftest reported ok=${rep.ok === true})` });
  else if (rep.ok === true && st.code === 0) checks.push({ id: "selftest", ok: true, detail: `selftest ok (${(rep.steps ?? []).length} steps)` });
  else {
    const failedAddon = (rep.addons ?? []).find((a) => a && a.ok === false);
    const first = (rep.errors ?? [])[0] ?? (failedAddon ? `addon ${failedAddon.name} failed${failedAddon.package ? ` (${failedAddon.package})` : ""}` : `exit ${st.code}`);
    checks.push({ id: "selftest", ok: false, detail: `selftest failed: ${String(first).slice(0, 300)}` });
  }
  const state = rep.model?.state;
  if (state === "present" || state === "downloaded") checks.push({ id: "model", ok: true, detail: `${rep.model.profile ?? "model"} ${state}` });
  else if (state === "missing") checks.push({ id: "model", ok: true, warn: true, detail: "model not in the cache yet; it downloads on first use (or re-run with --download-models)" });
  else checks.push({ id: "model", ok: true, detail: `model check ${state ?? "not reported"}` });
  return checks;
}

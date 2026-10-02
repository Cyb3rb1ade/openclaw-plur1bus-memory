/**
 * scripts/dist/installer/hermes/context.mjs — what `--update` and `--uninstall` need before they act (HM2 Task 9):
 * the flags checked, Hermes detected, its home, the installer state and the binding. `--host hermes` installs reach
 * update through install.mjs (F17), which hands over the same fields.
 */

import { statSync } from "node:fs";

import { EXIT, Stop } from "../report.mjs";
import { readBinding } from "./binding.mjs";
import { detectHermes } from "./detect.mjs";
import { createHermesCli } from "./hermes-cli.mjs";
import { readHermesState } from "./state.mjs";

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * @returns {Promise<{ det: object, hermesHome: string, hermes: object, state: object|null, binding: object|null }>}
 */
export async function hermesContext(ctx) {
  const { flags, env, platform, report, run } = ctx;
  if (ctx.det && ctx.hermes && ctx.hermesHome) return { det: ctx.det, hermesHome: ctx.hermesHome, hermes: ctx.hermes, state: ctx.state ?? null, binding: ctx.binding ?? readBinding(ctx.hermesHome) };
  if (flags["hermes-profile"] !== undefined && !PROFILE_RE.test(flags["hermes-profile"])) {
    throw new Stop(EXIT.FAILED, "args", `--hermes-profile ${JSON.stringify(flags["hermes-profile"])} is not a Hermes profile name`);
  }
  if (flags["hermes-profile"] !== undefined && flags["hermes-home"] !== undefined) throw new Stop(EXIT.FAILED, "args", "--hermes-profile and --hermes-home are exclusive");
  const det = await detectHermes({ env, platform, run, which: ctx.which, homedir: ctx.homedir, explicitHome: flags["hermes-home"] ?? null, profile: flags["hermes-profile"] ?? null });
  if (!det) throw new Stop(EXIT.INCOMPATIBLE, "detect", "hermes-not-found: no `hermes` launcher on PATH or in its usual places; nothing was changed");
  const hermesHome = det.home;
  report.set("hermes", { version: det.version, versionRaw: det.versionRaw, bin: det.bin, home: hermesHome, root: det.root, profile: det.profile, identity: det.identity, python: det.python });
  report.step("detect", "ok", `Hermes ${det.version ?? `(unknown version: ${det.versionRaw || "no output"})`} at ${det.bin}, home ${hermesHome}${det.profile ? ` (profile ${det.profile})` : ""} [${det.resolvedFrom}]`);
  if (!isDir(hermesHome)) throw new Stop(EXIT.INCOMPATIBLE, "detect", `${hermesHome} does not exist; nothing was changed`);
  let state = null;
  try {
    state = readHermesState(hermesHome);
  } catch (err) {
    throw new Stop(EXIT.FAILED, "state", `${err.message}; check the file and move it aside to continue; nothing was changed`);
  }
  const hermes = createHermesCli({ bin: det.bin, env: { ...env, HERMES_HOME: hermesHome }, run, platform });
  return { det, hermesHome, hermes, state, binding: readBinding(hermesHome) };
}

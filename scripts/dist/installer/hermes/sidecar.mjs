/**
 * scripts/dist/installer/hermes/sidecar.mjs — the pinned `plur1bus` sidecar binary (HM2-R10, HM2-R17).
 *
 * The binary named by the signed feed (`hosts.hermes.releases[].sidecar.binary[<target>]`, URL +
 * SHA-256) goes where the harness's own scripts put it, with the same atomic rename:
 *   POSIX:   $HOME/.local/bin/plur1bus        (harness scripts/install/install.sh:100, 129-130)
 *   Windows: %LOCALAPPDATA%\PLUR1BUS\bin\plur1bus.exe   (harness scripts/install/install.ps1:85-86, 113)
 * A binary already there is renamed to `<bin>.prev-<ts>` (a running .exe can be renamed, not
 * overwritten) and restored by a rollback; after a finished install it is removed.
 *
 * `plur1busHome` only chooses the install target (ruling F24): $PLUR1BUS_HOME (empty = unset,
 * HM2-R26), else ~/.plur1bus, on Windows %LOCALAPPDATA%\PLUR1BUS — the harness `resolve_home`
 * (crates/plur1bus/src/paths.rs). Existing homes are found by compat.mjs `findHarnessHomes`.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";

import { renameWithRetry, writeFileAtomic } from "../fsutil.mjs";
import { EXIT, Stop } from "../report.mjs";
import { fetchBytes } from "../update.mjs";
import { sha256Hex } from "../untar.mjs";

export const MAX_BINARY_BYTES = 256 * 1024 * 1024;

const pathFor = (platform) => (platform === "win32" ? win32 : posix);
const nonEmpty = (v) => (typeof v === "string" && v !== "" ? v : undefined);

function userHome(env, homedir, platform) {
  const hd = typeof homedir === "function" ? homedir() : homedir;
  return (platform === "win32" ? nonEmpty(env.USERPROFILE) : nonEmpty(env.HOME)) ?? hd;
}

function localAppData(env, homedir, platform) {
  return nonEmpty(env.LOCALAPPDATA) ?? win32.join(userHome(env, homedir, platform), "AppData", "Local");
}

/** Where the sidecar binary is installed. */
export function sidecarBinPath({ platform = process.platform, env, homedir = osHomedir }) {
  if (platform === "win32") return win32.join(localAppData(env, homedir, platform), "PLUR1BUS", "bin", "plur1bus.exe");
  return posix.join(userHome(env, homedir, platform), ".local", "bin", "plur1bus");
}

/** The PLUR1BUS home a new sidecar is set up in (absolute). */
export function plur1busHome({ platform = process.platform, env, homedir = osHomedir }) {
  const P = pathFor(platform);
  const explicit = nonEmpty(env.PLUR1BUS_HOME);
  if (explicit) return P.resolve(explicit);
  if (platform === "win32") return win32.join(localAppData(env, homedir, platform), "PLUR1BUS");
  return posix.join(userHome(env, homedir, platform), ".plur1bus");
}

/**
 * `<home>/manifest.json`: its profile (absent = full) and binary version; null without one;
 * `{ invalid }` for a manifest that does not parse (HM2-R27: fail closed, never set up over it).
 * @returns {null | { invalid: string } | { profile: "host"|"full", binaryVersion: string|null }}
 */
export function readSidecar({ home }) {
  let text;
  try {
    text = readFileSync(pathFor(process.platform).join(home, "manifest.json"), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    return { invalid: `unreadable (${err?.code ?? err})` };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { invalid: "not valid JSON" };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { invalid: "not a JSON object" };
  if (doc.profile !== undefined && doc.profile !== "host" && doc.profile !== "full") return { invalid: `unknown profile ${JSON.stringify(doc.profile)}` };
  const v = doc.binary && typeof doc.binary.version === "string" ? doc.binary.version : null;
  return { profile: doc.profile ?? "full", binaryVersion: v };
}

/**
 * Download the release's binary for `target`, verify it against the feed, and move it into place.
 * Nothing is written before the hash matched.
 * @param {{ release: object, target: string, bin: string, fetchImpl?: Function, testMode?: boolean, now?: () => number, platform?: string,
 *   previousBinName?: string|null, beforeChange?: ((plan: { fresh: boolean, previousBin: string|null }) => void) | null }} a
 *   `beforeChange` runs after the download verified and before anything moves (the caller records the plan);
 *   `onPoint` names the test seam's kill points; `ownBin` replaces this install's own binary (resume).
 * The brief's `keep` (HM1 keepArtefact) is deliberately not used: the previous binary is kept as `<bin>.prev-<ts>`
 * beside it (same volume, one rename back) until the install finished, and a fresh download is verified against
 * the signed feed every time; keeping artefacts for --offline is Task 9's update concern.
 * @returns {Promise<{ fresh: boolean, previousBin: string|null, sha256: string }>}
 */
export async function installSidecar({ release, target, bin, fetchImpl, testMode = false, now = Date.now, platform = process.platform, previousBinName = null, ownBin = false, beforeChange = null, onPoint = null }) {
  const art = release.sidecar?.binary?.[target];
  if (!art) throw new Stop(EXIT.INCOMPATIBLE, "sidecar", `the feed carries no sidecar binary for ${target}; nothing was changed`);
  const bytes = await fetchBytes(art.url, { testMode, fetchImpl, maxBytes: MAX_BINARY_BYTES, id: "sidecar" });
  const digest = sha256Hex(bytes);
  if (digest !== art.sha256) throw new Stop(EXIT.FAILED, "sidecar", `SHA-256 of ${art.url} (${digest.slice(0, 12)}…) does not match the feed (${art.sha256.slice(0, 12)}…); nothing was changed`);
  mkdirSync(dirname(bin), { recursive: true });
  const tmp = `${bin}.tmp-${process.pid}`;
  writeFileAtomic(tmp, bytes);
  if (platform !== "win32") chmodSync(tmp, 0o755);
  const fresh = !existsSync(bin);
  // `ownBin` (a resumed run): the binary there is this install's own copy, replaced without keeping it, so no
  // second `<bin>.prev-<ts>` appears; otherwise an existing binary goes to the recorded (or a new) prev name.
  const previousBin = fresh || ownBin ? null : (previousBinName ?? `${bin}.prev-${now()}`);
  try {
    if (beforeChange) beforeChange({ fresh, previousBin });
    onPoint?.("sidecar.planned");
    if (previousBin) {
      renameWithRetry(bin, previousBin);
      onPoint?.("sidecar.moved-aside");
    }
    renameWithRetry(tmp, bin);
  } catch (err) {
    rmSync(tmp, { force: true });
    if (previousBin && !existsSync(bin) && existsSync(previousBin)) renameWithRetry(previousBin, bin);
    throw err;
  }
  return { fresh, previousBin, sha256: digest };
}

/** Remove `<bin>.tmp-<pid>` downloads a killed run left beside the binary (only this installer writes that name). */
export function removeStaleBinTemps(bin) {
  const dir = dirname(bin);
  const prefix = `${basename(bin)}.tmp-`;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed = names.filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)));
  for (const n of removed) rmSync(join(dir, n), { force: true });
  return removed;
}

/** True when `bin` exists and its SHA-256 is `sha256` (a resumed run's own, finished copy). */
export function binaryMatches({ bin, sha256 }) {
  try {
    return sha256Hex(readFileSync(bin)) === sha256;
  } catch {
    return false;
  }
}

/** Undo installSidecar: remove a fresh binary, or put the previous one back. */
export function restoreSidecarBin({ bin, fresh, previousBin }) {
  if (previousBin && existsSync(previousBin)) {
    rmSync(bin, { force: true });
    renameWithRetry(previousBin, bin);
    return "restored";
  }
  if (fresh) {
    rmSync(bin, { force: true });
    return "removed";
  }
  return "kept";
}

/** After a finished install: the kept previous binary is no longer needed. */
export function dropPreviousBin(previousBin) {
  if (previousBin) rmSync(previousBin, { force: true });
}

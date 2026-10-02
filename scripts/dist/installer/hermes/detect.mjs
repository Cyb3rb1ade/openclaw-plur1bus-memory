/**
 * scripts/dist/installer/hermes/detect.mjs — find Hermes, its version and its home.
 *
 * Home resolution is a port of the harness's `defaultHermesHome`/`resolveHermesRoot`
 * (packages/core/src/import/sources/hermes.ts) with the same case table
 * (tests/fixtures/hermes/hermes-home-vectors.json, a byte copy of the harness file):
 * `HERMES_HOME` (Python expandvars + expanduser, `%VAR%` too on Windows) wins; a home of
 * `<root>/profiles/<name>` is profile mode; otherwise `~/.hermes`, on Windows
 * `%LOCALAPPDATA%\hermes` (else `%USERPROFILE%\AppData\Local\hermes`).
 *
 * Version (fact sheet §a, ruling HM2-R22a): line 1 of `hermes --version` matches
 * `Hermes Agent v<maj>.<min>.<patch> (<date>)`; anything else (e.g. `vgit.<sha>`) is an unknown
 * version: warned, never treated as below the minimum. Python: the `Python:` line; Hermes' own
 * `requires-python` comes from `<Install directory>/pyproject.toml` (HM2-R25).
 *
 * Launcher (fact sheet §j): `hermes` on PATH (`hermes.exe`, then `hermes.cmd` on Windows),
 * then `$HERMES_HOME/bin`, `<root>/bin` and `%LOCALAPPDATA%\hermes\bin` (Windows) or `~/.local/bin` (POSIX).
 */

import { accessSync, constants as fsConstants, readFileSync, statSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { posix, win32 } from "node:path";

import { whichOnPath } from "../detect.mjs";
import { createHermesCli } from "./hermes-cli.mjs";

const pathFor = (platform) => (platform === "win32" ? win32 : posix);

/** An environment variable, looked up case-insensitively on Windows (as the OS does). */
export function envGet(env, name, platform) {
  if (platform !== "win32") return env[name];
  if (env[name] !== undefined) return env[name];
  const k = Object.keys(env).find((x) => x.toUpperCase() === name.toUpperCase());
  return k === undefined ? undefined : env[k];
}

const nonEmpty = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Python's os.path.expandvars per flavour; an unknown name is left as written. */
export function expandVars(p, env, platform) {
  const re = platform === "win32" ? /%([^%]+)%|\$\{([^}]+)\}|\$([A-Za-z0-9_]+)/g : /\$\{([^}]+)\}|\$([A-Za-z0-9_]+)/g;
  return p.replace(re, (m, a, b, c) => envGet(env, a ?? b ?? c ?? "", platform) ?? m);
}

/** The home `~` stands for: HOME on POSIX, USERPROFILE on Windows (Python's expanduser), else homedir. */
export function userHome(env, homedir, platform) {
  return nonEmpty(envGet(env, platform === "win32" ? "USERPROFILE" : "HOME", platform)) ?? homedir;
}

function expandUser(p, env, homedir, platform) {
  const home = userHome(env, homedir, platform);
  if (p === "~") return home;
  if (p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\"))) return pathFor(platform).join(home, p.slice(2));
  return p;
}

/** Hermes' default root for this platform (harness `defaultHermesHome`). */
export function defaultHermesRoot({ env, platform = process.platform, homedir }) {
  const P = pathFor(platform);
  const home = userHome(env, homedir, platform);
  if (platform !== "win32") return P.join(home, ".hermes");
  const local = envGet(env, "LOCALAPPDATA", platform)?.trim();
  return P.join(local || P.join(home, "AppData", "Local"), "hermes");
}

function splitProfile(p, platform) {
  const P = pathFor(platform);
  const parent = P.dirname(p);
  const isProfiles = platform === "win32" ? P.basename(parent).toLowerCase() === "profiles" : P.basename(parent) === "profiles";
  return isProfiles && P.basename(p) ? { root: P.dirname(parent), profile: P.basename(p) } : null;
}

/**
 * @param {{ env: Record<string,string|undefined>, platform?: string, homedir?: string | (() => string), explicit?: string|null, profile?: string|null }} a
 *   `explicit` is `--hermes-home` (overrides HERMES_HOME), `profile` is `--hermes-profile` (a profile of the resolved root).
 * @returns {{ root: string, home: string, profile: string|null, resolvedFrom: string }}
 */
export function resolveHermesHome({ env, platform = process.platform, homedir = osHomedir, explicit = null, profile = null }) {
  const P = pathFor(platform);
  const hd = typeof homedir === "function" ? homedir() : homedir;
  let root;
  let home;
  let prof = null;
  let resolvedFrom;
  const raw = nonEmpty(explicit) ?? nonEmpty(envGet(env, "HERMES_HOME", platform));
  if (raw) {
    resolvedFrom = nonEmpty(explicit) ? "flag:--hermes-home" : "env:HERMES_HOME";
    const p = P.resolve(expandUser(expandVars(raw, env, platform), env, hd, platform));
    const split = splitProfile(p, platform);
    root = split ? split.root : p;
    prof = split ? split.profile : null;
    home = p;
  } else {
    resolvedFrom = "default";
    root = defaultHermesRoot({ env, platform, homedir: hd });
    home = root;
  }
  if (profile) {
    home = P.join(root, "profiles", profile);
    prof = profile;
    resolvedFrom = `${resolvedFrom}+flag:--hermes-profile`;
  }
  return { root, home, profile: prof, resolvedFrom };
}

/**
 * Hermes' `agent_identity` for a home (fact sheet §f; informational, the binding keys on the realpath):
 * a profile name for `<root>/profiles/<p>`, `default` for the default root and for any home outside it,
 * `custom` for another directory under the default root.
 */
export function hermesIdentity({ home, profile, defaultRoot, platform = process.platform }) {
  const P = pathFor(platform);
  if (profile) return profile;
  const eq = (a, b) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (eq(P.resolve(home), P.resolve(defaultRoot))) return "default";
  const rel = P.relative(defaultRoot, home);
  return rel && !rel.startsWith("..") && !P.isAbsolute(rel) ? "custom" : "default";
}

const VERSION_RE = /^Hermes Agent v(\d+)\.(\d+)\.(\d+) \((\d{4}\.\d+\.\d+)\)/;

/**
 * Parse `hermes --version` (fact sheet §a).
 * @returns {{ version: string|null, buildDate: string|null, raw: string, python: string|null, installDir: string|null }}
 */
export function parseHermesVersion(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/);
  const first = (lines[0] ?? "").trim();
  const m = VERSION_RE.exec(first);
  const py = lines.map((l) => /^Python:\s*(\d+\.\d+(?:\.\d+)?)/.exec(l.trim())).find(Boolean);
  const dir = lines.map((l) => /^Install directory:\s*(.+?)\s*$/.exec(l.trim())).find(Boolean);
  return {
    version: m ? `${m[1]}.${m[2]}.${m[3]}` : null,
    buildDate: m ? m[4] : null,
    raw: first,
    python: py ? py[1] : null,
    installDir: dir ? dir[1] : null,
  };
}

/** `requires-python` of Hermes' own pyproject.toml, or null (HM2-R25; read-only, never config or secrets). */
export function readRequiresPython(installDir, platform = process.platform) {
  if (!installDir) return null;
  try {
    const text = readFileSync(pathFor(platform).join(installDir, "pyproject.toml"), "utf8").slice(0, 256 * 1024);
    const m = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(text);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function isExecutable(p, platform) {
  try {
    if (!statSync(p).isFile()) return false;
    if (platform !== "win32") accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The hermes launcher, or null (fact sheet §j). */
export function findHermesBin({ env, platform = process.platform, root, home, homedir, which, isExec = isExecutable }) {
  const P = pathFor(platform);
  const find = which ?? ((name) => whichOnPath(name, { env, platform }));
  const names = platform === "win32" ? ["hermes.exe", "hermes.cmd"] : ["hermes"];
  for (const n of names) {
    const hit = find(n);
    if (hit) return hit;
  }
  // Windows: the home's and root's bin, then %LOCALAPPDATA%\hermes\bin (install.ps1's place), also when a custom
  // HERMES_HOME points elsewhere
  const dirs = platform === "win32"
    ? [...new Set([P.join(home, "bin"), P.join(root, "bin"), P.join(defaultHermesRoot({ env, platform, homedir }), "bin")])]
    : [P.join(userHome(env, homedir, platform), ".local", "bin")];
  for (const d of dirs) {
    for (const n of names) {
      const p = P.join(d, n);
      if (isExec(p, platform)) return p;
    }
  }
  return null;
}

/**
 * @param {{ env: Record<string,string|undefined>, platform?: string, run?: Function, which?: (name: string) => string|null,
 *   homedir?: string | (() => string), explicitHome?: string|null, profile?: string|null }} a
 * @returns {Promise<null | { bin: string, version: string|null, versionRaw: string, buildDate: string|null, python: string|null,
 *   requiresPython: string|null, root: string, home: string, profile: string|null, resolvedFrom: string, defaultRoot: string,
 *   identity: string, versionOk: boolean, versionDetail?: string }>}
 */
export async function detectHermes({ env, platform = process.platform, run, which, homedir = osHomedir, explicitHome = null, profile = null }) {
  const hd = typeof homedir === "function" ? homedir() : homedir;
  const loc = resolveHermesHome({ env, platform, homedir: hd, explicit: explicitHome, profile });
  const bin = findHermesBin({ env, platform, root: loc.root, home: loc.home, homedir: hd, which });
  if (!bin) return null;
  const cli = createHermesCli({ bin, env: { ...env, HERMES_HOME: loc.home }, run, platform });
  const v = await cli.version();
  const parsed = parseHermesVersion(v.stdout);
  const defaultRoot = defaultHermesRoot({ env, platform, homedir: hd });
  return {
    bin,
    version: parsed.version,
    versionRaw: parsed.raw,
    buildDate: parsed.buildDate,
    python: parsed.python,
    requiresPython: readRequiresPython(parsed.installDir, platform),
    ...loc,
    defaultRoot,
    identity: hermesIdentity({ home: loc.home, profile: loc.profile, defaultRoot, platform }),
    versionOk: v.code === 0,
    ...(v.code === 0 ? {} : { versionDetail: `hermes --version exit ${v.code}` }),
  };
}

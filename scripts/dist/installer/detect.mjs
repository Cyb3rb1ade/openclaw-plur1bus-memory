/**
 * scripts/dist/installer/detect.mjs — find OpenClaw, its Node and its state dir.
 *
 * State dir, exactly as OpenClaw resolves it (F2; src/config/state-dir.ts,
 * src/cli/profile-utils.ts, normalization-core home-dir at the reference
 * checkout): OPENCLAW_STATE_DIR (trimmed, `~` expanded) → <home>/.openclaw-<OPENCLAW_PROFILE>
 * (a valid, non-"default" profile name) → <home>/.openclaw if it exists → legacy
 * <home>/.clawdbot if only it exists → <home>/.openclaw. <home> = OPENCLAW_HOME →
 * HOME → USERPROFILE → os.homedir(); the literal values "undefined" and "null"
 * count as unset. Config = OPENCLAW_CONFIG_PATH ?? <state>/openclaw.json.
 *
 * Node: the `node` OpenClaw itself runs on. install-cli.sh's wrapper is a
 * shell script `exec "<prefix>/tools/node/bin/node" "<entry.js>" "$@"` (fact
 * sheet step 1): the first quoted path of that exec line. A `#!/abs/node`
 * shebang names it directly; `#!/usr/bin/env node` (npm global) and Windows
 * `openclaw.cmd` fall back to `node` on PATH.
 */

import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { posix, win32 } from "node:path";
import { createOpenclawCli, defaultRun } from "./openclaw-cli.mjs";

const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function clean(v) {
  const t = typeof v === "string" ? v.trim() : "";
  return t && t !== "undefined" && t !== "null" ? t : undefined;
}

/** The profile OpenClaw would select, or null (normalizeProfileName). */
export function normalizeProfile(raw) {
  const p = clean(raw);
  if (!p || p.toLowerCase() === "default" || !PROFILE_RE.test(p)) return null;
  return p;
}

/**
 * @param {{ env: Record<string,string|undefined>, platform?: string, homedir?: () => string, exists?: (p: string) => boolean }} a
 * @returns {{ stateDir: string, configPath: string, profile: string|null, legacy: boolean, home: string }}
 */
export function resolveOpenclawStateDir({ env, platform = process.platform, homedir = osHomedir, exists = existsSync }) {
  const path = platform === "win32" ? win32 : posix;
  const osHome = clean(env.HOME) ?? clean(env.USERPROFILE) ?? clean(safe(homedir));
  let home = clean(env.OPENCLAW_HOME);
  if (home && osHome && (home === "~" || home.startsWith("~/") || home.startsWith("~\\"))) home = osHome + home.slice(1);
  home = path.resolve(home ?? osHome ?? ".");

  const expand = (p) => path.resolve(p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? home + p.slice(1) : p);
  const profile = normalizeProfile(env.OPENCLAW_PROFILE);
  let stateDir;
  let legacy = false;
  const override = clean(env.OPENCLAW_STATE_DIR);
  if (override) {
    stateDir = expand(override);
  } else if (profile) {
    stateDir = path.join(home, `.openclaw-${profile}`);
  } else {
    const newDir = path.join(home, ".openclaw");
    const legacyDir = path.join(home, ".clawdbot");
    if (!tryExists(exists, newDir) && tryExists(exists, legacyDir)) {
      stateDir = legacyDir;
      legacy = true;
    } else {
      stateDir = newDir;
    }
  }
  const configOverride = clean(env.OPENCLAW_CONFIG_PATH);
  const configPath = configOverride ? expand(configOverride) : path.join(stateDir, "openclaw.json");
  return { stateDir, configPath, profile, legacy, home };
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function tryExists(exists, p) {
  try {
    return Boolean(exists(p));
  } catch {
    return false;
  }
}

/**
 * Find `name` on PATH (PATHEXT on win32). Returns the first regular file found.
 * @param {string} name
 * @param {{ env: Record<string,string|undefined>, platform?: string }} o
 */
export function whichOnPath(name, { env, platform = process.platform }) {
  const path = platform === "win32" ? win32 : posix;
  const pathValue = env.PATH ?? env.Path ?? "";
  const exts = platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase())] : [""];
  for (const dir of pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    for (const ext of exts) {
      if (platform === "win32" && ext === "" && !/\.[a-z0-9]+$/i.test(name)) continue;
      const p = path.join(dir, name + ext);
      try {
        if (!statSync(p).isFile()) continue;
        if (platform !== "win32") accessSync(p, fsConstants.X_OK); // skip non-executable files like a shell would
        return p;
      } catch {
        // next
      }
    }
  }
  return null;
}

/** Read the node binary a launcher script execs, or null. */
export function nodeFromLauncher(bin) {
  let head;
  try {
    head = readFileSync(realpathSync(bin)).subarray(0, 4096).toString("utf8");
  } catch {
    return null;
  }
  const exec = /^\s*exec\s+"([^"]+)"\s+"[^"]+"/m.exec(head);
  if (exec && /(^|[\\/])node(\.exe)?$/i.test(exec[1])) return exec[1];
  const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(head);
  if (shebang && !/\/env$/.test(shebang[1]) && /(^|\/)node$/.test(shebang[1])) return shebang[1];
  return null;
}

/**
 * @param {{ env: Record<string,string|undefined>, platform?: string, run?: typeof defaultRun, which?: (name: string) => string|null, homedir?: () => string }} a
 * @returns {Promise<null | { bin: string, version: string, commit: string, node: { bin: string|null, version: string|null }, stateDir: string, configPath: string, profile: string|null, legacy: boolean, versionDetail?: string }>}
 */
export async function detectOpenclaw({ env, platform = process.platform, run = defaultRun, which, homedir = osHomedir }) {
  const find = which ?? ((name) => whichOnPath(name, { env, platform }));
  const bin = find("openclaw");
  if (!bin) return null;
  const cli = createOpenclawCli({ bin, env, run });
  const v = await cli.version();
  const nodeBin = (platform === "win32" ? null : nodeFromLauncher(bin)) ?? find("node");
  let nodeVersion = null;
  if (nodeBin) {
    const r = await run(nodeBin, ["--version"], { env, timeoutMs: 30_000 });
    const m = /^v(\d+\.\d+\.\d+)/.exec(r.stdout.trim());
    if (r.code === 0 && m) nodeVersion = m[1];
  }
  const loc = resolveOpenclawStateDir({ env, platform, homedir });
  return {
    bin,
    version: v.version,
    commit: v.commit,
    ...(v.ok ? {} : { versionDetail: v.detail }),
    node: { bin: nodeBin, version: nodeVersion },
    ...loc,
  };
}

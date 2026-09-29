/**
 * scripts/dist/installer/compat.mjs — everything checked before any change (spec A.3 step 2).
 *
 * Findings are collected, never thrown: the caller prints all fatal ones
 * together and exits 3 (spec A.3). Targets per D8/F5; OpenClaw ≥ the release's
 * minGatewayVersion; Node within the release's engines range; free disk for
 * the plugin's dependency tree and one model; readonly config per fact (j)
 * (the installer enforces OPENCLAW_CONFIG_READONLY/OPENCLAW_NIX_MODE itself,
 * ruling R-S2); `openclaw config validate`; a store inside a harness home
 * (HM1-R17).
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir as osHomedir, machine as osMachine } from "node:os";
import { posix, win32 } from "node:path";
import { compareVersions } from "../build-plugin-feed.mjs";

/** Plugin dependency tree (~580 MB per npm generation, fact sheet (b)) + the E5 model (~490 MB), with headroom. */
export const REQUIRED_FREE_BYTES = 1536 * 1024 * 1024;
export const SUPPORTED_TARGETS = Object.freeze(["linux-x64", "linux-arm64", "darwin-arm64", "win-x64", "win-arm64"]);
const MIN_GLIBC = "2.27";

export const READONLY_REMEDY = Object.freeze({
  OPENCLAW_CONFIG_READONLY:
    "Config is externally managed (OPENCLAW_CONFIG_READONLY=1), so OpenClaw treats openclaw.json as immutable. Edit the config in your external deployment source, then redeploy or restart OpenClaw as needed.",
  OPENCLAW_NIX_MODE:
    "Config is managed by Nix (OPENCLAW_NIX_MODE=1), so OpenClaw treats openclaw.json as immutable. Edit the Nix source instead, then rebuild.",
});
export const INVALID_CONFIG_REMEDY = "OpenClaw's config does not validate. Run `openclaw doctor --fix` (details: `openclaw config validate`), then re-run the installer.";

/**
 * True when this is an x64 Node translated by Rosetta on Apple silicon: `sysctl.proc_translated` is 1, or the
 * machine reports arm64 while the process is x64. Only asked on darwin with arch x64; any probe error → false.
 * @param {{ platform: string, arch: string, sysctl?: () => string, machine?: () => string }} a
 */
export function runningUnderRosetta({ platform, arch, sysctl = defaultProcTranslated, machine = osMachine }) {
  if (platform !== "darwin" || arch !== "x64") return false;
  try {
    if (String(sysctl()).trim() === "1") return true;
  } catch {
    // no sysctl answer: fall through to the machine name
  }
  try {
    return String(machine()).trim() === "arm64";
  } catch {
    return false;
  }
}

function defaultProcTranslated() {
  return execFileSync("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * The installer's target id, or an unsupported descriptor. `rosetta` (runningUnderRosetta) makes the darwin-x64
 * refusal say that this is an x64 Node under Rosetta, not an Intel Mac, and what to install instead.
 * @param {{ platform: string, arch: string, glibcVersion?: string|null, rosetta?: boolean }} a
 * @returns {{ target: string, supported: boolean, detail: string }}
 */
export function resolveTarget({ platform, arch, glibcVersion, rosetta = false }) {
  const os = platform === "win32" ? "win" : platform;
  const base = `${os}-${arch}`;
  if (platform === "darwin" && arch === "x64" && rosetta) {
    return {
      target: base,
      supported: false,
      detail: "this Node is an x64 build running under Rosetta on Apple silicon (darwin-x64 is not supported); install the native arm64 Node (and run OpenClaw with it), then re-run the installer",
    };
  }
  if (platform === "linux") {
    if (!glibcVersion) return { target: `linux-musl-${arch}`, supported: false, detail: `musl/non-glibc Linux (${arch}) is not supported; supported: ${SUPPORTED_TARGETS.join(", ")}` };
    if (SUPPORTED_TARGETS.includes(base) && versionLess(glibcVersion, MIN_GLIBC)) {
      return { target: base, supported: false, detail: `glibc ${glibcVersion} is older than ${MIN_GLIBC}` };
    }
  }
  if (!SUPPORTED_TARGETS.includes(base)) return { target: base, supported: false, detail: `${base} is not supported; supported: ${SUPPORTED_TARGETS.join(", ")}` };
  return { target: base, supported: true, detail: base };
}

function versionLess(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/** The glibc runtime version of this process, or null (musl, non-Linux). */
export function currentGlibcVersion() {
  try {
    return process.report?.getReport?.()?.header?.glibcVersionRuntime ?? null;
  } catch {
    return null;
  }
}

/**
 * npm-style range check for the subset `engines.node` uses: `||` alternatives
 * of space-separated comparators (>=, >, <=, <, =, bare version; x.y shorthands).
 */
export function satisfiesRange(version, range) {
  const v = String(version).replace(/^v/, "");
  const full = (x) => {
    const parts = x.split(".");
    while (parts.length < 3) parts.push("0");
    return parts.join(".");
  };
  return String(range).split("||").some((alt) => {
    const comps = alt.trim().split(/\s+/).filter(Boolean);
    if (comps.length === 0) return false;
    return comps.every((c) => {
      const m = /^(>=|<=|>|<|=)?v?(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/.exec(c);
      if (!m) return false;
      const d = compareVersions(v, full(m[2]));
      switch (m[1] ?? "=") {
        case ">=": return d >= 0;
        case ">": return d > 0;
        case "<=": return d <= 0;
        case "<": return d < 0;
        default: return d === 0;
      }
    });
  });
}

/**
 * Every harness home that exists on this machine (recognised by its manifest.json, HB9):
 * $PLUR1BUS_HOME, ~/.plur1bus, %LOCALAPPDATA%\PLUR1BUS (win32). All are checked, not just the first.
 * @returns {string[]}
 */
export function findHarnessHomes({ env, platform = process.platform, homedir = osHomedir, exists = existsSync }) {
  const path = platform === "win32" ? win32 : posix;
  const home = env.HOME || env.USERPROFILE || homedir();
  const candidates = [
    env.PLUR1BUS_HOME,
    home ? path.join(home, ".plur1bus") : null,
    platform === "win32" && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "PLUR1BUS") : null,
  ].filter(Boolean);
  const found = [];
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (!found.includes(abs) && exists(path.join(abs, "manifest.json"))) found.push(abs);
  }
  return found;
}

/**
 * The store path the plugin will use (ruling R-S7): configured baseDbPath, else
 * os.homedir()/.openclaw/memory/lancedb-namespaced regardless of OPENCLAW_STATE_DIR or profile.
 */
export function resolveBaseDbPath({ configured, env, platform = process.platform, homedir = osHomedir }) {
  const path = platform === "win32" ? win32 : posix;
  const home = (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
  if (configured) {
    const c = String(configured);
    return path.resolve(c === "~" || c.startsWith("~/") || c.startsWith("~\\") ? home + c.slice(1) : c);
  }
  return path.join(home, ".openclaw", "memory", "lancedb-namespaced");
}

/**
 * realpath of `p`, or — when `p` does not exist yet (a store not created) —
 * the realpath of its deepest existing ancestor plus the missing tail, so both
 * sides of `inside()` resolve links alike (macOS: /var -> /private/var).
 */
export function realish(p, path) {
  const tail = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(realpathSync.native(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur || parent === ".") return p;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** `child` is `parent` or lies below it, compared by realpath (see realish) and, on win32, case-folded. */
export function inside(child, parent, platform) {
  const path = platform === "win32" ? win32 : posix;
  const norm = (p) => (platform === "win32" ? p.toLowerCase() : p);
  const rel = path.relative(norm(realish(parent, path)), norm(realish(child, path)));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * @param {{ openclawVersion: string|null, nodeVersion: string|null, target: {target: string, supported: boolean, detail: string},
 *   release: { compat: { minGatewayVersion: string }, node: string }, freeBytes: number|null, readonlyConfig: null|"OPENCLAW_CONFIG_READONLY"|"OPENCLAW_NIX_MODE",
 *   configValid: boolean, baseDbPath: string, harnessHomes?: string[], harnessHome?: string|null, platform?: string }} a
 * @returns {Array<{ id: string, fatal: boolean, detail: string }>}
 */
export function checkCompat({ openclawVersion, nodeVersion, target, release, freeBytes, readonlyConfig, configValid, baseDbPath, harnessHomes, harnessHome, platform = process.platform }) {
  const homes = [...(harnessHomes ?? []), ...(harnessHome ? [harnessHome] : [])];
  const findings = [];
  if (!target.supported) findings.push({ id: "unsupported-target", fatal: true, detail: target.detail });
  const min = release.compat.minGatewayVersion;
  if (!openclawVersion) {
    findings.push({ id: "openclaw-too-old", fatal: true, detail: `could not read the OpenClaw version (need ≥ ${min})` });
  } else {
    let old;
    try {
      old = compareVersions(openclawVersion, min) < 0;
    } catch {
      old = true;
    }
    if (old) findings.push({ id: "openclaw-too-old", fatal: true, detail: `OpenClaw ${openclawVersion} is older than ${min}; update OpenClaw first` });
  }
  if (!nodeVersion || !satisfiesRange(nodeVersion, release.node)) {
    findings.push({ id: "node-unsupported", fatal: true, detail: `OpenClaw's Node ${nodeVersion ?? "(not found)"} does not satisfy ${release.node}` });
  }
  if (typeof freeBytes === "number" && freeBytes < REQUIRED_FREE_BYTES) {
    findings.push({ id: "insufficient-disk", fatal: true, detail: `${Math.floor(freeBytes / 1048576)} MiB free, need ${REQUIRED_FREE_BYTES / 1048576} MiB` });
  }
  if (readonlyConfig) findings.push({ id: "config-readonly", fatal: true, detail: READONLY_REMEDY[readonlyConfig] });
  if (!configValid) findings.push({ id: "config-invalid", fatal: true, detail: INVALID_CONFIG_REMEDY });
  const home = baseDbPath ? homes.find((h) => inside(baseDbPath, h, platform)) : undefined;
  if (home) {
    const harnessHome = home;
    findings.push({ id: "store-inside-harness-home", fatal: true, detail: `baseDbPath ${baseDbPath} lies inside the PLUR1BUS harness home ${harnessHome}; one engine per store (D89)` });
  }
  return findings;
}

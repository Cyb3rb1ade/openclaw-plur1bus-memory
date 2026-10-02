#!/usr/bin/env node
/**
 * tests/helpers/assert-disposable.mjs — refuse to go on unless OpenClaw points at a disposable instance (HM1-R11).
 *
 * node tests/helpers/assert-disposable.mjs [--host openclaw|hermes] [--var NAME]...
 *
 * `--host hermes` (HM2 Task 11) checks HERMES_HOME and PLUR1BUS_HOME instead of the OpenClaw variables.
 *
 * OPENCLAW_HOME and OPENCLAW_STATE_DIR (plus every --var NAME, e.g. HOME on the POSIX legs) must be set, absolute,
 * and strictly inside the temp root: $RUNNER_TEMP when set (GitHub Actions), else os.tmpdir(). Symlinks of the
 * existing part of each path are resolved (macOS /var → /private/var) and win32 compares case-insensitively.
 * Prints one JSON line with the checked paths on stdout; exit 0, or 1 with every reason on stderr.
 * The plugin-dist workflow runs it as the first step after installing OpenClaw, and ci-plugin-dist.mjs before
 * every OpenClaw call it makes.
 */

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, posix, resolve, win32 } from "node:path";
import { parseArgs } from "node:util";

export const REQUIRED_VARS = Object.freeze(["OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
export const REQUIRED_VARS_BY_HOST = Object.freeze({ openclaw: REQUIRED_VARS, hermes: Object.freeze(["HERMES_HOME", "PLUR1BUS_HOME"]) });

/** The real path of `p`, resolving the longest existing prefix (the rest may not exist yet). */
function realish(p, path) {
  const tail = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...tail.reverse());
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** True when `child` is strictly below `parent`. */
export function strictlyInside(child, parent, platform = process.platform) {
  const path = platform === "win32" ? win32 : posix;
  const norm = (p) => (platform === "win32" ? realish(p, path).toLowerCase() : realish(p, path));
  const rel = path.relative(norm(parent), norm(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * @param {{ env?: Record<string,string|undefined>, vars?: string[], platform?: string, host?: "openclaw"|"hermes" }} [o]
 * @returns {{ ok: boolean, root: string, checked: Record<string,string>, errors: string[] }}
 */
export function assertDisposable({ env = process.env, vars = [], platform = process.platform, host = "openclaw" } = {}) {
  const required = REQUIRED_VARS_BY_HOST[host];
  if (!required) throw new Error(`unknown host ${JSON.stringify(host)} (openclaw|hermes)`);
  const path = platform === "win32" ? win32 : posix;
  const root = env.RUNNER_TEMP && String(env.RUNNER_TEMP).trim() ? path.resolve(env.RUNNER_TEMP) : tmpdir();
  const errors = [];
  const checked = {};
  for (const name of [...new Set([...required, ...vars])]) {
    const v = env[name];
    if (typeof v !== "string" || !v.trim()) {
      errors.push(`${name} is not set`);
      continue;
    }
    if (!(platform === "win32" ? win32.isAbsolute(v) : isAbsolute(v))) {
      errors.push(`${name}=${v} is not absolute`);
      continue;
    }
    checked[name] = path.resolve(v);
    if (!strictlyInside(v, root, platform)) errors.push(`${name}=${v} is not inside the temp root ${root}`);
  }
  return { ok: errors.length === 0, root, checked, errors };
}

if (import.meta.filename && resolve(process.argv[1] ?? "") === import.meta.filename) {
  let vars = [];
  let host = "openclaw";
  try {
    ({ values: { var: vars = [], host = "openclaw" } } = parseArgs({ args: process.argv.slice(2), options: { var: { type: "string", multiple: true }, host: { type: "string" } }, strict: true }));
  } catch (err) {
    process.stderr.write(`assert-disposable: ${err.message}\n`);
    process.exit(1);
  }
  let r;
  try {
    r = assertDisposable({ vars, host });
  } catch (err) {
    process.stderr.write(`assert-disposable: ${err.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ok: r.ok, root: r.root, checked: r.checked })}\n`);
  if (!r.ok) {
    process.stderr.write(`assert-disposable: ${host === "hermes" ? "Hermes" : "OpenClaw"} is not disposable here (HM1-R11); refusing to continue:\n  ${r.errors.join("\n  ")}\n`);
    process.exit(1);
  }
}


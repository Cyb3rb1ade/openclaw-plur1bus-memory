#!/usr/bin/env node
/**
 * verify-workspace-writer.mjs — read-only health check for workspace memory dirs.
 *
 * Verifies that every workspace memory directory under OPENCLAW_HOME is reachable
 * and writable by creating (and immediately removing) a tiny probe file inside
 * `<workspace>/memory/.healthcheck/`. Real memory files (*.md) and dream diary
 * files are never touched.
 *
 * Usage:
 *   node scripts/verify-workspace-writer.mjs
 *
 * Exit codes:
 *   0  all discovered workspace memory paths exist and are writable
 *   1  at least one path is missing or not writable (or no workspaces found)
 *   2  unexpected error (e.g. HOME not resolvable, config parse error)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveInside } from "../lib/sql-safety.js";

const HEALTH_DIR = ".healthcheck";
const TEMP_PREFIX = ".verify-";

/**
 * Resolves OPENCLAW_HOME from the environment, then a configured path inside
 * ~/.openclaw/openclaw.json, then ~/.openclaw.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 * @throws if HOME cannot be determined or openclaw.json cannot be parsed
 */
export function resolveOpenclawHome(env = process.env) {
  if (env.OPENCLAW_HOME) {
    return resolve(env.OPENCLAW_HOME);
  }

  const home = env.HOME || homedir();
  if (!home) {
    throw new Error("cannot determine user home directory");
  }

  const defaultPath = resolve(home, ".openclaw");
  const configPath = resolve(defaultPath, "openclaw.json");
  if (existsSync(configPath)) {
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (err) {
      throw new Error(`failed to parse openclaw.json: ${err.message}`);
    }
    const configured =
      cfg && typeof cfg === "object" &&
      (cfg.openclawHome || cfg.home || cfg.path);
    if (typeof configured === "string" && configured.length > 0) {
      return resolve(defaultPath, configured);
    }
  }

  return defaultPath;
}

/**
 * Discovers `<workspace>/memory` directories under OPENCLAW_HOME.
 * Matches directories whose name starts with "workspace" and contain a
 * "memory" subdirectory.
 *
 * @param {string} openclawHome
 * @returns {string[]}
 */
export function discoverWorkspaceMemoryPaths(openclawHome) {
  if (!existsSync(openclawHome)) {
    return [];
  }

  const entries = readdirSync(openclawHome, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("workspace")) {
      continue;
    }
    const memoryPath = resolveInside(openclawHome, entry.name, "memory");
    if (existsSync(memoryPath) && statSync(memoryPath).isDirectory()) {
      paths.push(memoryPath);
    }
  }
  return paths.sort();
}

/**
 * Checks whether a workspace memory path is writable by probing
 * `<path>/.healthcheck/.verify-<pid>-<ts>.tmp`.
 *
 * @param {string} memoryPath
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkWorkspaceMemoryWritable(memoryPath) {
  if (!existsSync(memoryPath)) {
    return { ok: false, reason: "workspace memory path does not exist" };
  }

  const st = statSync(memoryPath);
  if (!st.isDirectory()) {
    return { ok: false, reason: "workspace memory path is not a directory" };
  }

  try {
    const healthDir = resolveInside(memoryPath, HEALTH_DIR);
    mkdirSync(healthDir, { recursive: true });

    const probeName = `${TEMP_PREFIX}${process.pid}-${Date.now()}.tmp`;
    if (probeName.endsWith(".md")) {
      throw new Error("refusing to write a probe file with .md extension");
    }
    const probePath = resolveInside(healthDir, probeName);

    writeFileSync(probePath, "");
    unlinkSync(probePath);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `workspace memory path is not writable (${err.code || err.message})`,
    };
  }
}

/**
 * Runs the workspace writer verification.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} options
 * @returns {{ ok: boolean, exitCode: number, checked: number, error?: string }}
 */
export async function run(options = {}) {
  const env = options.env || process.env;

  try {
    const openclawHome = resolveOpenclawHome(env);
    const memoryPaths = discoverWorkspaceMemoryPaths(openclawHome);

    if (memoryPaths.length === 0) {
      console.log("[workspace-writer] warning: no workspace memory paths found");
      return { ok: false, exitCode: 1, checked: 0 };
    }

    let allOk = true;
    for (const memoryPath of memoryPaths) {
      const result = checkWorkspaceMemoryWritable(memoryPath);
      if (!result.ok) {
        allOk = false;
        console.log(`[workspace-writer] warning: ${result.reason}`);
      }
    }

    if (allOk) {
      console.log(
        `[workspace-writer] all ${memoryPaths.length} workspace memory path(s) exist and are writable`,
      );
    } else {
      console.log(
        "[workspace-writer] at least one workspace memory path is not writable",
      );
    }

    return { ok: allOk, exitCode: allOk ? 0 : 1, checked: memoryPaths.length };
  } catch (err) {
    console.error("[workspace-writer] error:", err.message);
    return { ok: false, exitCode: 2, checked: 0, error: err.message };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let env = process.env;
  const openclawHomeIndex = process.argv.indexOf("--openclaw-home");
  if (openclawHomeIndex !== -1 && process.argv[openclawHomeIndex + 1]) {
    env = { ...process.env, OPENCLAW_HOME: process.argv[openclawHomeIndex + 1] };
  }

  run({ env }).then((result) => process.exit(result.exitCode)).catch((err) => {
    console.error("[workspace-writer] unexpected error:", err.message);
    process.exit(2);
  });
}

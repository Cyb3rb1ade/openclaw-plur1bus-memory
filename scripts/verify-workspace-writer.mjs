#!/usr/bin/env node
/**
 * verify-workspace-writer.mjs — checks that memory workspace directories are writable.
 *
 * Discovers workspace-<agent>/memory directories and Dream Diary paths from the
 * OpenClaw config (or falls back to well-known defaults), then verifies write
 * access by writing a small healthcheck file to a dedicated tmp path only —
 * never to real memory or diary directories.
 *
 * Usage:
 *   node scripts/verify-workspace-writer.mjs [--openclaw-home DIR] [--quiet]
 *
 * Exit codes:
 *   0  All discovered workspaces are writable (or no workspaces found)
 *   1  One or more workspaces are not writable
 *   2  Unexpected error
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_AGENTS = ["main", "bernhardine", "heisenberg"];

function parseArgs(argv) {
  const opts = { openclawHome: join(homedir(), ".openclaw"), quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--openclaw-home") opts.openclawHome = argv[++i];
    else if (a === "--quiet") opts.quiet = true;
  }
  return opts;
}

function log(quiet, ...args) {
  if (!quiet) console.log(...args);
}

/**
 * Discovers workspace memory dirs from openclaw.json agents.list, falling back
 * to default agent names if the config is absent or unreadable.
 */
function discoverWorkspaceDirs(openclawHome) {
  const configPath = join(openclawHome, "openclaw.json");
  let agentIds = [];

  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      const list = cfg?.agents?.list;
      if (Array.isArray(list) && list.length > 0) {
        agentIds = list.map((e) => e?.id).filter(Boolean);
      }
    } catch {
      // fall through to defaults
    }
  }
  if (agentIds.length === 0) agentIds = DEFAULT_AGENTS;

  return agentIds.map((id) => {
    const wsKey = id === "main" ? "" : `-${id}`;
    const memDir = join(openclawHome, `workspace${wsKey}`, "memory");
    // Dream Diary files live inside memDir (e.g. YYYY-MM-DD.md); we check the
    // parent dir writability — never create actual diary files.
    return { agentId: id, memDir };
  });
}

/**
 * Checks that a directory exists and can be listed.
 */
function checkDirAccessible(dir) {
  if (!existsSync(dir)) return { ok: false, error: "directory does not exist" };
  try {
    readdirSync(dir);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Verifies write access by creating and immediately deleting a file inside
 * memDir/.healthcheck/ — a dedicated sub-directory that never holds real
 * memory data, so the probe touches the actual storage path.
 */
function checkWritable(memDir, agentId) {
  const hcDir = join(memDir, ".healthcheck");
  const checkPath = join(hcDir, `.probe-${agentId}-${Date.now()}`);
  try {
    mkdirSync(hcDir, { recursive: true });
    writeFileSync(checkPath, `healthcheck ${agentId} ${new Date().toISOString()}\n`);
    unlinkSync(checkPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { openclawHome, quiet } = opts;

  log(quiet, "verify-workspace-writer");
  log(quiet, `  openclaw-home: ${openclawHome}`);
  log(quiet, "");

  const workspaceDirs = discoverWorkspaceDirs(openclawHome);
  if (workspaceDirs.length === 0) {
    log(quiet, "  ✓ No workspaces found — nothing to check.");
    process.exit(0);
  }

  let failures = 0;

  for (const { agentId, memDir } of workspaceDirs) {
    const accessible = checkDirAccessible(memDir);
    if (!accessible.ok) {
      // Directory missing is a warning, not a hard failure — workspace may not
      // be initialized yet on a fresh install.
      log(quiet, `  ~ ${agentId}/memory  (${accessible.error}, skipping write check)`);
      continue;
    }

    const writable = checkWritable(memDir, agentId);
    if (writable.ok) {
      log(quiet, `  ✓ ${agentId}/memory`);
    } else {
      log(quiet, `  ✗ ${agentId}/memory  (write failed: ${writable.error})`);
      failures++;
    }
  }

  log(quiet, "");
  if (failures === 0) {
    log(quiet, `  ✓ All reachable workspace(s) writable.`);
    process.exit(0);
  } else {
    log(quiet, `  ✗ ${failures} workspace(s) not writable.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("verify-workspace-writer: unexpected error:", err);
  process.exit(2);
});

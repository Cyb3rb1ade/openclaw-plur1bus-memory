/**
 * find-deploy-dir.mjs — shared deploy-directory auto-detection for the
 * PLUR1BUS deploy-integrity scripts (repair-installed-plugin.mjs,
 * verify-plugin-deploy.mjs). Both must agree on where the deployed
 * extension lives, or they silently drift and check different directories.
 *
 * No root/home assumptions: works for any invoking user via node:os
 * homedir() (which resolves to that user's own $HOME, root or not — never
 * a hardcoded /root path). PLUR1BUS_DEPLOY always wins when set.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * @param {string} repoDir — repo root to read openclaw.plugin.json from
 * @returns {string} best-guess deploy directory (existing candidate, or the
 *   first/most-likely candidate if none exist yet)
 */
export function findDeployDir(repoDir) {
  if (process.env.PLUR1BUS_DEPLOY) return process.env.PLUR1BUS_DEPLOY;

  let pluginId = "memory-lancedb-namespaced";
  try {
    pluginId = JSON.parse(readFileSync(join(repoDir, "openclaw.plugin.json"), "utf8")).id ?? pluginId;
  } catch { /* default */ }

  const openclawHome = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
  const candidates = [
    join(openclawHome, "openclaw-plur1bus-memory"),
    join(openclawHome, "extensions", pluginId),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

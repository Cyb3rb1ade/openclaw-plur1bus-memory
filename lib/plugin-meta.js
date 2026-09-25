/**
 * lib/plugin-meta.js — the plugin's root directory and version, read once.
 * Was index.js:247 (__pluginDir) and :272-278 (PLUGIN_VERSION).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let version = "0.0.0";
try {
  version = JSON.parse(readFileSync(join(PLUGIN_ROOT, "openclaw.plugin.json"), "utf8")).version || version;
} catch (_err) { /* best-effort; stays "0.0.0" */ }

export const PLUGIN_VERSION = version;

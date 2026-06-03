/**
 * /einschalten + /ausschalten — Feature-Toggle.
 *
 * Schreibt direkt nach $OPENCLAW_CONFIG_PATH bzw. $HOME/.openclaw/openclaw.json.
 * Whitelist verhindert, dass beliebige Pfade gesetzt werden.
 *
 * Restart-Hinweis ist Teil der User-Antwort, weil der Plugin-Code die Werte
 * erst beim register() liest — ein Hot-Reload ist nicht garantiert.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { acquireJobLock, releaseJobLock } from "../job-lock.js";

/**
 * Führt eine read-modify-write-Operation auf openclaw.json unter einem
 * File-Lock aus, damit konkurrierende Writer (Toggle, /plur1bus setup,
 * mehrere Agenten) sich nicht gegenseitig überschreiben.
 *
 * @param {string} configPath
 * @param {() => any} fn — die kritische Sektion (read + write)
 */
export function withConfigLock(configPath, fn) {
  const lockPath = `${configPath}.lock`;
  try {
    acquireJobLock(lockPath, { staleMs: 30_000 });
  } catch (err) {
    return { ok: false, error: `Config wird gerade von einem anderen Vorgang geschrieben (Lock aktiv): ${err.message}` };
  }
  try {
    return fn();
  } finally {
    releaseJobLock(lockPath);
  }
}

export const FEATURE_WHITELIST = {
  vaultSync: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'obsidianBridge', 'enabled'],
    description: 'Vault-Sync (Obsidian-Bridge)',
  },
  kritischPush: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'criticalPush', 'enabled'],
    description: 'Push bei kritischen Memories',
  },
  dailyConsolidation: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'dailyConsolidation', 'enabled'],
    description: 'Tägliche Konsolidierung',
  },
};

export function listFeatures() {
  return Object.keys(FEATURE_WHITELIST);
}

function resolveOpenClawConfigPath() {
  if (process.env.OPENCLAW_CONFIG_PATH) return process.env.OPENCLAW_CONFIG_PATH;
  const home = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
  return join(home, "openclaw.json");
}

function setDeep(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (cur[seg] === undefined || cur[seg] === null || typeof cur[seg] !== "object") {
      cur[seg] = {};
    }
    cur = cur[seg];
  }
  cur[path[path.length - 1]] = value;
}

function atomicWriteJson(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

/**
 * @param {string} name      — Feature-Schlüssel aus der Whitelist
 * @param {boolean} enable   — true = einschalten, false = ausschalten
 * @param {object} [opts]
 * @param {string} [opts.configPath]
 */
export function toggleFeature(name, enable, opts = {}) {
  const known = listFeatures();
  if (!name) {
    return {
      ok: false,
      error: `Kein Feature angegeben.`,
      knownFeatures: known,
    };
  }
  const def = FEATURE_WHITELIST[name];
  if (!def) {
    return {
      ok: false,
      error: `Feature "${name}" unbekannt. Bekannt: ${known.join(', ')}`,
      knownFeatures: known,
    };
  }
  const path = opts.configPath || resolveOpenClawConfigPath();
  if (!existsSync(path)) {
    return { ok: false, error: `openclaw.json nicht gefunden: ${path}`, knownFeatures: known };
  }
  return withConfigLock(path, () => {
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      return { ok: false, error: `openclaw.json kann nicht gelesen werden: ${err.message}`, knownFeatures: known };
    }
    setDeep(cfg, def.configPath, !!enable);
    try {
      atomicWriteJson(path, cfg);
    } catch (err) {
      return { ok: false, error: `Schreiben fehlgeschlagen: ${err.message}`, knownFeatures: known };
    }
    return { ok: true, feature: name, enabled: !!enable, description: def.description };
  });
}

export function renderToggleResult(result) {
  if (!result?.ok) {
    const known = result?.knownFeatures || listFeatures();
    const knownLine = `Bekannt: ${known.join(', ')}`;
    const errLine = result?.error || "Unbekannter Fehler.";
    return `❌ ${errLine}\n${knownLine}`;
  }
  const def = FEATURE_WHITELIST[result.feature];
  const label = def?.description || result.feature;
  const state = result.enabled ? "an" : "aus";
  return `✅ ${label} ist jetzt ${state}. Restart erforderlich: systemctl --user restart openclaw-gateway`;
}

export function renderFeatureList() {
  const known = listFeatures();
  const lines = ["Bekannte Features:"];
  for (const name of known) {
    lines.push(`• ${name} — ${FEATURE_WHITELIST[name].description}`);
  }
  lines.push("");
  lines.push("Benutzung: /einschalten <feature>  oder  /ausschalten <feature>");
  return lines.join("\n");
}

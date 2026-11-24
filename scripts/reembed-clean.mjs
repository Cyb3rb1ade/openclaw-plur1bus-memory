#!/usr/bin/env node
/**
 * scripts/reembed-clean.mjs — Bestand bereinigt neu einbetten (7.20.10).
 *
 * Bernds Vorschlag 1 für den Bestand: Der gespeicherte Text bleibt wörtlich,
 * nur der Vektor wird aus cleanTextForEmbedding() neu berechnet
 * (lib/embedding-text.js, Regelsatz clean-v1). Geschrieben werden
 * ausschließlich `vector` und `embeddingTextMode`; Text, IDs und alle anderen
 * Spalten bleiben unverändert (geprüft je Block).
 *
 * Auswahl: Zeilen mit embeddingTextMode = 'raw' (Standard: nur status
 * 'active', --status all für alle). Je Zeile:
 *   - Text ändert sich durch die Bereinigung → neuer Vektor über den
 *     Embedding-Provider des Plugins (Batches, Pause zwischen den Aufrufen)
 *   - Text bleibt gleich → nur embeddingTextMode umstellen, kein API-Aufruf
 *   - nur Hülle (bereinigt leer) → bleibt 'raw', wie beim Capture
 *
 * Die bestehende Re-Embedding-Migration (lib/reembedding/*) passt hier nicht:
 * sie baut für einen Provider-/Modellwechsel eine neue Generation als Kopie,
 * läuft im Gateway (ein Block je bestätigtem RPC) und schaltet danach um. Hier
 * bleiben Modell, Dimension und Generation gleich, es ändert sich nur der
 * Eingabetext einzelner Zeilen — ein In-place-Update bei gestopptem Gateway.
 *
 * Aufruf:
 *   node scripts/reembed-clean.mjs --agent main --dry-run
 *   node scripts/reembed-clean.mjs --agent main --apply --snapshot ~/.openclaw/.snapshots/plur1bus-YYYYMMDD-HHMMSS
 *
 * Optionen:
 *   --agent <id>              Agent (mehrfach möglich, Pflicht)
 *   --dry-run | --apply       Standard: --dry-run (kein Provider, kein Schlüssel nötig)
 *   --status active|all       Standard: active
 *   --strip-speaker | --keep-speaker   überschreibt embedding.cleanText.stripSpeaker
 *   --batch-size <n>          Texte je Provider-Aufruf (Standard 64, max 512)
 *   --min-interval-ms <n>     Pause zwischen Provider-Aufrufen (Standard 250)
 *   --max-rows <n>            höchstens so viele Zeilen neu einbetten (gestaffelter Lauf)
 *   --min-cosine <x>          Abbruch vor dem Schreiben, wenn der Median des Kosinus alt/neu
 *                             darunter liegt (Standard 0.2, 0 = aus; falsches Modell/Endpoint)
 *   --snapshot <dir>          Snapshot von scripts/backup-snapshot.sh (Pflicht im Produktivpfad)
 *   --workspace-dir <dir>     Ziel des Audit-Logs (Standard: Workspace des Agenten laut openclaw.json)
 *   --openclaw-home <dir>     Standard: $OPENCLAW_HOME bzw. ~/.openclaw (wie backup-snapshot.sh)
 *   --base <dir>              LanceDB-Basis (Standard: baseDbPath aus der Plugin-Konfiguration)
 *   --out <dir>               Bericht und Checkpoint (Standard: <base>/../reembed-clean)
 *   --embedding-api-key-env <ENV>  Schlüssel aus dieser Variable (sonst wie das Plugin)
 *   --add-column              Spalte embeddingTextMode anlegen, falls sie fehlt (sonst Abbruch)
 *   --no-optimize             nach dem Lauf kein table.optimize()
 *   --allow-running-gateway   nur außerhalb von <openclaw-home> (Kopie)
 *   --json                    Bericht als JSON auf stdout
 *
 * Vorbedingungen für --apply im Produktivpfad (<base> unter <openclaw-home>):
 * Gateway gestoppt (systemd und Prozessliste), Plugin ≥ 7.20.10 ausgeliefert
 * (ältere Versionen schreiben Zeilen ohne die neue Spalte), frischer Snapshot
 * unter <openclaw-home>/.snapshots mit denselben LanceDB-Versionen wie live.
 * Jeder Lauf schreibt "started"/"committed"/"failed" per appendDestructiveOpLog.
 * Wiederaufnahme: mit demselben Aufruf (auch demselben --snapshot) erneut
 * starten — verarbeitete Zeilen sind nicht mehr 'raw'; der Checkpoint hält
 * Modus, Auswahl, Tabelle, Snapshot und die LanceDB-Versionen nach dem
 * letzten eigenen Schreibzugriff fest (geschrieben vor dem ersten
 * Schreibzugriff und nach jedem Block). Fortgesetzt wird mit demselben
 * Snapshot nur, wenn live genau diese Versionen hat; hat ein anderer Schreiber
 * (Gateway zwischen zwei Teilläufen) oder ein harter Abbruch mitten im Block
 * (SIGKILL, OOM) etwas geschrieben, bricht das Skript ab und verlangt einen
 * frischen Snapshot, der dann die neue Basis ist. Ctrl-C/SIGTERM beendet den
 * laufenden Block, schreibt "failed" und den Checkpoint und beendet den ganzen
 * Lauf: weitere --agent werden nicht mehr begonnen ("skipped: interrupted" im
 * Bericht). Ein zweites Signal beendet sofort (danach ist ein frischer
 * Snapshot nötig), auch bei mehreren Agenten. Zwischen
 * Teilläufen bleibt der Gateway gestoppt, sonst ebenfalls frischer Snapshot.
 * table.optimize() läuft erst, wenn alle Zeilen durch sind.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  cleanTextForEmbedding,
  embeddingTextModeFor,
  resolveEmbeddingCleanTextConfig,
} from "../lib/embedding-text.js";
import { resolvePromotionDbRoot } from "../lib/promoted-memory-reindex.js";
import { redactError } from "../lib/safe-logging.js";
import {
  appendDestructiveOpLog, resolveInside, safeAgentId, safeUuid,
} from "../lib/sql-safety.js";

const TABLE_NAME = "memories";
const MIN_PLUGIN_VERSION = [7, 20, 10];
const DEFAULT_BATCH_SIZE = 64;
const MAX_BATCH_SIZE = 512;
const DEFAULT_MIN_INTERVAL_MS = 250;
// Zufallsvektoren (fremder Raum) liegen bei 3072 Dimensionen um |cos| < 0,05;
// Rohtext und bereinigter Text desselben Modells deutlich darüber.
const DEFAULT_MIN_COSINE = 0.2;
const MODE_ONLY_CHUNK = 500;
const EXAMPLE_LIMIT = 8;
// Grobe Schätzung für Deutsch/Englisch mit cl100k-artigen Tokenizern.
const CHARS_PER_TOKEN = 3.5;
// USD je 1 Mio. Tokens (OpenAI-Preisliste, Stand 2026); unbekannt → keine Kostenschätzung.
const PRICE_PER_MILLION = Object.freeze({
  "text-embedding-3-large": 0.13,
  "text-embedding-3-small": 0.02,
  "text-embedding-ada-002": 0.10,
});
// Diese Regeln entfernen nur feste Hüllen; ihre Fragmente dürfen im Bericht
// stehen (Ziffern maskiert). Alles andere erscheint nur als Regel + Länge.
const PRINTABLE_RULES = new Set(["audioEnvelope", "placeholder", "stageDirection", "filler", "timestamp", "talkMode"]);
const ROLE_SPEAKERS = /^(?:User|Assistant|Human|AI):$/i;
// Ältere Importe schrieben IDs als 32- bzw. 64-stelligen Hex-Hash (Bestand
// 24.11.2026: main 604, bernhardine 310, heisenberg 235 aktive Zeilen). Sie
// bestehen nur aus [0-9a-f] und sind damit im SQL-Literal so sicher wie eine
// UUID; alles andere bleibt unangetastet und wird als invalidId gezählt.
const LEGACY_HEX_ID_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;

/**
 * safeUuid, zusätzlich die Hex-IDs alter Importe (nur [0-9a-f], 32/64 Zeichen).
 * @param {unknown} id
 * @returns {string}
 */
function safeRowId(id) {
  if (typeof id === "string" && LEGACY_HEX_ID_RE.test(id)) return id;
  return safeUuid(id);
}

/**
 * Liest die Aufrufparameter.
 * @param {string[]} argv
 * @returns {object}
 */
export function parseArgs(argv) {
  const options = {
    agents: [],
    apply: false,
    status: "active",
    stripSpeaker: null,
    batchSize: DEFAULT_BATCH_SIZE,
    minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
    maxRows: null,
    minCosine: DEFAULT_MIN_COSINE,
    snapshot: "",
    workspaceDir: "",
    openclawHome: "",
    base: "",
    out: "",
    embeddingApiKeyEnv: "",
    addColumn: false,
    optimize: true,
    allowRunningGateway: false,
    json: false,
  };
  let dryRun = false;
  const value = (index, name) => {
    const v = argv[index + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} requires a value`);
    return v;
  };
  const positiveInt = (raw, name, max) => {
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 0 || (max && n > max)) throw new Error(`${name} must be an integer between 0 and ${max ?? "∞"}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--agent": options.agents.push(safeAgentId(value(i, arg))); i += 1; break;
      case "--dry-run": dryRun = true; break;
      case "--apply": options.apply = true; break;
      case "--status": {
        const s = value(i, arg); i += 1;
        if (s !== "active" && s !== "all") throw new Error("--status must be active or all");
        options.status = s; break;
      }
      case "--strip-speaker": options.stripSpeaker = true; break;
      case "--keep-speaker": options.stripSpeaker = false; break;
      case "--batch-size": options.batchSize = positiveInt(value(i, arg), arg, MAX_BATCH_SIZE); i += 1; break;
      case "--min-interval-ms": options.minIntervalMs = positiveInt(value(i, arg), arg, 60_000); i += 1; break;
      case "--max-rows": options.maxRows = positiveInt(value(i, arg), arg); i += 1; break;
      case "--min-cosine": {
        const raw = value(i, arg); i += 1;
        const n = Number(raw);
        if (!/^\d*\.?\d+$/.test(raw) || !Number.isFinite(n) || n < 0 || n > 1) throw new Error("--min-cosine must be a number between 0 and 1");
        options.minCosine = n; break;
      }
      case "--snapshot": options.snapshot = resolve(value(i, arg)); i += 1; break;
      case "--workspace-dir": options.workspaceDir = resolve(value(i, arg)); i += 1; break;
      case "--openclaw-home": options.openclawHome = resolve(value(i, arg)); i += 1; break;
      case "--base": options.base = resolve(value(i, arg)); i += 1; break;
      case "--out": options.out = resolve(value(i, arg)); i += 1; break;
      case "--embedding-api-key-env": {
        const env = value(i, arg); i += 1;
        if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(env)) throw new Error("--embedding-api-key-env requires a valid environment variable name");
        options.embeddingApiKeyEnv = env; break;
      }
      case "--add-column": options.addColumn = true; break;
      case "--no-optimize": options.optimize = false; break;
      case "--allow-running-gateway": options.allowRunningGateway = true; break;
      case "--json": options.json = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (dryRun && options.apply) throw new Error("--dry-run and --apply cannot be combined");
  if (options.agents.length === 0) throw new Error("--agent <id> is required");
  if (options.batchSize < 1) throw new Error("--batch-size must be at least 1");
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonReplacer(_key, value) {
  if (typeof value === "bigint") return value.toString();
  if (ArrayBuffer.isView(value)) return Array.from(value);
  return value;
}

function toArray(vector) {
  if (Array.isArray(vector)) return vector;
  if (ArrayBuffer.isView(vector)) return Array.from(vector);
  if (vector && typeof vector.toArray === "function") return Array.from(vector.toArray());
  return null;
}

function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function maskFragment(rule, fragment) {
  const text = String(fragment || "").replace(/\s+/g, " ").trim();
  if (rule === "speaker" && ROLE_SPEAKERS.test(text)) return text;
  if (!PRINTABLE_RULES.has(rule)) return `<${rule}: ${text.length} chars>`;
  return text.replace(/\d/g, "9").slice(0, 60);
}

/** Hash aller Spalten außer vector und embeddingTextMode (bzw. mit vector). */
function rowFingerprint(row, { withVector = false } = {}) {
  const keys = Object.keys(row).filter((k) => k !== "embeddingTextMode" && (withVector || k !== "vector")).sort();
  const picked = {};
  for (const k of keys) picked[k] = row[k];
  return sha256(JSON.stringify(picked, jsonReplacer));
}

/**
 * Plant die Bereinigung für eine Liste von Zeilen (rein, ohne I/O).
 * @param {Array<{id: string, text: string}>} rows
 * @param {{stripSpeaker: boolean}} cleanOpts
 * @returns {{reembed: Array<{id: string, cleaned: string, chars: number}>, modeOnly: string[],
 *   envelopeOnly: string[], invalidId: number, rules: Record<string, number>,
 *   examples: Array<object>, cleanedChars: number}}
 */
export function planCleanReembed(rows, cleanOpts) {
  const plan = { reembed: [], modeOnly: [], envelopeOnly: [], invalidId: 0, rules: {}, examples: [], cleanedChars: 0 };
  for (const row of rows) {
    let id;
    try {
      id = safeRowId(String(row.id));
    } catch (_invalid) {
      // Gezählt und im Bericht ausgewiesen; solche Zeilen bleiben "raw".
      plan.invalidId += 1;
      continue;
    }
    const text = typeof row.text === "string" ? row.text : "";
    const removed = [];
    const cleaned = cleanTextForEmbedding(text, {
      stripSpeaker: cleanOpts.stripSpeaker === true,
      onRule: (rule, fragment) => {
        plan.rules[rule] = (plan.rules[rule] || 0) + 1;
        removed.push({ rule, fragment: maskFragment(rule, fragment) });
      },
    });
    if (cleaned === text) {
      plan.modeOnly.push(id);
    } else if (!cleaned.trim()) {
      plan.envelopeOnly.push(id);
    } else {
      plan.reembed.push({ id, cleaned, chars: cleaned.length });
      plan.cleanedChars += cleaned.length;
      if (plan.examples.length < EXAMPLE_LIMIT) {
        plan.examples.push({ id: id.slice(0, 8), charsBefore: text.length, charsAfter: cleaned.length, removed: removed.slice(0, 6) });
      }
    }
  }
  return plan;
}

function defaultGatewayState() {
  let systemd = "unknown";
  try {
    systemd = execFileSync("systemctl", ["--user", "is-active", "openclaw-gateway"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (error) {
    // is-active endet bei "inactive" mit Exit != 0; der Status steht dann in stdout.
    systemd = String(error?.stdout || "").trim() || "unknown";
  }
  const processes = [];
  let unreadable = 0;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let args;
    try {
      args = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch (_gone) {
      // Prozess inzwischen beendet oder nicht lesbar — im Bericht gezählt.
      unreadable += 1;
      continue;
    }
    if (args.includes("gateway") && args.some((part) => /openclaw/.test(part) && !/reembed-clean/.test(part))) processes.push(Number(name));
  }
  const running = ["active", "activating", "reloading", "deactivating"].includes(systemd) || processes.length > 0;
  return { systemd, processes, running, unreadableProcesses: unreadable };
}

function versionAtLeast(version, min) {
  const parts = String(version || "").split(/[.-]/).slice(0, 3).map((p) => Number(p));
  if (parts.length < 3 || parts.some((p) => !Number.isFinite(p))) return false;
  for (let i = 0; i < 3; i += 1) {
    if (parts[i] > min[i]) return true;
    if (parts[i] < min[i]) return false;
  }
  return true;
}

function readLivePluginVersion(openclawHome) {
  const file = join(openclawHome, "extensions", "memory-lancedb-namespaced", "package.json");
  try {
    return JSON.parse(readFileSync(file, "utf8")).version || "";
  } catch (err) {
    return `unreadable: ${redactError(err).message}`;
  }
}

function lanceVersions(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : null;
}

/** Zahl und Hash der LanceDB-Versionsdateien (Checkpoint-Vergleich beim Fortsetzen). */
function versionState(dir) {
  const list = lanceVersions(dir) || [];
  return { count: list.length, sha256: sha256(list.join("\n")) };
}

/**
 * Prüft, dass der Snapshot (Layout von scripts/backup-snapshot.sh) dieselben
 * LanceDB-Versionen der Tabelle enthält wie live — bei gestopptem Gateway der
 * Beweis, dass er aktuell ist. Beim Fortsetzen eines unfertigen Laufs
 * (allowSuperset) genügt es, dass live alle Versionen des Snapshots enthält;
 * dass die zusätzlichen von diesem Lauf stammen, prüft runAgent vorher am
 * Versionsstand im Checkpoint.
 */
function verifySnapshot(snapshotDir, { openclawHome, base, agent, isProd, allowSuperset = false }) {
  const problems = [];
  if (!existsSync(join(snapshotDir, "manifest.json"))) problems.push("manifest.json missing");
  if (isProd) {
    const snapRoot = join(openclawHome, ".snapshots");
    if (!(snapshotDir + "/").startsWith(snapRoot + "/")) problems.push(`snapshot must live under ${snapRoot}`);
  }
  const relBase = relative(openclawHome, base);
  const candidates = [
    !relBase.startsWith("..") && !isAbsolute(relBase) ? join(snapshotDir, relBase, agent) : null,
    join(snapshotDir, "memory", "lancedb-namespaced", agent),
    join(snapshotDir, agent),
  ].filter(Boolean);
  const snapAgent = candidates.find((dir) => existsSync(join(dir, `${TABLE_NAME}.lance`)));
  const live = lanceVersions(join(base, agent, `${TABLE_NAME}.lance`, "_versions"));
  const snap = snapAgent ? lanceVersions(join(snapAgent, `${TABLE_NAME}.lance`, "_versions")) : null;
  const identical = Boolean(live && snap) && live.length === snap.length && live.every((v, i) => v === snap[i]);
  // Mengen-Inklusion: die Dateinamen sortieren nicht numerisch ("10…" < "9…").
  const liveSet = new Set(live || []);
  const superset = Boolean(live && snap) && snap.every((v) => liveSet.has(v));
  if (!snapAgent) problems.push(`no ${agent}/${TABLE_NAME}.lance in snapshot`);
  else if (!identical && !(allowSuperset && superset)) problems.push(`LanceDB versions differ (live ${live?.length ?? "-"}, snapshot ${snap?.length ?? "-"})`);
  return {
    snapshot: snapshotDir,
    ok: problems.length === 0,
    problems,
    lanceVersions: { live: live?.length ?? 0, snapshot: snap?.length ?? 0, identical },
    ...(allowSuperset && superset && !identical ? { resumedWithSupersetSnapshot: true } : {}),
  };
}

function loadOpenclawConfig(openclawHome) {
  const file = join(openclawHome, "openclaw.json");
  if (!existsSync(file)) return { config: null, error: "openclaw.json not found" };
  try {
    return { config: JSON.parse(readFileSync(file, "utf8")), error: null };
  } catch (err) {
    return { config: null, error: `openclaw.json unreadable: ${redactError(err).message}` };
  }
}

function agentWorkspaceDir(hostConfig, agentId) {
  const entries = hostConfig?.agents?.entries;
  const own = entries && typeof entries === "object" && !Array.isArray(entries) ? entries[agentId]?.workspace : null;
  if (typeof own === "string" && own.trim()) return own.trim();
  const fallback = hostConfig?.agents?.defaults?.workspace;
  return typeof fallback === "string" && fallback.trim() ? fallback.trim() : "";
}

async function defaultCreateEmbedder(pluginConfig, options) {
  const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const [{ normalizeEmbeddingConfig }, { createEmbeddingProvider }] = await Promise.all([
    import(pathToFileURL(join(pluginDir, "lib", "providers", "config-normalize.js")).href),
    import(pathToFileURL(join(pluginDir, "lib", "providers", "factory.js")).href),
  ]);
  const normalized = normalizeEmbeddingConfig(pluginConfig?.embedding || {}, {
    acceptNonCommercialLicense: pluginConfig?.modelPreparation?.acceptNonCommercialLicense === true,
  });
  if (options.embeddingApiKeyEnv) {
    normalized.apiKey = undefined;
    normalized.apiKeyEnv = options.embeddingApiKeyEnv;
  }
  // Kein Cache: jeder Text kommt genau einmal vor.
  normalized.embeddingCacheEnabled = false;
  const provider = createEmbeddingProvider(normalized);
  return {
    model: normalized.model || "",
    dimensions: Number(provider.dimensions()),
    embedBatch: async (texts) => (typeof provider.embedBatch === "function"
      ? provider.embedBatch(texts, 3, { purpose: "reembedding" })
      : Promise.all(texts.map((t) => provider.embedPassage(t, { purpose: "reembedding" })))),
    shutdown: async () => provider.shutdown?.(),
  };
}

function readCheckpoint(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, jsonReplacer, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

function quantiles(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  const round = (v) => Math.round(v * 10_000) / 10_000;
  return { n: sorted.length, min: round(sorted[0]), p10: round(at(0.1)), median: round(at(0.5)), max: round(sorted[sorted.length - 1]) };
}

async function readRowsByIds(table, ids) {
  if (ids.length === 0) return [];
  const list = ids.map((id) => `'${safeRowId(id)}'`).join(",");
  return table.query().where(`id IN (${list})`).toArray();
}

/**
 * Bearbeitet einen Agenten (Probelauf oder Anwendung).
 * @returns {Promise<object>} Bericht
 */
async function runAgent(agent, ctx) {
  const { options, runtime, lancedb, cleanCfg, textMode, openclawHome, base, outDir, pluginConfig, hostConfig } = ctx;
  // Stopp-Zustand des ganzen Laufs (runCli): ein Signal gilt für alle Agenten.
  const stop = ctx.stop || { signal: null };
  const now = runtime.now ? runtime.now() : Date.now();
  const report = {
    agent,
    mode: options.apply ? "apply" : "dry-run",
    textMode,
    stripSpeaker: cleanCfg.stripSpeaker,
    statusFilter: options.status,
    startedAt: new Date(now).toISOString(),
    preconditions: {},
    counts: {},
  };
  const agentDir = resolveInside(base, agent);
  const isProd = (() => {
    const home = existsSync(openclawHome) ? realpathSync(openclawHome) : openclawHome;
    return (agentDir + "/").startsWith(home + "/");
  })();
  report.preconditions.productionPath = isProd;
  if (!existsSync(join(agentDir, `${TABLE_NAME}.lance`))) throw new Error(`no ${TABLE_NAME} table for agent ${agent}`);
  const db = await lancedb.connect(agentDir);
  const table = await db.openTable(TABLE_NAME);
  const schema = await table.schema();
  const fieldNames = new Set(schema.fields.map((f) => f.name));
  const vectorField = schema.fields.find((f) => f.name === "vector");
  const tableDims = Number(vectorField?.type?.listSize);
  const hasModeColumn = fieldNames.has("embeddingTextMode");
  report.preconditions.table = { dims: tableDims, hasModeColumn, rows: await table.countRows() };

  const where = [];
  if (options.status === "active") where.push("status = 'active'");
  if (hasModeColumn) where.push("embeddingTextMode = 'raw'");
  const selectCols = ["id", "text"];
  let query = table.query().select(selectCols);
  if (where.length) query = query.where(where.join(" AND "));
  const rows = await query.toArray();
  const plan = planCleanReembed(rows, cleanCfg);
  const limited = options.maxRows != null ? plan.reembed.slice(0, options.maxRows) : plan.reembed;
  const tokens = Math.ceil(plan.cleanedChars / CHARS_PER_TOKEN);
  const limitedTokens = Math.ceil(limited.reduce((s, r) => s + r.chars, 0) / CHARS_PER_TOKEN);
  const model = pluginConfig?.embedding?.model || "";
  const price = PRICE_PER_MILLION[model];
  report.counts = {
    selected: rows.length,
    reembed: plan.reembed.length,
    reembedThisRun: limited.length,
    modeOnly: plan.modeOnly.length,
    envelopeOnly: plan.envelopeOnly.length,
    invalidId: plan.invalidId,
  };
  report.rules = plan.rules;
  report.estimate = {
    model: model || "(plugin default)",
    tokens,
    tokensThisRun: limitedTokens,
    requests: Math.ceil(limited.length / options.batchSize),
    usd: price != null ? Math.round(tokens * price / 100) / 10_000 : null,
    usdThisRun: price != null ? Math.round(limitedTokens * price / 100) / 10_000 : null,
    note: "tokens ≈ cleaned chars / 3.5",
  };
  report.examples = plan.examples;
  if (!options.apply) {
    report.preconditions.modeColumn = hasModeColumn ? "present" : "missing (plugin 7.20.10 adds it at its first start; --apply refuses without --add-column)";
    return report;
  }

  // ═══ APPLY ═════════════════════════════════════════════════════════════
  const gateway = (runtime.gatewayState || defaultGatewayState)();
  report.preconditions.gateway = gateway;
  if (gateway.running && isProd) throw new Error(`gateway is running (${gateway.systemd}, pids ${gateway.processes?.join(",") || "-"}) — stop it first`);
  if (gateway.running && !options.allowRunningGateway) throw new Error("gateway is running; pass --allow-running-gateway for a copy outside the OpenClaw home");
  if (isProd) {
    const liveVersion = (runtime.livePluginVersion || readLivePluginVersion)(openclawHome);
    report.preconditions.livePluginVersion = liveVersion;
    if (!versionAtLeast(liveVersion, MIN_PLUGIN_VERSION)) throw new Error(`live plugin ${liveVersion || "unknown"} is older than 7.20.10 — deploy first (older versions cannot write rows with embeddingTextMode)`);
    if (!options.snapshot) throw new Error("production apply requires --snapshot <dir> from scripts/backup-snapshot.sh taken after the gateway stopped");
  }
  // Checkpoint vor dem Snapshot-Abgleich lesen: ein unfertiger Lauf (Abbruch
  // oder --max-rows) hat seit dem Snapshot selbst Versionen geschrieben.
  const tablePath = join(agentDir, `${TABLE_NAME}.lance`);
  const versionsDir = join(tablePath, "_versions");
  const checkpointPath = join(outDir, `${agent}.checkpoint.json`);
  const previous = readCheckpoint(checkpointPath);
  const resuming = Boolean(previous && previous.done !== true);
  if (resuming) {
    if (previous.textMode !== textMode || previous.statusFilter !== options.status || (previous.table && previous.table !== tablePath)) {
      throw new Error(`unfinished checkpoint uses ${previous.textMode}/${previous.statusFilter} on ${previous.table || "?"}; finish it with the same settings or move ${checkpointPath} away`);
    }
    report.resumedFrom = previous.updatedAt;
  }
  // Fortsetzen mit demselben Snapshot: live muss genau den Versionsstand nach
  // dem letzten eigenen Schreibzugriff haben. Sonst hat jemand anderes
  // geschrieben (Gateway zwischen zwei Teilläufen) oder ein Block wurde hart
  // abgebrochen — ein Rollback auf den alten Snapshot verlöre dann Daten.
  const sameSnapshot = resuming && (previous.snapshot || null) === (options.snapshot || null);
  if (sameSnapshot) {
    const live = versionState(versionsDir);
    const recorded = previous.lanceVersions;
    if (!recorded || recorded.count !== live.count || recorded.sha256 !== live.sha256) {
      throw new Error(`table changed since the last checkpoint (live ${live.count} versions, checkpoint ${recorded?.count ?? "none"}): another writer or an interrupted write; take a fresh snapshot (scripts/backup-snapshot.sh, gateway stopped) and run again with it${options.snapshot ? "" : `, or move ${checkpointPath} away`}`);
    }
  }
  if (options.snapshot) {
    // Mehr Versionen als der Snapshot nur beim Fortsetzen mit genau dem Snapshot,
    // der vor dem ersten Teil des Laufs geprüft wurde; ein anderer (frischer)
    // Snapshot muss live genau entsprechen und wird die neue Basis.
    const snap = verifySnapshot(options.snapshot, { openclawHome, base, agent, isProd, allowSuperset: sameSnapshot });
    report.preconditions.snapshot = snap;
    if (!snap.ok) throw new Error(`snapshot does not match the current state: ${snap.problems.join("; ")}`);
  }
  const workspaceDir = options.workspaceDir || agentWorkspaceDir(hostConfig, agent);
  if (!workspaceDir || !existsSync(workspaceDir)) throw new Error("no workspace directory for the audit log; pass --workspace-dir");
  report.preconditions.auditLog = join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl");

  if (previous && !resuming) {
    renameSync(checkpointPath, `${checkpointPath}.${String(previous.updatedAt || "done").replace(/[^0-9A-Za-z]/g, "")}`);
  }
  const checkpoint = resuming ? previous : {
    version: 2, agent, table: tablePath, textMode, stripSpeaker: cleanCfg.stripSpeaker, snapshot: options.snapshot || null,
    statusFilter: options.status, startedAt: new Date(now).toISOString(), batches: 0, rowsReembedded: 0, rowsModeOnly: 0, providerCalls: 0, done: false,
  };
  if (resuming && !sameSnapshot) {
    checkpoint.snapshot = options.snapshot || null;
    report.preconditions.rebasedOnSnapshot = true;
  }
  checkpoint.version = 2;
  // refreshVersions: false nur, wenn ein fremder Schreiber nicht auszuschließen
  // ist (Kopie mit laufendem Gateway) — dann bleibt der letzte eigene Stand.
  const saveCheckpoint = ({ refreshVersions = true } = {}) => {
    if (refreshVersions) checkpoint.lanceVersions = versionState(versionsDir);
    checkpoint.updatedAt = new Date((runtime.now ? runtime.now() : Date.now())).toISOString();
    writeJson(checkpointPath, checkpoint);
  };

  const audit = (entry) => {
    const full = { source: "reembed-clean", event: "reembed-clean", agentId: agent, textMode, statusFilter: options.status, snapshot: options.snapshot || null, timestamp: new Date().toISOString(), ...entry };
    const ok = appendDestructiveOpLog(workspaceDir, full);
    if (!ok) throw new Error(`audit log write failed (${entry.result})`);
  };

  let embedder = null;
  const rowsBefore = report.preconditions.table.rows;
  const cosines = [];
  const progress = { reembedded: 0, modeOnly: 0, providerCalls: 0 };
  // Ctrl-C/SIGTERM (Handler in runCli): den laufenden Block zu Ende bringen,
  // dann über den catch-Zweig "failed" und den Checkpoint schreiben.
  const checkStop = () => {
    if (stop.signal) throw new Error(`interrupted by ${stop.signal}; stopped after the last complete block`);
  };
  // Ein Signal während der Vorprüfungen: diesen Agenten gar nicht beginnen.
  checkStop();
  audit({ result: "started", planned: report.counts, estimate: report.estimate });
  try {
    // Checkpoint vor dem ersten Schreibzugriff: ein harter Abbruch im ersten
    // Block lässt sonst keinen Stand zurück, an dem ein Neustart prüfen kann.
    saveCheckpoint();
    if (!hasModeColumn) {
      if (!options.addColumn) throw new Error("column embeddingTextMode is missing — start plugin 7.20.10 once or pass --add-column");
      await table.addColumns([{ name: "embeddingTextMode", valueSql: "'raw'" }]);
      report.preconditions.modeColumn = "added";
      saveCheckpoint();
    }

    // Provider vor dem ersten Schreibzugriff prüfen (Dimension der Tabelle).
    if (limited.length > 0) {
      embedder = await (runtime.createEmbedder || defaultCreateEmbedder)(pluginConfig, options);
      report.preconditions.embedder = { model: embedder.model || model, dimensions: embedder.dimensions };
      if (embedder.dimensions !== tableDims) throw new Error(`embedding dimensions ${embedder.dimensions} do not match the table (${tableDims})`);
    }

    // 1. Nur Modus: Texte, an denen die Bereinigung nichts ändert.
    for (let i = 0; i < plan.modeOnly.length; i += MODE_ONLY_CHUNK) {
      checkStop();
      const ids = plan.modeOnly.slice(i, i + MODE_ONLY_CHUNK);
      const before = new Map((await readRowsByIds(table, ids)).map((r) => [r.id, rowFingerprint(r, { withVector: true })]));
      const list = ids.map((id) => `'${safeRowId(id)}'`).join(",");
      await table.update({ where: `embeddingTextMode = 'raw' AND id IN (${list})`, values: { embeddingTextMode: textMode } });
      const after = await readRowsByIds(table, ids);
      for (const row of after) {
        if (row.embeddingTextMode !== textMode) throw new Error(`mode not set for ${row.id}`);
        if (before.get(row.id) !== rowFingerprint(row, { withVector: true })) throw new Error(`row changed beyond embeddingTextMode: ${row.id}`);
      }
      progress.modeOnly += after.length;
      checkpoint.rowsModeOnly += after.length;
      checkpoint.batches += 1;
      saveCheckpoint();
    }

    // 2. Neu einbetten.
    for (let i = 0; i < limited.length; i += options.batchSize) {
      checkStop();
      const batch = limited.slice(i, i + options.batchSize);
      const ids = batch.map((r) => r.id);
      const beforeRows = new Map((await readRowsByIds(table, ids)).map((r) => [r.id, r]));
      const vectors = await embedder.embedBatch(batch.map((r) => r.cleaned));
      progress.providerCalls += 1;
      checkpoint.providerCalls += 1;
      if (!Array.isArray(vectors) || vectors.length !== batch.length) throw new Error("embedding batch result mismatch");
      const updates = batch.map((r, j) => {
        const vector = toArray(vectors[j]);
        if (!vector || vector.length !== tableDims || vector.some((v) => !Number.isFinite(v)) || vector.every((v) => v === 0)) {
          throw new Error(`invalid vector for ${r.id}`);
        }
        return { id: r.id, vector, embeddingTextMode: textMode };
      });
      // Kosinus alt/neu vor dem Schreiben: Vektoren aus einem fremden Raum
      // (falsches Modell, OPENAI_BASE_URL in der Shell) bei gleicher Dimension
      // liegen um 0. Geprüft wird der Median über alle Blöcke dieses Laufs
      // einschließlich des neuen, also schon vor dem ersten Schreiben.
      const blockCosines = [];
      for (const update of updates) {
        const oldVector = toArray(beforeRows.get(update.id)?.vector);
        if (oldVector && oldVector.length === update.vector.length) blockCosines.push(cosine(oldVector, update.vector));
      }
      if (options.minCosine > 0 && blockCosines.length > 0) {
        const median = quantiles([...cosines, ...blockCosines]).median;
        if (median < options.minCosine) {
          throw new Error(`old/new cosine median ${median} is below --min-cosine ${options.minCosine}; wrong embedding model or endpoint? This block was not written`);
        }
      }
      checkStop();
      const result = await table.mergeInsert("id").whenMatchedUpdateAll().execute(updates);
      if (Number(result?.numInsertedRows || 0) !== 0) throw new Error("merge inserted rows — aborting");
      const afterRows = await readRowsByIds(table, ids);
      for (const row of afterRows) {
        const old = beforeRows.get(row.id);
        if (!old) throw new Error(`row ${row.id} appeared during the run`);
        if (rowFingerprint(old) !== rowFingerprint(row)) throw new Error(`row changed beyond vector/embeddingTextMode: ${row.id}`);
        if (row.embeddingTextMode !== textMode) throw new Error(`mode not set for ${row.id}`);
        const newVector = toArray(row.vector);
        if (!newVector || newVector.length !== tableDims) throw new Error(`vector missing after write: ${row.id}`);
      }
      if (afterRows.length !== batch.length) throw new Error(`readback count ${afterRows.length} != ${batch.length}`);
      cosines.push(...blockCosines);
      progress.reembedded += batch.length;
      checkpoint.rowsReembedded += batch.length;
      checkpoint.batches += 1;
      saveCheckpoint();
      if (i + options.batchSize < limited.length) await sleep(options.minIntervalMs);
    }

    // 3. Prüfung.
    const rowsAfter = await table.countRows();
    const nullVectors = await table.countRows("vector IS NULL");
    const remainingRaw = await table.countRows(options.status === "active" ? "status = 'active' AND embeddingTextMode = 'raw'" : "embeddingTextMode = 'raw'");
    report.verification = {
      rowsBefore,
      rowsAfter,
      nullVectors,
      remainingRaw,
      expectedRemainingRaw: plan.envelopeOnly.length + plan.invalidId + (plan.reembed.length - limited.length),
      cosineOldNew: quantiles(cosines),
      minCosine: options.minCosine,
    };
    if (rowsAfter !== rowsBefore) throw new Error(`row count changed: ${rowsBefore} → ${rowsAfter}`);
    if (nullVectors !== 0) throw new Error(`${nullVectors} rows without vector`);
    const complete = plan.reembed.length === limited.length;
    // Kompaktieren erst, wenn alles durch ist: zwischen Teilläufen würde
    // optimize() die Versionen umschichten, auf die der Snapshot-Abgleich baut.
    if (options.optimize && complete) {
      checkStop();
      const stats = await table.optimize();
      report.optimize = { fragmentsRemoved: Number(stats?.compaction?.fragmentsRemoved || 0), fragmentsAdded: Number(stats?.compaction?.fragmentsAdded || 0) };
      const rowsAfterOptimize = await table.countRows();
      if (rowsAfterOptimize !== rowsBefore) throw new Error(`row count changed by optimize: ${rowsBefore} → ${rowsAfterOptimize}`);
    }
    checkpoint.done = complete;
    saveCheckpoint();
    report.progress = progress;
    audit({ result: "committed", progress, verification: report.verification });
    return report;
  } catch (error) {
    report.progress = progress;
    let written = false;
    try {
      written = appendDestructiveOpLog(workspaceDir, { source: "reembed-clean", event: "reembed-clean", agentId: agent, textMode, result: "failed", error: redactError(error).message.slice(0, 500), progress, timestamp: new Date().toISOString() });
    } catch (auditError) {
      process.stderr.write(`reembed-clean: failed-audit write threw: ${redactError(auditError).message}\n`);
    }
    if (!written) process.stderr.write("reembed-clean: audit entry 'failed' not written\n");
    try {
      // Bei gestopptem Gateway schreibt nur dieser Prozess: der Stand auf der
      // Platte ist der eigene. Mit laufendem Gateway (Kopie) bleibt der letzte
      // geprüfte Stand, ein Neustart verlangt dann einen frischen Snapshot.
      saveCheckpoint({ refreshVersions: !gateway.running });
    } catch (cpError) {
      process.stderr.write(`reembed-clean: checkpoint write failed: ${redactError(cpError).message}\n`);
    }
    error.report = report;
    throw error;
  } finally {
    if (embedder?.shutdown) {
      try {
        await embedder.shutdown();
      } catch (shutdownError) {
        process.stderr.write(`reembed-clean: embedder shutdown failed: ${redactError(shutdownError).message}\n`);
      }
    }
  }
}

function summaryLine(r) {
  const c = r.counts;
  const est = r.estimate;
  const parts = [
    `${r.agent} ${r.mode}: selected=${c.selected} reembed=${c.reembed}${c.reembedThisRun !== c.reembed ? ` (this run ${c.reembedThisRun})` : ""} modeOnly=${c.modeOnly} envelopeOnly=${c.envelopeOnly} invalidId=${c.invalidId}`,
    `tokens≈${est.tokens}${est.usd != null ? ` (~$${est.usd})` : ""} requests=${est.requests} mode=${r.textMode}`,
  ];
  if (r.verification) parts.push(`rows ${r.verification.rowsBefore}→${r.verification.rowsAfter} remainingRaw=${r.verification.remainingRaw} cosine=${JSON.stringify(r.verification.cosineOldNew)}`);
  return parts.join(" | ");
}

/**
 * CLI mit injizierbaren Abhängigkeiten (Tests: Fake-Embedder, Gateway-Status).
 * @param {string[]} argv
 * @param {{stdout?: object, stderr?: object, createEmbedder?: Function, gatewayState?: Function,
 *   livePluginVersion?: Function, now?: Function, lancedb?: object,
 *   signals?: import("node:events").EventEmitter}} [runtime]
 *   signals: Quelle für SIGINT/SIGTERM (Standard process), in Tests ein
 *   EventEmitter. Bei --apply beendet das erste Signal den laufenden Block und
 *   den ganzen Lauf (übrige Agenten "skipped: interrupted"), das zweite sofort.
 * @returns {Promise<number>} Exit-Code (1 auch nach einem Signal)
 */
export async function runCli(argv, runtime = {}) {
  const stdout = runtime.stdout || process.stdout;
  const stderr = runtime.stderr || process.stderr;
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`reembed-clean usage error: ${redactError(error).message}\n`);
    return 2;
  }
  const openclawHome = options.openclawHome || process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
  const { config, error: configError } = loadOpenclawConfig(openclawHome);
  const pluginConfig = config?.plugins?.entries?.["memory-lancedb-namespaced"]?.config || {};
  if (configError && options.apply && !runtime.createEmbedder) {
    stderr.write(`reembed-clean failed: ${configError}\n`);
    return 1;
  }
  const base = options.base || resolvePromotionDbRoot(pluginConfig, openclawHome);
  const outDir = options.out || join(dirname(base), "reembed-clean");
  const configured = resolveEmbeddingCleanTextConfig(pluginConfig?.embedding?.cleanText);
  const cleanCfg = { enabled: configured.enabled, stripSpeaker: options.stripSpeaker ?? configured.stripSpeaker };
  const textMode = embeddingTextModeFor(cleanCfg);
  if (textMode === "raw") {
    stderr.write("reembed-clean: embedding.cleanText.enabled is false — nothing to do\n");
    return 1;
  }
  const lancedb = runtime.lancedb || await import("@lancedb/lancedb");
  const reports = [];
  let code = 0;
  // Ctrl-C/SIGTERM gelten für den ganzen Lauf, nicht je Agent: mit Handlern je
  // Agent beendete ein Signal nur den laufenden Agenten, die übrigen --agent liefen
  // danach komplett (Provider-Aufrufe, Schreibzugriffe), und ein zweites
  // Signal galt im nächsten Agenten wieder als erstes. Nur bei --apply; der
  // Probelauf schreibt nichts und endet beim Signal wie gewohnt sofort.
  const stop = { signal: null };
  const signals = runtime.signals || process;
  const handlers = {};
  const detachSignals = () => {
    for (const [sig, handler] of Object.entries(handlers)) signals.removeListener(sig, handler);
  };
  if (options.apply) {
    for (const sig of ["SIGINT", "SIGTERM"]) {
      handlers[sig] = () => {
        if (stop.signal) {
          // Zweites Signal: Handler weg, das Signal erneut auslösen → Standardverhalten.
          detachSignals();
          if (signals === process) process.kill(process.pid, sig);
          return;
        }
        stop.signal = sig;
        stderr.write(`reembed-clean: ${sig} received, stopping after the current block; no further agent is started (again to stop at once)\n`);
      };
      signals.on(sig, handlers[sig]);
    }
  }
  try {
    for (const [index, agent] of options.agents.entries()) {
      try {
        const report = await runAgent(agent, { options, runtime, lancedb, cleanCfg, textMode, openclawHome, base, outDir, pluginConfig, hostConfig: config, stop });
        reports.push(report);
      } catch (error) {
        code = 1;
        const report = error.report || { agent };
        report.error = redactError(error).message;
        reports.push(report);
        stderr.write(`reembed-clean ${agent} failed: ${report.error}\n`);
      }
      if (stop.signal) {
        const rest = options.agents.slice(index + 1);
        for (const skipped of rest) {
          reports.push({ agent: skipped, skipped: "interrupted", error: `skipped (interrupted by ${stop.signal})` });
        }
        if (rest.length > 0) stderr.write(`reembed-clean: ${stop.signal} — skipped ${rest.join(", ")}\n`);
        code = 1;
        break;
      }
    }
  } finally {
    detachSignals();
  }
  if (options.apply) {
    try {
      const stamp = new Date((runtime.now ? runtime.now() : Date.now())).toISOString().replace(/[:.]/g, "-");
      writeJson(join(outDir, `report-${stamp}.json`), reports);
    } catch (error) {
      code = 1;
      stderr.write(`reembed-clean: report write failed: ${redactError(error).message}\n`);
    }
  }
  if (options.json) stdout.write(`${JSON.stringify(reports, jsonReplacer, 2)}\n`);
  else for (const r of reports) if (r.counts) stdout.write(`${summaryLine(r)}\n`);
  return code;
}

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (IS_MAIN) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`reembed-clean fatal: ${redactError(error).message}\n`);
    process.exitCode = 1;
  });
}

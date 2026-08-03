import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { inferEmotionalValence, serializeEmotionalValence } from "./emotion.js";
import { buildRecallSafetyPreamble } from "./relevant-memory-context.js";

export const NEO_CATEGORIES = [
  "project_fact",
  "architecture_decision",
  "technical_constraint",
  "tooling_constraint",
  "workspace_rule",
  "user_preference",
  "communication_style",
  "behavior_feedback",
  "agent_strategy",
  "todo",
  "open_question",
  "bug",
  "failure",
  "success",
  "code_context",
  "file_context",
  "external_source",
  "test_result",
  "curation_note",
  "dream_synthesis",
  "assistant_claim",
  "assistant_plan",
  "assistant_suggestion",
  "assistant_mistake_candidate",
];

export const NEO_ORIGIN_KINDS = [
  "user_explicit",
  "user_correction",
  "user_confirmation",
  "user_rejection",
  "assistant_claim",
  "assistant_plan",
  "assistant_suggestion",
  "tool_result",
  "test_result",
  "file_context",
  "repo_context",
  "web_source",
  "dream_synthesis",
  "manual_curation",
];

export const NEO_TRUST_LEVELS = [
  "untrusted",
  "user_asserted",
  "assistant_asserted",
  "tool_observed",
  "validated",
  "curated",
];

export const NEO_SCOPES = ["agent_private", "workspace_shared", "global_user"];
export const NEO_STATUSES = ["candidate", "active", "promoted", "demoted", "conflict", "pruned", "tombstoned"];
export const DEFAULT_NEO_WORKSPACE_MAPPINGS = Object.freeze([]);
export const NEO_JSONL_FILES = Object.freeze([
  "turn-journal.jsonl",
  "memory-candidates.jsonl",
  "reaction-ledger.jsonl",
  "behavior-cards.jsonl",
  "embedding-queue.jsonl",
  "dream-diary.jsonl",
  "episodes.jsonl",
  "memory-graph.jsonl",
  "pattern-analysis.jsonl",
  "retrieval-ledger.jsonl",
  "reconsolidation-events.jsonl",
]);

// JSON (nicht JSONL) — werden separat behandelt, nicht gecappt/gedupt
export const NEO_JSON_FILES = Object.freeze([
  "hook-state.json",
  "run-state.json",
  "record-index.json",
  "workspace-manifest.json",
]);

export const NEO_RECALL_LANES = [
  "recent_turns",
  "workspace_facts",
  "architecture_decisions",
  "technical_constraints",
  "tooling_constraints",
  "user_preferences",
  "behavior_cards",
  "failures_and_corrections",
  "open_questions",
  "todos",
  "shared_dreams",
  "agent_private_reflections",
  "code_context",
  "knowledge_md",
];

const PROMPT_INJECTION_RE = /\b(ignore (all )?(previous|prior|above|instructions?)|disregard (all )?(prior|previous|instructions?)|system prompt|developer message|tool_call|act as|pretend (to be|you are)|you are now|new (role|persona|instruction)|forget (?:\w+\s+){0,3}(previous|prior|above|instructions?)|jailbreak|prompt injection)\b|<\/?(?:tool|system|s|assistant|human|prompt)[^>]{0,30}>|<\|im_start\||<\|im_end\||#{3,}\s*(system|assistant|user)\b/i;

// Marker für systemisch injizierten Kontext (Recall-Blöcke, Status-Reminder,
// Cron-/Heartbeat-Kontext). Solche Texte dürfen NIEMALS wieder als neue
// Memory-Kandidaten captured werden, sonst entsteht eine Recall/Capture-
// Rückkopplung, die Stores aufbläht und den Gateway-Prozess auslastet.
// Quelle: Performance-Analysis 2026-05-29, §"Empfohlene dauerhafte Fixes".
//
// Statt einer großen Alternation-Regex (super-linear auf langen/adversarialen
// Texten) nutzen wir einen linearen String.includes()-Vorfilter für die
// häufigen Marker plus eine kleine, begrenzte Regex für JSON-Restmarker.
const INJECTED_QUICK_MARKERS = [
  "<plur1bus-recall",
  "</plur1bus-recall",
  "<plur1bus-start-notice",
  "</plur1bus-start-notice",
  "plur1bus — make your agent yours",
  "<temporal-context>",
  "</temporal-context>",
  "<relevant-memories",
  "</relevant-memories",
  "<knowledge-update-reminder",
  "</knowledge-update-reminder",
  "<adaptive-learning",
  "</adaptive-learning",
  "recall safety rules",
  "plur1bus internal classify-recent",
  "critical-memory-classifier",
  "tts-status",
  "[cron:",
  "heartbeat_ok",
  "reference utc:",
  "current time:",
  "you are a memory search agent",
  "memory search agent. another model",
  "bounded search query",
  "use only the available memory tools",
  "conversation info (untrusted metadata)",
  // Heartbeat-Polls des Hosts. Der bestehende Marker "heartbeat_ok" trifft nur
  // die Antwort, nicht den Poll selbst — dadurch landeten die Polls als
  // vermeintliche User-Turns im Journal (heisenberg: 58 von 64 "User"-Turns).
  "[openclaw heartbeat",
  // Dream-Generierung des Host-Plugins memory-core. Laeuft als Agent-Turn und
  // wurde deshalb von unserem agent_end-Hook als User-Eingabe erfasst — eine
  // Rueckkopplung, bei der das Gedaechtnis seine eigene Verarbeitung
  // protokolliert (main: 31 solcher Turns im Beobachtungsfenster).
  "write a dream diary entry from these memory fragments",
];

// JSON-Restmarker mit optionalen Whitespaces. Jede Regex steht für sich
// (keine Alternation), sodass keine kaskadierte Backtracking-Falle entsteht.
// Sie werden nur ausgewertet, wenn die schnellen Includes keinen Treffer
// geliefert haben UND ein strukturierter Hinweis-Substring vorhanden ist.
const INJECTED_JSON_REGEXES = [
  /capturedBy"\s*:\s*"agent_end_capture/i,
  /embeddingStatus"\s*:\s*"pending/i,
  /"chat_id"\s*:\s*"telegram:/i,
  /"message_id"\s*:\s*"/i,
  /"sender_id"\s*:\s*"/i,
];

// Hinweis-Substrings für die JSON-Regex-Gruppe (lowercase, da der Text bereits
// in Kleinbuchstaben umgewandelt wird). Ohne einen dieser Substrings kann keine
// der JSON-Regexes matchen → Regex-Loop komplett überspringen.
const JSON_MARKER_HINTS = ['capturedby', 'embeddingstatus', '"chat_id"', '"message_id"', '"sender_id"'];

/**
 * Liefert true, wenn der Text systemisch injizierter Kontext ist (Recall-Block,
 * Status-Reminder, Cron-/Heartbeat-Kontext) und daher NICHT als neuer
 * Memory-Kandidat gespeichert werden darf.
 *
 * Laufzeit: O(n) in der Textlänge, unabhängig von der Marker-Anzahl.
 */
export function isInjectedContextText(text) {
  const s = String(text || "");
  if (s.length === 0) return false;
  const lower = s.toLowerCase();
  for (const marker of INJECTED_QUICK_MARKERS) {
    if (lower.includes(marker)) return true;
  }

  let needsJsonCheck = false;
  for (const hint of JSON_MARKER_HINTS) {
    if (lower.includes(hint)) { needsJsonCheck = true; break; }
  }
  if (!needsJsonCheck) return false;

  for (const re of INJECTED_JSON_REGEXES) {
    if (re.test(s)) return true;
  }
  return false;
}

export function sanitizePathPart(value) {
  const s = String(value || "default").trim();
  return (s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "default").slice(0, 120);
}

function normalizeWorkspaceKey(value) {
  return String(value || "default").trim() || "default";
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function stableHash(...parts) {
  return createHash("sha256")
    .update(JSON.stringify(["neo-stable-id-v1", ...parts]))
    .digest("hex")
    .slice(0, 20);
}

function stableId(prefix, ...parts) {
  return `${prefix}_${stableHash(prefix, ...parts)}`;
}

function canonicalWorkspaceStorageKey(workspaceKey) {
  const raw = String(workspaceKey || "default").trim() || "default";
  return `${sanitizePathPart(raw).slice(0, 80)}--${stableHash("workspace", raw)}`;
}

// ---------------------------------------------------------------------------
// Workspace-Write-Lock
//
// Der Lock ist ein Verzeichnis (mkdir ist atomar). Darin liegt `owner.json`
// mit PID und Startzeit des Halters, damit ein abgestürzter Halter erkannt
// und übernommen werden kann — ohne das gab es permanente Blockaden: stirbt
// das Gateway im kritischen Abschnitt, blieb das Lock-Verzeichnis für immer
// liegen und JEDER weitere Write lief in NEO_WRITE_BACKPRESSURE.
//
// Die drei Zeitwerte hängen zusammen und dürfen nur GEMEINSAM geändert
// werden. Es muss gelten:
//
//     NEO_LOCK_STALE_MS  >  NEO_LOCK_LONG_ACQUIRE_MS  >  NEO_LOCK_ACQUIRE_MS
//
// NEO_LOCK_STALE_MS muss insbesondere über der längsten LEGITIMEN Haltedauer
// liegen (der Prune-Lauf über das Turn-Journal). Ist es kleiner, stiehlt ein
// Takeover einem gesunden, nur langsamen Halter mitten im Rewrite den Lock.
// ---------------------------------------------------------------------------
const NEO_LOCK_ACQUIRE_MS = Math.max(1_000, Number(process.env.PLUR1BUS_NEO_LOCK_ACQUIRE_MS) || 5_000);
const NEO_LOCK_LONG_ACQUIRE_MS = Math.max(NEO_LOCK_ACQUIRE_MS, Number(process.env.PLUR1BUS_NEO_LOCK_LONG_ACQUIRE_MS) || 60_000);
const NEO_LOCK_STALE_MS = Math.max(NEO_LOCK_LONG_ACQUIRE_MS * 2, Number(process.env.PLUR1BUS_NEO_LOCK_STALE_MS) || 300_000);
// Ein Lock-Verzeichnis ohne lesbare owner.json ist entweder gerade im
// Entstehen (Fenster zwischen mkdir und Schreiben) oder stammt aus einer
// älteren Version ohne Owner-Datei. Erst nach dieser Frist als tot werten.
const NEO_LOCK_ORPHAN_GRACE_MS = 15_000;

function neoLockOwnerPath(lockPath) {
  return join(lockPath, "owner.json");
}

function writeNeoLockOwner(lockPath) {
  try {
    writeFileSync(neoLockOwnerPath(lockPath), JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }), "utf8");
  } catch (_) { /* Owner-Info ist Diagnose-Beiwerk, kein harter Fehler */ }
}

function readNeoLockOwner(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(neoLockOwnerPath(lockPath), "utf8"));
    const pid = Number(parsed?.pid);
    return Number.isInteger(pid) && pid > 0 ? { pid, acquiredAt: parsed?.acquiredAt || "" } : null;
  } catch (_) {
    return null;
  }
}

function neoLockHolderAlive(pid) {
  if (pid === process.pid) return true; // Reentranz: nicht uns selbst abräumen.
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = Prozess existiert, gehört nur jemand anderem.
    return error?.code === "EPERM";
  }
}

function neoLockAgeMs(lockPath) {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch (_) {
    return 0;
  }
}

/**
 * Prüft ein bestehendes Lock-Verzeichnis und übernimmt es, wenn der Halter
 * nachweislich weg ist. Gibt true zurück, wenn danach ein neuer Versuch
 * lohnt.
 */
function tryTakeoverStaleNeoLock(lockPath, logger) {
  const ageMs = neoLockAgeMs(lockPath);
  const owner = readNeoLockOwner(lockPath);

  let reason = "";
  if (ageMs > NEO_LOCK_STALE_MS) {
    // Greift unabhängig vom PID — deckt auch PID-Wiederverwendung ab.
    reason = `älter als ${NEO_LOCK_STALE_MS}ms (${Math.round(ageMs / 1000)}s)`;
  } else if (owner && !neoLockHolderAlive(owner.pid)) {
    reason = `Halter-PID ${owner.pid} existiert nicht mehr`;
  } else if (!owner && ageMs > NEO_LOCK_ORPHAN_GRACE_MS) {
    reason = `keine owner.json und älter als ${NEO_LOCK_ORPHAN_GRACE_MS}ms`;
  }
  if (!reason) return false;

  try {
    try { unlinkSync(neoLockOwnerPath(lockPath)); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    rmdirSync(lockPath);
    logger?.warn?.(`neo: verwaistes Write-Lock übernommen (${lockPath}): ${reason}`);
    return true;
  } catch (error) {
    // ENOENT/ENOTEMPTY: ein anderer Prozess war schneller bzw. der Halter
    // lebt doch wieder — einfach erneut versuchen.
    return error?.code === "ENOENT";
  }
}

/**
 * Ein Acquire-Versuch. `deadline` ist ein ABSOLUTER Zeitstempel und muss vom
 * Aufrufer über alle Versuche hinweg konstant gehalten werden — würde er hier
 * pro Aufruf neu berechnet, liefe die Warteschleife nie aus.
 *
 * @returns {string|null} Lock-Pfad bei Erfolg, null wenn der Aufrufer warten
 *   und erneut versuchen soll. Wirft NEO_WRITE_BACKPRESSURE nach Deadline.
 */
function tryAcquireNeoLock(lockPath, deadline, logger) {
  try {
    mkdirSync(lockPath, { recursive: false });
    writeNeoLockOwner(lockPath);
    return lockPath;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    // Auf verwaisten Halter prüfen; bei Übernahme sofort erneut versuchen.
    if (tryTakeoverStaleNeoLock(lockPath, logger)) {
      try {
        mkdirSync(lockPath, { recursive: false });
        writeNeoLockOwner(lockPath);
        return lockPath;
      } catch (retryError) {
        if (retryError?.code !== "EEXIST") throw retryError;
        // Jemand anders war schneller — normal weiterwarten.
      }
    }
    if (Date.now() >= deadline) {
      const locked = new Error("Neo workspace writer backpressure: lock deadline exceeded");
      locked.code = "NEO_WRITE_BACKPRESSURE";
      locked.lockPath = lockPath;
      throw locked;
    }
    return null;
  }
}

function neoLockPathFor(paths) {
  mkdirSync(paths.workspaceDir, { recursive: true });
  return join(paths.workspaceDir, ".neo-write.lock");
}

function releaseNeoLock(lockPath) {
  try { unlinkSync(neoLockOwnerPath(lockPath)); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try { rmdirSync(lockPath); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function workspaceWriteLock(paths, action, { timeoutMs = NEO_LOCK_ACQUIRE_MS, logger = null } = {}) {
  const lockDir = neoLockPathFor(paths);
  const deadline = Date.now() + timeoutMs;
  let lockPath = null;
  while (lockPath === null) {
    lockPath = tryAcquireNeoLock(lockDir, deadline, logger);
    if (lockPath === null) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try {
    return action();
  } finally {
    releaseNeoLock(lockPath);
  }
}

async function workspaceWriteLockAsync(paths, action, { timeoutMs = NEO_LOCK_ACQUIRE_MS, logger = null } = {}) {
  const lockDir = neoLockPathFor(paths);
  const deadline = Date.now() + timeoutMs;
  let lockPath = null;
  while (lockPath === null) {
    lockPath = tryAcquireNeoLock(lockDir, deadline, logger);
    if (lockPath === null) await new Promise(resolve => setTimeout(resolve, 10));
  }
  try { return await action(); }
  finally { releaseNeoLock(lockPath); }
}

function expandHomePath(value) {
  const s = String(value || "");
  if (s === "~") return homedir();
  if (s.startsWith("~/")) return join(homedir(), s.slice(2));
  return s;
}

function normalizeWorkspacePath(value, options = {}) {
  if (!value || typeof value !== "string") return "";
  const expanded = expandHomePath(value.trim());
  const absolute = isAbsolute(expanded) ? expanded : resolve(options.cwd || process.cwd(), expanded);
  try {
    return realpathSync(absolute);
  } catch (_) {
    return resolve(absolute);
  }
}

function mapSet(map, key, value) {
  if (!key || !value) return;
  const safe = normalizeWorkspaceKey(value);
  map.set(String(key), safe);
  map.set(sanitizePathPart(key).toLowerCase(), safe);
  map.set(String(key).toLowerCase(), safe);
}

function mapGet(map, key) {
  if (!key) return "";
  return map.get(String(key))
    || map.get(sanitizePathPart(key).toLowerCase())
    || map.get(String(key).toLowerCase())
    || "";
}

function collectWorkspaceEntries(config = {}, options = {}) {
  const entries = [];
  const add = (entry = {}) => {
    if (!entry || typeof entry !== "object") return;
    const workspaceKey = firstString(entry.workspaceKey, entry.workspace_id, entry.workspaceId, entry.id, entry.name);
    if (!workspaceKey) return;
    const paths = [
      entry.path,
      entry.workspacePath,
      entry.workspaceDir,
      entry.dir,
      entry.workspace,
      ...(Array.isArray(entry.paths) ? entry.paths : []),
    ].filter(value => typeof value === "string" && value.trim());
    const pathBasenames = paths.map(value => basename(expandHomePath(value))).filter(Boolean);
    entries.push({
      workspaceKey: normalizeWorkspaceKey(workspaceKey),
      paths,
      aliases: [
        entry.alias,
        entry.label,
        entry.agent_id,
        entry.agentId,
        entry.agent,
        entry.workspace_id,
        entry.workspaceId,
        entry.id,
        entry.name,
        ...(Array.isArray(entry.aliases) ? entry.aliases : []),
        ...pathBasenames,
      ].filter(value => typeof value === "string" && value.trim()),
      legacyKeys: [
        ...(Array.isArray(entry.legacyKeys) ? entry.legacyKeys.filter(value => typeof value === "string" && value.trim()) : []),
        ...pathBasenames.filter(value => sanitizePathPart(value) !== sanitizePathPart(workspaceKey)),
      ],
    });
  };

  for (const entry of DEFAULT_NEO_WORKSPACE_MAPPINGS) add(entry);
  const obsidian = options.obsidianBridge || config.obsidianBridge || {};
  const neo = options.neo || config.neo || {};
  for (const entry of Array.isArray(obsidian.workspaces) ? obsidian.workspaces : []) add(entry);
  for (const entry of Array.isArray(neo.workspaces) ? neo.workspaces : []) add(entry);
  for (const entry of Array.isArray(options.workspaces) ? options.workspaces : []) add(entry);
  for (const entry of Array.isArray(options.defaultWorkspaces) ? options.defaultWorkspaces : []) add(entry);
  return entries;
}

function addWorkspaceAliases(aliasMap, rawAliases = {}) {
  if (Array.isArray(rawAliases)) {
    for (const entry of rawAliases) {
      if (!entry || typeof entry !== "object") continue;
      const target = firstString(entry.workspaceKey, entry.workspace_id, entry.workspaceId, entry.target, entry.id);
      const aliases = [entry.alias, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
      for (const alias of aliases) mapSet(aliasMap, alias, target);
    }
    return;
  }
  if (rawAliases && typeof rawAliases === "object") {
    for (const [alias, target] of Object.entries(rawAliases)) {
      if (typeof target === "string") mapSet(aliasMap, alias, target);
    }
  }
}

export function buildNeoWorkspaceAliases(config = {}, options = {}) {
  const pathMap = new Map();
  const aliasMap = new Map();
  const migrationMappings = new Map();
  const entries = collectWorkspaceEntries(config, options);
  for (const entry of entries) {
    for (const path of entry.paths) {
      const normalized = normalizeWorkspacePath(path, options);
      if (normalized) pathMap.set(normalized, entry.workspaceKey);
    }
    for (const alias of entry.aliases) mapSet(aliasMap, alias, entry.workspaceKey);
    for (const legacyKey of entry.legacyKeys) {
      mapSet(aliasMap, legacyKey, entry.workspaceKey);
      migrationMappings.set(sanitizePathPart(legacyKey), entry.workspaceKey);
    }
  }

  const neo = options.neo || config.neo || {};
  addWorkspaceAliases(aliasMap, options.workspaceAliases);
  addWorkspaceAliases(aliasMap, neo.workspaceAliases);
  addWorkspaceAliases(aliasMap, config.workspaceAliases);

  return {
    paths: [...pathMap.entries()].map(([path, workspaceKey]) => ({ path, workspaceKey })),
    aliases: [...aliasMap.entries()].map(([alias, workspaceKey]) => ({ alias, workspaceKey })),
    migrations: [...migrationMappings.entries()]
      .map(([legacyKey, workspaceKey]) => ({ legacyKey, workspaceKey })),
  };
}

function normalizeAliasResolver(options = {}) {
  const source = options.workspaceAliases || options.workspaceResolver || options.aliasResolver || {};
  const pathMap = new Map();
  const aliasMap = new Map();

  const addPath = (path, workspaceKey) => {
    const normalized = normalizeWorkspacePath(path, options);
    if (normalized && workspaceKey) pathMap.set(normalized, normalizeWorkspaceKey(workspaceKey));
  };
  const addAlias = (alias, workspaceKey) => mapSet(aliasMap, alias, workspaceKey);

  for (const entry of Array.isArray(source.paths) ? source.paths : []) addPath(entry.path, entry.workspaceKey);
  for (const entry of Array.isArray(source.aliases) ? source.aliases : []) addAlias(entry.alias, entry.workspaceKey);
  if (source.pathMap instanceof Map) {
    for (const [path, workspaceKey] of source.pathMap.entries()) addPath(path, workspaceKey);
  }
  if (source.aliasMap instanceof Map) {
    for (const [alias, workspaceKey] of source.aliasMap.entries()) addAlias(alias, workspaceKey);
  }
  if (source && typeof source === "object" && !Array.isArray(source) && !source.paths && !source.aliases) {
    for (const [alias, workspaceKey] of Object.entries(source)) {
      if (typeof workspaceKey === "string") addAlias(alias, workspaceKey);
    }
  }

  if (pathMap.size === 0 && aliasMap.size === 0) {
    const built = buildNeoWorkspaceAliases(options.config || {}, options);
    for (const entry of built.paths) addPath(entry.path, entry.workspaceKey);
    for (const entry of built.aliases) addAlias(entry.alias, entry.workspaceKey);
  }

  return { pathMap, aliasMap };
}

export function neoSessionKeysFromContext(ctx = {}, event = {}) {
  return Array.from(new Set([
    event.agentSessionKey,
    ctx.agentSessionKey,
    event.sessionKey,
    ctx.sessionKey,
    event.sessionId,
    ctx.sessionId,
    event.runId,
    ctx.runId,
  ].filter(value => typeof value === "string" && value.trim()).map(value => value.trim())));
}

export function listNeoWorkspaceKeys(rootDir) {
  if (!rootDir) return [];
  const workspacesDir = join(rootDir, "workspaces");
  try {
    if (!existsSync(workspacesDir)) return [];
    return readdirSync(workspacesDir)
      .filter(name => {
        try { return statSync(join(workspacesDir, name)).isDirectory(); }
        catch (_) { return false; }
      })
      .map(name => sanitizePathPart(name))
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

export function workspaceKeyFromContext(ctx = {}, options = {}) {
  const event = options.event || {};
  const explicit = firstString(
    event.workspaceKey,
    ctx.workspaceKey,
    event.workspaceId,
    ctx.workspaceId,
  );
  if (explicit) return normalizeWorkspaceKey(explicit);

  const sessionKeys = neoSessionKeysFromContext(ctx, event);
  const sessionWorkspaceKeys = options.sessionWorkspaceKeys || options.sessionWorkspaceMap;
  if (sessionWorkspaceKeys) {
    for (const sessionKey of sessionKeys) {
      const mapped = typeof sessionWorkspaceKeys.get === "function" ? sessionWorkspaceKeys.get(sessionKey) : sessionWorkspaceKeys[sessionKey];
      if (mapped) return normalizeWorkspaceKey(mapped);
    }
  }

  const resolver = normalizeAliasResolver(options);
  const workspaceDir = firstString(event.workspaceDir, ctx.workspaceDir, options.workspaceDir);
  const workspaceName = firstString(event.workspace, ctx.workspace);
  for (const candidate of [workspaceDir, workspaceName]) {
    if (!candidate) continue;
    const pathMatch = resolver.pathMap.get(normalizeWorkspacePath(candidate, options));
    if (pathMatch) return normalizeWorkspaceKey(pathMatch);
  }
  for (const candidate of [workspaceName, workspaceDir ? basename(workspaceDir) : ""]) {
    const aliasMatch = mapGet(resolver.aliasMap, candidate);
    if (aliasMatch) return normalizeWorkspaceKey(aliasMatch);
  }

  const runtimeWorkspace = firstString(
    options.runtimeWorkspaceKey,
    options.runtime?.agent?.workspaceKey,
    options.runtime?.workspaceKey,
  );
  if (runtimeWorkspace) return normalizeWorkspaceKey(runtimeWorkspace);

  const configured = firstString(
    options.defaultWorkspaceKey,
    options.corpusDefaultWorkspaceKey,
    options.config?.corpusDefaultWorkspaceKey,
  );
  if (configured) return normalizeWorkspaceKey(configured);

  if (workspaceName) return normalizeWorkspaceKey(workspaceName);
  if (workspaceDir) return normalizeWorkspaceKey(basename(workspaceDir));

  const existing = listNeoWorkspaceKeys(options.rootDir);
  if (existing.length === 1) return existing[0];

  return "default";
}

function readJsonlWithErrors(path) {
  const records = [];
  const invalid = [];
  if (!existsSync(path)) return { records, invalid };
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        invalid.push({ path, line: index + 1, reason: "line is not a JSON object" });
        return;
      }
      records.push({ record: parsed, line: index + 1, raw: line });
    } catch (err) {
      invalid.push({ path, line: index + 1, reason: String(err?.message || err) });
    }
  });
  return { records, invalid };
}

function writeJsonlAtomic(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, records.map(record => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), "utf8");
  renameSync(tmp, path);
}

function backupFreshnessError(backupDir, options = {}) {
  if (!backupDir) return "A fresh backup directory is required for non-dry-run migration.";
  try {
    const stat = statSync(backupDir);
    if (!stat.isDirectory()) return `Backup path is not a directory: ${backupDir}`;
    const maxAgeMs = Number(options.freshBackupMs || 24 * 60 * 60 * 1000);
    if (maxAgeMs > 0 && Date.now() - stat.mtimeMs > maxAgeMs) {
      return `Backup directory is older than ${Math.round(maxAgeMs / 60000)} minutes: ${backupDir}`;
    }
  } catch (err) {
    return `Backup directory is not accessible: ${backupDir} (${String(err?.message || err)})`;
  }
  return "";
}

function isJsonStateObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function jsonStateValueKey(value) {
  return `${typeof value}:${JSON.stringify(value)}`;
}

function mergeCanonicalJsonState(legacyValue, canonicalValue) {
  if (canonicalValue === undefined) return legacyValue;
  if (legacyValue === undefined) return canonicalValue;
  if (Array.isArray(legacyValue) && Array.isArray(canonicalValue)) {
    const seen = new Set();
    return [...canonicalValue, ...legacyValue].filter((value) => {
      const key = jsonStateValueKey(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (isJsonStateObject(legacyValue) && isJsonStateObject(canonicalValue)) {
    const merged = { ...legacyValue };
    for (const [key, value] of Object.entries(canonicalValue)) {
      merged[key] = mergeCanonicalJsonState(legacyValue[key], value);
    }
    return merged;
  }
  return canonicalValue;
}

function mergeNeoJsonState(file, legacyState, canonicalState) {
  const legacy = isJsonStateObject(legacyState) ? legacyState : {};
  const canonical = isJsonStateObject(canonicalState) ? canonicalState : {};
  const merged = mergeCanonicalJsonState(legacy, canonical);
  if (file === "run-state.json") {
    merged.completed = mergeCanonicalJsonState(legacy.completed || {}, canonical.completed || {});
  } else if (file === "hook-state.json") {
    return mergeCanonicalJsonState(legacy, canonical);
  } else if (file === "record-index.json") {
    merged.ids = mergeCanonicalJsonState(legacy.ids || {}, canonical.ids || {});
    merged.embeddingQueue = mergeCanonicalJsonState(legacy.embeddingQueue || {}, canonical.embeddingQueue || {});
  }
  return merged;
}

/**
 * Migrates explicitly mapped legacy Neo workspaces into canonical storage.
 * @param {string} rootDir
 * @param {object} [options]
 * @returns {object}
 */
export function migrateNeoWorkspaces(rootDir, options = {}) {
  const dryRun = options.dryRun !== false;
  const verbose = options.verbose === true;
  const backupDir = firstString(options.backupDir, options.backupPath);
  const report = {
    ok: true,
    dryRun,
    verbose,
    rootDir,
    backupDir: backupDir || null,
    recordsScanned: 0,
    recordsCopied: 0,
    duplicatesSkipped: 0,
    invalidRecordsFound: 0,
    filesWouldWrite: [],
    filesWritten: [],
    invalidRecords: [],
    mappings: [],
  };

  if (!rootDir) {
    return { ...report, ok: false, error: "Neo rootDir is required." };
  }
  if (!dryRun && options.requireBackup !== false) {
    const backupError = backupFreshnessError(backupDir, options);
    if (backupError) return { ...report, ok: false, error: backupError };
  }

  const configured = Array.isArray(options.mappings) && options.mappings.length > 0
    ? options.mappings
    : Array.isArray(options.workspaceAliases?.migrations) && options.workspaceAliases.migrations.length > 0
      ? options.workspaceAliases.migrations
      : DEFAULT_NEO_WORKSPACE_MAPPINGS.flatMap((entry) => (entry.legacyKeys || [])
        .map((legacyKey) => ({ legacyKey, workspaceKey: entry.workspaceKey })));
  const mappings = configured
    .map((entry) => ({
      legacyKey: sanitizePathPart(entry.legacyKey || entry.from || entry.source),
      workspaceKey: normalizeWorkspaceKey(entry.workspaceKey || entry.to || entry.target),
    }))
    .filter((entry) => entry.legacyKey && entry.workspaceKey);
  const ambiguous = new Set();
  const targetsByLegacy = new Map();
  for (const mapping of mappings) {
    const targets = targetsByLegacy.get(mapping.legacyKey) || new Set();
    targets.add(mapping.workspaceKey);
    targetsByLegacy.set(mapping.legacyKey, targets);
    if (targets.size > 1) ambiguous.add(mapping.legacyKey);
  }
  if (ambiguous.size > 0) return { ...report, ok: false, error: `Ambiguous legacy workspace mappings: ${[...ambiguous].join(", ")}` };

  const workspacesDir = join(rootDir, "workspaces");
  for (const mapping of mappings) {
    const legacyDir = join(workspacesDir, mapping.legacyKey);
    const canonicalDir = join(workspacesDir, canonicalWorkspaceStorageKey(mapping.workspaceKey));
    const mappingReport = { ...mapping, sourceDir: legacyDir, targetDir: canonicalDir, files: [] };
    report.mappings.push(mappingReport);
    if (!existsSync(legacyDir)) continue;

    const migrateMapping = () => {
      for (const file of NEO_JSONL_FILES) {
        const sourcePath = join(legacyDir, file);
        const targetPath = join(canonicalDir, file);
        if (!existsSync(sourcePath)) continue;
        const source = readJsonlWithErrors(sourcePath);
        const target = readJsonlWithErrors(targetPath);
        options.onMigrationTargetRead?.({ file, sourcePath, targetPath });
        report.invalidRecords.push(...source.invalid, ...target.invalid);
        report.invalidRecordsFound += source.invalid.length + target.invalid.length;

        const merged = [];
        const seen = new Set();
        for (const { record } of target.records) {
          const key = record.id ? `id:${String(record.id)}` : `target:${JSON.stringify(record)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(record);
        }

        let copied = 0;
        let skipped = 0;
        for (const { record, line } of source.records) {
          report.recordsScanned += 1;
          const key = record.id ? `id:${String(record.id)}` : `source:${sourcePath}:${line}:${JSON.stringify(record)}`;
          if (seen.has(key)) {
            skipped += 1;
            continue;
          }
          seen.add(key);
          copied += 1;
          merged.push({
            ...record,
            workspaceKey: mapping.workspaceKey,
            legacyWorkspaceKey: record.legacyWorkspaceKey || mapping.legacyKey,
          });
        }

        report.recordsCopied += copied;
        report.duplicatesSkipped += skipped;
        const fileReport = { file, sourcePath, targetPath, recordsScanned: source.records.length, copied, duplicatesSkipped: skipped, invalid: source.invalid.length + target.invalid.length };
        mappingReport.files.push(fileReport);
        if (copied > 0) {
          if (dryRun) {
            report.filesWouldWrite.push(targetPath);
          } else {
            writeJsonlAtomic(targetPath, merged);
            report.filesWritten.push(targetPath);
          }
        }
      }

      // JSON-Dateien (nicht JSONL) separat migrieren
      for (const file of NEO_JSON_FILES) {
        const sourcePath = join(legacyDir, file);
        const targetPath = join(canonicalDir, file);
        if (!existsSync(sourcePath)) continue;
        let sourceState;
        let targetState;
        try { sourceState = JSON.parse(readFileSync(sourcePath, "utf8")); } catch (_) { sourceState = {}; }
        try { targetState = JSON.parse(readFileSync(targetPath, "utf8")); } catch (_) { targetState = {}; }
        options.onMigrationTargetRead?.({ file, sourcePath, targetPath });
        const merged = mergeNeoJsonState(file, sourceState, targetState);
        if (dryRun) {
          report.filesWouldWrite.push(targetPath);
        } else {
          writeJsonAtomic(targetPath, merged);
          report.filesWritten.push(targetPath);
        }
        mappingReport.files.push({ file, sourcePath, targetPath, note: "json_merge" });
      }
      const manifestPath = join(canonicalDir, "workspace-manifest.json");
      const legacyManifestPath = join(legacyDir, "workspace-manifest.json");
      const preservedManifest = dryRun
        ? mergeNeoJsonState(
            "workspace-manifest.json",
            readJson(legacyManifestPath, {}),
            readJson(manifestPath, {}),
          )
        : readJson(manifestPath, {});
      const manifest = {
        ...preservedManifest,
        version: 1,
        workspaceKey: mapping.workspaceKey,
        legacyKey: mapping.legacyKey,
        migratedAt: new Date().toISOString(),
      };
      if (dryRun) report.filesWouldWrite.push(manifestPath);
      else {
        writeJsonAtomic(manifestPath, manifest);
        report.filesWritten.push(manifestPath);
      }
    };
    if (dryRun) migrateMapping();
    else workspaceWriteLock({ workspaceDir: canonicalDir }, migrateMapping);
  }
  return report;
}

export function normalizeNeoScope(scope, fallback = "agent_private") {
  const mapped = {
    "agent-private": "agent_private",
    workspace: "workspace_shared",
    user: "global_user",
  }[scope] || scope;
  return NEO_SCOPES.includes(mapped) ? mapped : fallback;
}

export function normalizeNeoStatus(status, fallback = "candidate") {
  return NEO_STATUSES.includes(status) ? status : fallback;
}

export function escapeMemoryText(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Sanitizes memory text before prompt injection — HTML-escapes, strips control
 * chars, and truncates to maxChars. Use for display content, not IDs.
 */
export function sanitizeMemoryTextForPrompt(text, maxChars = 400) {
  let s = String(text || "").slice(0, maxChars);
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Strip control characters (keep tab + newline only)
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  // Collapse excessive whitespace to prevent format manipulation
  s = s.replace(/\n{3,}/g, "\n\n").replace(/ {5,}/g, "    ");
  return s;
}

function sanitizePromptIdentifier(value, fallback = "unknown") {
  const s = sanitizePathPart(value || fallback);
  return escapeMemoryText(s || fallback);
}

export function looksLikePromptInjection(text) {
  return PROMPT_INJECTION_RE.test(String(text || ""));
}

export function extractVisibleText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type && block.type !== "text") {
      const name = block.name || block.fileName || block.filename || "";
      const mediaType = block.mediaType || block.mimeType || block.mime_type || "";
      parts.push(`[visible ${block.type}${name ? `: ${name}` : ""}${mediaType ? ` (${mediaType})` : ""}]`);
    }
  }
  return parts.join("\n").trim();
}

export function categorizeNeoText(text, role = "user") {
  const lower = String(text || "").toLowerCase();
  if (role === "assistant") {
    if (/\b(plan|i will|ich werde|vorschlag|proposal|sollten wir|we should)\b/.test(lower)) return "assistant_plan";
    if (/\b(maybe|could|könnte|suggest|empfehle|recommend)\b/.test(lower)) return "assistant_suggestion";
    return "assistant_claim";
  }
  if (role === "tool") return /test|passed|failed|assert|coverage/.test(lower) ? "test_result" : "tooling_constraint";
  if (/bug|fehler|regression|kaputt|broken|failure|failed|traceback|exception/.test(lower)) return "bug";
  if (/todo|to-do|offen|open question|frage|unklar/.test(lower)) return "open_question";
  if (/decision|entscheid|nehmen wir|gewählt|chosen|architecture|architektur/.test(lower)) return "architecture_decision";
  if (/must|muss|niemals|never|hard policy|constraint|verboten|allowed|erlaubt/.test(lower)) return "technical_constraint";
  if (/workspace|scope|isolation|leak|shared|private/.test(lower)) return "workspace_rule";
  if (/prefer|bevorzug|mag|style|ton|antwortstil|kurz|ausführlich/.test(lower)) return "user_preference";
  if (/github|git|docker|cron|systemctl|shell|hook|provider|runner/.test(lower)) return "tooling_constraint";
  if (/https?:\/\//.test(lower)) return "external_source";
  return "project_fact";
}

export function inferOriginKind(text, role = "user") {
  const lower = String(text || "").toLowerCase();
  if (role === "assistant") {
    if (categorizeNeoText(text, role) === "assistant_plan") return "assistant_plan";
    if (categorizeNeoText(text, role) === "assistant_suggestion") return "assistant_suggestion";
    return "assistant_claim";
  }
  if (role === "tool") return /test|assert|passed|failed/.test(lower) ? "test_result" : "tool_result";
  if (/\b(no|nein|wrong|falsch|nicht so|korrig|correction|aber)\b/.test(lower)) return "user_correction";
  if (/\b(yes|ja|genau|richtig|passt|confirmed|bestätigt)\b/.test(lower)) return "user_confirmation";
  if (/\b(nope|ablehnen|reject|stop|nicht mehr)\b/.test(lower)) return "user_rejection";
  return "user_explicit";
}

export function createOrigin(params = {}) {
  const role = params.role || "user";
  const kind = NEO_ORIGIN_KINDS.includes(params.kind) ? params.kind : inferOriginKind(params.evidence || "", role);
  const trustLevel = params.trustLevel || (
    role === "assistant" ? "assistant_asserted" :
    role === "tool" ? "tool_observed" :
    kind === "manual_curation" ? "curated" :
    "user_asserted"
  );
  return {
    kind,
    role,
    sourceTurnIds: Array.isArray(params.sourceTurnIds) ? params.sourceTurnIds.filter(Boolean) : [],
    sourceMemoryIds: Array.isArray(params.sourceMemoryIds) ? params.sourceMemoryIds.filter(Boolean) : [],
    sourceToolCallIds: Array.isArray(params.sourceToolCallIds) ? params.sourceToolCallIds.filter(Boolean) : [],
    capturedBy: params.capturedBy || "agent_end_capture",
    trustLevel: NEO_TRUST_LEVELS.includes(trustLevel) ? trustLevel : "untrusted",
    confidence: clamp01(params.confidence ?? 0.7),
    scope: normalizeNeoScope(params.scope, role === "assistant" ? "agent_private" : "workspace_shared"),
    workspaceKey: params.workspaceKey || "default",
    agentId: params.agentId || "default",
    sessionId: params.sessionId || "",
  };
}

export function createTurnEvent(params = {}) {
  const content = String(params.content || "").trim();
  const role = params.role || "user";
  const id = params.id || randomUUID();
  const workspaceKey = params.workspaceKey || "default";
  const agentId = params.agentId || "default";
  const sessionId = params.sessionId || "";
  const category = params.category || categorizeNeoText(content, role);
  const emotion = inferEmotionalValence(content, category);
  return {
    id,
    workspaceKey,
    agentId,
    sessionId,
    turnIndex: Number.isFinite(params.turnIndex) ? params.turnIndex : 0,
    role,
    content,
    categories: Array.from(new Set([category, ...(params.categories || [])].filter(c => NEO_CATEGORIES.includes(c)))),
    origin: createOrigin({
      kind: params.originKind,
      role,
      sourceTurnIds: [id],
      // createOrigin fuehrt sourceToolCallIds, createTurnEvent reichte es
      // aber nie durch — die Verknuepfung eines Tool-Ergebnisses zu seinem
      // Aufruf ging damit verloren.
      sourceToolCallIds: params.sourceToolCallIds,
      capturedBy: params.capturedBy || "agent_end_capture",
      confidence: params.confidence ?? 0.75,
      scope: params.scope,
      workspaceKey,
      agentId,
      sessionId,
      evidence: content,
    }),
    visibility: {
      scope: normalizeNeoScope(params.scope, role === "assistant" ? "agent_private" : "workspace_shared"),
      recallable: params.recallable !== false,
      promptInjectable: params.promptInjectable === true,
      dreamEligible: params.dreamEligible !== false && role !== "assistant",
    },
    attribution: {
      repliesToTurnIds: Array.isArray(params.repliesToTurnIds) ? params.repliesToTurnIds : [],
      usedMemoryIds: Array.isArray(params.usedMemoryIds) ? params.usedMemoryIds : [],
      usedBehaviorCardIds: Array.isArray(params.usedBehaviorCardIds) ? params.usedBehaviorCardIds : [],
      usedDreamIds: Array.isArray(params.usedDreamIds) ? params.usedDreamIds : [],
      usedToolIds: Array.isArray(params.usedToolIds) ? params.usedToolIds : [],
    },
    quality: {
      confidence: clamp01(params.confidence ?? 0.75),
      userConfirmed: false,
      contradicted: false,
      stale: false,
      promoted: false,
      demoted: false,
      pruned: false,
      promptInjectionSuspected: looksLikePromptInjection(content),
    },
    emotionalValence: serializeEmotionalValence(emotion),
    emotionalIntensity: emotion.emotionalIntensity,
    emotionalDominant: emotion.emotionalDominant,
    createdAt: params.createdAt || new Date().toISOString(),
  };
}

// Resolves a per-message ISO createdAt instead of batch-stamping every
// message in a capture with the same value.
//
// Bug fixed here: callers of turnEventsFromMessages compute ONE
// `new Date().toISOString()` per batch (captureNeoFromAgentEnd below, and
// the agent_end capture path in index.js) and pass it as params.createdAt
// for every message in that batch, so every turn in a session got an
// IDENTICAL createdAt. groupTurnsIntoEpisodes (lib/episodes.js) splits
// episodes on the gap between consecutive createdAt values, so identical
// timestamps meant zero gaps were ever detected — every episode ended up
// with startTime === endTime and durationMinutes: 0 in production
// (confirmed against the live turn-journal.jsonl).
//
// Field choice `msg.timestamp` (number, epoch ms) is not guessed. This
// function has no prior test coverage (tests/ and test/ have zero calls to
// turnEventsFromMessages), and the persisted turn-journal only records this
// function's OUTPUT (createdAt) — neither source says anything about the
// *input* message shape. The plugin's own call sites never read per-message
// time either (that omission is the bug being fixed). The field name was
// instead confirmed against the installed OpenClaw host package
// (/usr/lib/node_modules/openclaw, 2026.7.2-beta.6 — matches the running
// `openclaw --version` and satisfies this plugin's declared
// minGatewayVersion 2026.5.12-beta.6): every message constructor in
// agent-core (user prompts via normalizePromptInput, assistant streams,
// tool results via createToolResultMessage, failure/interrupted messages)
// stamps `timestamp: Date.now()` — 36 occurrences in that one file, 95
// across the whole dist/ tree. It is a number (epoch ms), never an ISO
// string.
//
// Falls back to the batch-level `fallback` (params.createdAt) for messages
// that don't carry it — hand-built messages, tests, or older/foreign hosts.
function messageCreatedAt(msg, fallback) {
  const raw = msg?.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) return new Date(raw).toISOString();
  if (typeof raw === "string" && raw.trim()) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Tool-Ergebnisse (role "toolResult")
//
// Der Host verpackt jeden Tool-Rueckgabewert in eine Nachricht mit
// role "toolResult" (createToolResultMessage). Das Plugin filterte bisher auf
// role "tool" und las msg.tool_call_id statt msg.toolCallId — beides traf nie
// zu, weshalb NIE ein Tool-Ergebnis ins Gedaechtnis kam. Die
// Klassifizierungs-Zweige fuer role "tool" (categorizeNeoText & Co.) waren
// entsprechend toter Code.
//
// Erfasst wird bewusst nicht alles: Shell- und Datei-Rohausgaben sind der mit
// Abstand groesste Textanteil, stehen ohnehin auf der Platte und sind nicht
// das, woran ein Agent sich erinnern soll. Sie wuerden ausserdem ueber den
// NEO_MAX_RECORDS-Cap echte Gespraechs-Turns verdraengen. Fehlerergebnisse
// sind dagegen IMMER erinnernswert — auch von Shell und Datei-Tools: dass und
// warum etwas schiefging, ist genau das, was spaeter zaehlt.
// ---------------------------------------------------------------------------
const TOOL_RESULT_MAX_CHARS = Math.max(
  500,
  Number(process.env.PLUR1BUS_TOOL_RESULT_MAX_CHARS) || 5000,
);

// Tools, deren Erfolgsausgabe Rohmaterial statt Erkenntnis ist.
const BULK_OUTPUT_TOOL_RE = /^(bash|exec|exec_command|local_shell|shell|read|write|edit|apply_patch|str_replace[a-z_]*)$/i;

export function normalizeTurnRole(role) {
  const value = typeof role === "string" ? role.trim() : "";
  // Host-Rolle auf die interne Kurzform bringen; die
  // Klassifizierungs-Zweige unten erwarten "tool".
  if (value === "toolResult" || value === "tool_result") return "tool";
  return value;
}

/**
 * Entscheidet, ob ein Tool-Ergebnis ins Gedaechtnis aufgenommen wird.
 *
 * @param {Object} msg — Host-Nachricht mit toolName / isError
 * @returns {boolean}
 */
export function isMemorableToolResult(msg) {
  if (msg?.isError === true) return true; // Fehler immer, egal welches Tool.
  const name = typeof msg?.toolName === "string" ? msg.toolName.trim() : "";
  if (!name) return false; // Ohne Tool-Bezug nicht einordenbar → nicht erfassen.
  return !BULK_OUTPUT_TOOL_RE.test(name);
}

export function truncateToolResult(text, maxChars = TOOL_RESULT_MAX_CHARS) {
  const value = String(text || "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}\n[… gekürzt, ${value.length - maxChars} Zeichen ausgelassen]`;
}

/**
 * Converts visible conversation messages into Neo turn records with stable replay IDs.
 */
export function turnEventsFromMessages(messages = [], params = {}) {
  const events = [];
  let previousAssistantId = "";
  let turnIndex = Number.isFinite(params.startTurnIndex) ? params.startTurnIndex : 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = normalizeTurnRole(msg.role);
    if (!["user", "assistant", "tool"].includes(role)) continue;
    // Tool-Ergebnisse werden gefiltert und gekürzt — siehe
    // isMemorableToolResult / TOOL_RESULT_MAX_CHARS.
    if (role === "tool" && !isMemorableToolResult(msg)) continue;
    let content = extractVisibleText(msg.content);
    if (role === "tool") content = truncateToolResult(content);
    if (!content || content.length < 2) continue;
    // Systemisch injizierten Kontext (Recall-Blöcke, Status-Reminder, Cron)
    // nicht als Turn erfassen → verhindert Recall/Capture-Rückkopplung.
    if (isInjectedContextText(content)) continue;
    // Der Host nennt das Feld toolCallId (createToolResultMessage);
    // tool_call_id bleibt als Fallback für ältere Hosts.
    const rawToolCallId = msg.toolCallId || msg.tool_call_id || "";
    const sourceToolCallIds = rawToolCallId ? [rawToolCallId] : [];
    const event = createTurnEvent({
      id: stableId(
        "turn",
        params.workspaceKey || "default",
        params.agentId || "default",
        params.sessionId || "",
        turnIndex,
        role,
        normalizeStatement(content),
        sourceToolCallIds,
      ),
      workspaceKey: params.workspaceKey,
      agentId: params.agentId,
      sessionId: params.sessionId,
      turnIndex: turnIndex++,
      role,
      content,
      sourceToolCallIds,
      // Ein Tool-Ergebnis antwortet auf den Assistant-Turn, der es aufgerufen
      // hat — damit wird sourceToolCallIds erstmals auswertbar.
      repliesToTurnIds: (role === "user" || role === "tool") && previousAssistantId ? [previousAssistantId] : [],
      // Tool-Ergebnisse sind agent_private wie Assistant-Turns: sie stammen
      // aus der internen Arbeit des Agenten und können Dateiinhalte oder
      // Kommandoausgaben enthalten. workspace_shared waere hier ein Leck.
      scope: role === "assistant" || role === "tool" ? "agent_private" : "workspace_shared",
      createdAt: messageCreatedAt(msg, params.createdAt),
    });
    if (role === "assistant") previousAssistantId = event.id;
    events.push(event);
  }
  return events;
}

/**
 * Derives memory candidates from turns using deterministic IDs tied to source turns.
 */
export function memoryCandidatesFromTurns(turns = []) {
  return turns
    .filter(turn => turn.visibility?.recallable && turn.content && !turn.quality?.promptInjectionSuspected && !isInjectedContextText(turn.content))
    .map(turn => {
      const category = turn.categories?.[0] || categorizeNeoText(turn.content, turn.role);
      const assistant = turn.role === "assistant";
      const normalizedStatement = normalizeStatement(turn.content);
      return {
        id: stableId("mem", turn.id, category, normalizedStatement),
        workspaceKey: turn.workspaceKey,
        agentId: assistant ? turn.agentId : undefined,
        statement: turn.content,
        normalizedStatement,
        category,
        origin: {
          ...turn.origin,
          sourceTurnIds: [turn.id],
          trustLevel: assistant ? "assistant_asserted" : turn.origin.trustLevel,
        },
        sourceTurnIds: [turn.id],
        status: assistant ? "candidate" : "active",
        confidence: assistant ? 0.45 : turn.quality?.confidence ?? 0.75,
        salience: initialSalience(category, turn.role),
        recency: 1,
        embeddingStatus: "pending",
        createdAt: turn.createdAt,
        emotionalValence: turn.emotionalValence,
        emotionalIntensity: turn.emotionalIntensity,
        emotionalDominant: turn.emotionalDominant,
      };
    });
}

/**
 * Extracts deterministic reaction signals from user turns.
 */
export function reactionSignalsFromTurns(turns = []) {
  const signals = [];
  for (const turn of turns) {
    if (turn.role !== "user") continue;
    const classification = classifyReaction(turn.content);
    if (!classification) continue;
    const targetIds = turn.attribution?.repliesToTurnIds || [];
    signals.push({
      id: stableId(
        "react",
        turn.id,
        classification.targetType,
        targetIds,
        classification.polarity,
        classification.intensity,
        classification.explicitness,
        normalizeStatement(turn.content),
      ),
      workspaceKey: turn.workspaceKey,
      agentId: turn.agentId,
      sessionId: turn.sessionId,
      turnId: turn.id,
      targetType: classification.targetType,
      targetIds,
      polarity: classification.polarity,
      intensity: classification.intensity,
      confidence: classification.confidence,
      explicitness: classification.explicitness,
      evidence: turn.content.slice(0, 1000),
      extractedAt: new Date().toISOString(),
    });
  }
  return signals;
}

/**
 * Converts reaction signals into behavior cards with deterministic source-derived IDs.
 */
export function behaviorCardsFromReactions(signals = []) {
  return signals
    .filter(signal => signal.explicitness !== "implicit_acceptance" && signal.explicitness !== "ambiguous")
    .map(signal => {
      const category = inferBehaviorCategory(signal.evidence);
      const statement = normalizeBehaviorStatement(signal.evidence);
      return {
        id: stableId("behavior", signal.id, category, statement),
        workspaceKey: signal.workspaceKey,
        agentId: signal.agentId,
        category,
        statement,
        status: signal.polarity < 0 ? "conflict" : signal.explicitness === "explicit_correction" || signal.explicitness === "explicit_instruction" ? "active" : "candidate",
        confidence: signal.confidence,
        salience: signal.intensity,
        sourceSignals: [signal.id],
        lastConfirmedAt: signal.polarity > 0 ? signal.extractedAt : undefined,
        lastContradictedAt: signal.polarity < 0 ? signal.extractedAt : undefined,
        embeddingStatus: "pending",
        createdAt: signal.extractedAt,
      };
    });
}

export function transitionRecordStatus(record, nextStatus, opts = {}) {
  const status = normalizeNeoStatus(nextStatus);
  const out = { ...record, status, updatedAt: opts.now || new Date().toISOString() };
  if (status === "promoted") {
    out.confidence = clamp01((record.confidence ?? 0.5) + 0.2);
    out.salience = clamp01((record.salience ?? 0.5) + 0.2);
    out.embeddingStatus = "stale";
    if (opts.promoteScope && record.origin) out.origin = { ...record.origin, scope: normalizeNeoScope(opts.promoteScope, record.origin.scope) };
  } else if (status === "demoted") {
    out.salience = clamp01((record.salience ?? 0.5) - 0.25);
    out.embeddingStatus = "stale";
  } else if (status === "pruned") {
    out.embeddingStatus = "excluded";
  } else if (status === "tombstoned") {
    out.embeddingStatus = "tombstoned";
  } else if (status === "active") {
    out.embeddingStatus = record.embeddingStatus === "fresh" ? "fresh" : "pending";
  }
  return out;
}

function neoRecordScope(item) {
  return normalizeNeoScope(item?.visibility?.scope || item?.origin?.scope, "");
}

/** Returns whether a Neo record is visible to the explicit requester bindings. */
export function isNeoRecordAccessible(item, requester = {}) {
  const scope = neoRecordScope(item);
  if (scope === "agent_private") {
    return Boolean(requester.requesterAgentId && item?.agentId && requester.requesterAgentId === item.agentId);
  }
  if (scope === "workspace_shared") {
    return Boolean(requester.requesterWorkspaceKey && item?.workspaceKey && requester.requesterWorkspaceKey === item.workspaceKey);
  }
  if (scope === "global_user") {
    const ownerId = item?.ownerId || item?.origin?.ownerId || item?.visibility?.ownerId;
    return Boolean(requester.requesterOwnerId && ownerId && requester.requesterOwnerId === ownerId);
  }
  return false;
}

export function scoreNeoRecallItem(item, query, lane = "workspace_facts", opts = {}) {
  if (!item || ["pruned", "tombstoned"].includes(item.status) || item.hardDeleted === true) return -Infinity;
  const q = tokenizeForScore(query);
  const text = tokenizeForScore(`${item.statement || item.content || ""} ${item.category || ""}`);
  const semantic = jaccard(q, text);
  const categoryBoost = laneMatchesCategory(lane, item.category) ? 0.25 : 0;
  const trustBoost = ({ curated: 0.3, validated: 0.25, user_asserted: 0.18, tool_observed: 0.18, assistant_asserted: -0.2, untrusted: -0.3 })[item.origin?.trustLevel] ?? 0;
  const curationBoost = item.status === "promoted" ? 0.25 : item.status === "active" ? 0.1 : 0;
  const salience = clamp01(item.salience ?? 0.5) * 0.15;
  const recency = clamp01(item.recency ?? 0.5) * 0.1;
  const penalties =
    (item.origin?.role === "assistant" ? 0.2 : 0) +
    (item.status === "demoted" ? 0.35 : 0) +
    (item.status === "conflict" ? 0.3 : 0) +
    (item.stale === true ? 0.15 : 0);
  const vectorScore = cosineSimilarity(opts.queryVector, item.embedding);
  return semantic + (Number.isFinite(vectorScore) ? vectorScore * 0.75 : 0) + categoryBoost + trustBoost + curationBoost + salience + recency - penalties;
}

export function routeNeoRecall(items = [], query, opts = {}) {
  const lanes = opts.lanes || NEO_RECALL_LANES;
  const maxPerLane = opts.maxPerLane || 3;
  const minScore = opts.minScore ?? 0.05;
  const out = Object.fromEntries(lanes.map(lane => [lane, []]));
  const uniqueItems = [];
  const inputSeen = new Set();

  for (const item of items) {
    const id = item?.id ? String(item.id) : "";
    if (id) {
      if (inputSeen.has(id)) continue;
      inputSeen.add(id);
    }
    uniqueItems.push(item);
  }

  const candidates = [];
  uniqueItems.forEach((item, itemIndex) => {
    if (!isNeoRecordAccessible(item, opts)) return;
    lanes.forEach((lane, laneIndex) => {
      const score = scoreNeoRecallItem(item, query, lane, opts);
      if (Number.isFinite(score) && score > minScore) {
        candidates.push({ lane, laneIndex, itemIndex, item, score });
      }
    });
  });

  candidates.sort((a, b) =>
    b.score - a.score ||
    a.laneIndex - b.laneIndex ||
    a.itemIndex - b.itemIndex
  );

  const outputSeen = new Set();
  for (const row of candidates) {
    if (out[row.lane].length >= maxPerLane) continue;
    const id = row.item?.id ? String(row.item.id) : "";
    if (id && outputSeen.has(id)) continue;
    out[row.lane].push({ item: row.item, score: row.score });
    if (id) outputSeen.add(id);
  }
  return out;
}

export function formatNeoRecallContext(lanes, opts = {}) {
  const lines = [];
  const maxItemChars = opts.maxItemChars || 500;
  const maxTotalChars = opts.maxTotalChars || 5000;
  const renderedIds = new Set();
  let usedChars = 0;
  for (const [lane, rows] of Object.entries(lanes || {})) {
    for (const row of rows || []) {
      const item = row.item;
      const rawId = item?.id ? String(item.id) : "";
      if (rawId && renderedIds.has(rawId)) continue;
      const text = sanitizeMemoryTextForPrompt(item.statement || item.content || "", maxItemChars);
      const safeLane = sanitizePromptIdentifier(lane, "lane");
      const safeCategory = sanitizePromptIdentifier(item.category, "category");
      const safeTrust = sanitizePromptIdentifier(item.origin?.trustLevel || "untrusted", "untrusted");
      const safeId = sanitizePromptIdentifier(rawId || item.id, "id");
      const line = `  <memory-record lane="${safeLane}" category="${safeCategory}" trust="${safeTrust}" id="${safeId}" score="${row.score.toFixed(2)}"><quoted-evidence>${text}</quoted-evidence></memory-record>`;
      if (usedChars + line.length > maxTotalChars) {
        lines.push("  - [truncated] Additional PLUR1BUS recall items were omitted because the recall block reached its configured size limit.");
        return wrapNeoRecallContext(lines, opts);
      }
      usedChars += line.length;
      lines.push(line);
      if (rawId) renderedIds.add(rawId);
    }
  }
  if (lines.length === 0) return "";
  return wrapNeoRecallContext(lines, opts);
}

function wrapNeoRecallContext(lines, opts = {}) {
  const keyAttr = opts.idempotencyKey ? ` idempotency-key="${sanitizePromptIdentifier(opts.idempotencyKey, "turn")}"` : "";
  return `<plur1bus-recall untrusted="true" mode="historical-evidence-only"${keyAttr}>\n${buildRecallSafetyPreamble({ compact: true })}\n${lines.join("\n")}\n</plur1bus-recall>`;
}

export function findLatestNeoRecord(store, id, limits = {}) {
  const targetId = String(id || "");
  if (!targetId) return null;
  const latest = new Map();
  for (const item of store.readCandidates(limits.candidates || 10_000, limits)) {
    if (item?.id) latest.set(item.id, item);
  }
  for (const item of store.readBehaviorCards(limits.behaviorCards || 10_000, limits)) {
    if (item?.id) latest.set(item.id, item);
  }
  const item = latest.get(targetId) || null;
  return isNeoRecordAccessible(item, limits) ? item : null;
}

// Liefert den dedup-Schlüssel eines geparsten Records (Statement-/Content-Text).
function recordDedupKey(record) {
  if (!record || typeof record !== "object") return "";
  const base = record.normalizedStatement || record.statement || record.content || record.text || "";
  return normalizeStatement(base);
}

// Liefert den Text eines Records, gegen den auf injizierten Kontext geprüft wird.
function recordText(record) {
  if (!record || typeof record !== "object") return "";
  return String(record.statement || record.content || record.text || record.summary || "");
}

/**
 * Bereinigt eine einzelne neo-JSONL-Datei: entfernt injizierten Kontext,
 * dedupt (optional) nach Statement und kappt auf die jüngsten `maxRecords`.
 * Schreibt atomar zurück (außer dryRun). Liefert Statistik.
 * Wird sowohl von der täglichen Konsolidierung als auch vom Cleanup-Skript genutzt.
 */
export function pruneNeoJsonlFile(path, options = {}) {
  const maxRecords = Number.isFinite(options.maxRecords) ? options.maxRecords : NEO_MAX_RECORDS;
  const dedup = options.dedup !== false;
  const dryRun = options.dryRun === true;
  const stats = { path, exists: false, before: 0, removedInjected: 0, removedDup: 0, removedCap: 0, after: 0 };
  if (!existsSync(path)) return stats;
  stats.exists = true;
  const rawLines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  stats.before = rawLines.length;
  const seen = new Set();
  const kept = [];
  for (const line of rawLines) {
    let record = null;
    try { record = JSON.parse(line); } catch (_) { record = null; }
    const text = record ? recordText(record) : line;
    if (isInjectedContextText(text) || (record === null && isInjectedContextText(line))) {
      stats.removedInjected++;
      continue;
    }
    if (dedup && record) {
      const key = recordPruneDedupeKey(record);
      if (key && seen.has(key)) { stats.removedDup++; continue; }
      if (key) seen.add(key);
    }
    kept.push(line);
  }
  let finalLines = kept;
  if (kept.length > maxRecords) {
    stats.removedCap = kept.length - maxRecords;
    finalLines = kept.slice(-maxRecords);
  }
  stats.after = finalLines.length;
  if (!dryRun && (stats.removedInjected || stats.removedDup || stats.removedCap)) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, finalLines.length ? finalLines.join("\n") + "\n" : "", "utf8");
    renameSync(tmp, path);
  }
  return stats;
}

/**
 * Creates a filesystem-backed Neo JSONL store for one workspace.
 */
export function createNeoStore(rootDir, workspaceKey = "default") {
  const canonicalWorkspaceKey = canonicalWorkspaceStorageKey(workspaceKey);
  const workspaceDir = join(rootDir, "workspaces", canonicalWorkspaceKey);
  const legacyWorkspaceDir = join(rootDir, "workspaces", sanitizePathPart(workspaceKey));
  const paths = {
    workspaceDir,
    turns: join(workspaceDir, "turn-journal.jsonl"),
    candidates: join(workspaceDir, "memory-candidates.jsonl"),
    reactions: join(workspaceDir, "reaction-ledger.jsonl"),
    behavior: join(workspaceDir, "behavior-cards.jsonl"),
    embeddings: join(workspaceDir, "embedding-queue.jsonl"),
    dreams: join(workspaceDir, "dream-diary.jsonl"),
    episodes: join(workspaceDir, "episodes.jsonl"),
    graph: join(workspaceDir, "memory-graph.jsonl"),
    patterns: join(workspaceDir, "pattern-analysis.jsonl"),
    retrievalLedger: join(workspaceDir, "retrieval-ledger.jsonl"),
    reconsolidationEvents: join(workspaceDir, "reconsolidation-events.jsonl"),
    runs: join(workspaceDir, "run-state.json"),
    hooks: join(workspaceDir, "hook-state.json"),
    index: join(workspaceDir, "record-index.json"),
  };
  const legacyPaths = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, join(legacyWorkspaceDir, basename(path))]));
  // Collision guard: sanitizePathPart() is LOSSY — e.g. "tenant/a" and
  // "tenant_a" both sanitize to the legacy dir name "tenant_a" (so does
  // "tenant a", "tenant:a", ...). Auto-merging a legacy directory whose name
  // was produced by a lossy sanitization is unsafe: some OTHER workspace key
  // could have produced that exact same legacy directory name, and merging
  // it in would leak that other workspace's data into this one's reads. This
  // exact scenario is covered by tests/neo-b8-closure.test.js "uses
  // collision-resistant storage after an explicit legacy migration", which
  // asserts createNeoStore(root, "tenant/a") must NOT auto-read the
  // "tenant_a" legacy dir before an operator resolves the ambiguity via
  // migrateNeoWorkspaces (which physically copies into canonical storage,
  // so canonical-only reads see it from then on regardless of this gate).
  //
  // Only auto-merge when the legacy name is self-identifying for THIS
  // workspaceKey, i.e. sanitization was a no-op — then no other key could
  // have coincidentally collided onto it via lossy sanitization, and the
  // legacy directory unambiguously belongs to this workspace (the real,
  // evidenced production bug: "workspace", "workspace-bernhardine",
  // "workspace-heisenberg" are all already sanitizer-clean, so they keep
  // merging under this gate).
  const legacyReadIsSafe = sanitizePathPart(workspaceKey) === String(workspaceKey || "default").trim();
  // Reads BOTH the canonical (hashed) and legacy (pre-hash) workspace path for
  // one JSONL store, merges them, and returns the most recent `limit` records.
  // Previously `legacyPath` was accepted but never read: workspaces migrated
  // to the `--<hash>` naming scheme lost read access to everything written
  // under the old, unhashed directory name (real impact: bernhardine saw 12
  // of 167 episodes, main 16 of 41 — the rest sat in the legacy dir).
  //
  // Each side is read via the existing bounded tail reader (readJsonlTail),
  // never a full-file scan, so this stays cheap even for multi-MB journals.
  // Reading `limit` records from each side before merging is sufficient to
  // recover the true global top-`limit`: any record in the true merged top-K
  // has, by definition, fewer than K records ahead of it in the FULL union,
  // so it has fewer than K ahead of it within its own source too — it is
  // therefore guaranteed to be in ITS OWN source's top-K tail read.
  //
  // The requester/isNeoRecordAccessible ACL filter is preserved and applied
  // AFTER the merge, over both canonical and legacy records alike — legacy
  // origin never bypasses the ACL.
  const readMerged = (path, legacyPath, limit, requester) => {
    const canonical = readJsonlTail(path, limit);
    const legacy = legacyReadIsSafe && legacyPath && legacyPath !== path ? readJsonlTail(legacyPath, limit) : [];
    return mergeNeoRecordsById(canonical, legacy)
      .filter(record => !requester || isNeoRecordAccessible(record, requester))
      .slice(-limit);
  };
  const write = (action) => workspaceWriteLock(paths, action);
  return {
    paths,
    legacyPaths,
    appendTurns: (items) => write(() => appendJsonlDedupe(paths.turns, items, { indexPath: paths.index, bucket: "turns" })),
    appendCandidates: (items) => write(() => appendJsonlDedupe(paths.candidates, items, { indexPath: paths.index, bucket: "candidateContent", dedupeKey: appendCandidateContentDedupeKey })),
    appendReactions: (items) => write(() => appendJsonlDedupe(paths.reactions, items, { indexPath: paths.index, bucket: "reactions" })),
    appendBehaviorCards: (items) => write(() => appendJsonlDedupe(paths.behavior, items, { indexPath: paths.index, bucket: "behavior" })),
    appendEmbeddingQueue: (items) => write(() => appendEmbeddingQueueDedupe(paths.embeddings, items.map(item => {
      const targetType = inferEmbeddingTargetType(item);
      const impact = inferEmbeddingImpact(item);
      return {
        id: stableId("embq", targetType, item.id, impact),
        targetId: item.id,
        targetType,
        workspaceKey: item.workspaceKey,
        agentId: item.agentId,
        impact,
        status: item.embeddingStatus || "pending",
        queuedAt: new Date().toISOString(),
      };
    }), { indexPath: paths.index })),
    drainEmbeddingQueue: async (opts = {}) => workspaceWriteLockAsync(paths, () => drainEmbeddingQueueFile(paths, opts), { timeoutMs: NEO_LOCK_LONG_ACQUIRE_MS }),
    appendDreams: (items) => write(() => appendJsonl(paths.dreams, items)),
    appendEpisodes: (items) => write(() => appendJsonl(paths.episodes, items)),
    appendGraphEdges: (items) => write(() => appendJsonl(paths.graph, items)),
    appendPatterns: (items) => write(() => appendJsonl(paths.patterns, items)),
    appendRetrievalLedger: (items) => write(() => appendJsonl(paths.retrievalLedger, items)),
    appendReconsolidationEvents: (items) => write(() => appendJsonl(paths.reconsolidationEvents, items)),
    readCandidates: (limit = 500, requester) => readMerged(paths.candidates, legacyPaths.candidates, limit, requester),
    readBehaviorCards: (limit = 200, requester) => readMerged(paths.behavior, legacyPaths.behavior, limit, requester),
    readTurns: (limit = 200, requester) => readMerged(paths.turns, legacyPaths.turns, limit, requester),
    // No `requester` threaded through on these four: dreams/episodes/graph
    // edges/patterns carry no `visibility.scope` or `origin.scope` field (see
    // createEpisode, createEdge, the rem-dream pattern writer — none set one),
    // so isNeoRecordAccessible(record, requester) would return false for
    // EVERY record of these types once a requester is passed, silently
    // zeroing the result instead of filtering it. Making these ACL-aware
    // needs a real scope/ownership field on the record schema first, which is
    // outside this fix's scope. Do not add a requester param here without
    // adding that field — read this comment as the reason before wiring one
    // of these to `neoRequester(...)` the way readCandidates/readBehaviorCards
    // already are.
    readDreams: (limit = 100) => readMerged(paths.dreams, legacyPaths.dreams, limit),
    readEpisodes: (limit = 100) => readMerged(paths.episodes, legacyPaths.episodes, limit),
    readGraphEdges: (limit = 10_000) => readMerged(paths.graph, legacyPaths.graph, limit),
    readPatterns: (limit = 500) => readMerged(paths.patterns, legacyPaths.patterns, limit),
    // readRetrievalLedger and readReconsolidationEvents intentionally stay
    // canonical-only (NOT routed through readMerged), unlike the four reads
    // above. Both are consumed as append-ledgers with real, correctness-
    // sensitive semantics, not plain display reads:
    //  - readReconsolidationEvents feeds safe-update.js `isIdempotent()`,
    //    a duplicate-prevention gate keyed on `idempotencyKey`. Retroactively
    //    surfacing legacy-path events would change what that gate considers
    //    "already done" for records this plugin has never merge-tested.
    //  - readRetrievalLedger feeds a stateful, watermark-driven consumer
    //    (lib/jobs/memory-dynamics-maintenance.js `processRetrievalLedgerWork`)
    //    that applies real side effects (retrieval reinforcement, decay) and
    //    advances a persisted high-watermark per (agentId, workspaceKey). A
    //    merge/sort bug here risks either double-applying an effect or
    //    silently starving the watermark of entries it should see.
    // Both were bugs of pure invisibility for the four reads above (data that
    // should be readable just wasn't). Here the risk profile is different —
    // a merge bug could corrupt state, not just hide it — so this is left as
    // a deliberate follow-up decision rather than folded into this fix.
    readRetrievalLedger: (limit = 500) => readJsonlTail(paths.retrievalLedger, limit),
    readReconsolidationEvents: (limit = 500) => readJsonlTail(paths.reconsolidationEvents, limit),
    readRunState: () => readJson(paths.runs, {}),
    writeRunState: (state) => write(() => writeJsonAtomic(paths.runs, state)),
    hasCompletedRun: (runKey) => {
      const state = readJson(paths.runs, {});
      return Boolean(state.completed?.[runKey]);
    },
    markRunCompleted: (runKey, meta = {}) => write(() => {
      const state = readJson(paths.runs, {});
      state.completed = state.completed || {};
      state.completed[runKey] = { completedAt: new Date().toISOString(), ...meta };
      writeJsonAtomic(paths.runs, state);
    }),
    readHooks: () => readJson(paths.hooks, {}),
    // Wartung: bereinigt alle JSONL-Stores dieses Workspaces (injizierter
    // Kontext raus, dedup, Cap). Liefert pro Datei eine Statistik.
    // Der Lock wird bewusst PRO DATEI genommen, nicht einmal für den ganzen
    // Lauf: das Turn-Journal erreicht dreistellige MB, und ein Lock über alle
    // Dateien hinweg hielt ihn weit über die Acquire-Deadline hinaus — jeder
    // parallele Writer lief dadurch in NEO_WRITE_BACKPRESSURE. Zwischen den
    // Dateien bekommen normale Appends jetzt wieder Luft.
    pruneAll: (opts = {}) => {
      const targets = {
        turns: paths.turns,
        candidates: paths.candidates,
        reactions: paths.reactions,
        behavior: paths.behavior,
        embeddings: paths.embeddings,
        dreams: paths.dreams,
        episodes: paths.episodes,
        graph: paths.graph,
        patterns: paths.patterns,
        retrievalLedger: paths.retrievalLedger,
        reconsolidationEvents: paths.reconsolidationEvents,
      };
      const report = {};
      for (const [name, p] of Object.entries(targets)) {
        // Embedding-Queue, Retrieval-Ledger und Reconsolidation-Events nicht dedupen.
        const fileOpts = { ...opts, dedup: opts.dedup !== false && name !== "embeddings" && name !== "retrievalLedger" && name !== "reconsolidationEvents" };
        report[name] = workspaceWriteLock(paths, () => pruneNeoJsonlFile(p, fileOpts), { timeoutMs: NEO_LOCK_LONG_ACQUIRE_MS });
      }
      return report;
    },
    recordHook: (hookName, meta = {}) => write(() => {
      const current = readJson(paths.hooks, {});
      const prev = current[hookName] || {};
      // Merge statt Replace: Teil-Updates (z.B. processedDreams,
      // processedEpisodes, lastProcessedMessageCount aus den fire-and-forget
      // Callbacks im agent_end) dürfen die Keys der jeweils anderen nicht
      // überschreiben. Sonst geht die High-Watermark / Idempotenz verloren.
      current[hookName] = {
        ...prev,
        count: Number(prev.count || 0) + 1,
        lastFiredAt: new Date().toISOString(),
        ...meta,
      };
      writeJsonAtomic(paths.hooks, current);
      return current[hookName];
    }),
  };
}

export function captureNeoFromAgentEnd(event, ctx, store, options = {}) {
  const workspaceKey = workspaceKeyFromContext(ctx, { ...options, event });
  const agentId = ctx?.agentId || "default";
  const sessionId = event?.sessionId || event?.sessionKey || event?.runId ||
    ctx?.sessionId || ctx?.sessionKey || ctx?.runId || "";
  const turns = turnEventsFromMessages(event?.messages || [], {
    workspaceKey,
    agentId,
    sessionId,
    createdAt: new Date().toISOString(),
  });
  const candidates = memoryCandidatesFromTurns(turns);
  const reactions = reactionSignalsFromTurns(turns);
  const behaviorCards = behaviorCardsFromReactions(reactions);
  const appendedTurns = store.appendTurns(turns);
  const appendedCandidates = store.appendCandidates(candidates);
  store.appendReactions(reactions);
  const appendedBehaviorCards = store.appendBehaviorCards(behaviorCards);
  const queueTurns = Array.isArray(appendedTurns) ? appendedTurns : turns;
  const queueCandidates = Array.isArray(appendedCandidates) ? appendedCandidates : candidates;
  const queueBehaviorCards = Array.isArray(appendedBehaviorCards) ? appendedBehaviorCards : behaviorCards;
  store.appendEmbeddingQueue([...queueTurns, ...queueCandidates, ...queueBehaviorCards]);
  return { turns, candidates, reactions, behaviorCards };
}

export function buildNeoDoctorReport(params = {}) {
  const hooks = params.hooks || {};
  const cfg = params.config || {};
  const now = Date.now();
  const checks = [];
  const hookCfg = cfg.hooks || {};
  checks.push(check("conversation_access", hookCfg.allowConversationAccess === true, "hooks.allowConversationAccess should be true for visible conversation capture."));
  checks.push(check("prompt_injection_allowed", hookCfg.allowPromptInjection !== false, "hooks.allowPromptInjection=false blocks before_prompt_build prompt context."));
  checks.push(check("agent_end_fired", Boolean(hooks.agent_end?.lastFiredAt), "agent_end has not fired in this workspace yet."));
  checks.push(check("before_prompt_build_fired", Boolean(hooks.before_prompt_build?.lastFiredAt), "before_prompt_build has not fired in this workspace yet."));
  for (const hookName of ["agent_end", "before_prompt_build"]) {
    const last = hooks[hookName]?.lastFiredAt ? new Date(hooks[hookName].lastFiredAt).getTime() : 0;
    if (last && now - last > 7 * 86_400_000) {
      checks.push(check(`${hookName}_freshness`, false, `${hookName} last fired more than 7 days ago.`));
    }
  }
  checks.push(check("no_host_cron_required", true, "PLUR1BUS neo runtime does not require root cron or hidden host crontab."));
  checks.push(check("augment_mode", cfg.mode !== "slot", "Default mode must remain augment so memory-core keeps the slot."));
  return {
    status: checks.every(c => c.ok) ? "ok" : "warning",
    generatedAt: new Date().toISOString(),
    checks,
  };
}

function check(id, ok, message) {
  return { id, ok: Boolean(ok), level: ok ? "ok" : "warn", message };
}

function normalizeStatement(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 4000);
}

function initialSalience(category, role) {
  if (role === "assistant") return 0.35;
  if (["architecture_decision", "technical_constraint", "workspace_rule", "user_preference"].includes(category)) return 0.8;
  if (["bug", "failure", "test_result"].includes(category)) return 0.7;
  return 0.55;
}

function classifyReaction(text) {
  const lower = String(text || "").toLowerCase();
  if (/\b(no|nein|wrong|falsch|nicht so|korrig|correction|aber)\b/.test(lower)) return { targetType: "behavior", polarity: -1, intensity: 0.9, confidence: 0.85, explicitness: "explicit_correction" };
  if (/\b(ja|yes|genau|richtig|passt|confirmed|stimmt)\b/.test(lower)) return { targetType: "architecture_decision", polarity: 1, intensity: 0.65, confidence: 0.75, explicitness: "explicit_praise" };
  if (/\b(mach|do it|immer|always|niemals|never|soll|muss|must)\b/.test(lower)) return { targetType: "behavior", polarity: 1, intensity: 0.85, confidence: 0.8, explicitness: "explicit_instruction" };
  if (/\b(fehl|missing|gap|was ist mit|what about)\b/.test(lower)) return { targetType: "open_question", polarity: 0, intensity: 0.7, confidence: 0.65, explicitness: "ambiguous" };
  return null;
}

function inferBehaviorCategory(text) {
  const lower = String(text || "").toLowerCase();
  if (/style|ton|kurz|ausführlich|direct|direkt/.test(lower)) return "communication_style";
  if (/cron|shell|systemctl|execstartpre|patch|hook|tool/.test(lower)) return "tooling_constraints";
  if (/memory|recall|capture|workspace|scope|leak/.test(lower)) return "memory_policy";
  if (/architecture|architektur|slot|augment|core/.test(lower)) return "architecture_constraints";
  return "workflow_preference";
}

function normalizeBehaviorStatement(text) {
  return normalizeStatement(text).slice(0, 1000);
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function tokenizeForScore(text) {
  return new Set(String(text || "").toLowerCase().split(/[^a-z0-9äöüß_-]+/i).filter(t => t.length > 2));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) return NaN;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return NaN;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function laneMatchesCategory(lane, category) {
  const map = {
    workspace_facts: ["project_fact", "workspace_rule"],
    architecture_decisions: ["architecture_decision"],
    technical_constraints: ["technical_constraint"],
    tooling_constraints: ["tooling_constraint"],
    user_preferences: ["user_preference", "communication_style"],
    behavior_cards: ["behavior_feedback"],
    failures_and_corrections: ["failure", "bug", "assistant_mistake_candidate"],
    open_questions: ["open_question"],
    todos: ["todo"],
    shared_dreams: ["dream_synthesis"],
    code_context: ["code_context", "file_context"],
    knowledge_md: ["curation_note"],
  };
  return (map[lane] || []).includes(category);
}

// Obergrenze für JSONL-Stores: verhindert unbegrenztes Wachstum (Quelle der
// Performance-Eskalation 2026-05-29). Überschreitet eine Datei NEO_MAX_RECORDS,
// wird sie atomar auf den jüngsten Tail gekürzt. Per Env überschreibbar.
const NEO_MAX_RECORDS = Math.max(500, Number(process.env.PLUR1BUS_NEO_MAX_RECORDS) || 5000);
// Byte-Schwelle, ab der überhaupt ein Cap-Check (Zeilenzählung) lohnt. So wird
// nicht bei jedem Append die ganze Datei angefasst.
const NEO_CAP_CHECK_BYTES = Math.max(256 * 1024, Number(process.env.PLUR1BUS_NEO_CAP_CHECK_BYTES) || 2 * 1024 * 1024);
// Lokaler Replay-Dedupe liest nur den jüngsten Tail statt unbounded Stores zu scannen.
const NEO_APPEND_DEDUPE_TAIL_RECORDS = Math.max(100, Number(process.env.PLUR1BUS_NEO_APPEND_DEDUPE_TAIL_RECORDS) || NEO_MAX_RECORDS);

// Liest die letzten `limit` nicht-leeren Zeilen einer Datei, ohne die gesamte
// Datei in den Speicher zu laden. Liest rückwärts in Chunks ab Dateiende.
export function readJsonlTailLines(path, limit) {
  if (!existsSync(path) || limit <= 0) return [];
  const fd = openSync(path, "r");
  try {
    let pos = fstatSync(fd).size;
    if (pos === 0) return [];
    const chunkSize = 64 * 1024;
    const buf = Buffer.alloc(chunkSize);
    // Collect raw byte chunks (back-to-front) and decode ONCE at the end. Decoding
    // each chunk independently corrupts multibyte UTF-8 chars that straddle a chunk
    // boundary (lead + continuation bytes land in separate toString calls → U+FFFD).
    const chunks = [];
    let newlineCount = 0;
    // +1 Newline, damit eine evtl. angeschnittene erste Zeile verworfen werden kann
    while (pos > 0 && newlineCount <= limit) {
      const readLen = Math.min(chunkSize, pos);
      pos -= readLen;
      const bytes = readSync(fd, buf, 0, readLen, pos);
      // Copy: buf is reused on the next iteration.
      chunks.unshift(Buffer.from(buf.subarray(0, bytes)));
      // Newline (0x0A) is ASCII and can never be a UTF-8 continuation byte, so
      // counting raw newline bytes is safe without decoding.
      for (let i = 0; i < bytes; i++) if (buf[i] === 0x0a) newlineCount++;
    }
    const tail = Buffer.concat(chunks).toString("utf8");
    const lines = tail.split("\n").filter(Boolean);
    return lines.slice(-limit);
  } finally {
    closeSync(fd);
  }
}

// Kürzt eine JSONL-Datei atomar auf die jüngsten `maxRecords` Zeilen.
function capJsonl(path, maxRecords) {
  const lines = readJsonlTailLines(path, maxRecords);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, lines.length ? lines.join("\n") + "\n" : "", "utf8");
  renameSync(tmp, path);
}

function appendJsonl(path, items) {
  const list = Array.isArray(items) ? items : [items];
  if (list.length === 0) return [];
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, list.map(item => JSON.stringify(item)).join("\n") + "\n", "utf8");
  // Bounded growth: erst Größe prüfen (billig), dann ggf. cappen.
  try {
    if (statSync(path).size > NEO_CAP_CHECK_BYTES) {
      const recent = readJsonlTailLines(path, NEO_MAX_RECORDS + 1);
      if (recent.length > NEO_MAX_RECORDS) capJsonl(path, NEO_MAX_RECORDS);
    }
  } catch (_) { /* Cap ist best-effort, niemals den Append fehlschlagen lassen */ }
  return list;
}

function appendDedupeId(record) {
  if (!record || typeof record !== "object" || !record.id) return "";
  if (record.updatedAt || record.embeddingUpdatedAt) return "";
  return String(record.id);
}

function recordStatusTransitionDedupeKey(record) {
  if (!record || typeof record !== "object" || !record.id || !record.updatedAt) return "";
  const status = normalizeNeoStatus(record.status, "");
  if (!status || status === "candidate") return "";
  return `status:${record.id}:${status}:${record.updatedAt}`;
}

function recordPruneDedupeKey(record) {
  return recordStatusTransitionDedupeKey(record) || recordDedupKey(record);
}

function appendCandidateContentDedupeKey(record) {
  if (!record || typeof record !== "object") return "";
  const statusKey = recordStatusTransitionDedupeKey(record);
  if (statusKey) return statusKey;
  const key = recordDedupKey(record);
  if (!key) return appendDedupeId(record);
  return `content:${stableHash("candidate-content", key)}`;
}

function appendJsonlDedupe(path, items, options = {}) {
  const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
  if (list.length === 0) return [];
  const dedupeKey = typeof options.dedupeKey === "function" ? options.dedupeKey : appendDedupeId;
  const indexPath = options.indexPath || "";
  const bucket = options.bucket || "";
  const seen = new Set();
  let index = null;
  let indexChanged = false;

  if (indexPath && bucket) {
    index = readRecordIndex(indexPath);
    indexChanged = hydrateRecordIndexBucket(index, bucket, path, dedupeKey);
    for (const id of index.ids[bucket] || []) seen.add(id);
  } else {
    const tailLimit = Number.isFinite(options.tailRecords) ? options.tailRecords : NEO_APPEND_DEDUPE_TAIL_RECORDS;
    for (const record of readJsonlTail(path, tailLimit)) {
      const id = dedupeKey(record);
      if (id) seen.add(id);
    }
  }

  const appendable = [];
  for (const item of list) {
    const id = dedupeKey(item);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    appendable.push(item);
  }
  appendJsonl(path, appendable);
  if (index && bucket && appendable.length > 0) {
    index.ids[bucket] = [...seen];
    indexChanged = true;
  }
  if (index && indexChanged) writeRecordIndex(indexPath, index);
  return appendable;
}

function appendEmbeddingQueueDedupe(path, items, options = {}) {
  const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
  if (list.length === 0) return [];
  const indexPath = options.indexPath || "";
  const index = indexPath ? readRecordIndex(indexPath) : null;
  let indexChanged = index ? hydrateEmbeddingQueueIndex(index, path) : false;
  const statuses = index?.embeddingQueue?.statuses || {};

  const appendable = [];
  for (const item of list) {
    const key = embeddingQueueStateKey(item);
    if (key && statuses[key] === "pending") continue;
    if (key) {
      statuses[key] = item.status || "pending";
      indexChanged = true;
    }
    appendable.push(item);
  }
  appendJsonl(path, appendable);
  if (index && indexChanged) writeRecordIndex(indexPath, index);
  return appendable;
}

function readJsonlTail(path, limit) {
  return readJsonlTailLines(path, limit).map(line => {
    try { return JSON.parse(line); } catch (_) { return null; }
  }).filter(Boolean);
}

// Every Neo record constructor sets `createdAt` (ISO string) — createTurnEvent,
// memoryCandidatesFromTurns, behaviorCardsFromReactions, createEpisode,
// light-dream/rem-dream, createEdge, and the rem-dream pattern writer all do.
// Episodes additionally carry `startTime` (when the episode itself happened,
// as opposed to createdAt = when the episode record was written, which can
// lag behind during a later consolidation pass) — prefer it when present,
// mirroring the existing precedent in lib/episodes.js calculateVividness()
// ("Use startTime, then createdAt ... never Date.now()").
function recordTimeMs(record) {
  const raw = record?.startTime ?? record?.createdAt;
  if (raw == null) return NaN;
  const t = typeof raw === "number" ? raw : new Date(raw).getTime();
  return Number.isFinite(t) ? t : NaN;
}

// Stable comparator for merge-sorting Neo records ascending by time. Records
// with no usable time field are NOT dropped or randomly ordered — they sort
// before every dated record, and ties (including NaN-vs-NaN) fall back to
// Array.prototype.sort's guaranteed stability, i.e. original read order.
function compareRecordTime(a, b) {
  const ta = recordTimeMs(a);
  const tb = recordTimeMs(b);
  const aFinite = Number.isFinite(ta);
  const bFinite = Number.isFinite(tb);
  if (!aFinite && !bFinite) return 0;
  if (!aFinite) return -1;
  if (!bFinite) return 1;
  return ta - tb;
}

// Merges two record lists (canonical + legacy) deduped by `id`, canonical
// wins on collision. Records without an `id` can't be deduped and are kept
// as-is (no data loss). Returns the merge sorted ascending by time — callers
// slice(-limit) for "most recent N".
function mergeNeoRecordsById(canonical, legacy) {
  if (!legacy || legacy.length === 0) return [...canonical].sort(compareRecordTime);
  const byId = new Map();
  const unidentified = [];
  // Legacy inserted first, canonical second, so a same-id canonical record
  // overwrites its legacy counterpart in the Map (canonical wins).
  for (const record of legacy) {
    const id = record?.id ? String(record.id) : "";
    if (id) byId.set(id, record); else unidentified.push(record);
  }
  for (const record of canonical) {
    const id = record?.id ? String(record.id) : "";
    if (id) byId.set(id, record); else unidentified.push(record);
  }
  return [...byId.values(), ...unidentified].sort(compareRecordTime);
}

function readJsonlAll(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch (err) { return { __parseError: String(err?.message || err), __raw: line }; }
    });
}

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, path);
}

function normalizeRecordIndex(raw = {}) {
  const ids = raw && typeof raw.ids === "object" && raw.ids ? raw.ids : {};
  const normalizedIds = {};
  for (const bucket of ["turns", "candidates", "candidateContent", "reactions", "behavior"]) {
    normalizedIds[bucket] = Array.isArray(ids[bucket]) ? [...new Set(ids[bucket].map(String).filter(Boolean))] : [];
  }
  const queue = raw && typeof raw.embeddingQueue === "object" && raw.embeddingQueue ? raw.embeddingQueue : {};
  const statuses = queue.statuses && typeof queue.statuses === "object" ? queue.statuses : {};
  return {
    version: 1,
    ids: normalizedIds,
    embeddingQueue: {
      statuses: Object.fromEntries(
        Object.entries(statuses)
          .filter(([key, value]) => key && typeof value === "string")
          .map(([key, value]) => [String(key), value]),
      ),
    },
  };
}

function readRecordIndex(indexPath) {
  return normalizeRecordIndex(readJson(indexPath, {}));
}

function writeRecordIndex(indexPath, index) {
  writeJsonAtomic(indexPath, normalizeRecordIndex(index));
}

function hydrateRecordIndexBucket(index, bucket, jsonlPath, dedupeKey = appendDedupeId) {
  if (!index?.ids?.[bucket] || index.ids[bucket].length > 0 || !existsSync(jsonlPath)) return false;
  const seen = new Set();
  for (const record of readJsonlAll(jsonlPath)) {
    const id = dedupeKey(record);
    if (id) seen.add(id);
  }
  index.ids[bucket] = [...seen];
  return seen.size > 0;
}

function hydrateEmbeddingQueueIndex(index, queuePath) {
  const statuses = index?.embeddingQueue?.statuses || {};
  if (Object.keys(statuses).length > 0 || !existsSync(queuePath)) return false;
  for (const record of readJsonlAll(queuePath)) {
    const key = embeddingQueueStateKey(record);
    if (key && record.status) statuses[key] = record.status;
  }
  index.embeddingQueue.statuses = statuses;
  return Object.keys(statuses).length > 0;
}

function inferEmbeddingTargetType(item) {
  if (item.sourceSignals) return "behavior";
  if (item.sourceTurnIds && item.statement) return "memory";
  if (item.role) return "turn";
  return "unknown";
}

function inferEmbeddingImpact(item = {}) {
  const raw = String(item.impact || item.risk || item.priority || "").toLowerCase();
  if (["critical", "high", "medium", "low"].includes(raw)) return raw;
  // Legacy queue entries did not persist impact. These are Neo shadow records,
  // so the safe default for automatic bookkeeping is low-impact.
  return "low";
}

function targetPathForEmbedding(paths, targetType) {
  if (targetType === "memory") return paths.candidates;
  if (targetType === "behavior") return paths.behavior;
  if (targetType === "turn") return paths.turns;
  return "";
}

function latestRecordById(path) {
  const records = readJsonlAll(path).filter(record => record && !record.__parseError && record.id);
  const byId = new Map();
  for (const record of records) byId.set(record.id, record);
  return byId;
}

function createEmbeddingTargetState(paths) {
  return {
    memory: { path: paths.candidates, byId: latestRecordById(paths.candidates), updates: [] },
    behavior: { path: paths.behavior, byId: latestRecordById(paths.behavior), updates: [] },
    turn: { path: paths.turns, byId: latestRecordById(paths.turns), updates: [] },
  };
}

function validEmbedding(vector, dimensions) {
  if (!Array.isArray(vector) || vector.length === 0) return false;
  if (Number.isFinite(dimensions) && vector.length !== dimensions) return false;
  return vector.every(value => Number.isFinite(value));
}

async function markEmbeddingTargetFresh(paths, queueItem, nowIsoStr, targetState = null, options = {}) {
  const targetPath = targetPathForEmbedding(paths, queueItem.targetType);
  if (!targetPath || !queueItem.targetId) return { ok: false, reason: "unsupported_target" };

  const state = targetState?.[queueItem.targetType] || null;
  const target = state ? state.byId.get(queueItem.targetId) : latestRecordById(targetPath).get(queueItem.targetId);
  if (!target) return { ok: false, reason: "missing_target" };
  if (typeof options.embedder !== "function") return { ok: false, reason: "embedder_unavailable", deferred: true };
  let embedding;
  try {
    embedding = await options.embedder(target.statement || target.content || "", target);
  } catch (error) {
    return { ok: false, reason: `embedder_failed:${error?.message || String(error)}`, deferred: true };
  }
  if (!validEmbedding(embedding, options.dimensions)) return { ok: false, reason: "invalid_embedding", deferred: true };

  const updated = {
    ...target,
    embedding: [...embedding],
    embeddingStatus: "fresh",
    embeddingImpact: inferEmbeddingImpact(queueItem),
    embeddingUpdatedAt: nowIsoStr,
  };
  if (state) {
    state.updates.push(updated);
    state.byId.set(updated.id, updated);
  } else {
    appendJsonl(targetPath, [updated]);
  }
  return { ok: true };
}

function flushEmbeddingTargetUpdates(targetState) {
  for (const state of Object.values(targetState || {})) {
    if (state.updates.length > 0) appendJsonl(state.path, state.updates);
  }
}

function embeddingQueueItemMatches(item, options = {}) {
  if (!item || item.__parseError) return false;
  if (item.status && item.status !== "pending" && !(item.status === "deferred" && typeof options.embedder === "function")) return false;
  const requestedImpact = options.impact ? String(options.impact).toLowerCase() : "low";
  if (requestedImpact !== "all" && inferEmbeddingImpact(item) !== requestedImpact) return false;
  return true;
}

function embeddingQueueStateKey(item) {
  if (!item || item.__parseError) return "";
  if (item.id) return String(item.id);
  if (!item.targetId || !item.targetType) return "";
  return stableId("embq", item.targetType, item.targetId, inferEmbeddingImpact(item));
}

function latestEmbeddingQueueEntries(queue = [], onParseError = () => {}) {
  const byKey = new Map();
  queue.forEach((item, index) => {
    if (item?.__parseError) {
      onParseError(item);
      return;
    }
    const key = embeddingQueueStateKey(item);
    if (!key) return;
    byKey.set(key, { key, item, index });
  });
  return [...byKey.values()].sort((a, b) => a.index - b.index);
}

async function drainEmbeddingQueueFile(paths, options = {}) {
  const nowIsoStr = (options.now ? new Date(options.now) : new Date()).toISOString();
  const maxItems = Math.max(1, Number(options.maxItems || 100));
  const queue = readJsonlAll(paths.embeddings);
  const targetState = createEmbeddingTargetState(paths);
  let processed = 0;
  let missingTargets = 0;
  let deferred = 0;
  let parseErrors = 0;
  const latestEntries = latestEmbeddingQueueEntries(queue, () => { parseErrors++; });
  const latestByKey = new Map(latestEntries.map(entry => [entry.key, entry.item]));
  const queueUpdates = [];

  for (const { key, item } of latestEntries) {
    if (processed >= maxItems || !embeddingQueueItemMatches(item, options)) continue;

    const target = await markEmbeddingTargetFresh(paths, item, nowIsoStr, targetState, options);
    if (!target.ok) {
      if (target.deferred) deferred++;
      else missingTargets++;
      const skipped = {
        ...item,
        impact: inferEmbeddingImpact(item),
        status: target.deferred ? "deferred" : "skipped",
        processedAt: nowIsoStr,
        reason: target.reason,
      };
      latestByKey.set(key, skipped);
      queueUpdates.push(skipped);
      continue;
    }

    processed++;
    const done = {
      ...item,
      impact: inferEmbeddingImpact(item),
      status: "done",
      processedAt: nowIsoStr,
      reason: "low_impact_auto_processed",
    };
    latestByKey.set(key, done);
    queueUpdates.push(done);
  }

  if (processed > 0 || missingTargets > 0 || deferred > 0 || parseErrors > 0) {
    flushEmbeddingTargetUpdates(targetState);
    if (queueUpdates.length > 0) {
      appendJsonl(paths.embeddings, queueUpdates);
      const index = readRecordIndex(paths.index);
      hydrateEmbeddingQueueIndex(index, paths.embeddings);
      for (const update of queueUpdates) {
        const key = embeddingQueueStateKey(update);
        if (key && update.status) index.embeddingQueue.statuses[key] = update.status;
      }
      writeRecordIndex(paths.index, index);
    }
  }

  const pending = [...latestByKey.values()].filter(item => item && item.status === "pending").length;
  return {
    processed,
    pending,
    skipped: missingTargets,
    deferred,
    parseErrors,
    queuePath: paths.embeddings,
  };
}

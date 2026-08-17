#!/usr/bin/env node
/**
 * auto-capture-lancedb.mjs — Cron-basierter Auto-Capture für memory-lancedb-namespaced
 * Liest die neuesten Session-Nachrichten der drei Hauptagenten und speichert sie in LanceDB.
 *
 * Cron: alle 5 Minuten
 * Usage: OPENAI_API_KEY=... node auto-capture-lancedb.mjs
 *
 * v2.2.0: Gruppen-Erkennung + Sender-Attribution + saubere Textextraktion
 */

import {
  closeSync,
  createReadStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { resolveInside, safeAgentId, safeUuid, sqlString } from "../lib/sql-safety.js";
import { decideEpistemicStatusForCapture } from "../lib/epistemic-capture.js";
import { readEpistemicCutoff } from "../lib/epistemic-cutoff.js";
import { assertCardWriteAllowed } from "../lib/tombstone-write-guard.js";

// ─── Config ─────────────────────────────────────────────────────────────────
// Operator-local fallback agents. Keep personal IDs out of the public repo.
// Override with PLUR1BUS_AGENTS env var, e.g. PLUR1BUS_AGENTS='main,agent-a,agent-b'
const FALLBACK_AGENTS = (process.env.PLUR1BUS_AGENTS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const HOME = homedir();
const BASE = join(HOME, ".openclaw");
const CONFIG_PATH = join(BASE, "openclaw.json");
const AGENTS_DIR = join(BASE, "agents");
const STATE_DIR = join(BASE, ".auto-capture-state");
const BASE_DB_PATH = join(BASE, "memory", "lancedb-namespaced");
const MAX_TEXT_LEN = 15000;
const DUPLICATE_THRESHOLD = 0.95;
const SUMMARY_MAX_WORDS = 150;
const MIN_TEXT_LEN = 10;
const CHECKPOINT_FINGERPRINT_WINDOW = 2048;
const CHECKPOINT_STATE_VERSION = 2;
const PLUGIN_DIR = process.env.PLUR1BUS_PLUGIN_DIR || join(BASE, "extensions", "memory-lancedb-namespaced");

let distanceToScore;
let categorizeMemory;

// ─── Injected-Context-Filter (verhindert Re-Capture von PLUR1BUS-Blöcken) ───
const INJECTED_CONTEXT_RE = /<\/?plur1bus-recall|<\/?plur1bus-start-notice|PLUR1BUS — Make your agent yours|<\/?relevant-memories|<\/?knowledge-update-reminder|<\/?adaptive-learning|RECALL SAFETY RULES|capturedBy"\s*:\s*"agent_end_capture|embeddingStatus"\s*:\s*"pending|plur1bus internal classify-recent|critical-memory-classifier|TTS-STATUS|\[cron:|heartbeat_ok|Reference UTC:|Current time:|You are a memory search agent|memory search agent\. Another model|bounded search query|Use only the available memory tools|Conversation info \(untrusted metadata\)|"chat_id"\s*:\s*"telegram:|"message_id"\s*:\s*"|"sender_id"\s*:/i;

function isInjectedContextText(text) {
  if (!text || typeof text !== "string") return false;
  return INJECTED_CONTEXT_RE.test(text);
}

export function readPluginConfig(configPath = CONFIG_PATH) {
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    return cfg?.plugins?.entries?.["memory-lancedb-namespaced"]?.config || {};
  } catch (_) {}
  return {};
}

// ─── Agent Discovery ─────────────────────────────────────────────────────────
function discoverAgents() {
  if (!existsSync(CONFIG_PATH)) {
    console.log("[discovery] openclaw.json not found — using fallback");
    return FALLBACK_AGENTS;
  }
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const list = cfg?.agents?.list;
    if (!Array.isArray(list) || list.length === 0) {
      console.log("[discovery] agents.list empty — using fallback");
      return FALLBACK_AGENTS;
    }
    const ids = list.map(e => e?.id).filter(Boolean);
    return ids.length > 0 ? ids : FALLBACK_AGENTS;
  } catch (e) {
    console.warn(`[discovery] parse failed: ${e.message} — using fallback`);
    return FALLBACK_AGENTS;
  }
}

// ─── Plugin module imports ───────────────────────────────────────────────────
let lancedb;

function importLocalModule(filePath) {
  return import(pathToFileURL(filePath).href);
}

async function importFirstExisting(paths, label) {
  for (const filePath of paths) {
    if (!existsSync(filePath)) continue;
    try {
      return await importLocalModule(filePath);
    } catch (err) {
      console.warn(`[init] ${label} import failed at ${filePath}: ${err.message}`);
    }
  }
  try {
    return await import(label);
  } catch (err) {
    throw new Error(`Unable to import ${label}; set PLUR1BUS_PLUGIN_DIR to the installed plugin directory. (${err.message})`);
  }
}

export async function loadPluginModules(pluginDir = PLUGIN_DIR) {
  const lancedbCandidatePaths = [
    join(pluginDir, "node_modules", "@lancedb", "lancedb", "dist", "index.js"),
    join(pluginDir, "..", "memory-lancedb-stock", "node_modules", "@lancedb", "lancedb", "dist", "index.js"),
  ];
  const [factoryMod, normalizeMod, scoreMod, categorizeMod, lanceMod] = await Promise.all([
    importLocalModule(join(pluginDir, "lib", "providers", "factory.js")),
    importLocalModule(join(pluginDir, "lib", "providers", "config-normalize.js")),
    importLocalModule(join(pluginDir, "lib", "score.js")),
    importLocalModule(join(pluginDir, "lib", "categorize.js")),
    importFirstExisting(lancedbCandidatePaths, "@lancedb/lancedb"),
  ]);
  return {
    createEmbeddingProvider: factoryMod.createEmbeddingProvider,
    normalizeEmbeddingConfig: normalizeMod.normalizeEmbeddingConfig,
    distanceToScore: scoreMod.distanceToScore,
    categorizeMemory: categorizeMod.categorizeMemory,
    lancedb: lanceMod,
  };
}

async function init(pluginDir = PLUGIN_DIR) {
  const modules = await loadPluginModules(pluginDir);
  lancedb = modules.lancedb;
  distanceToScore = modules.distanceToScore;
  categorizeMemory = modules.categorizeMemory;
  return modules;
}

// ─── Embedding ───────────────────────────────────────────────────────────────
export function buildEmbeddingConfig(pluginConfig = {}, env = process.env) {
  const raw = { ...(pluginConfig.embedding || {}) };
  if (env.EMBEDDING_MODEL) {
    raw.model = env.EMBEDDING_MODEL;
    if (raw.provider === "local-transformers") {
      raw.local = { ...(raw.local || {}), model: env.EMBEDDING_MODEL };
    }
  }
  if (raw.provider !== "local-transformers" && !raw.apiKey && !raw.apiKeyEnv) {
    raw.apiKeyEnv = "OPENAI_API_KEY";
  }
  return raw;
}

export function createEmbeddings(modules, pluginConfig = readPluginConfig()) {
  const embeddingConfig = modules.normalizeEmbeddingConfig(buildEmbeddingConfig(pluginConfig));
  const provider = modules.createEmbeddingProvider(embeddingConfig);
  const dim = Number(provider.dimensions?.() || embeddingConfig.dimensions || 3072);
  return {
    dim,
    provider,
    async embedBatch(texts, options = {}) {
      const input = (Array.isArray(texts) ? texts : [texts]).map((text) => String(text).slice(0, 8000));
      return provider.embedBatch(input, 3, options);
    },
    async embed(text, options = {}) {
      const [vector] = await this.embedBatch([text], options);
      return vector;
    },
  };
}

// ─── LanceDB ─────────────────────────────────────────────────────────────────
async function getOrCreateTable(dbPath, dim) {
  const db = await lancedb.connect(dbPath);
  const tables = await db.tableNames();
  if (tables.includes("memories")) {
    const tbl = await db.openTable("memories");
    try {
      const schema = await tbl.schema();
      const fields = schema.fields.map(f => f.name);
      const newCols = [
        ["sourceTurnId", "''"],
        ["sourceMessageRole", "''"],
        ["sourceTimestamp", "0"],
        ["sourceUrl", "''"],
        ["evidenceQuote", "''"],
        ["scope", "'agent-private'"],
        ["workspaceKey", "''"],
      ];
      for (const [name, sql] of newCols) {
        if (!fields.includes(name)) {
          try { await tbl.addColumns([{ name, valueSql: sql }]); } catch (_) {}
        }
      }
    } catch (_) {}
    return tbl;
  }
  return db.createTable("memories", [
    {
      id: "init",
      text: "",
      summary: "",
      origin: "system",
      vector: new Array(dim).fill(0),
      importance: 0,
      category: "system",
      createdAt: Date.now(),
      mergedFrom: "[]",
      expiresAt: 0,
      storedBy: "system",
      sourceTurnId: "",
      sourceMessageRole: "",
      sourceTimestamp: 0,
      sourceUrl: "",
      evidenceQuote: "",
      scope: "agent-private",
      workspaceKey: "",
    },
  ]);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateSummary(text, maxWords) {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  return words.slice(0, maxWords).join(" ") + (words.length > maxWords ? "..." : "");
}

// Extrahiert den eigentlichen User-Text nach allen injizierten Kontext-Blöcken.
// Injizierte Blöcke enden immer mit einem ``` (JSON-Code-Block) gefolgt vom echten Text.
function extractCleanUserText(rawText) {
  // Versuche nach bekannten End-Markern zu schneiden
  const endMarkers = [
    "</knowledge-update-reminder>",
    "</relevant-memories>",
    "</adaptive-learning>",
  ];
  for (const marker of endMarkers) {
    const idx = rawText.lastIndexOf(marker);
    if (idx === -1) continue;
    let rest = rawText.slice(idx + marker.length).trim();
    // Noch vorhandene JSON-Blöcke (Conversation info, Sender) wegschneiden
    rest = rest.replace(/^[\s\S]*?```\s*\n\}\s*\n```\s*/g, "").trim();
    // Einzelne übriggebliebene Code-Blöcke entfernen
    rest = rest.replace(/```json[\s\S]*?```/g, "").trim();
    if (rest.length >= 3) return rest;
  }
  // Fallback: letzter Code-Block-Rest
  const parts = rawText.split("```");
  if (parts.length > 1) {
    const afterLast = parts[parts.length - 1].trim();
    if (afterLast.length >= 3) return afterLast;
  }
  return rawText.trim();
}

// Liest ALLE Messages einer Session (inkl. role="" Metadaten) und extrahiert:
// - isGroup: ob es eine Telegram-Gruppen-Session ist
// - groupSubject: Name der Gruppe
// - senderByPosition: Map von Nachrichten-Index zu Sender-Name
function parseSessionContext(messages) {
  let isGroup = false;
  let groupSubject = "";
  const senderByPosition = new Map(); // index der nächsten user-Nachricht → sender

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const m = msg.message || msg;
    const role = m.role;
    const content = m.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content.filter(c => c.type === "text").map(c => c.text).join("\n");
    }

    if (!text) continue;

    // Gruppen-Erkennung aus Metadaten-Einträgen (role="" oder role="user" mit inline-Kontext)
    if (/"is_group_chat"\s*:\s*true/.test(text)) isGroup = true;
    const subjMatch = text.match(/"group_subject"\s*:\s*"([^"]+)"/);
    if (subjMatch) groupSubject = subjMatch[1];

    // Sender-Info aus Metadaten extrahieren und der nächsten user-Nachricht zuordnen
    if (role === "" || role === undefined || role === null) {
      const senderMatch = text.match(/"name"\s*:\s*"([^"]+)"/);
      const usernameMatch = text.match(/"username"\s*:\s*"([^"]+)"/);
      if (senderMatch || usernameMatch) {
        // Finde die nächste user-Nachricht nach diesem Metadaten-Eintrag
        for (let j = i + 1; j < messages.length; j++) {
          const nextMsg = messages[j].message || messages[j];
          if (nextMsg.role === "user") {
            const name = senderMatch?.[1] || "";
            const username = usernameMatch?.[1] || "";
            senderByPosition.set(j, { name, username });
            break;
          }
        }
      }
    }

    // Inline-Sender aus user-Nachrichten (wenn Kontext drin steckt)
    if (role === "user") {
      const inlineSender = text.match(/"sender"\s*:\s*"([^"]+)"/);
      const inlineUsername = text.match(/"username"\s*:\s*"([^"]+)"/);
      if ((inlineSender || inlineUsername) && !senderByPosition.has(i)) {
        senderByPosition.set(i, {
          name: inlineSender?.[1] || "",
          username: inlineUsername?.[1] || "",
        });
      }
    }
  }

  return { isGroup, groupSubject, senderByPosition };
}

// Extrahiert Text-Items aus Messages — mit optionalem Gruppen-Kontext.
function extractTexts(messages, sessionCtx = null) {
  const items = [];
  const urlPattern = /https?:\/\/[^\s]{10,}/;
  const { isGroup = false, groupSubject = "", senderByPosition = new Map() } = sessionCtx || {};

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const m = msg.message || msg;
    const role = m.role;
    if (role !== "user" && role !== "assistant") continue;

    const content = m.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content.filter(c => c.type === "text").map(c => c.text).join("\n");
    }

    if (!text.trim()) continue;

    // Injizierte Kontextblöcke filtern — aber nur wenn der Text AUSSCHLIESSLICH Injektionen ist.
    // Wenn es ein Gruppen-User-Message ist, erst den echten Text extrahieren.
    let cleanedText = text.trim();
    if (role === "user" && isInjectedContextText(cleanedText)) {
      // Versuche den echten User-Text zu retten
      cleanedText = extractCleanUserText(cleanedText);
      if (isInjectedContextText(cleanedText) || cleanedText.length < MIN_TEXT_LEN) continue;
    }

    if (cleanedText.length < MIN_TEXT_LEN) continue;

    // Sender-Attribution für Gruppen-User-Nachrichten
    let prefix = role === "user" ? "User: " : "Assistant: ";
    let senderLabel = "";
    if (isGroup && role === "user") {
      const senderInfo = senderByPosition.get(i);
      if (senderInfo?.name || senderInfo?.username) {
        const name = senderInfo.name || senderInfo.username;
        const uname = senderInfo.username ? ` (@${senderInfo.username})` : "";
        senderLabel = `${name}${uname}`;
        prefix = `[Gruppe${groupSubject ? `: ${groupSubject}` : ""}] ${name}${uname}: `;
      } else if (groupSubject) {
        prefix = `[Gruppe: ${groupSubject}] User: `;
      } else {
        prefix = "[Gruppe] User: ";
      }
    }

    const urlMatch = role === "user" ? cleanedText.match(urlPattern) : null;
    items.push({
      text: prefix + cleanedText,
      rawText: cleanedText,
      role,
      senderLabel,
      isGroup,
      sourceTurnId: msg.id || msg.parentId || msg.runId || "",
      sourceTimestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : (msg.createdAt || 0),
      sourceUrl: urlMatch ? urlMatch[0].slice(0, 500) : "",
      _sourceMessage: msg,
    });
  }
  return items;
}

// ─── State tracking ───────────────────────────────────────────────────────────
function getStateFile(agentId) {
  mkdirSync(STATE_DIR, { recursive: true });
  return resolveInside(STATE_DIR, `${safeAgentId(agentId)}.json`);
}

function loadState(agentId) {
  const f = getStateFile(agentId);
  if (!existsSync(f)) return { files: {} };
  try {
    const raw = JSON.parse(readFileSync(f, "utf8"));
    if (raw.files) return raw;
    if (raw.lastFile && typeof raw.lastSize === "number") {
      return { files: { [raw.lastFile]: raw.lastSize } };
    }
    return { files: {} };
  } catch (err) {
    console.warn(`[${agentId}] auto-capture state could not be loaded: ${err.message}`);
    return { files: {} };
  }
}

function saveState(agentId, state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const stateFile = getStateFile(agentId);
  const tempFile = resolveInside(STATE_DIR, `${safeAgentId(agentId)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempFile, JSON.stringify({ version: CHECKPOINT_STATE_VERSION, ...state }), "utf8");
    renameSync(tempFile, stateFile);
  } catch (err) {
    if (existsSync(tempFile)) {
      try {
        unlinkSync(tempFile);
      } catch (cleanupErr) {
        console.warn(`[${agentId}] auto-capture state temp cleanup failed: ${cleanupErr.message}`);
      }
    }
    throw err;
  }
}

function normalizeFileCheckpoint(value) {
  if (typeof value === "number") {
    return { offset: Math.max(0, Number(value) || 0), identity: "", fingerprint: "" };
  }
  if (!value || typeof value !== "object") {
    return { offset: 0, identity: "", fingerprint: "" };
  }
  return {
    offset: Math.max(0, Number(value.offset) || 0),
    identity: typeof value.identity === "string" ? value.identity : "",
    fingerprint: typeof value.fingerprint === "string" ? value.fingerprint : "",
  };
}

function getFileIdentity(stats) {
  const device = Number(stats.dev || 0);
  const inode = Number(stats.ino || 0);
  if (device !== 0 || inode !== 0) return `${device}:${inode}`;
  return `birth:${Math.trunc(Number(stats.birthtimeMs || 0))}`;
}

function readFingerprintChunk(fd, start, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, buffer, read, length - read, start + read);
    if (count === 0) break;
    read += count;
  }
  return buffer.subarray(0, read);
}

function createCheckpointFingerprintFromDescriptor(descriptor, fileSize, offset) {
  const safeOffset = Math.min(fileSize, Math.max(0, Number(offset) || 0));
  const hash = createHash("sha256").update(`plur1bus-auto-capture-v2:${safeOffset}:`);
  if (safeOffset === 0) return hash.digest("hex");

  const firstLength = Math.min(CHECKPOINT_FINGERPRINT_WINDOW, safeOffset);
  const tailStart = Math.max(firstLength, safeOffset - CHECKPOINT_FINGERPRINT_WINDOW);
  const tailLength = safeOffset - tailStart;
  hash.update(readFingerprintChunk(descriptor, 0, firstLength));
  if (tailLength > 0) {
    hash.update(`:${tailStart}:`);
    hash.update(readFingerprintChunk(descriptor, tailStart, tailLength));
  }
  return hash.digest("hex");
}

function deterministicCaptureId(agentId, item, trimmed) {
  const hex = createHash("sha256")
    .update(JSON.stringify([
      safeAgentId(agentId),
      item._sourceFile,
      item._fileIdentity,
      item._checkpointOffset,
      trimmed,
    ]))
    .digest("hex");
  return safeUuid(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`);
}

function isSessionFile(name) {
  if (!name.endsWith(".jsonl")) return false;
  if (name.includes(".trajectory.")) return false;
  if (name.includes(".checkpoint.")) return false;
  if (name.includes(".deleted.")) return false;
  return true;
}

/**
 * Read complete non-empty JSONL lines from a byte offset without loading the full file.
 * @param {string} filePath Session JSONL file path.
 * @param {number} offset Byte offset to start reading from.
 * @param {{ descriptor?: number }} options Optional caller-owned descriptor that binds reads to one open file.
 * @returns {Promise<{ lines: string[], records: Array<{line: string, endOffset: number}>, nextOffset: number }>} Complete lines, record boundaries, and the next safe byte offset.
 */
export async function readSessionLinesSinceOffset(filePath, offset = 0, options = {}) {
  const start = Math.max(0, Number(offset) || 0);
  const lines = [];
  const records = [];
  let nextOffset = start;
  let pending = "";

  await new Promise((resolve, reject) => {
    const descriptor = Number.isInteger(options.descriptor) ? options.descriptor : null;
    const stream = createReadStream(filePath, {
      start,
      encoding: "utf8",
      ...(descriptor == null ? {} : { fd: descriptor, autoClose: false }),
    });
    stream.on("data", (chunk) => {
      pending += chunk;
      const parts = pending.split("\n");
      pending = parts.pop() || "";
      for (const line of parts) {
        nextOffset += Buffer.byteLength(`${line}\n`, "utf8");
        records.push({ line, endOffset: nextOffset });
        if (line.trim().length > 0) lines.push(line);
      }
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  return { lines, records, nextOffset };
}

/**
 * Read complete non-empty JSONL lines from a byte offset.
 * @param {string} filePath Session JSONL file path.
 * @param {number} offset Byte offset to start reading from.
 * @returns {Promise<string[]>} Complete non-empty lines after the offset.
 */
export async function readLinesFromOffset(filePath, offset = 0) {
  const { lines } = await readSessionLinesSinceOffset(filePath, offset);
  return lines;
}

function resolveDistanceToScoreFn(options = {}) {
  return options.distanceToScoreFn || distanceToScore || ((distance) => 1 / (1 + (distance ?? 0)));
}

function isDuplicateDistance(distance, options = {}) {
  const threshold = Number.isFinite(options.duplicateThreshold) ? options.duplicateThreshold : DUPLICATE_THRESHOLD;
  const score = resolveDistanceToScoreFn(options)(distance);
  return Number.isFinite(score) && score >= threshold;
}

function squaredL2Distance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = Number(a[i]) - Number(b[i]);
    if (!Number.isFinite(diff)) return Infinity;
    sum += diff * diff;
  }
  return sum;
}

async function findExistingDuplicateIndexesFallback(table, vectors, options = {}) {
  const duplicates = new Set();
  for (let i = 0; i < vectors.length; i++) {
    try {
      const results = await table.search(vectors[i]).limit(1).toArray();
      if (results.length > 0 && results[0]._distance !== undefined && isDuplicateDistance(results[0]._distance, options)) {
        duplicates.add(i);
      }
    } catch (err) {
      options.onWarn?.(`fallback duplicate check failed for candidate ${i}: ${err.message}`);
      options.unresolvedIndexes?.add(i);
      duplicates.add(i);
    }
  }
  return duplicates;
}

/**
 * Find duplicate candidate indexes with one LanceDB multi-query ANN search when available.
 * @param {Object} table LanceDB table.
 * @param {number[][]} vectors Candidate vectors in candidate order.
 * @param {Object} options Duplicate threshold and scoring options.
 * @returns {Promise<Set<number>>} Candidate indexes that already exist in the table.
 */
export async function findExistingDuplicateIndexes(table, vectors, options = {}) {
  if (!table || !Array.isArray(vectors) || vectors.length === 0) return new Set();

  if (typeof table.query !== "function") {
    return findExistingDuplicateIndexesFallback(table, vectors, options);
  }

  try {
    let builder = table.query().nearestTo(vectors[0]);
    if (vectors.length > 1 && typeof builder.addQueryVector !== "function") {
      return findExistingDuplicateIndexesFallback(table, vectors, options);
    }
    for (const vector of vectors.slice(1)) {
      const next = builder.addQueryVector(vector);
      if (next != null) builder = next;
    }
    builder = builder.limit(1) || builder;
    const rows = await builder.toArray();
    const duplicates = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const index = Number.isInteger(row?.query_index)
        ? row.query_index
        : (vectors.length === 1 ? 0 : -1);
      if (index < 0 || index >= vectors.length) continue;
      if (row._distance !== undefined && isDuplicateDistance(row._distance, options)) {
        duplicates.add(index);
      }
    }
    return duplicates;
  } catch (err) {
    options.onWarn?.(`multi-query duplicate check failed, falling back to per-candidate search: ${err.message}`);
    return findExistingDuplicateIndexesFallback(table, vectors, options);
  }
}

function findInBatchDuplicateIndexes(prepared, options = {}) {
  const duplicates = new Set();
  for (let i = 0; i < prepared.length; i++) {
    if (duplicates.has(i)) continue;
    for (let j = i + 1; j < prepared.length; j++) {
      if (duplicates.has(j)) continue;
      const distance = squaredL2Distance(prepared[i]?.vector, prepared[j]?.vector);
      if (isDuplicateDistance(distance, options)) duplicates.add(j);
    }
  }
  return duplicates;
}

/**
 * Remove candidates that already exist in LanceDB or duplicate earlier candidates in the same batch.
 * @param {Object} table LanceDB table.
 * @param {Array<Object>} prepared Candidate entries with a vector property.
 * @param {Object} options Duplicate threshold and scoring options.
 * @returns {Promise<Array<Object>>} Candidates safe to store.
 */
export async function filterPreparedForStorageByBatchDedup(table, prepared, options = {}) {
  const vectorPrepared = (Array.isArray(prepared) ? prepared : []).filter((entry) => Array.isArray(entry?.vector));
  const existingDuplicates = await findExistingDuplicateIndexes(
    table,
    vectorPrepared.map((entry) => entry.vector),
    options,
  );
  const notExisting = vectorPrepared.filter((_, index) => !existingDuplicates.has(index));
  const inBatchDuplicates = findInBatchDuplicateIndexes(notExisting, options);
  return notExisting.filter((_, index) => !inBatchDuplicates.has(index));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function resolveCheckpointStart(agentId, file, checkpoint) {
  if (checkpoint.offset > file.size) {
    console.warn(`[${agentId}] session truncation detected for ${file.name}; restarting from byte zero`);
    return 0;
  }
  if (checkpoint.identity && checkpoint.identity !== file.identity) {
    console.warn(`[${agentId}] session rotation detected for ${file.name}; restarting from byte zero`);
    return 0;
  }
  if (checkpoint.fingerprint && checkpoint.offset > 0) {
    const currentFingerprint = createCheckpointFingerprintFromDescriptor(
      file.descriptor,
      file.size,
      checkpoint.offset,
    );
    if (currentFingerprint !== checkpoint.fingerprint) {
      console.warn(`[${agentId}] session fingerprint changed for ${file.name}; restarting from byte zero`);
      return 0;
    }
  }
  return checkpoint.offset;
}

function acknowledgedOffset(fileRun) {
  let offset = fileRun.startOffset;
  for (const record of fileRun.records) {
    if (!record.acknowledged) break;
    offset = record.endOffset;
  }
  return offset;
}

function checkpointEntriesEqual(left, right) {
  const normalized = normalizeFileCheckpoint(left);
  return normalized.offset === right.offset
    && normalized.identity === right.identity
    && normalized.fingerprint === right.fingerprint;
}

function persistAcknowledgedCheckpoints(agentId, stateFiles, fileRuns) {
  let changed = false;
  for (const fileRun of fileRuns) {
    if (fileRun.invalidated) continue;
    const offset = acknowledgedOffset(fileRun);
    let nextEntry;
    const descriptor = openSync(fileRun.path, "r");
    try {
      const latestStats = fstatSync(descriptor);
      const latestIdentity = getFileIdentity(latestStats);
      if (latestIdentity !== fileRun.identity || latestStats.size < offset) {
        console.warn(`[${agentId}] ${fileRun.name} changed during capture; deferring the new file to the next run`);
        fileRun.invalidated = true;
        nextEntry = {
          offset: 0,
          identity: latestIdentity,
          fingerprint: createCheckpointFingerprintFromDescriptor(descriptor, latestStats.size, 0),
        };
      } else {
        nextEntry = {
          offset,
          identity: fileRun.identity,
          fingerprint: createCheckpointFingerprintFromDescriptor(descriptor, latestStats.size, offset),
        };
      }
    } finally {
      closeSync(descriptor);
    }
    if (!checkpointEntriesEqual(stateFiles[fileRun.name], nextEntry)) {
      stateFiles[fileRun.name] = nextEntry;
      changed = true;
    }
  }
  if (changed) saveState(agentId, { files: stateFiles });
}

async function findDurableCaptureRow(table, expected) {
  const id = safeUuid(expected.id);
  const rows = await table.query().where(`id = ${sqlString(id)}`).limit(2).toArray();
  if (!Array.isArray(rows) || rows.length === 0) return false;
  if (rows.length !== 1) {
    throw new Error(`capture durability verification found ${rows.length} rows for ${id}`);
  }
  const row = rows[0];
  const durableVector = Array.from(row.vector || []);
  const expectedVector = Array.isArray(expected.vector) ? expected.vector : null;
  const vectorMatches = expectedVector
    ? durableVector.length === expectedVector.length
      && durableVector.every((value, index) => Number.isFinite(Number(value))
        && Math.abs(Number(value) - Number(expectedVector[index])) <= 1e-6)
    : durableVector.length === Number(expected.dim)
      && durableVector.every((value) => Number.isFinite(Number(value)));
  if (row.id !== id
    || row.text !== expected.text
    || row.storedBy !== expected.storedBy
    || !vectorMatches
    || (row.status !== undefined && row.status !== "active")) {
    throw new Error(`capture durability verification mismatch for ${id}`);
  }
  return true;
}

function buildCaptureRow(agentId, entry, captureTimestamp) {
  const { it, trimmed, vector, id } = entry;
  const origin = it._isGroup ? "group" : "dm";
  const evidenceBase = (it.rawText || "").slice(0, 180);
  const evidenceQuote = it.senderLabel
    ? `[${it.senderLabel}] ${evidenceBase}`.slice(0, 200)
    : evidenceBase;

  return {
    id,
    text: trimmed,
    summary: generateSummary(trimmed, SUMMARY_MAX_WORDS),
    origin,
    vector,
    importance: 0.7,
    category: categorizeMemory(trimmed),
    createdAt: captureTimestamp,
    mergedFrom: "[]",
    expiresAt: 0,
    storedBy: agentId,
    sourceTurnId: it.sourceTurnId || "",
    sourceMessageRole: it.role || "",
    epistemicStatus: decideEpistemicStatusForCapture({
      text: trimmed,
      sourceMessageRole: it.role || "",
      origin,
      cutoffFailed: !readEpistemicCutoff(BASE_DB_PATH).ok,
    }),
    sourceTimestamp: it.sourceTimestamp || captureTimestamp,
    sourceUrl: it.sourceUrl || "",
    evidenceQuote,
    scope: "agent-private",
    type: "memory",
    confirmed: false,
    emotionalValence: "",
    emotionalIntensity: 0,
    emotionalDominant: "neutral",
    moodContextAtCapture: "",
    replayCount: 0,
    lastReplayed: 0,
    retrievalCount: 0,
    lastRetrievedAt: 0,
    memoryStrength: 1.0,
    halfLifeDays: 30,
    lastStrengthenedAt: 0,
    lastDynamicsAt: 0,
    memoryClass: "standard",
    neverForget: 0,
    coreMemoryScore: 0.0,
    coreMemoryReason: "",
    versionNumber: 1,
    previousVersion: "",
    supersededBy: "",
    updateSource: "auto-capture",
    updateEvidence: "",
    reconsolidationConfidence: 0.0,
    status: "active",
    versionCreatedAt: captureTimestamp,
    updatedAt: captureTimestamp,
    memoryKind: "memory",
    reminderStatus: "",
    remindAt: 0,
    remindedAt: 0,
    dispatchedAt: 0,
    acknowledgedAt: 0,
    cancelledAt: 0,
    reminderKey: "",
    dispatchCount: 0,
    lastDispatchAttemptAt: 0,
    nextDispatchAttemptAt: 0,
    workspaceKey: "",
  };
}

async function readSessionFileRunInput(agentId, sessionsDir, name, stateFiles) {
  const path = resolveInside(sessionsDir, name);
  let descriptor;
  let stats;
  try {
    descriptor = openSync(path, "r");
    stats = fstatSync(descriptor);
  } catch (err) {
    if (Number.isInteger(descriptor)) closeSync(descriptor);
    console.warn(`[${agentId}] session open failed for ${name}: ${err.message}`);
    return null;
  }
  if (stats.size <= 0) {
    closeSync(descriptor);
    return null;
  }

  const openFile = { name, path, size: stats.size, identity: getFileIdentity(stats), descriptor };
  try {
    const checkpoint = normalizeFileCheckpoint(stateFiles[name]);
    const lastOffset = resolveCheckpointStart(agentId, openFile, checkpoint);
    const slice = openFile.size > lastOffset
      ? await readSessionLinesSinceOffset(path, lastOffset, { descriptor })
      : { records: [], nextOffset: lastOffset };
    return {
      file: { name, path, size: openFile.size, identity: openFile.identity },
      lastOffset,
      slice,
    };
  } finally {
    closeSync(descriptor);
  }
}

async function captureAgent(agentId, embeddings) {
  const safeAgent = safeAgentId(agentId);
  if (!existsSync(AGENTS_DIR)) return { stored: 0, candidates: 0 };
  const sessionsDir = resolveInside(AGENTS_DIR, safeAgent, "sessions");
  if (!existsSync(sessionsDir)) return { stored: 0, candidates: 0 };

  const fileNames = readdirSync(sessionsDir).filter(isSessionFile);
  if (fileNames.length === 0) return { stored: 0, candidates: 0 };

  const state = loadState(safeAgent);
  const stateFiles = state.files || {};

  const files = [];
  const fileRuns = [];
  const allItems = [];
  for (const name of fileNames) {
    const runInput = await readSessionFileRunInput(safeAgent, sessionsDir, name, stateFiles);
    if (!runInput) continue;
    const { file, lastOffset, slice } = runInput;
    files.push(file);
    const records = slice.records.map((record) => ({ ...record, acknowledged: true }));

    const messages = [];
    const recordByMessage = new Map();
    let parseErrors = 0;
    for (const record of records) {
      if (!record.line.trim()) continue;
      try {
        const message = JSON.parse(record.line);
        messages.push(message);
        recordByMessage.set(message, record);
      } catch (err) {
        parseErrors++;
        console.warn(`[${safeAgent}] unparsable session line ending at byte ${record.endOffset} in ${file.name}: ${err.message}`);
      }
    }
    if (parseErrors > 0) {
      console.warn(`[${safeAgent}] skipped ${parseErrors} unparsable session lines in ${file.name}`);
    }

    // v2.2.0: Gruppen-Kontext aus ALLEN Nachrichten (inkl. role="") lesen
    const sessionCtx = parseSessionContext(messages);
    const items = extractTexts(messages, sessionCtx);
    for (const it of items) {
      const record = recordByMessage.get(it._sourceMessage);
      if (!record) continue;
      it._sourceFile = file.name;
      it._fileIdentity = file.identity;
      it._checkpointOffset = record.endOffset;
      it._isGroup = sessionCtx.isGroup;
      it._record = record;
      record.item = it;
    }
    allItems.push(...items);
    fileRuns.push({
      ...file,
      startOffset: lastOffset,
      nextOffset: slice.nextOffset,
      records,
      invalidated: false,
    });
  }

  if (files.length === 0) return { stored: 0, candidates: 0 };

  const userUrlItems = allItems.filter(it => it.sourceUrl);
  const seen = new Set();
  const toCapture = [];
  for (const it of [...userUrlItems.slice(-10), ...allItems.slice(-50)]) {
    if (!seen.has(it.text)) { seen.add(it.text); toCapture.push(it); }
    if (toCapture.length >= 50) break;
  }

  for (const item of toCapture) item._record.acknowledged = false;
  persistAcknowledgedCheckpoints(safeAgent, stateFiles, fileRuns);
  if (toCapture.length === 0) return { stored: 0, candidates: 0 };

  mkdirSync(BASE_DB_PATH, { recursive: true });
  const dbPath = resolveInside(BASE_DB_PATH, safeAgent);
  mkdirSync(dbPath, { recursive: true });
  const table = await getOrCreateTable(dbPath, embeddings.dim);

  const captureTimestamp = Date.now();
  let stored = 0;
  const prepared = toCapture.map((it) => {
    const trimmed = it.text.slice(0, MAX_TEXT_LEN);
    return {
      it,
      trimmed,
      id: deterministicCaptureId(safeAgent, it, trimmed),
    };
  });
  const pendingEmbedding = [];
  for (const entry of prepared) {
    try {
      if (await findDurableCaptureRow(table, {
        ...entry,
        storedBy: safeAgent,
        text: entry.trimmed,
        dim: embeddings.dim,
      })) {
        entry.it._record.acknowledged = true;
      } else {
        pendingEmbedding.push(entry);
      }
    } catch (err) {
      console.error(`[${safeAgent}] capture idempotency check error: ${err.message}`);
    }
  }
  persistAcknowledgedCheckpoints(safeAgent, stateFiles, fileRuns);

  let batchVectors = [];
  if (pendingEmbedding.length > 0) {
    try {
      batchVectors = await embeddings.embedBatch(pendingEmbedding.map((entry) => entry.trimmed), { agentId: safeAgent });
    } catch (err) {
      console.warn(`[${safeAgent}] embedBatch failed, falling back to per-item embeddings: ${err.message}`);
    }
  }

  const preparedWithVectors = [];
  for (let i = 0; i < pendingEmbedding.length; i++) {
    const entry = pendingEmbedding[i];
    try {
      const vector = Array.isArray(batchVectors[i])
        ? batchVectors[i]
        : await embeddings.embed(entry.trimmed, { agentId: safeAgent });
      if (!Array.isArray(vector)
        || vector.length !== embeddings.dim
        || vector.some((value) => !Number.isFinite(Number(value)))) {
        throw new Error(`invalid embedding vector (expected ${embeddings.dim} finite dimensions)`);
      }
      preparedWithVectors.push({ ...entry, vector });
    } catch (err) {
      console.error(`[${safeAgent}] capture vector error: ${err.message}`);
    }
  }

  const unresolvedDuplicateChecks = new Set();
  const existingDuplicates = await findExistingDuplicateIndexes(
    table,
    preparedWithVectors.map((entry) => entry.vector),
    {
      duplicateThreshold: DUPLICATE_THRESHOLD,
      distanceToScoreFn: distanceToScore,
      onWarn: (message) => console.warn(`[${safeAgent}] ${message}`),
      unresolvedIndexes: unresolvedDuplicateChecks,
    },
  );

  const canonicalEntries = [];
  const duplicateDependencies = [];
  for (let i = 0; i < preparedWithVectors.length; i++) {
    const entry = preparedWithVectors[i];
    if (unresolvedDuplicateChecks.has(i)) continue;
    if (existingDuplicates.has(i)) {
      entry.it._record.acknowledged = true;
      continue;
    }
    const canonical = canonicalEntries.find((candidate) => isDuplicateDistance(
      squaredL2Distance(candidate.vector, entry.vector),
      { duplicateThreshold: DUPLICATE_THRESHOLD, distanceToScoreFn: distanceToScore },
    ));
    if (canonical) {
      duplicateDependencies.push({ duplicate: entry, canonical });
    } else {
      canonicalEntries.push(entry);
    }
  }
  persistAcknowledgedCheckpoints(safeAgent, stateFiles, fileRuns);

  const rowsToAdd = [];
  const entryByRowId = new Map();
  for (const entry of canonicalEntries) {
    try {
      const row = buildCaptureRow(safeAgent, entry, captureTimestamp);
      const guard = assertCardWriteAllowed({
        baseDbPath: BASE_DB_PATH,
        agentId: safeAgent,
        text: row.text,
        scope: row.scope || "agent-private",
        workspaceIdentity: row.workspaceKey || "",
        ownerUserId: "",
      });
      if (!guard.allowed) {
        console.warn(`[${safeAgent}] capture blocked by tombstone`);
        continue;
      }
      rowsToAdd.push(row);
      entryByRowId.set(row.id, entry);
    } catch (err) {
      console.error(`[${safeAgent}] capture error: ${err.message}`);
    }
  }

  let batchFailed = false;
  if (rowsToAdd.length > 0) {
    try {
      await table.add(rowsToAdd);
    } catch (err) {
      batchFailed = true;
      console.error(`[${safeAgent}] batch capture add error: ${err.message}`);
    }
  }

  for (const row of rowsToAdd) {
    const entry = entryByRowId.get(row.id);
    try {
      let durable = await findDurableCaptureRow(table, row);
      if (!durable && batchFailed) {
        await table.add([row]);
        durable = await findDurableCaptureRow(table, row);
      }
      if (!durable) throw new Error(`capture row ${row.id} was not readable after insert`);
      entry.it._record.acknowledged = true;
      stored++;
      persistAcknowledgedCheckpoints(safeAgent, stateFiles, fileRuns);
    } catch (err) {
      console.error(`[${safeAgent}] capture add error: ${err.message}`);
    }
  }

  for (const { duplicate, canonical } of duplicateDependencies) {
    if (canonical.it._record.acknowledged) duplicate.it._record.acknowledged = true;
  }
  persistAcknowledgedCheckpoints(safeAgent, stateFiles, fileRuns);

  if (stored > 0) {
    const groupCount = toCapture.filter(it => it._isGroup).length;
    console.log(`[${safeAgent}] captured ${stored}/${toCapture.length} memories (${groupCount} group) from ${files.length} session-files`);
  }
  return { stored, candidates: toCapture.length };
}

async function main() {
  const filterArgs = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const allAgents = discoverAgents();
  const agents = filterArgs.length > 0
    ? allAgents.filter(a => filterArgs.includes(a))
    : allAgents;

  console.log(`[main] processing ${agents.length} agents${filterArgs.length ? ` (filtered)` : ""}: ${agents.join(", ")}`);

  const modules = await init();
  const embeddings = createEmbeddings(modules, readPluginConfig(CONFIG_PATH));

  let totalStored = 0, totalCands = 0, errors = 0;
  for (const agent of agents) {
    try {
      const r = await captureAgent(agent, embeddings);
      totalStored += r.stored; totalCands += r.candidates;
    } catch (err) {
      errors++;
      console.error(`[${agent}] error: ${err.message}`);
    }
  }

  console.log(`[main] done — stored=${totalStored}, candidates=${totalCands}, errors=${errors}`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch(err => {
    console.error("[main] fatal:", err.message);
    process.exit(1);
  });
}

#!/usr/bin/env node
/**
 * auto-capture-lancedb.mjs — Cron-basierter Auto-Capture für memory-lancedb-namespaced
 * Liest die neuesten Session-Nachrichten der drei Hauptagenten und speichert sie in LanceDB.
 *
 * Cron: alle 5 Minuten
 * Usage: node auto-capture-lancedb.mjs [agent-id...]
 *
 * v2.2.0: Gruppen-Erkennung + Sender-Attribution + saubere Textextraktion
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// Shared modules aus dem Plugin (v1.9.0)
import { distanceToScore } from "../extensions/memory-lancedb-namespaced/lib/score.js";
import { categorizeMemory } from "../extensions/memory-lancedb-namespaced/lib/categorize.js";

// ─── Config ─────────────────────────────────────────────────────────────────
const FALLBACK_AGENTS = ["main", "bernhardine", "heisenberg"];
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
// ─── Plugin-Dir Auflösung ────────────────────────────────────────────────────
const PLUR1BUS_PLUGIN_DIR = process.env.PLUR1BUS_PLUGIN_DIR
  || join(homedir(), ".openclaw", "extensions", "memory-lancedb-namespaced");

const FACTORY_PATH = join(PLUR1BUS_PLUGIN_DIR, "lib/providers/factory.js");
const CONFIG_NORMALIZE_PATH = join(PLUR1BUS_PLUGIN_DIR, "lib/providers/config-normalize.js");

async function loadProviderFactory() {
  try {
    const [factoryMod, normalizeMod] = await Promise.all([
      import(FACTORY_PATH),
      import(CONFIG_NORMALIZE_PATH),
    ]);
    return {
      createEmbeddingProvider: factoryMod.createEmbeddingProvider,
      normalizeEmbeddingConfig: normalizeMod.normalizeEmbeddingConfig,
    };
  } catch (e) {
    throw new Error(
      `[auto-capture] Provider-Factory nicht gefunden unter ${FACTORY_PATH}. ` +
      `Ist memory-lancedb-namespaced installiert? Setze PLUR1BUS_PLUGIN_DIR. (${e.message})`
    );
  }
}

function readPluginEmbeddingConfig(configPath) {
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    return cfg?.plugins?.entries?.["memory-lancedb-namespaced"]?.embedding || {};
  } catch (_) {
    return {};
  }
}

// ─── Injected-Context-Filter (verhindert Re-Capture von PLUR1BUS-Blöcken) ───
const INJECTED_CONTEXT_RE = /<\/?plur1bus-recall|<\/?relevant-memories|<\/?knowledge-update-reminder|<\/?adaptive-learning|RECALL SAFETY RULES|capturedBy"\s*:\s*"agent_end_capture|embeddingStatus"\s*:\s*"pending|plur1bus internal classify-recent|critical-memory-classifier|TTS-STATUS|\[cron:|heartbeat_ok|Reference UTC:|Current time:|You are a memory search agent|memory search agent\. Another model|bounded search query|Use only the available memory tools|Conversation info \(untrusted metadata\)|"chat_id"\s*:\s*"telegram:|"message_id"\s*:\s*"|"sender_id"\s*:/i;

function isInjectedContextText(text) {
  if (!text || typeof text !== "string") return false;
  return INJECTED_CONTEXT_RE.test(text);
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

// ─── LanceDB import ──────────────────────────────────────────────────────────
const PLUGIN_DIR = join(homedir(), ".openclaw", "extensions", "memory-lancedb-namespaced");
const LANCEDB_PATH = join(PLUGIN_DIR, "../memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js");

let lancedb;

async function init() {
  lancedb = await import(LANCEDB_PATH);
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
    });
  }
  return items;
}

// ─── State tracking ───────────────────────────────────────────────────────────
function getStateFile(agentId) {
  return join(STATE_DIR, `${agentId}.json`);
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
  } catch {
    return { files: {} };
  }
}

function saveState(agentId, state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(getStateFile(agentId), JSON.stringify(state));
}

function isSessionFile(name) {
  if (!name.endsWith(".jsonl")) return false;
  if (name.includes(".trajectory.")) return false;
  if (name.includes(".checkpoint.")) return false;
  if (name.includes(".deleted.")) return false;
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function captureAgent(agentId, embeddings) {
  const sessionsDir = join(AGENTS_DIR, agentId, "sessions");
  if (!existsSync(sessionsDir)) return { stored: 0, candidates: 0 };

  const files = readdirSync(sessionsDir)
    .filter(isSessionFile)
    .map((f) => ({ name: f, path: join(sessionsDir, f), size: statSync(join(sessionsDir, f)).size }))
    .filter((f) => f.size > 0);

  if (files.length === 0) return { stored: 0, candidates: 0 };

  const state = loadState(agentId);
  const stateFiles = state.files || {};

  const allItems = [];
  for (const file of files) {
    const lastOffset = stateFiles[file.name] || 0;
    if (file.size <= lastOffset) continue;

    const raw = readFileSync(file.path, "utf8");
    const newPortion = raw.slice(lastOffset);
    const newLines = newPortion.split("\n").filter(l => l.trim().length > 0);

    const messages = [];
    for (const line of newLines) {
      try { messages.push(JSON.parse(line)); } catch {}
    }

    // v2.2.0: Gruppen-Kontext aus ALLEN Nachrichten (inkl. role="") lesen
    const sessionCtx = parseSessionContext(messages);
    const items = extractTexts(messages, sessionCtx);
    for (const it of items) {
      it._sourceFile = file.name;
      it._isGroup = sessionCtx.isGroup;
    }
    allItems.push(...items);
    stateFiles[file.name] = file.size;
  }

  if (allItems.length === 0) {
    saveState(agentId, { files: stateFiles });
    return { stored: 0, candidates: 0 };
  }

  const items = allItems;
  const userUrlItems = items.filter(it => it.sourceUrl);
  const seen = new Set();
  const toCapture = [];
  for (const it of [...userUrlItems.slice(-10), ...items.slice(-50)]) {
    if (!seen.has(it.text)) { seen.add(it.text); toCapture.push(it); }
    if (toCapture.length >= 50) break;
  }

  const dbPath = join(BASE_DB_PATH, agentId);
  mkdirSync(dbPath, { recursive: true });
  const table = await getOrCreateTable(dbPath, embeddings.dim);

  const captureTimestamp = Date.now();
  let stored = 0;
  for (const it of toCapture) {
    try {
      const trimmed = it.text.slice(0, MAX_TEXT_LEN);
      const vector = await embeddings.embed(trimmed);

      const results = await table.search(vector).limit(1).toArray();
      if (results.length > 0 && results[0]._distance !== undefined) {
        if (distanceToScore(results[0]._distance) >= DUPLICATE_THRESHOLD) continue;
      }

      // v2.2.0: origin aus Session-Kontext ableiten
      const origin = it._isGroup ? "group" : "dm";

      // Sender-Info in evidenceQuote vermerken
      const evidenceBase = (it.rawText || "").slice(0, 180);
      const evidenceQuote = it.senderLabel
        ? `[${it.senderLabel}] ${evidenceBase}`.slice(0, 200)
        : evidenceBase;

      await table.add([
        {
          id: randomUUID(),
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
          sourceTimestamp: it.sourceTimestamp || captureTimestamp,
          sourceUrl: it.sourceUrl || "",
          evidenceQuote,
          scope: "agent-private",
          // PLUR1BUS schema compat (v2.3.0)
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
        },
      ]);
      stored++;
    } catch (err) {
      console.error(`[${agentId}] capture error: ${err.message}`);
    }
  }

  saveState(agentId, { files: stateFiles });
  if (stored > 0) {
    const groupCount = toCapture.filter(it => it._isGroup).length;
    console.log(`[${agentId}] captured ${stored}/${toCapture.length} memories (${groupCount} group) from ${files.length} session-files`);
  }
  return { stored, candidates: items.length };
}

async function main() {
  const { createEmbeddingProvider, normalizeEmbeddingConfig } = await loadProviderFactory();
  const rawEmbeddingCfg = readPluginEmbeddingConfig(CONFIG_PATH);
  const embCfg = normalizeEmbeddingConfig(rawEmbeddingCfg);

  const filterArgs = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const allAgents = discoverAgents();
  const agents = filterArgs.length > 0
    ? allAgents.filter(a => filterArgs.includes(a))
    : allAgents;

  console.log(`[main] processing ${agents.length} agents${filterArgs.length ? ` (filtered)` : ""}: ${agents.join(", ")}`);

  await init();
  const embeddings = createEmbeddingProvider(embCfg);
  if (!embeddings) {
    console.error("[auto-capture] Embedding-Provider konnte nicht initialisiert werden. " +
      "Prüfe openclaw.json → plugins.entries.memory-lancedb-namespaced.embedding");
    process.exit(1);
  }

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

main().catch(err => {
  console.error("[main] fatal:", err.message);
  process.exit(1);
});

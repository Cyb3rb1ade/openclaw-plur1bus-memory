#!/usr/bin/env node
/**
 * auto-capture-lancedb.mjs — Cron-basierter Auto-Capture für memory-lancedb-namespaced
 * Liest die neuesten Session-Nachrichten der drei Hauptagenten und speichert sie in LanceDB.
 *
 * Cron: alle 5 Minuten
 * Usage: OPENAI_API_KEY=... node auto-capture-lancedb.mjs
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
const MIN_TEXT_LEN = 10; // gesenkt von 20 — kurze Bestätigungen werden auch erfasst
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-large";

// ─── Agent Discovery — alle Agents aus openclaw.json (NICHT pro workspace dedupliziert,
// da Subagents eigene Sessions haben) ──────────────────────────────────────
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

// ─── LanceDB + OpenAI imports (from memory-lancedb-stock) ───────────────────
const PLUGIN_DIR = join(homedir(), ".openclaw", "extensions", "memory-lancedb-namespaced");
const LANCEDB_PATH = join(PLUGIN_DIR, "../memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js");
const OPENAI_PATH = join(PLUGIN_DIR, "../memory-lancedb-stock/node_modules/openai/index.js");

const EMBEDDING_DIMENSIONS = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

let lancedb, OpenAI;

async function init() {
  lancedb = await import(LANCEDB_PATH);
  const openaiMod = await import(OPENAI_PATH);
  OpenAI = openaiMod.default || openaiMod.OpenAI;
}

// ─── Embedding ──────────────────────────────────────────────────────────────
function createEmbeddings(apiKey, model) {
  const openai = new OpenAI({ apiKey });
  const dim = EMBEDDING_DIMENSIONS[model] || 3072;
  return {
    dim,
    async embed(text) {
      const resp = await openai.embeddings.create({
        model,
        input: text.slice(0, 8000),
        dimensions: dim,
      });
      return Array.from(resp.data[0].embedding);
    },
  };
}

// ─── LanceDB ────────────────────────────────────────────────────────────────
async function getOrCreateTable(dbPath, dim) {
  const db = await lancedb.connect(dbPath);
  const tables = await db.tableNames();
  if (tables.includes("memories")) {
    const tbl = await db.openTable("memories");
    // v1.8.0 — Schema-Migration für bestehende DBs (idempotent)
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
      // v1.8.0
      sourceTurnId: "",
      sourceMessageRole: "",
      sourceTimestamp: 0,
      sourceUrl: "",
      evidenceQuote: "",
      scope: "agent-private",
    },
  ]);
}

// ─── Helpers ────────────────────────────────────────────────────────────────
// categorizeMemory wird aus shared module importiert (v1.9.0).

function generateSummary(text, maxWords) {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  return words.slice(0, maxWords).join(" ") + (words.length > maxWords ? "..." : "");
}

function extractTexts(messages) {
  const items = []; // { text, role, sourceTurnId, sourceTimestamp, sourceUrl }
  const urlPattern = /https?:\/\/[^\s]{10,}/;
  for (const msg of messages) {
    const m = msg.message || msg;
    const role = m.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = m.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    }
    if (text.trim().length >= MIN_TEXT_LEN) {
      const prefix = role === "user" ? "User: " : "Assistant: ";
      const cleaned = text.trim();
      const urlMatch = role === "user" ? cleaned.match(urlPattern) : null;
      items.push({
        text: prefix + cleaned,
        rawText: cleaned,
        role,
        sourceTurnId: msg.id || msg.parentId || msg.runId || "",
        sourceTimestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : (msg.createdAt || 0),
        sourceUrl: urlMatch ? urlMatch[0].slice(0, 500) : "",
      });
    }
  }
  return items;
}

// ─── State tracking (Byte-Offset pro Datei — exakt, keine Approximation) ───
function getStateFile(agentId) {
  return join(STATE_DIR, `${agentId}.json`);
}

function loadState(agentId) {
  const f = getStateFile(agentId);
  if (!existsSync(f)) return { files: {} };
  try {
    const raw = JSON.parse(readFileSync(f, "utf8"));
    // v1.8.2-Migration: alte { lastFile, lastSize }-State wird konvertiert
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

// Filter: echte Session-Dateien (kein trajectory, checkpoint, deleted, trajectory-path)
function isSessionFile(name) {
  if (!name.endsWith(".jsonl")) return false;
  if (name.includes(".trajectory.")) return false;
  if (name.includes(".checkpoint.")) return false;
  if (name.includes(".deleted.")) return false;
  return true;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function captureAgent(agentId, embeddings) {
  const sessionsDir = join(AGENTS_DIR, agentId, "sessions");
  if (!existsSync(sessionsDir)) return { stored: 0, candidates: 0 };

  // ALLE aktiven Sessions sammeln (nicht nur newest) — keine Drops mehr bei parallelen Sessions
  const files = readdirSync(sessionsDir)
    .filter(isSessionFile)
    .map((f) => ({ name: f, path: join(sessionsDir, f), size: statSync(join(sessionsDir, f)).size }))
    .filter((f) => f.size > 0);

  if (files.length === 0) return { stored: 0, candidates: 0 };

  const state = loadState(agentId);
  const stateFiles = state.files || {};

  // Sammle ALLE neuen Items aus ALLEN gewachsenen Sessions
  const allItems = [];
  for (const file of files) {
    const lastOffset = stateFiles[file.name] || 0;
    if (file.size <= lastOffset) continue; // unverändert oder geschrumpft (truncate)

    // Lies NUR ab byteOffset → exakt, keine Line-Approximation
    const raw = readFileSync(file.path, "utf8");
    // Sicherstellen dass wir an einer Line-Grenze starten (bei UTF-8 multibyte ggf. shift)
    const newPortion = raw.slice(lastOffset);
    const newLines = newPortion.split("\n").filter(l => l.trim().length > 0);

    const messages = [];
    for (const line of newLines) {
      try { messages.push(JSON.parse(line)); } catch {}
    }
    const items = extractTexts(messages);
    for (const it of items) it._sourceFile = file.name; // für State-Update später
    allItems.push(...items);

    stateFiles[file.name] = file.size; // tracke neue Position
  }

  if (allItems.length === 0) {
    saveState(agentId, { files: stateFiles });
    return { stored: 0, candidates: 0 };
  }

  // Items aus allen Files mergen — ältere zuerst, neueste zuletzt (für Slicing)
  const items = allItems;

  // Cap erhöht von 5 → 50 (v1.8.0): bei langen Bursts wurden >50% gedroppt.
  // Duplicate-Check (0.95) filtert echten Müll ohnehin raus.
  // User-URLs werden zusätzlich priorisiert (siehe Plugin-Logik).
  const userUrlItems = items.filter(it => it.sourceUrl);
  const seen = new Set();
  const toCapture = [];
  for (const it of [...userUrlItems.slice(-10), ...items.slice(-50)]) {
    if (!seen.has(it.text)) { seen.add(it.text); toCapture.push(it); }
    if (toCapture.length >= 50) break;
  }

  // Open/create LanceDB
  const dbPath = join(BASE_DB_PATH, agentId);
  mkdirSync(dbPath, { recursive: true });
  const table = await getOrCreateTable(dbPath, embeddings.dim);

  const captureTimestamp = Date.now();
  let stored = 0;
  for (const it of toCapture) {
    try {
      const trimmed = it.text.slice(0, MAX_TEXT_LEN);
      const vector = await embeddings.embed(trimmed);

      // Duplicate check via shared distanceToScore (v1.9.0).
      const results = await table.search(vector).limit(1).toArray();
      if (results.length > 0 && results[0]._distance !== undefined) {
        if (distanceToScore(results[0]._distance) >= DUPLICATE_THRESHOLD) continue;
      }

      await table.add([
        {
          id: randomUUID(),
          text: trimmed,
          summary: generateSummary(trimmed, SUMMARY_MAX_WORDS),
          origin: "dm",
          vector,
          importance: 0.7,
          category: categorizeMemory(trimmed),
          createdAt: captureTimestamp,
          mergedFrom: "[]",
          expiresAt: 0,
          storedBy: agentId,
          // v1.8.0 — Provenance fields
          sourceTurnId: it.sourceTurnId || "",
          sourceMessageRole: it.role || "",
          sourceTimestamp: it.sourceTimestamp || captureTimestamp,
          sourceUrl: it.sourceUrl || "",
          evidenceQuote: (it.rawText || "").slice(0, 200),
          scope: "agent-private",
        },
      ]);
      stored++;
    } catch (err) {
      console.error(`[${agentId}] capture error: ${err.message}`);
    }
  }

  saveState(agentId, { files: stateFiles });
  if (stored > 0) {
    console.log(`[${agentId}] captured ${stored}/${toCapture.length} memories (had ${items.length} candidates from ${files.length} session-files)`);
  }
  return { stored, candidates: items.length };
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY not set");
    process.exit(1);
  }

  const filterArgs = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const allAgents = discoverAgents();
  const agents = filterArgs.length > 0
    ? allAgents.filter(a => filterArgs.includes(a))
    : allAgents;

  console.log(`[main] processing ${agents.length} agents${filterArgs.length ? ` (filtered)` : ""}: ${agents.join(", ")}`);

  await init();
  const embeddings = createEmbeddings(apiKey, EMBEDDING_MODEL);

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
  if (totalCands > 0 || totalStored > 0) {
    console.log(`[main] done: ${totalStored} stored, ${totalCands} candidates, ${errors} errors`);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});

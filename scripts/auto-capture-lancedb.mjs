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

// ─── Config ─────────────────────────────────────────────────────────────────
const AGENTS = ["main", "bernhardine", "heisenberg"];
const AGENTS_DIR = join(homedir(), ".openclaw", "agents");
const STATE_DIR = join(homedir(), ".openclaw", ".auto-capture-state");
const BASE_DB_PATH = join(homedir(), ".openclaw", "memory", "lancedb-namespaced");
const MAX_TEXT_LEN = 15000;
const DUPLICATE_THRESHOLD = 0.95;
const SUMMARY_MAX_WORDS = 150;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-large";

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
function categorizeMemory(text) {
  const t = text.toLowerCase();
  if (t.includes("http") || t.includes("url") || t.includes("link")) return "reference";
  if (t.includes("fehler") || t.includes("error") || t.includes("fix")) return "debug";
  if (t.includes("config") || t.includes("setting")) return "config";
  return "conversation";
}

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
    if (text.trim().length > 20) {
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

// ─── State tracking (prevent re-capture) ────────────────────────────────────
function getStateFile(agentId) {
  return join(STATE_DIR, `${agentId}.json`);
}

function loadState(agentId) {
  const f = getStateFile(agentId);
  if (!existsSync(f)) return { lastFile: "", lastSize: 0 };
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return { lastFile: "", lastSize: 0 };
  }
}

function saveState(agentId, state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(getStateFile(agentId), JSON.stringify(state));
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function captureAgent(agentId, embeddings) {
  const sessionsDir = join(AGENTS_DIR, agentId, "sessions");
  if (!existsSync(sessionsDir)) return;

  // Find newest active .jsonl file
  const files = readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ name: f, path: join(sessionsDir, f), mtime: statSync(join(sessionsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) return;
  const newest = files[0];

  // Check state — skip if unchanged
  const state = loadState(agentId);
  const currentSize = statSync(newest.path).size;
  if (state.lastFile === newest.name && state.lastSize === currentSize) return;

  // Read JSONL — only the NEW portion
  const raw = readFileSync(newest.path, "utf8");
  const lines = raw.trim().split("\n");

  // If same file but grown, only read new lines
  let startLine = 0;
  if (state.lastFile === newest.name && state.lastSize > 0) {
    // Approximate: count lines in old portion
    const oldLines = readFileSync(newest.path, "utf8").slice(0, state.lastSize).split("\n").length - 1;
    startLine = Math.max(0, oldLines);
  }

  const newLines = lines.slice(startLine);
  if (newLines.length === 0) {
    saveState(agentId, { lastFile: newest.name, lastSize: currentSize });
    return;
  }

  const messages = [];
  for (const line of newLines) {
    try {
      messages.push(JSON.parse(line));
    } catch {}
  }

  const items = extractTexts(messages);
  if (items.length === 0) {
    saveState(agentId, { lastFile: newest.name, lastSize: currentSize });
    return;
  }

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

      // Duplicate check
      const results = await table.search(vector).limit(1).toArray();
      if (results.length > 0 && results[0]._distance !== undefined && (1 - results[0]._distance) > DUPLICATE_THRESHOLD) {
        continue;
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

  saveState(agentId, { lastFile: newest.name, lastSize: currentSize });
  if (stored > 0) {
    console.log(`[${agentId}] captured ${stored}/${toCapture.length} memories (had ${items.length} candidates)`);
  }
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY not set");
    process.exit(1);
  }

  await init();
  const embeddings = createEmbeddings(apiKey, EMBEDDING_MODEL);

  for (const agent of AGENTS) {
    try {
      await captureAgent(agent, embeddings);
    } catch (err) {
      console.error(`[${agent}] error: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});

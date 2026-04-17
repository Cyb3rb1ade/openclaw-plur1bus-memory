#!/usr/bin/env node
/**
 * embed-promoted-memories.mjs
 *
 * Harmonisierung Dreaming ↔ LanceDB:
 * Liest neue Promotionen aus MEMORY.md (erkennbar am openclaw-memory-promotion-Marker)
 * und embedded sie in die per-Agent LanceDB — damit kuratierte Dreaming-Fakten
 * auch im Active-Memory Real-Time Recall auftauchen.
 *
 * Cron: 30 4 * * *  (täglich nach dem Dreaming-Zyklus ~04:00)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __pluginDir = dirname(fileURLToPath(import.meta.url));

// Config
const AGENTS = [
  { id: "main",         workspace: "workspace" },
  { id: "bernhardine",  workspace: "workspace-bernhardine" },
  { id: "heisenberg",   workspace: "workspace-heisenberg" },
];
const BASE   = join(homedir(), ".openclaw");
const DB_BASE = join(BASE, "memory", "lancedb-namespaced");
const STATE_DIR = join(BASE, ".embed-promotions-state");
const PLUGIN_DIR = join(BASE, "extensions", "memory-lancedb-namespaced");
const LANCEDB_PATH = join(PLUGIN_DIR, "../memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js");
const OPENAI_PATH  = join(PLUGIN_DIR, "../memory-lancedb-stock/node_modules/openai/index.js");
const EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIM   = 3072;

// Parse MEMORY.md and extract promoted entries
function parsePromotions(content) {
  const promotions = [];
  const lines = content.split("\n");
  let currentMeta = null;
  for (const line of lines) {
    const markerMatch = line.match(/<!--\s*openclaw-memory-promotion:([^>]+)\s*-->/);
    if (markerMatch) {
      currentMeta = markerMatch[1].trim();
      continue;
    }
    if (currentMeta && line.startsWith("- ")) {
      // Extract text (strip score/recalls/avg/source metadata at end)
      const text = line.replace(/\[score=[\d.]+[^\]]*\]\s*$/, "").replace(/^- /, "").trim();
      if (text.length > 20) {
        promotions.push({ meta: currentMeta, text });
      }
      currentMeta = null;
    }
  }
  return promotions;
}

// Load state: which promotion markers have already been embedded
function loadState(agentId) {
  const f = join(STATE_DIR, `${agentId}-promotions.json`);
  if (!existsSync(f)) return { embedded: [] };
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return { embedded: [] }; }
}

function saveState(agentId, state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, `${agentId}-promotions.json`), JSON.stringify(state, null, 2));
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error("OPENAI_API_KEY not set"); process.exit(1); }

  const lancedb = await import(LANCEDB_PATH);
  const { default: OpenAI } = await import(OPENAI_PATH);
  const openai = new OpenAI({ apiKey });

  async function embed(text) {
    const r = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: text.slice(0, 8000), dimensions: EMBEDDING_DIM });
    return Array.from(r.data[0].embedding);
  }

  async function getOrCreateTable(db) {
    const tables = await db.tableNames();
    if (tables.includes("memories")) return db.openTable("memories");
    return db.createTable("memories", [{
      id: "init", text: "", summary: "", origin: "system",
      vector: new Array(EMBEDDING_DIM).fill(0),
      importance: 0, category: "system", createdAt: Date.now(),
      mergedFrom: "[]", expiresAt: 0, storedBy: "system"
    }]);
  }

  for (const agent of AGENTS) {
    const memoryMd = join(BASE, agent.workspace, "memory", "MEMORY.md");
    if (!existsSync(memoryMd)) { console.log(`[${agent.id}] No MEMORY.md, skipping`); continue; }

    const content = readFileSync(memoryMd, "utf8");
    const promotions = parsePromotions(content);
    if (promotions.length === 0) { console.log(`[${agent.id}] No promotions found`); continue; }

    const state = loadState(agent.id);
    const alreadyEmbedded = new Set(state.embedded);
    const toEmbed = promotions.filter(p => !alreadyEmbedded.has(p.meta));

    if (toEmbed.length === 0) { console.log(`[${agent.id}] All ${promotions.length} promotions already embedded`); continue; }
    console.log(`[${agent.id}] ${toEmbed.length} new promotions to embed (${promotions.length} total)`);

    const dbPath = join(DB_BASE, agent.id);
    mkdirSync(dbPath, { recursive: true });
    const db = await lancedb.connect(dbPath);
    const table = await getOrCreateTable(db);

    let stored = 0;
    for (const p of toEmbed) {
      try {
        const vector = await embed(p.text);
        // Duplicate check
        const results = await table.search(vector).limit(1).toArray();
        const isDupe = results.length > 0 && results[0]._distance !== undefined && (1 - results[0]._distance) > 0.95;
        if (isDupe) {
          console.log(`  [${agent.id}] Skipped (duplicate): ${p.text.slice(0, 60)}...`);
          alreadyEmbedded.add(p.meta);
          continue;
        }
        await table.add([{
          id: randomUUID(),
          text: p.text,
          summary: p.text.slice(0, 150),
          origin: "dreaming-promotion",
          vector,
          importance: 0.9,
          category: "curated",
          createdAt: Date.now(),
          mergedFrom: "[]",
          expiresAt: 0,
          storedBy: agent.id,
        }]);
        alreadyEmbedded.add(p.meta);
        stored++;
        console.log(`  [${agent.id}] Embedded: ${p.text.slice(0, 60)}...`);
      } catch (err) {
        console.error(`  [${agent.id}] Error: ${err.message}`);
      }
    }
    state.embedded = [...alreadyEmbedded];
    saveState(agent.id, state);
    console.log(`[${agent.id}] Done: stored=${stored}/${toEmbed.length}`);
  }
}

main().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });

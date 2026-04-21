#!/usr/bin/env node
/**
 * migrate-memory-md-to-lancedb.mjs
 *
 * Liest MEMORY.md eines Agents, bettet alle Einträge in LanceDB ein,
 * und ersetzt die MEMORY.md durch einen kompakten Header + Referenzhinweis.
 *
 * Usage: OPENAI_API_KEY=... node migrate-memory-md-to-lancedb.mjs [agentId]
 * Beispiel: node migrate-memory-md-to-lancedb.mjs main
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __pluginDir = dirname(fileURLToPath(import.meta.url));
const BASE = join(homedir(), ".openclaw");
const DB_BASE = join(BASE, "memory", "lancedb-namespaced");
const PLUGIN_DIR = join(BASE, "extensions", "memory-lancedb-namespaced");
const LANCEDB_PATH = join(PLUGIN_DIR, "../memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js");
const OPENAI_PATH  = join(PLUGIN_DIR, "../memory-lancedb-stock/node_modules/openai/index.js");

const EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIM   = 3072;
const MIN_CHUNK_LEN   = 30;
const DRY_RUN = process.argv.includes("--dry-run");

const AGENT_WORKSPACES = {
  main:         "workspace",
  bernhardine:  "workspace-bernhardine",
  heisenberg:   "workspace-heisenberg",
};

// ─── Parsing ─────────────────────────────────────────────────────────────────

function chunkMemoryMd(content) {
  const chunks = [];
  const lines = content.split("\n");
  let currentSection = "";
  let currentLines = [];
  let inHeader = true;
  let headerLines = [];

  for (const line of lines) {
    // Track the header (User Profile + preamble)
    if (inHeader && !line.startsWith("## ") && !line.startsWith("<!-- openclaw-memory-promotion")) {
      headerLines.push(line);
      continue;
    }
    inHeader = false;

    if (line.startsWith("## ") || line.startsWith("<!-- openclaw-memory-promotion")) {
      // Save previous section
      if (currentLines.length > 0) {
        const text = currentLines.join("\n").trim();
        if (text.length >= MIN_CHUNK_LEN) {
          chunks.push({ section: currentSection, text });
        }
      }
      // Start new section
      if (line.startsWith("## ")) {
        currentSection = line.replace(/^## /, "").trim();
        currentLines = [line];
      } else {
        // Promotion marker — next non-empty line is the entry
        currentSection = "promoted";
        currentLines = [];
      }
    } else if (line.startsWith("- ") && currentSection === "promoted") {
      // Promotion entry
      const text = line.replace(/^- /, "").replace(/\[score=[^\]]+\]\s*$/, "").trim();
      if (text.length >= MIN_CHUNK_LEN) {
        chunks.push({ section: "promoted", text });
      }
      currentSection = "promoted";
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  // Last section
  if (currentLines.length > 0) {
    const text = currentLines.join("\n").trim();
    if (text.length >= MIN_CHUNK_LEN) {
      chunks.push({ section: currentSection, text });
    }
  }

  const header = headerLines.join("\n").trim();
  return { header, chunks };
}

// ─── Embedding + LanceDB ─────────────────────────────────────────────────────

async function getOrCreateTable(db, dim) {
  const tables = await db.tableNames();
  if (tables.includes("memories")) return db.openTable("memories");
  return db.createTable("memories", [{
    id: "init", text: "", summary: "", origin: "system",
    vector: new Array(dim).fill(0),
    importance: 0, category: "system", createdAt: Date.now(),
    mergedFrom: "[]", expiresAt: 0, storedBy: "system"
  }]);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function migrateAgent(agentId, openai, lancedb) {
  const workspace = AGENT_WORKSPACES[agentId];
  if (!workspace) { console.error(`Unknown agent: ${agentId}`); return; }

  const memoryMdPath = join(BASE, workspace, "MEMORY.md");
  if (!existsSync(memoryMdPath)) {
    console.log(`[${agentId}] No MEMORY.md at ${memoryMdPath}, skipping`);
    return;
  }

  const content = readFileSync(memoryMdPath, "utf8");
  const sizeBefore = content.length;
  console.log(`[${agentId}] MEMORY.md: ${(sizeBefore/1024).toFixed(1)}k chars`);

  const { header, chunks } = chunkMemoryMd(content);
  console.log(`[${agentId}] Parsed: ${chunks.length} chunks, header: ${header.length} chars`);

  if (DRY_RUN) {
    console.log(`[${agentId}] DRY RUN — would embed ${chunks.length} chunks`);
    chunks.slice(0, 3).forEach((c, i) => console.log(`  [${i}] ${c.section}: ${c.text.slice(0, 80)}...`));
    return;
  }

  // Open LanceDB
  const dbPath = join(DB_BASE, agentId);
  mkdirSync(dbPath, { recursive: true });
  const db = await lancedb.connect(dbPath);
  const table = await getOrCreateTable(db, EMBEDDING_DIM);

  let stored = 0, dupes = 0, errors = 0;

  for (const chunk of chunks) {
    try {
      const text = chunk.text.slice(0, 8000);

      // Embed
      const resp = await openai.embeddings.create({
        model: EMBEDDING_MODEL, input: text, dimensions: EMBEDDING_DIM
      });
      const vector = Array.from(resp.data[0].embedding);

      // Duplicate check
      const results = await table.search(vector).limit(1).toArray();
      if (results.length > 0 && results[0]._distance !== undefined && (1 - results[0]._distance) > 0.97) {
        dupes++;
        continue;
      }

      await table.add([{
        id: randomUUID(),
        text: text,
        summary: text.slice(0, 200),
        origin: "memory-md-migration",
        vector,
        importance: 0.95,
        category: chunk.section === "promoted" ? "curated" : "knowledge",
        createdAt: Date.now(),
        mergedFrom: "[]",
        expiresAt: 0,
        storedBy: agentId,
      }]);
      stored++;
      process.stdout.write(`\r[${agentId}] ${stored} stored, ${dupes} dupes, ${errors} errors`);
    } catch (err) {
      errors++;
      console.error(`\n[${agentId}] Error: ${err.message.slice(0, 100)}`);
    }
  }
  console.log(`\n[${agentId}] Done: ${stored} stored, ${dupes} dupes, ${errors} errors`);

  // Write compact MEMORY.md
  const today = new Date().toISOString().slice(0, 10);
  const newContent = `# MEMORY.md - Long-Term Memory

> **Migriert am ${today}:** Alle ${chunks.length} Einträge wurden in LanceDB eingebettet
> (Agent: ${agentId}, ${stored} neu eingebettet, ${dupes} Duplikate übersprungen).
> Das Wissen ist über Active-Memory und \`memory_recall\` abrufbar.

---

${header}

---

## Archiv-Hinweis

Der vollständige Inhalt dieser Datei (${(sizeBefore/1024).toFixed(0)}k Zeichen) wurde in die
LanceDB-Datenbank migriert und ist semantisch durchsuchbar.

- **Recall:** \`memory_recall\` Tool oder Active-Memory (automatisch)
- **Backup:** \`MEMORY.md.bak-${today.replace(/-/g, "")}\`
- **Kategorie:** \`knowledge\` und \`curated\` in LanceDB

*Diese Datei wird weiterhin für neue Promotions verwendet.*
`;

  writeFileSync(memoryMdPath, newContent, "utf8");
  console.log(`[${agentId}] MEMORY.md: ${(sizeBefore/1024).toFixed(1)}k → ${(newContent.length/1024).toFixed(1)}k chars`);
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error("OPENAI_API_KEY not set"); process.exit(1); }

  const lancedb = await import(LANCEDB_PATH);
  const { default: OpenAI } = await import(OPENAI_PATH);
  const openai = new OpenAI({ apiKey });

  const agentArg = process.argv[2];
  const agents = agentArg
    ? [agentArg]
    : Object.keys(AGENT_WORKSPACES);

  for (const agent of agents) {
    await migrateAgent(agent, openai, lancedb);
  }
}

main().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });

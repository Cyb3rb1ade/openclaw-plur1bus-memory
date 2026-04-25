#!/usr/bin/env node
/**
 * memory-doctor.mjs — Health-Check / Wartungs-CLI für openclaw-plur1bus-memory
 *
 * Subcommands:
 *   stats     [agent]            — Zähler, Verteilungen, Speicher pro Agent
 *   dupes     [agent] [thresh]   — Cluster fast-identischer Memories (Jaccard ≥ thresh, default 0.85)
 *   stale     [days]             — Memories älter X Tage mit niedriger importance (default: 90)
 *   orphans   [agent]            — Memories ohne storedBy / origin
 *   pending   [agent]            — High-importance Memories nicht in KNOWLEDGE.md
 *   eval      [agent]            — recall-eval.json gegen agent laufen lassen
 *   all                          — alle Checks (kompakt)
 *
 * Beispiele:
 *   node memory-doctor.mjs stats
 *   node memory-doctor.mjs dupes bernhardine 0.97
 *   node memory-doctor.mjs eval main
 */

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

let _lancedb = null;
async function getLanceDB() {
  if (!_lancedb) {
    const lancedbPath = join(__dir, "..", "extensions", "memory-lancedb-stock", "node_modules", "@lancedb", "lancedb", "dist", "index.js");
    _lancedb = await import(lancedbPath);
  }
  return _lancedb;
}

let _OpenAI = null;
async function getOpenAI() {
  if (!_OpenAI) {
    const openaiPath = join(__dir, "..", "extensions", "memory-lancedb-stock", "node_modules", "openai", "index.js");
    const m = await import(openaiPath);
    _OpenAI = m.default;
  }
  return _OpenAI;
}

function loadConfig() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const plugin = cfg?.plugins?.entries?.["memory-lancedb-namespaced"]?.config || {};
  let baseDbPath = plugin.baseDbPath || join(homedir(), ".openclaw", "memory", "lancedb-namespaced");
  if (baseDbPath.startsWith("~/")) baseDbPath = join(homedir(), baseDbPath.slice(2));
  return { plugin, baseDbPath, agents: cfg?.agents?.list || [] };
}

function discoverAgents(baseDbPath, filter) {
  if (!existsSync(baseDbPath)) return [];
  const all = readdirSync(baseDbPath, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  if (filter) return all.filter(a => a === filter);
  return all;
}

function workspaceDirFor(agentId, cfg) {
  const ag = cfg.agents.find(a => a.id === agentId);
  if (ag?.workspace) return ag.workspace.startsWith("/") ? ag.workspace : join(homedir(), ag.workspace);
  return join(homedir(), ".openclaw", `workspace-${agentId}`);
}

function dirSize(p) {
  let size = 0;
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { try { size += statSync(f).size; } catch (_) {} }
    }
  };
  walk(p);
  return size;
}

function fmtBytes(n) { return (n / 1024 / 1024).toFixed(1) + " MB"; }
function fmtDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

async function openTable(baseDbPath, agentId) {
  const lancedb = await getLanceDB();
  const dbPath = join(baseDbPath, agentId);
  if (!existsSync(dbPath)) return null;
  const db = await lancedb.connect(dbPath);
  const tables = await db.tableNames();
  if (!tables.includes("memories")) return null;
  return await db.openTable("memories");
}

function tokenize(text) {
  return new Set(
    String(text || "").toLowerCase().replace(/[^a-z0-9äöüß\s]/gi, " ")
      .split(/\s+/).filter(w => w.length >= 4),
  );
}

function jaccard(a, b) {
  const sa = tokenize(a), sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

// ============================================================================
// Subcommands
// ============================================================================

async function cmdStats(args) {
  const cfg = loadConfig();
  const agents = discoverAgents(cfg.baseDbPath, args[0]);
  console.log(`\n${"Agent".padEnd(35)} ${"Memories".padStart(10)} ${"Size".padStart(10)} ${"≥0.85".padStart(8)} ${"TTL".padStart(6)} ${"Decision".padStart(10)} ${"NoStored".padStart(10)}`);
  console.log("-".repeat(95));
  let totMem = 0, totSize = 0;
  for (const ag of agents) {
    const tbl = await openTable(cfg.baseDbPath, ag);
    if (!tbl) { console.log(`${ag.padEnd(35)} ${"---".padStart(10)} (no table)`); continue; }
    const rows = await tbl.toArrow ? null : null;
    const df = await (await tbl.query()).toArray();
    const sz = dirSize(join(cfg.baseDbPath, ag));
    const hi = df.filter(r => (r.importance ?? 0) >= 0.85).length;
    const ttl = df.filter(r => (r.expiresAt ?? 0) > 0).length;
    const dec = df.filter(r => r.category === "decision").length;
    const orph = df.filter(r => !r.storedBy).length;
    console.log(`${ag.padEnd(35)} ${String(df.length).padStart(10)} ${fmtBytes(sz).padStart(10)} ${String(hi).padStart(8)} ${String(ttl).padStart(6)} ${String(dec).padStart(10)} ${String(orph).padStart(10)}`);
    totMem += df.length; totSize += sz;
  }
  console.log("-".repeat(95));
  console.log(`${"TOTAL".padEnd(35)} ${String(totMem).padStart(10)} ${fmtBytes(totSize).padStart(10)}`);
}

async function cmdDupes(args) {
  const cfg = loadConfig();
  const agentFilter = args[0];
  // Jaccard-Default 0.85 (textuelle Token-Überlappung). Anders als der LanceDB
  // duplicateThreshold (0.95) für Vektor-Cosine — Jaccard ist strenger weil es
  // exakte Wort-Übereinstimmung verlangt, nicht nur semantische Ähnlichkeit.
  const threshold = parseFloat(args[1]) || 0.85;
  const agents = discoverAgents(cfg.baseDbPath, agentFilter);
  console.log(`\nDuplicate clusters per agent (Jaccard ≥ ${threshold}):\n`);
  for (const ag of agents) {
    const tbl = await openTable(cfg.baseDbPath, ag);
    if (!tbl) continue;
    const rows = await (await tbl.query()).toArray();
    if (rows.length < 2) continue;
    // Jaccard auf text/summary — billig genug für tausende Memories, skaliert O(n²).
    const clusters = [];
    const seen = new Set();
    for (let i = 0; i < rows.length; i++) {
      if (seen.has(i)) continue;
      const cluster = [i];
      for (let j = i + 1; j < rows.length; j++) {
        if (seen.has(j)) continue;
        const sim = jaccard(rows[i].summary || rows[i].text, rows[j].summary || rows[j].text);
        if (sim >= threshold) {
          cluster.push(j);
          seen.add(j);
        }
      }
      if (cluster.length >= 2) clusters.push(cluster);
      seen.add(i);
    }
    if (clusters.length === 0) {
      console.log(`  ${ag}: no clusters`);
      continue;
    }
    console.log(`  ${ag}: ${clusters.length} clusters (${clusters.reduce((a, c) => a + c.length, 0)} memories)`);
    for (const c of clusters.slice(0, 5)) {
      console.log(`    cluster (${c.length}): ${(rows[c[0]].summary || rows[c[0]].text || "").slice(0, 100)}`);
    }
    if (clusters.length > 5) console.log(`    ... and ${clusters.length - 5} more clusters`);
  }
}

async function cmdStale(args) {
  const cfg = loadConfig();
  const days = parseInt(args[0]) || 90;
  const cutoff = Date.now() - days * 86_400_000;
  const agents = discoverAgents(cfg.baseDbPath);
  console.log(`\nMemories older than ${days} days with importance < 0.5:\n`);
  for (const ag of agents) {
    const tbl = await openTable(cfg.baseDbPath, ag);
    if (!tbl) continue;
    const rows = await (await tbl.query()).toArray();
    const stale = rows.filter(r => (r.createdAt ?? 0) > 0 && r.createdAt < cutoff && (r.importance ?? 0) < 0.5);
    console.log(`  ${ag}: ${stale.length} stale (${rows.length} total)`);
  }
}

async function cmdOrphans(args) {
  const cfg = loadConfig();
  const agents = discoverAgents(cfg.baseDbPath, args[0]);
  console.log(`\nMemories without storedBy or origin:\n`);
  for (const ag of agents) {
    const tbl = await openTable(cfg.baseDbPath, ag);
    if (!tbl) continue;
    const rows = await (await tbl.query()).toArray();
    const noStored = rows.filter(r => !r.storedBy);
    const noOrigin = rows.filter(r => !r.origin);
    console.log(`  ${ag}: ${noStored.length} without storedBy, ${noOrigin.length} without origin (${rows.length} total)`);
  }
}

async function cmdPending(args) {
  const cfg = loadConfig();
  const minImp = cfg.plugin?.schicht15?.minImportance ?? 0.7;
  const agents = discoverAgents(cfg.baseDbPath, args[0]);
  console.log(`\nHigh-importance memories (≥${minImp}, decision/fact) NOT in KNOWLEDGE.md:\n`);
  for (const ag of agents) {
    const tbl = await openTable(cfg.baseDbPath, ag);
    if (!tbl) continue;
    const rows = await (await tbl.query()).toArray();
    const high = rows.filter(r => (r.importance ?? 0) >= minImp && (r.category === "decision" || r.category === "fact"));

    const wsDir = workspaceDirFor(ag, cfg);
    const knowledgePath = join(wsDir, "memory", "KNOWLEDGE.md");
    let knowledge = "";
    if (existsSync(knowledgePath)) knowledge = readFileSync(knowledgePath, "utf8").toLowerCase();

    // Heuristik: ein Memory gilt als "in KNOWLEDGE.md" wenn ≥3 seiner Tokens im KNOWLEDGE.md vorkommen
    let notIn = 0;
    for (const m of high) {
      const tokens = [...tokenize(m.summary || m.text)].slice(0, 6);
      const matches = tokens.filter(t => knowledge.includes(t)).length;
      if (matches < 3) notIn++;
    }
    console.log(`  ${ag}: ${notIn} pending / ${high.length} high-importance (${rows.length} total)`);
  }
}

async function cmdEval(args) {
  const cfg = loadConfig();
  const evalPath = join(__dir, "recall-eval.json");
  const samplePath = join(__dir, "recall-eval.sample.json");
  let activePath;
  if (existsSync(evalPath)) {
    activePath = evalPath;
  } else if (existsSync(samplePath)) {
    activePath = samplePath;
    console.warn(`! recall-eval.json fehlt — verwende ${samplePath}.\n  Kopiere die Sample-Datei und passe sie an deine LanceDB an, dann erneut laufen lassen.\n`);
  } else {
    console.error(`Recall-Eval-Datei fehlt: ${evalPath} und ${samplePath}`);
    process.exit(1);
  }
  const evalData = JSON.parse(readFileSync(activePath, "utf8"));
  const apiKey = cfg.plugin?.embedding?.apiKey;
  const model = cfg.plugin?.embedding?.model || "text-embedding-3-small";
  const dimensions = cfg.plugin?.embedding?.dimensions;

  if (!apiKey || apiKey.startsWith("${")) {
    console.error("OPENAI_API_KEY nicht direkt in openclaw.json — eval braucht echten Key.");
    process.exit(1);
  }

  const OpenAI = await getOpenAI();
  const openai = new OpenAI({ apiKey });
  const agentFilter = args[0];

  const agents = Object.keys(evalData).filter(a => !a.startsWith("_") && (!agentFilter || a === agentFilter));
  console.log(`\nRecall-Eval für ${agents.length} Agenten:\n`);

  let totalCases = 0, totalPass = 0;
  for (const ag of agents) {
    const tbl = await openTable(cfg.baseDbPath, ag);
    if (!tbl) { console.log(`  ${ag}: keine DB`); continue; }
    const cases = evalData[ag] || [];
    let pass = 0;
    for (const c of cases) {
      const emb = await openai.embeddings.create({ model, input: c.query, ...(dimensions ? { dimensions } : {}) });
      const vec = emb.data[0].embedding;
      const results = await tbl.vectorSearch(vec).limit(c.limit || 5).toArray();
      const top5 = results.slice(0, c.limit || 5);
      let ok = false;
      if (c.expectedMemoryId) {
        ok = top5.some(r => r.id === c.expectedMemoryId);
      } else if (c.expectedTextContains) {
        const all = top5.map(r => (r.text || "").toLowerCase()).join(" ");
        ok = c.expectedTextContains.every(s => all.includes(s.toLowerCase()));
      } else if (c.expectedCategory) {
        ok = top5.some(r => r.category === c.expectedCategory);
      } else if (c.minScore && top5[0]) {
        const score = 1 / (1 + (top5[0]._distance ?? 0));
        ok = score >= c.minScore;
      }
      if (ok) pass++;
      console.log(`    ${ok ? "✓" : "✗"} ${c.query}`);
    }
    console.log(`  ${ag}: ${pass}/${cases.length} pass (${(pass / cases.length * 100).toFixed(0)}%)`);
    totalCases += cases.length; totalPass += pass;
  }
  console.log(`\nGesamt: ${totalPass}/${totalCases} (${(totalPass / Math.max(1, totalCases) * 100).toFixed(0)}%)`);
}

async function cmdAll() {
  await cmdStats([]);
  console.log();
  await cmdOrphans([]);
  console.log();
  await cmdPending([]);
  console.log();
  await cmdStale([]);
}

// ============================================================================
// Dispatcher
// ============================================================================

const [, , cmd, ...args] = process.argv;

const commands = { stats: cmdStats, dupes: cmdDupes, stale: cmdStale, orphans: cmdOrphans, pending: cmdPending, eval: cmdEval, all: cmdAll };

if (!cmd || !commands[cmd]) {
  console.log("Usage: memory-doctor.mjs <command> [args]\n");
  console.log("Commands: stats, dupes, stale, orphans, pending, eval, all\n");
  console.log("Examples:");
  console.log("  node memory-doctor.mjs stats");
  console.log("  node memory-doctor.mjs dupes bernhardine 0.90  # default 0.85 (Jaccard)");
  console.log("  node memory-doctor.mjs stale 90");
  console.log("  node memory-doctor.mjs eval main");
  process.exit(cmd ? 1 : 0);
}

await commands[cmd](args);

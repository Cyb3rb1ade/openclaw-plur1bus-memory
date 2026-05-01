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
 *   eval      [agent] [mode]     — mode = "raw" (default, nur LanceDB) oder "pipeline" (volle Live-Pipeline mit Canonical/Boost/Dedup/Rerank)
 *   provider-check               — validiert Embedding-Endpoint, Modell, Dim, DB-Dim-Konsistenz
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
    const lancedbPath = resolveStockDependency("@lancedb", "lancedb", "dist", "index.js");
    _lancedb = await import(lancedbPath);
  }
  return _lancedb;
}

let _OpenAI = null;
async function getOpenAI() {
  if (!_OpenAI) {
    const openaiPath = resolveStockDependency("openai", "index.js");
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

function resolveStockDependency(...parts) {
  const candidates = [
    join(__dir, "..", "extensions", "memory-lancedb-stock", "node_modules", ...parts),
    join(homedir(), ".openclaw", "extensions", "memory-lancedb-stock", "node_modules", ...parts),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(`Missing memory-lancedb-stock dependency: ${parts.join("/")}`);
  }
  return found;
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
  // Argumente: cmdEval(["agent?", "raw|pipeline?"])
  // Default-Mode: raw (Backward-kompatibel zu v1.8.x)
  const agentFilter = args[0] && !["raw", "pipeline"].includes(args[0]) ? args[0] : null;
  const mode = args.find(a => ["raw", "pipeline"].includes(a)) || "raw";

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
    console.error("API-Key (OPENAI/OPENROUTER) nicht direkt in openclaw.json — eval braucht echten Key.");
    process.exit(1);
  }

  // v2.1.0: baseUrl unterstützt OpenRouter und andere OpenAI-kompatible Endpunkte
  const baseUrl = cfg.plugin?.embedding?.baseUrl;
  const OpenAI = await getOpenAI();
  const openai = new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  if (baseUrl) console.log(`(Eval nutzt baseUrl: ${baseUrl})`);

  // Pipeline-Mode: lade shared module + recall-config aus openclaw.json
  let runRecallPipeline, recallCfg, rerankerInstance;
  if (mode === "pipeline") {
    const pipelineMod = await import("../extensions/memory-lancedb-namespaced/lib/recall-pipeline.js");
    runRecallPipeline = pipelineMod.runRecallPipeline;
    recallCfg = cfg.plugin?.recall || {};
    // Reranker konfigurieren wenn aktiv
    const rrCfg = cfg.plugin?.reranker;
    if (rrCfg?.enabled !== false && rrCfg?.apiKey) {
      const rrKey = rrCfg.apiKey.startsWith("${")
        ? process.env[rrCfg.apiKey.replace(/^\$\{|}$/g, "")]
        : rrCfg.apiKey;
      if (rrKey) {
        rerankerInstance = {
          async rerank(query, documents, topN) {
            const r = await fetch("https://api.cohere.com/v2/rerank", {
              method: "POST",
              headers: { "Authorization": `Bearer ${rrKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({ model: rrCfg.model || "rerank-v3.5", query, documents, top_n: topN, return_documents: false }),
            });
            if (!r.ok) throw new Error(`rerank ${r.status}`);
            return (await r.json()).results;
          },
        };
      }
    }
  }

  const agents = Object.keys(evalData).filter(a => !a.startsWith("_") && (!agentFilter || a === agentFilter));
  console.log(`\nRecall-Eval [${mode}] für ${agents.length} Agenten:\n`);

  let totalCases = 0, totalPass = 0;
  for (const ag of agents) {
    const tbl = await openTable(cfg.baseDbPath, ag);
    if (!tbl) { console.log(`  ${ag}: keine DB`); continue; }
    const cases = evalData[ag] || [];
    let pass = 0;
    for (const c of cases) {
      const limit = c.limit || 5;
      let collectedTexts = [];   // alle Texte für expectedTextContains
      let topIds = [];           // alle IDs für expectedMemoryId
      let topCategories = [];    // für expectedCategory
      let topScore = 0;          // für minScore

      // v2.1.0: encoding_format=float für OpenRouter-Kompatibilität
      const isOpenAi = !model.includes("/") || model.startsWith("openai/") || model.startsWith("text-embedding-");
      const buildEmbReq = (input) => {
        const r = { model, input, encoding_format: "float" };
        if (isOpenAi && dimensions) r.dimensions = dimensions;
        return r;
      };

      if (mode === "raw") {
        const emb = await openai.embeddings.create(buildEmbReq(c.query));
        const vec = emb.data[0].embedding;
        const results = await tbl.vectorSearch(vec).limit(limit).toArray();
        collectedTexts = results.map(r => (r.text || "").toLowerCase());
        topIds = results.map(r => r.id);
        topCategories = results.map(r => r.category);
        if (results[0]) topScore = 1 / (1 + (results[0]._distance ?? 0));
      } else {
        // Pipeline-Mode: exakt was Auto-Recall live tut
        const embeddings = {
          dim: dimensions,
          embed: async (text) => {
            const r = await openai.embeddings.create(buildEmbReq(text));
            return Array.from(r.data[0].embedding);
          },
        };
        const workspaceDir = workspaceDirFor(ag, cfg);
        const r = await runRecallPipeline({
          query: c.query,
          dbTable: tbl,
          embeddings,
          workspaceDir,
          topN: limit,
          recallMinScore: cfg.plugin?.recallMinScore ?? 0.15,
          importanceBoost: recallCfg.importanceBoost ?? 0.3,
          dedupEnabled: recallCfg.dedup !== false,
          dedupJaccard: recallCfg.dedupJaccard ?? 0.6,
          canonicalEnabled: recallCfg.canonicalFirst !== false,
          canonicalMinScore: recallCfg.canonicalMinScore ?? 0.30,
          canonicalMaxItems: recallCfg.canonicalMaxItems ?? 2,
          reranker: rerankerInstance,
          rerankCandidates: cfg.plugin?.reranker?.candidates ?? 20,
        });
        // Sammle Texte aus canonical + memories für die Match-Checks
        for (const cn of r.canonical) collectedTexts.push((cn.text || "").toLowerCase());
        for (const m of r.memories) collectedTexts.push((m.entry.text || "").toLowerCase());
        topIds = r.memories.map(m => m.entry.id);
        topCategories = r.memories.map(m => m.entry.category);
        if (r.memories[0]) topScore = r.memories[0].score;
        else if (r.canonical[0]) topScore = r.canonical[0].score;
      }

      let ok = false;
      if (c.expectedMemoryId) {
        ok = topIds.includes(c.expectedMemoryId);
      } else if (c.expectedTextContains) {
        const all = collectedTexts.join(" ");
        ok = c.expectedTextContains.every(s => all.includes(s.toLowerCase()));
      } else if (c.expectedCategory) {
        ok = topCategories.includes(c.expectedCategory);
      } else if (c.minScore) {
        ok = topScore >= c.minScore;
      }
      if (ok) pass++;
      console.log(`    ${ok ? "✓" : "✗"} ${c.query}`);
    }
    console.log(`  ${ag}: ${pass}/${cases.length} pass (${(pass / cases.length * 100).toFixed(0)}%)`);
    totalCases += cases.length; totalPass += pass;
  }
  console.log(`\nGesamt [${mode}]: ${totalPass}/${totalCases} (${(totalPass / Math.max(1, totalCases) * 100).toFixed(0)}%)`);
}

async function cmdProviderCheck(args) {
  // v2.1.1: validiert komplettes Embedding-Setup gegen alle Agent-DBs.
  // Prüft: API erreichbar, Modell antwortet, Dim stimmt mit allen DBs überein.
  const cfg = loadConfig();
  const emb = cfg.plugin?.embedding;
  if (!emb) { console.error("Keine embedding-Config gefunden."); process.exit(1); }

  const apiKey = emb.apiKey?.startsWith("${")
    ? process.env[emb.apiKey.replace(/^\$\{|}$/g, "")]
    : emb.apiKey;
  const baseUrl = emb.baseUrl || null;
  const model = emb.model;
  const configDim = emb.dimensions;

  console.log(`\n=== Embedding-Provider-Check ===\n`);
  console.log(`Endpoint:      ${baseUrl || "https://api.openai.com/v1 (default)"}`);
  console.log(`Modell:        ${model}`);
  console.log(`Config-Dim:    ${configDim || "(nicht gesetzt — wird aus EMBEDDING_DIMENSIONS-Map default)"}`);
  console.log(`API-Key:       ${apiKey ? `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}` : "(fehlt!)"}`);
  console.log();

  if (!apiKey) {
    console.error("✗ API-Key fehlt oder ENV-Variable nicht gesetzt.");
    process.exit(1);
  }

  // Test 1: Embedding-Call
  console.log("[1/3] Test-Embedding-Call …");
  const OpenAI = await getOpenAI();
  const client = new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  const isOpenAi = !model.includes("/") || model.startsWith("openai/") || model.startsWith("text-embedding-");
  const req = { model, input: "provider-check probe", encoding_format: "float" };
  if (isOpenAi && configDim) req.dimensions = configDim;
  let actualDim;
  try {
    const r = await client.embeddings.create(req);
    actualDim = r.data[0].embedding.length;
    console.log(`     ✓ Modell antwortet, ${actualDim}-dim Vektoren`);
  } catch (e) {
    console.error(`     ✗ Embedding-Call fehlgeschlagen: ${e.message}`);
    process.exit(1);
  }

  // Test 2: Config-Dim vs. tatsächliche Dim
  console.log(`\n[2/3] Config-Dim Konsistenz …`);
  if (configDim && configDim !== actualDim) {
    console.error(`     ✗ Config sagt ${configDim}, API liefert ${actualDim}. Korrigiere openclaw.json!`);
    process.exit(1);
  } else if (configDim === actualDim) {
    console.log(`     ✓ Config (${configDim}) = API (${actualDim})`);
  } else {
    console.log(`     ⚠ Config-Dim leer, API liefert ${actualDim} — ergänze 'dimensions: ${actualDim}' in openclaw.json`);
  }

  // Test 3: Alle bestehenden Agent-DBs auf Dim-Mismatch prüfen
  console.log(`\n[3/3] Bestehende Agent-DBs vs. API-Dim ${actualDim} …`);
  const agents = discoverAgents(cfg.baseDbPath);
  let mismatch = 0;
  for (const ag of agents) {
    const tbl = await openTable(cfg.baseDbPath, ag);
    if (!tbl) continue;
    try {
      const schema = await tbl.schema();
      const vecField = schema.fields.find(f => f.name === "vector");
      // FixedSizeList<3072> oder ähnlich — extract size aus type
      const dimStr = vecField?.type?.toString().match(/\d+/)?.[0];
      const dbDim = dimStr ? parseInt(dimStr) : null;
      if (dbDim === null) {
        console.log(`     ? ${ag}: Schema-Dim nicht ermittelbar`);
      } else if (dbDim === actualDim) {
        console.log(`     ✓ ${ag}: ${dbDim} = ${actualDim}`);
      } else {
        console.log(`     ✗ ${ag}: DB hat ${dbDim}, API liefert ${actualDim} — store/recall werden brechen!`);
        mismatch++;
      }
    } catch (e) {
      console.log(`     ? ${ag}: ${e.message}`);
    }
  }

  console.log();
  if (mismatch > 0) {
    console.error(`⚠ ${mismatch} Agent-DB(s) mit Dim-Mismatch — Provider/Modell-Wechsel wahrscheinlich. Optionen:`);
    console.error(`  1. Wechsel rückgängig (auf altes Modell zurück)`);
    console.error(`  2. Fresh-DB pro Agent: rm -r /pfad/zu/lancedb-namespaced/<agent>/ — Dreaming/Migrate/embed-promoted füllt sie wieder`);
    process.exit(1);
  }
  console.log(`✓ Provider-Check bestanden (${agents.length} Agenten geprüft, alle DB-Dim = ${actualDim})`);
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

const commands = { stats: cmdStats, dupes: cmdDupes, stale: cmdStale, orphans: cmdOrphans, pending: cmdPending, eval: cmdEval, "provider-check": cmdProviderCheck, all: cmdAll };

if (!cmd || !commands[cmd]) {
  console.log("Usage: memory-doctor.mjs <command> [args]\n");
  console.log("Commands: stats, dupes, stale, orphans, pending, eval, provider-check, all\n");
  console.log("Examples:");
  console.log("  node memory-doctor.mjs stats");
  console.log("  node memory-doctor.mjs dupes bernhardine 0.90  # default 0.85 (Jaccard)");
  console.log("  node memory-doctor.mjs stale 90");
  console.log("  node memory-doctor.mjs eval main          # default 'raw' (Vektorsuche pur)");
  console.log("  node memory-doctor.mjs eval main pipeline # volle Live-Pipeline (Canonical+Boost+Rerank+Dedup)");
  process.exit(cmd ? 1 : 0);
}

await commands[cmd](args);

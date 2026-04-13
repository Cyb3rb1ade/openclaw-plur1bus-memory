/**
 * memory-lancedb-namespaced
 *
 * Per-agent isolation: jeder Agent bekommt seine eigene LanceDB unter {baseDbPath}/{agentId}/
 * Gleiche API wie memory-lancedb, aber mit ctx.agentId routing.
 *
 * HINWEIS: Auto-Capture ist deaktiviert, da OpenClaw keinen "agent_end" Hook unterstützt.
 * Stattdessen: Agents sollen memory_store Tool verwenden für wichtige Informationen.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pfade relativ zum Plugin-Verzeichnis auflösen — funktioniert unabhängig vom Installations-Prefix
const __pluginDir = dirname(fileURLToPath(import.meta.url));
const LANCEDB_PATH = join(__pluginDir, "../memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js");
const OPENAI_PATH  = join(__pluginDir, "../memory-lancedb-stock/node_modules/openai/index.js");

const DEFAULT_BASE_DB_PATH = join(homedir(), ".openclaw", "memory", "lancedb-namespaced");
const DEFAULT_MODEL = "text-embedding-3-small";

const EMBEDDING_DIMENSIONS = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

const TABLE_NAME = "memories";
const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"];
const MEMORY_ORIGINS = ["dm", "group", "cron", "internal"];

// Lazy-loaded modules
let _lancedb = null;
let _OpenAI = null;

// ============================================================================
// Reranker — Cohere Rerank API v2
// ============================================================================

class Reranker {
  constructor(apiKey, model = "rerank-v3.5") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async rerank(query, documents, topN) {
    if (!documents || documents.length === 0) return [];

    const response = await fetch("https://api.cohere.com/v2/rerank", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents,
        top_n: topN,
        return_documents: false,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Cohere rerank failed (${response.status}): ${err}`);
    }

    const data = await response.json();
    // Returns [{index, relevance_score}, ...]  sorted by relevance_score desc
    return data.results;
  }
}

async function getLanceDB() {
  if (!_lancedb) _lancedb = await import(LANCEDB_PATH);
  return _lancedb;
}

async function getOpenAI() {
  if (!_OpenAI) {
    const m = await import(OPENAI_PATH);
    _OpenAI = m.default;
  }
  return _OpenAI;
}

function resolveEnvVars(value) {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const v = process.env[envVar];
    if (!v) throw new Error(`Environment variable ${envVar} is not set`);
    return v;
  });
}

// ============================================================================
// Summary generation — no LLM, pure text truncation (for metadata fields)
// ============================================================================

function generateSummary(text, maxWords = 75) {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text;
  const truncated = words.slice(0, maxWords).join(' ');
  const lastPunct = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? ')
  );
  if (lastPunct > truncated.length * 0.6) return truncated.slice(0, lastPunct + 1);
  return truncated + '…';
}

// ============================================================================
// LLM-based summarization for long messages (auto-capture)
// ============================================================================

async function summarizeForCapture(text, maxChars, llmCfg, logger) {
  try {
    const result = await callLlm([
      {
        role: "user",
        content: `Summarize this text into the most important facts, decisions, preferences, and actionable information. Keep all specific names, numbers, URLs, dates, technical details, and configuration values. Output ONLY the summary, no preamble. Target length: ${Math.round(maxChars / 4)} characters.\n\n${text.slice(0, 60000)}`,
      },
    ], { ...llmCfg, maxTokens: Math.round(maxChars / 3) });
    if (result && result.length > 20) return result;
  } catch (e) {
    if (logger) logger.warn(`memory-lancedb-namespaced: summarize failed (${e.message}), falling back to truncation`);
  }
  // Fallback: truncate if LLM fails
  return text.slice(0, maxChars);
}

// ============================================================================
// MemoryDB — pro Agent eine Instanz
// ============================================================================

class MemoryDB {
  constructor(dbPath, vectorDim) {
    this.dbPath = dbPath;
    this.vectorDim = vectorDim;
    this.db = null;
    this.table = null;
    this.initPromise = null;
  }

  async init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const lancedb = await getLanceDB();
      this.db = await lancedb.connect(this.dbPath);
      const tables = await this.db.tableNames();
      if (tables.includes(TABLE_NAME)) {
        this.table = await this.db.openTable(TABLE_NAME);
        // Migrate: add missing columns
        try {
          const schema = await this.table.schema();
          const hasSum = schema.fields.some(f => f.name === 'summary');
          if (!hasSum) {
            await this.table.addColumns([{ name: 'summary', valueSql: "''" }]);
          }
          const hasOrigin = schema.fields.some(f => f.name === 'origin');
          if (!hasOrigin) {
            await this.table.addColumns([{ name: 'origin', valueSql: "'dm'" }]);
          }
          const hasMergedFrom = schema.fields.some(f => f.name === 'mergedFrom');
          if (!hasMergedFrom) {
            await this.table.addColumns([{ name: 'mergedFrom', valueSql: "'[]'" }]);
          }
          const hasExpiresAt = schema.fields.some(f => f.name === 'expiresAt');
          if (!hasExpiresAt) {
            await this.table.addColumns([{ name: 'expiresAt', valueSql: '0' }]);
          }
          const hasStoredBy = schema.fields.some(f => f.name === 'storedBy');
          if (!hasStoredBy) {
            await this.table.addColumns([{ name: 'storedBy', valueSql: "''" }]);
          }
        } catch (_e) { /* older LanceDB version — graceful degradation */ }
      } else {
        this.table = await this.db.createTable(TABLE_NAME, [
          {
            id: "__schema__",
            text: "",
            summary: "",
            origin: "dm",
            vector: Array(this.vectorDim).fill(0),
            importance: 0,
            category: "other",
            createdAt: 0,
            mergedFrom: "[]",
            expiresAt: 0,
            storedBy: "",
          },
        ]);
        await this.table.delete('id = "__schema__"');
      }
    })();
    return this.initPromise;
  }

  async store(entry) {
    await this.init();
    await this.table.add([{ ...entry, id: entry.id || randomUUID() }]);
  }

  async search(vector, limit = 5, minScore = 0.3) {
    await this.init();
    const count = await this.table.countRows();
    if (count === 0) return [];
    const results = await this.table.vectorSearch(vector).limit(limit).toArray();
    const mapped = results.map((r) => ({
      entry: {
        id: r.id,
        text: r.text,
        summary: r.summary || "",
        origin: r.origin || "dm",
        category: r.category,
        importance: r.importance,
        createdAt: r.createdAt,
      },
      score: 1 / (1 + (r._distance ?? 0)),
    }));
    return mapped.filter((r) => r.score >= minScore);
  }

  async findSimilar(vector, text, threshold = 0.95) {
    await this.init();
    const count = await this.table.countRows();
    if (count === 0) return [];
    const results = await this.table.vectorSearch(vector).limit(10).toArray();
    return results
      .filter((r) => {
        const score = 1 / (1 + (r._distance ?? 0));
        return score >= threshold || r.text === text;
      })
      .map((r) => ({ entry: r, score: 1 / (1 + (r._distance ?? 0)) }));
  }

  async findMergeCandidate(vector, mergeThreshold, duplicateThreshold) {
    await this.init();
    const count = await this.table.countRows();
    if (count === 0) return null;
    const results = await this.table.vectorSearch(vector).limit(5).toArray();
    const candidates = results
      .map(r => ({ entry: { id: r.id, text: r.text, importance: r.importance ?? 0.5, storedBy: r.storedBy || "" }, score: 1 / (1 + (r._distance ?? 0)) }))
      .filter(r => r.score >= mergeThreshold && r.score < duplicateThreshold)
      .sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  async delete(id) {
    await this.init();
    // Validate UUID format before interpolating into SQL — prevents injection
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }
    await this.table.delete(`id = "${id}"`);
  }

  async purgeExpired() {
    await this.init();
    const now = Date.now();
    if (!Number.isFinite(now) || now < 0) throw new Error(`Invalid timestamp: ${now}`);
    await this.table.delete(`expiresAt > 0 AND expiresAt < ${now}`);
  }
}

class AgentDbPool {
  constructor(basePath, vectorDim) {
    this.basePath = basePath;
    this.vectorDim = vectorDim;
    this.dbs = new Map();
  }

  getDb(agentId) {
    const id = agentId || "default";
    if (!this.dbs.has(id)) {
      const dbPath = join(this.basePath, id);
      this.dbs.set(id, new MemoryDB(dbPath, this.vectorDim));
    }
    return this.dbs.get(id);
  }
}

class Embeddings {
  constructor(apiKey, model, baseUrl, dimensions, fallbackCfg) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.dimensions = dimensions;
    this._client = null;
    // fallbackCfg: { apiKey, model, baseUrl } — must produce same dimensions as primary
    this._fallbackCfg = fallbackCfg || null;
    this._fallbackClient = null;
  }

  async getClient() {
    if (!this._client) {
      const OpenAI = await getOpenAI();
      this._client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseUrl,
      });
    }
    return this._client;
  }

  async getFallbackClient() {
    if (!this._fallbackClient && this._fallbackCfg) {
      const OpenAI = await getOpenAI();
      this._fallbackClient = new OpenAI({
        apiKey: this._fallbackCfg.apiKey,
        baseURL: this._fallbackCfg.baseUrl,
      });
    }
    return this._fallbackClient;
  }

  async embed(text, retries = 3) {
    const client = await this.getClient();
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await client.embeddings.create({
          model: this.model,
          input: text,
          dimensions: this.dimensions,
        });
        return response.data[0].embedding;
      } catch (err) {
        lastErr = err;
        if (attempt === retries) break;
        const isRateLimit = err?.status === 429 || String(err).includes("rate");
        const delay = isRateLimit ? Math.min(1000 * 2 ** attempt, 16000) : 500 * (attempt + 1);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    // Primary failed — try fallback if configured
    const fallbackClient = await this.getFallbackClient();
    if (fallbackClient && this._fallbackCfg) {
      try {
        const response = await fallbackClient.embeddings.create({
          model: this._fallbackCfg.model || this.model,
          input: text,
          dimensions: this.dimensions, // must match primary — same dim constraint
        });
        return response.data[0].embedding;
      } catch (fallbackErr) {
        // Both failed — throw original error for clarity
        throw lastErr;
      }
    }
    throw lastErr;
  }
}

function categorizeMemory(text) {
  const lower = text.toLowerCase();
  if (/prefer|like|love|hate|want|always|never|usually|tend to/.test(lower)) return "preference";
  if (/decided|will use|going with|chosen|picked/.test(lower)) return "decision";
  if (/is |are |was |were |has |have |\d{4}/.test(lower)) return "fact";
  if (/name:|person:|company:|product:|place:/.test(lower)) return "entity";
  return "other";
}

const DISPLAY_SOURCES = new Set(["group", "cron", "internal"]);

function formatRelevantMemoriesContext(memories) {
  if (!memories || memories.length === 0) return "";
  const items = memories.map((m) => {
    const src = DISPLAY_SOURCES.has(m.source) ? `|${m.source}` : "";
    return `  - [${m.category}${src}] ${m.display} (ID: ${m.id})`;
  }).join("\n");
  return `<relevant-memories>\n${items}\n</relevant-memories>`;
}

function textSuggestsGroupOrigin(text) {
  if (!text || typeof text !== "string") return false;
  return (
    /"is_group_chat"\s*:\s*true/.test(text) ||
    /"group_subject"\s*:/.test(text) ||
    /"group_channel"\s*:/.test(text) ||
    /Guild #/i.test(text) ||
    /\[Discord Guild /i.test(text)
  );
}

// ============================================================================
// Curation-Log
// ============================================================================

function appendCurationLog(workspaceDir, agentId, entry) {
  try {
    const dir = join(workspaceDir, ".adaptive-learning");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "curation-log.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch (_) { /* non-blocking — log errors silently */ }
}

function appendConflictLog(workspaceDir, entry) {
  try {
    const dir = join(workspaceDir, ".adaptive-learning");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "conflict-log.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    console.warn("[conflict-log] write failed:", e?.message);
  }
}

// ============================================================================
// LLM helper — shared for merge-check and KNOWLEDGE.md updates
// ============================================================================

async function callLlm(messages, llmCfg) {
  const OpenAI = await getOpenAI();
  const clientOpts = { apiKey: llmCfg.apiKey, baseURL: llmCfg.baseUrl };
  if (llmCfg.headers) clientOpts.defaultHeaders = llmCfg.headers;
  const client = new OpenAI(clientOpts);
  const body = {
    model: llmCfg.model,
    temperature: 0,
    max_tokens: llmCfg.maxTokens || 300,
    ...(llmCfg.jsonMode ? { response_format: { type: "json_object" } } : {}),
    messages,
  };
  // Disable thinking for reasoning models (kimi-for-coding, etc.)
  if (llmCfg.disableThinking) {
    body.thinking = { budget_tokens: 0 };
  }
  const response = await client.chat.completions.create(body);
  return response.choices[0]?.message?.content?.trim() || null;
}

async function callMergeCheck(existingText, newText, llmCfg) {
  const content = await callLlm([
    {
      role: "user",
      content: `Two memory fragments — should they be merged into one?\n\nFragment A: ${existingText}\nFragment B: ${newText}\n\nRespond with JSON only: {"merge": boolean, "reason": "brief explanation", "mergedText": "merged version (only if merge=true)"}\nRules:\n- merge=true only if both fragments describe the same subject/fact from different angles\n- mergedText must contain ALL information from both fragments\n- mergedText must be longer than the shorter of the two fragments`,
    },
  ], { ...llmCfg, jsonMode: true, maxTokens: 300 });
  if (!content) return null;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (_) {
    return null; // LLM returned invalid JSON — treat as no-merge
  }
  // Schema-Validierung: merge muss boolean sein, reason string, mergedText optional string
  if (typeof parsed?.merge !== "boolean" || typeof parsed?.reason !== "string") return null;
  if (parsed.merge && typeof parsed.mergedText !== "string") return null;
  return parsed;
}

// ============================================================================
// Schicht 1.5 — Pending-Tracking & knowledge_update
// ============================================================================

const KNOWLEDGE_PENDING_FILE = "knowledge-pending.json";
const KNOWLEDGE_LOCK_FILE    = "knowledge-update.lock";
const KNOWLEDGE_MD_FILE      = "memory/KNOWLEDGE.md";

function readKnowledgePending(workspaceDir) {
  try {
    const p = join(workspaceDir, ".adaptive-learning", KNOWLEDGE_PENDING_FILE);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  } catch (_) {}
  return { pendingCount: 0, pendingMemoryIds: [], lastUpdateAt: null, lastStoreAt: null };
}

function trackKnowledgePending(workspaceDir, memoryId) {
  try {
    const dir  = join(workspaceDir, ".adaptive-learning");
    const p    = join(dir, KNOWLEDGE_PENDING_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const state = readKnowledgePending(workspaceDir);
    state.pendingCount = Math.min((state.pendingCount || 0) + 1, 1000);
    state.pendingMemoryIds = [...(state.pendingMemoryIds || []), memoryId].slice(-50);
    state.lastStoreAt = new Date().toISOString();
    writeFileSync(p, JSON.stringify(state, null, 2), "utf8");
  } catch (_) {}
}

function clearKnowledgePending(workspaceDir) {
  try {
    const p = join(workspaceDir, ".adaptive-learning", KNOWLEDGE_PENDING_FILE);
    const state = readKnowledgePending(workspaceDir);
    state.pendingCount      = 0;
    state.pendingMemoryIds  = [];
    state.lastUpdateAt      = new Date().toISOString();
    writeFileSync(p, JSON.stringify(state, null, 2), "utf8");
  } catch (_) {}
}

// ============================================================================
// Schicht 1.5 — KNOWLEDGE.md
// ============================================================================

async function updateKnowledgeMd(workspaceDir, text, category, importance, llmCfg, logger) {
  if (!workspaceDir || !llmCfg) return;
  const memDir = join(workspaceDir, "memory");
  const knowledgePath = join(memDir, "KNOWLEDGE.md");

  let currentContent = "";
  try {
    if (existsSync(knowledgePath)) currentContent = readFileSync(knowledgePath, "utf8");
  } catch (_) {}

  const today = new Date().toISOString().slice(0, 10);

  const updated = await callLlm([
    {
      role: "user",
      content: `Here is the current KNOWLEDGE.md (empty = not yet created):\n${currentContent || "(empty)"}\n\nNew memory (category=${category}, importance=${importance.toFixed(1)}, date=${today}):\n${text}\n\nIntegrate this information into the KNOWLEDGE.md.\n- Add a new entry under the appropriate section with today's date.\n- If an existing entry is logically identical, replace it instead of adding a duplicate.\n- Change NOTHING else.\n- Return ONLY the updated Markdown, no code block wrapper.`,
    },
  ], { ...llmCfg, maxTokens: 3000 });

  if (!updated) return;

  let finalContent = updated;

  if (finalContent.split("\n").length > 200) {
    const compacted = await callLlm([
      {
        role: "user",
        content: `The following KNOWLEDGE.md has grown too large (>200 lines). Consolidate it thematically — do NOT simply truncate.\n\nRules:\n1. Keep ALL unique facts and decisions — lose no information.\n2. Group thematically related entries under a shared point.\n3. Structure: Domain → Category → consolidated fact (Context-Tree style).\n4. If multiple entries describe the same concept from different angles, write one entry covering all aspects.\n5. Keep the date of the oldest merged entry.\n6. Target: max 150 lines, achieved only through real consolidation.\n7. Return ONLY the updated Markdown, no code block wrapper.\n\n${finalContent}`,
      },
    ], { ...llmCfg, maxTokens: 4000 });

    const compactedLines = compacted?.split("\n").length ?? Infinity;
    if (compacted && compactedLines <= 150) {
      finalContent = compacted;
    } else {
      logger?.warn?.(`memory-lancedb-namespaced: KNOWLEDGE.md compaction skipped: result (${compactedLines} lines) not ≤150`);
      // Write the uncompacted updated version anyway
    }
  }

  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
  // Atomic write: write to temp file, then rename
  const tmpPath = knowledgePath + ".tmp";
  writeFileSync(tmpPath, finalContent, "utf8");
  renameSync(tmpPath, knowledgePath);
}

// ============================================================================
// Plugin Definition
// ============================================================================

const plugin = {
  id: "memory-lancedb-namespaced",
  name: "Memory (LanceDB, per-Agent)",
  description: "Per-agent isolated LanceDB memory",
  kind: "extension",

  register(api) {
    const cfg = api.pluginConfig || {};

    const embeddingCfg = cfg.embedding || {};
    const apiKey = resolveEnvVars(embeddingCfg.apiKey || "${OPENAI_API_KEY}");
    const model = embeddingCfg.model || DEFAULT_MODEL;
    const baseUrl = embeddingCfg.baseUrl;
    const dimensions = embeddingCfg.dimensions;
    const fallbackEmbeddingCfg = embeddingCfg.fallback
      ? {
          apiKey: resolveEnvVars(embeddingCfg.fallback.apiKey || "${OPENAI_API_KEY_FALLBACK}"),
          model: embeddingCfg.fallback.model || model,
          baseUrl: embeddingCfg.fallback.baseUrl,
        }
      : null;
    if (fallbackEmbeddingCfg) api.logger.info(`memory-lancedb-namespaced: embedding fallback configured (${fallbackEmbeddingCfg.model} @ ${fallbackEmbeddingCfg.baseUrl || "openai"})`);
    const autoRecall = cfg.autoRecall !== false;

    // Configurable thresholds
    const recallMinScore     = cfg.recallMinScore     ?? 0.15;
    const autoRecallMinScore = cfg.autoRecallMinScore ?? 0.2;
    const duplicateThreshold = cfg.duplicateThreshold ?? 0.95;
    const forgetThreshold    = cfg.forgetThreshold    ?? 0.3;
    const summaryMaxWords    = cfg.summaryMaxWords    ?? 150;

    // GC config
    const gcCfg = cfg.gc || {};
    const gcEnabled = gcCfg.enabled !== false; // default true

    // TTL presets
    const TTL_MAP = { session: 86_400_000, short: 14 * 86_400_000 };

    // Merging config
    const mergingCfg = cfg.merging || {};
    const mergingEnabled = mergingCfg.enabled === true;
    const mergingThreshold = mergingCfg.threshold ?? 0.70;
    const mergingLlmCfg = mergingEnabled ? {
      model: mergingCfg.model || "kimi-for-coding",
      baseUrl: mergingCfg.baseUrl || undefined,
      apiKey: mergingCfg.apiKey ? resolveEnvVars(mergingCfg.apiKey) : apiKey,
      disableThinking: mergingCfg.disableThinking ?? false,
      headers: mergingCfg.headers || undefined,
    } : null;
    if (mergingEnabled) api.logger.info(`memory-lancedb-namespaced: merging enabled (threshold: ${mergingThreshold}, model: ${mergingLlmCfg.model})`);

    // Schicht 1.5 config
    const schicht15Cfg = cfg.schicht15 || {};
    const schicht15Enabled = schicht15Cfg.enabled === true;
    const schicht15MinImportance = schicht15Cfg.minImportance ?? 0.7;
    const schicht15LlmCfg = schicht15Enabled ? {
      model: schicht15Cfg.model || mergingCfg.model || "kimi-for-coding",
      baseUrl: schicht15Cfg.baseUrl || mergingCfg.baseUrl || undefined,
      apiKey: schicht15Cfg.apiKey ? resolveEnvVars(schicht15Cfg.apiKey) : (mergingLlmCfg?.apiKey || apiKey),
      disableThinking: schicht15Cfg.disableThinking ?? mergingCfg.disableThinking ?? false,
      headers: schicht15Cfg.headers || mergingCfg.headers || undefined,
    } : null;
    if (schicht15Enabled) api.logger.info(`memory-lancedb-namespaced: schicht15 enabled (minImportance: ${schicht15MinImportance})`)

    const vectorDim = dimensions ?? (EMBEDDING_DIMENSIONS[model] || 1536);
    const baseDbPath = api.resolvePath(cfg.baseDbPath || DEFAULT_BASE_DB_PATH);

    const pool = new AgentDbPool(baseDbPath, vectorDim);
    const embeddings = new Embeddings(apiKey, model, baseUrl, dimensions, fallbackEmbeddingCfg);

    // Per-agent capture queue — serializes concurrent agent_end events to prevent DB race conditions
    const captureQueues = new Map(); // agentId → Promise (tail of queue)
    function enqueueCapture(agentId, fn) {
      const prev = captureQueues.get(agentId) || Promise.resolve();
      const next = prev.then(fn).catch(() => {}); // errors are non-blocking
      captureQueues.set(agentId, next);
      // Prevent unbounded queue growth — replace tail once resolved
      next.then(() => { if (captureQueues.get(agentId) === next) captureQueues.delete(agentId); });
    }

    // Reranker (optional — nur wenn konfiguriert)
    const rerankerCfg = cfg.reranker || {};
    const rerankerEnabled = rerankerCfg.enabled !== false && !!rerankerCfg.apiKey;
    const reranker = rerankerEnabled
      ? new Reranker(resolveEnvVars(rerankerCfg.apiKey), rerankerCfg.model)
      : null;
    // Wie viele Kandidaten vor dem Re-Ranking holen (dann auf limit/top_n reduzieren)
    const rerankCandidates = rerankerCfg.candidates ?? 20;

    if (reranker) {
      api.logger.info(`memory-lancedb-namespaced: reranker enabled (model: ${rerankerCfg.model || "rerank-v3.5"})`);
    }

    api.logger.info(`memory-lancedb-namespaced: registered (baseDbPath: ${baseDbPath})`);

    // ========================================================================
    // Auto-Capture: Speichere User-Nachrichten automatisch
    // ========================================================================

    if (cfg.autoCapture) {
      api.logger.info(`memory-lancedb-namespaced: enabling autoCapture`);

      api.on("agent_end", (event, ctx) => {
        api.logger.info(`memory-lancedb-namespaced: agent_end hook fired`);

        if (!event.success || !event.messages || event.messages.length === 0) {
          api.logger.info(`memory-lancedb-namespaced: skipping capture - success=${event.success}, messages=${event.messages?.length || 0}`);
          return;
        }

        const agentId = ctx?.agentId || "default";
        const db = pool.getDb(agentId);

        enqueueCapture(agentId, async () => {

        try {
          // Extrahiere Text aus User- und Assistant-Nachrichten
          const maxChars = cfg.captureMaxChars || 15000;
          const texts = [];
          const userUrlTexts = []; // User-Nachrichten mit URLs — immer priorisieren
          const urlPattern = /https?:\/\/[^\s]{10,}/;

          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") continue;
            const isUser = msg.role === "user";
            const isAssistant = msg.role === "assistant";
            if (!isUser && !isAssistant) continue;

            const content = msg.content;

            // String Content — collect as-is (summarization happens later for oversized texts)
            if (typeof content === "string") {
              if (content && content.length > 20) {
                texts.push(content);
                if (isUser && urlPattern.test(content)) userUrlTexts.push(content);
              }
              continue;
            }

            // Array Content (content blocks)
            if (Array.isArray(content)) {
              for (const block of content) {
                if (!block || typeof block !== "object") continue;

                if (
                  block.type === "text" &&
                  typeof block.text === "string" &&
                  block.text.length > 20
                ) {
                  texts.push(block.text);
                  if (isUser && urlPattern.test(block.text)) userUrlTexts.push(block.text);
                  continue;
                }

                // Non-text blocks (image, document, file, etc.) — mindestens als Stub erfassen
                if (isUser && block.type && block.type !== "text") {
                  const name = block.name || block.fileName || block.filename || "";
                  const mediaType = block.mediaType || block.mimeType || block.mime_type || "";
                  const stub = [
                    `[User schickte ${block.type}`,
                    name ? `: ${name}` : "",
                    mediaType ? ` (${mediaType})` : "",
                    "]",
                  ].join("").trim();
                  if (stub.length > 20) {
                    texts.push(stub);
                    userUrlTexts.push(stub); // Attachments wie URLs priorisieren
                  }
                }
              }
            }
          }

          if (texts.length === 0) {
            api.logger.info(`memory-lancedb-namespaced: no texts to capture`);
            return;
          }

          api.logger.info(`memory-lancedb-namespaced: found ${texts.length} texts to capture for agent=${agentId}`);
          const captureOrigin = texts.some((text) => textSuggestsGroupOrigin(text)) ? "group" : "dm";

          // Priorisierung: User-Nachrichten mit URLs zuerst (max 3), dann neueste Texte (max 5)
          // Gesamt-Cap: 8. Verhindert dass frühe Link-Nachrichten von späteren Antworten verdrängt werden.
          const seen = new Set();
          const captureList = [];
          for (const t of [...userUrlTexts.slice(-3), ...texts.slice(-5)]) {
            if (!seen.has(t)) { seen.add(t); captureList.push(t); }
            if (captureList.length >= 8) break;
          }

          let stored = 0;
          let skipped = 0;

          for (let text of captureList) {
            try {
              // Oversized texts: LLM-summarize (or truncate as fallback)
              if (text.length > maxChars) {
                if (mergingLlmCfg) {
                  api.logger.info(`memory-lancedb-namespaced: summarizing oversized text (${text.length} chars) for agent=${agentId}`);
                  text = await summarizeForCapture(text, maxChars, mergingLlmCfg, api.logger);
                } else {
                  text = text.slice(0, maxChars);
                }
              }

              const vector = await embeddings.embed(text);

              // Duplikat-Check
              const existing = await db.search(vector, 1, duplicateThreshold);
              if (existing.length > 0) {
                skipped++;
                continue;
              }

              const category = categorizeMemory(text);
              const summary = generateSummary(text, summaryMaxWords);

              await db.store({
                id: randomUUID(),
                text,
                summary,
                origin: captureOrigin,
                vector,
                importance: 0.7,
                category,
                createdAt: Date.now(),
                mergedFrom: "[]",
                expiresAt: 0,
                storedBy: agentId,
              });
              stored++;
              api.logger.info(`memory-lancedb-namespaced: stored memory [${category}|${captureOrigin}] for agent=${agentId}`);
            } catch (err) {
              api.logger.warn(`memory-lancedb-namespaced: failed to store capture: ${String(err)}`);
            }
          }

          api.logger.info(`memory-lancedb-namespaced: capture complete - stored=${stored}, skipped=${skipped}`);
        } catch (err) {
          api.logger.warn(`memory-lancedb-namespaced: capture failed for agent=${agentId}: ${String(err)}`);
        }
        }); // enqueueCapture
      });
    }

    // ========================================================================
    // Tools (per-Agent via Factory)
    // ========================================================================

    api.registerTool((ctx) => {
      const agentId = ctx.agentId;
      const db = pool.getDb(agentId);

      return [
        {
          name: "memory_recall",
          label: "Memory Recall",
          description: "Search through long-term memories. Use when you need context about user preferences, past decisions, or previously discussed topics.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "What to search for in memory" },
              limit: { type: "number", description: "Max results (default 5)" },
              full_text: { type: "boolean", description: "Return full text instead of summary (default false)" },
            },
            required: ["query"],
          },
          async execute(_toolCallId, params) {
            try {
              const limit = params.limit || 5;
              const vector = await embeddings.embed(params.query);
              // Mit Reranker: mehr Kandidaten holen, dann re-ranken
              const fetchLimit = reranker ? Math.max(rerankCandidates, limit * 3) : limit;
              const results = await db.search(vector, fetchLimit, recallMinScore);
              if (results.length === 0) return { content: [{ type: "text", text: "No relevant memories found." }] };

              let ordered = results;
              if (reranker && results.length > 1) {
                try {
                  const docs = results.map((r) => r.entry.summary || generateSummary(r.entry.text, summaryMaxWords));
                  const reranked = await reranker.rerank(params.query, docs, limit);
                  ordered = reranked.map((r) => results[r.index]);
                } catch (rerr) {
                  api.logger.warn(`memory-lancedb-namespaced: rerank failed, falling back to vector order: ${String(rerr)}`);
                  ordered = results.slice(0, limit);
                }
              } else {
                ordered = results.slice(0, limit);
              }

              const fullText = params.full_text === true;
              const text = ordered.map((r) => {
                const display = fullText
                  ? r.entry.text
                  : (r.entry.summary || generateSummary(r.entry.text, summaryMaxWords));
                const orig = DISPLAY_SOURCES.has(r.entry.origin) ? `|${r.entry.origin}` : "";
                return `[${r.entry.category}${orig}] ${display} (score: ${r.score.toFixed(2)}, ID: ${r.entry.id})`;
              }).join("\n");
              return { content: [{ type: "text", text }] };
            } catch (err) {
              return { content: [{ type: "text", text: `Memory recall failed: ${String(err)}` }] };
            }
          },
        },
        {
          name: "memory_store",
          label: "Memory Store",
          description: "Save important information in long-term memory. Use for preferences, facts, decisions. IMPORTANT: Proactively store significant user information! Set origin='group' when storing from a group chat so future recall shows the origin context.",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string", description: "Information to remember" },
              category: { type: "string", enum: MEMORY_CATEGORIES, description: "Memory category" },
              importance: { type: "number", description: "Importance 0-1 (default 0.5)" },
              origin: { type: "string", enum: MEMORY_ORIGINS, description: "Origin context: 'dm' = direct message (default), 'group' = Telegram group chat, 'cron' = background job, 'internal' = agent-generated. ALWAYS set 'group' when storing from a group chat!" },
              ttl: { type: "string", enum: ["session", "short"], description: "Memory lifetime: 'session' = until tomorrow, 'short' = 14 days. Omit for permanent storage." },
            },
            required: ["text"],
          },
          async execute(_toolCallId, params) {
            try {
              const vector = await embeddings.embed(params.text);
              const category = params.category || categorizeMemory(params.text);
              const origin = MEMORY_ORIGINS.includes(params.origin) ? params.origin : "dm";
              const importance = params.importance ?? 0.5;
              const expiresAt = params.ttl && TTL_MAP[params.ttl] ? Date.now() + TTL_MAP[params.ttl] : 0;

              // 1. Duplicate check
              const existing = await db.findSimilar(vector, params.text, duplicateThreshold);
              if (existing.length > 0) {
                if (ctx.workspaceDir) appendCurationLog(ctx.workspaceDir, agentId, { event: "memory.rejected_duplicate", timestamp: new Date().toISOString(), agentId, memoryId: existing[0].entry.id, text: params.text.slice(0, 200), category, origin, reason: `duplicate_score:${existing[0].score.toFixed(3)}`, relatedId: existing[0].entry.id });
                return { content: [{ type: "text", text: `Similar memory already exists: "${existing[0].entry.text}"` }] };
              }

              // 2. Merge check (+ conflict detection for decision category)
              if (mergingEnabled && mergingLlmCfg) {
                const mergeCandidate = await db.findMergeCandidate(vector, mergingThreshold, duplicateThreshold);
                if (mergeCandidate) {
                  let mergeResult = null;
                  try {
                    mergeResult = await Promise.race([
                      callMergeCheck(mergeCandidate.entry.text, params.text, mergingLlmCfg),
                      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 30000)),
                    ]);
                  } catch (mergeErr) {
                    api.logger.warn(`memory-lancedb-namespaced: merge check skipped: ${String(mergeErr)}`);
                  }
                  // Conflict detection: log if decision from different agent
                  if (category === "decision" && ctx.workspaceDir && mergeCandidate.entry.storedBy && mergeCandidate.entry.storedBy !== agentId) {
                    const mergeDecision = mergeResult?.merge === true ? "merged" : "stored_separately";
                    appendConflictLog(ctx.workspaceDir, { schemaVersion: 1, timestamp: new Date().toISOString(), newMemoryId: null, newAgentId: agentId, newText: params.text.slice(0, 200), existingMemoryId: mergeCandidate.entry.id, existingAgentId: mergeCandidate.entry.storedBy, existingText: mergeCandidate.entry.text.slice(0, 200), score: mergeCandidate.score, category, mergeDecision });
                  }
                  const minLen = Math.min(mergeCandidate.entry.text.length, params.text.length);
                  if (mergeResult?.merge === true && mergeResult.mergedText && mergeResult.mergedText.length > minLen) {
                    await db.delete(mergeCandidate.entry.id);
                    const mergedVector = await embeddings.embed(mergeResult.mergedText);
                    const mergedEntry = { id: randomUUID(), text: mergeResult.mergedText, summary: generateSummary(mergeResult.mergedText, summaryMaxWords), origin, vector: mergedVector, importance: Math.max(importance, mergeCandidate.entry.importance), category, createdAt: Date.now(), mergedFrom: JSON.stringify([mergeCandidate.entry.id]), expiresAt, storedBy: agentId };
                    await db.store(mergedEntry);
                    if (ctx.workspaceDir) appendCurationLog(ctx.workspaceDir, agentId, { event: "memory.merged", timestamp: new Date().toISOString(), agentId, memoryId: mergedEntry.id, text: mergeResult.mergedText.slice(0, 200), category, origin, reason: `merged_with:${mergeCandidate.entry.id} (${mergeResult.reason || ""})`, relatedId: mergeCandidate.entry.id });
                    if (ctx.workspaceDir && Math.max(importance, mergeCandidate.entry.importance) >= schicht15MinImportance && (category === "decision" || category === "fact")) {
                      trackKnowledgePending(ctx.workspaceDir, mergedEntry.id);
                    }
                    return { content: [{ type: "text", text: `Memory merged [${category}|${origin}]: "${mergeResult.mergedText}" (ID: ${mergedEntry.id})` }], details: { action: "merged", id: mergedEntry.id } };
                  }
                }
              } else if (category === "decision" && ctx.workspaceDir) {
                // Merging disabled: read-only conflict check for decision memories
                try {
                  const conflictCandidate = await db.findMergeCandidate(vector, mergingThreshold, duplicateThreshold);
                  if (conflictCandidate && conflictCandidate.entry.storedBy && conflictCandidate.entry.storedBy !== agentId) {
                    appendConflictLog(ctx.workspaceDir, { schemaVersion: 1, timestamp: new Date().toISOString(), newMemoryId: null, newAgentId: agentId, newText: params.text.slice(0, 200), existingMemoryId: conflictCandidate.entry.id, existingAgentId: conflictCandidate.entry.storedBy, existingText: conflictCandidate.entry.text.slice(0, 200), score: conflictCandidate.score, category, mergeDecision: "no_merge_llm_call" });
                  }
                } catch (_) {}
              }

              // 3. Normal store
              const summary = generateSummary(params.text, summaryMaxWords);
              const entry = { id: randomUUID(), text: params.text, summary, origin, vector, importance, category, createdAt: Date.now(), mergedFrom: "[]", expiresAt, storedBy: agentId };
              await db.store(entry);
              if (ctx.workspaceDir) appendCurationLog(ctx.workspaceDir, agentId, { event: "memory.stored", timestamp: new Date().toISOString(), agentId, memoryId: entry.id, text: params.text.slice(0, 200), category, origin, reason: "stored", relatedId: null });
              if (ctx.workspaceDir && importance >= schicht15MinImportance && (category === "decision" || category === "fact")) {
                trackKnowledgePending(ctx.workspaceDir, entry.id);
              }
              return { content: [{ type: "text", text: `Memory stored [${category}|${origin}]: ${summary} (ID: ${entry.id})` }], details: { action: "stored", id: entry.id } };
            } catch (err) {
              return { content: [{ type: "text", text: `Memory store failed: ${String(err)}` }] };
            }
          },
        },
        {
          name: "memory_forget",
          label: "Memory Forget",
          description: "Remove a memory from long-term storage.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search to find memory" },
              memoryId: { type: "string", description: "Specific memory ID" },
            },
          },
          async execute(_toolCallId, params) {
            try {
              if (params.memoryId) {
                await db.delete(params.memoryId);
                return { content: [{ type: "text", text: `Memory ${params.memoryId} forgotten.` }] };
              }
              if (params.query) {
                const vector = await embeddings.embed(params.query);
                const results = await db.search(vector, 5, forgetThreshold);
                if (results.length === 0) return { content: [{ type: "text", text: "No matching memory found." }] };
                if (results.length > 1) {
                  const list = results.map((r) => `${r.entry.id}: ${r.entry.text}`).join("\n");
                  return { content: [{ type: "text", text: `Found ${results.length} candidates. Specify memoryId:\n${list}` }] };
                }
                await db.delete(results[0].entry.id);
                return { content: [{ type: "text", text: `Forgotten: "${results[0].entry.text}"` }] };
              }
              return { content: [{ type: "text", text: "Provide query or memoryId." }] };
            } catch (err) {
              return { content: [{ type: "text", text: `Memory forget failed: ${String(err)}` }] };
            }
          },
        },
        {
          name: "knowledge_update",
          label: "Knowledge Update",
          description: "Curate important memories (decisions, high-importance facts) into KNOWLEDGE.md. Call this when you make an architecture decision, formulate a stable preference, complete a project, or store something with importance ≥ 0.85. Only available when Schicht 1.5 is enabled.",
          parameters: {
            type: "object",
            properties: {
              note: { type: "string", description: "Optional context note for this update run" },
            },
          },
          async execute(_toolCallId, params) {
            if (!schicht15Enabled || !schicht15LlmCfg) {
              return { content: [{ type: "text", text: "Schicht 1.5 is not enabled. Enable it in plugin config." }] };
            }
            if (!ctx.workspaceDir) {
              return { content: [{ type: "text", text: "knowledge_update: workspaceDir not available." }] };
            }

            // Mutex via lock file — atomic acquire with wx flag (exclusive create)
            const lockPath = join(ctx.workspaceDir, ".adaptive-learning", KNOWLEDGE_LOCK_FILE);
            // Staleness check: remove lock files older than 5 minutes (crash recovery)
            if (existsSync(lockPath)) {
              try {
                const lockAge = Date.now() - statSync(lockPath).mtimeMs;
                if (lockAge > 5 * 60 * 1000) {
                  const { unlinkSync } = await import("node:fs");
                  unlinkSync(lockPath);
                  api.logger.warn("memory-lancedb-namespaced: removed stale knowledge lock file");
                } else {
                  return { content: [{ type: "text", text: "knowledge_update: another update is already running (lock file exists). Try again in a moment." }] };
                }
              } catch (_) {
                return { content: [{ type: "text", text: "knowledge_update: lock file check failed. Try again." }] };
              }
            }
            try {
              // Atomic lock acquire with exponential backoff retry
              const { closeSync } = await import("node:fs");
              let acquired = false;
              for (let attempt = 0; attempt < 5; attempt++) {
                try {
                  const fd = openSync(lockPath, "wx");
                  writeFileSync(fd, new Date().toISOString());
                  closeSync(fd);
                  acquired = true;
                  break;
                } catch (lockErr) {
                  if (lockErr.code !== "EEXIST") throw lockErr;
                  // Lock exists — wait with backoff and retry
                  await new Promise(r => setTimeout(r, Math.min(100 * 2 ** attempt, 2000)));
                }
              }
              if (!acquired) {
                return { content: [{ type: "text", text: "knowledge_update: could not acquire lock after 5 attempts. Try again later." }] };
              }

              const pending = readKnowledgePending(ctx.workspaceDir);
              const pendingIds = pending.pendingMemoryIds || [];

              // Fetch pending memories from DB
              let pendingTexts = [];
              if (pendingIds.length > 0) {
                try {
                  await db.init();
                  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                  const safeIds = pendingIds.filter(id => uuidRe.test(id));
                  const rows = await db.table.query().where(`id IN (${safeIds.map(id => `'${id}'`).join(",")})`).toArray();
                  pendingTexts = rows.map(r => ({ id: r.id, text: r.text, category: r.category || "fact", importance: r.importance ?? 0.5 }));
                } catch (fetchErr) {
                  api.logger.warn(`memory-lancedb-namespaced: knowledge_update DB fetch failed: ${String(fetchErr)}`);
                }
              }

              if (pendingTexts.length === 0 && !params?.note) {
                clearKnowledgePending(ctx.workspaceDir);
                return { content: [{ type: "text", text: "No pending memories to integrate into KNOWLEDGE.md." }] };
              }

              // Build update prompt
              const memDir = join(ctx.workspaceDir, "memory");
              const knowledgePath = join(memDir, "KNOWLEDGE.md");
              let currentContent = "";
              try {
                if (existsSync(knowledgePath)) currentContent = readFileSync(knowledgePath, "utf8");
              } catch (_) {}

              const today = new Date().toISOString().slice(0, 10);
              const newEntriesBlock = pendingTexts.length > 0
                ? pendingTexts.map(m => `- category=${m.category}, importance=${m.importance.toFixed(1)}: ${m.text}`).join("\n")
                : `(no pending memories — manual trigger${params?.note ? `: ${params.note}` : ""})`;

              const updated = await callLlm([
                {
                  role: "user",
                  content: `Here is the current KNOWLEDGE.md (empty = not yet created):\n${currentContent || "(empty)"}\n\nNew memories to integrate (date=${today}):\n${newEntriesBlock}${params?.note ? `\n\nCurator note: ${params.note}` : ""}\n\nIntegrate these into the KNOWLEDGE.md.\n- Add entries under appropriate sections with today's date.\n- If an existing entry is logically identical, replace it instead of adding a duplicate.\n- Change NOTHING else.\n- Return ONLY the updated Markdown, no code block wrapper.`,
                },
              ], { ...schicht15LlmCfg, maxTokens: 3000 });

              if (!updated) {
                return { content: [{ type: "text", text: "knowledge_update: LLM returned empty result." }] };
              }

              let finalContent = updated;

              // Compaction if >200 lines
              if (finalContent.split("\n").length > 200) {
                const compacted = await callLlm([
                  {
                    role: "user",
                    content: `The following KNOWLEDGE.md has grown too large (>200 lines). Consolidate it thematically — do NOT simply truncate.\n\nRules:\n1. Keep ALL unique facts and decisions — lose no information.\n2. Group thematically related entries under a shared point.\n3. Structure: Domain → Category → consolidated fact (Context-Tree style).\n4. If multiple entries describe the same concept from different angles, write one entry covering all aspects.\n5. Keep the date of the oldest merged entry.\n6. Target: max 150 lines, achieved only through real consolidation.\n7. Return ONLY the updated Markdown, no code block wrapper.\n\n${finalContent}`,
                  },
                ], { ...schicht15LlmCfg, maxTokens: 4000 });

                const compactedLines = compacted?.split("\n").length ?? Infinity;
                if (compacted && compactedLines <= 150) {
                  finalContent = compacted;
                  api.logger.info(`memory-lancedb-namespaced: KNOWLEDGE.md compacted to ${compactedLines} lines`);
                } else {
                  api.logger.warn(`memory-lancedb-namespaced: KNOWLEDGE.md compaction skipped: result (${compactedLines} lines) not ≤150`);
                }
              }

              // Atomic write
              if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
              const tmpPath = knowledgePath + ".tmp";
              writeFileSync(tmpPath, finalContent, "utf8");
              renameSync(tmpPath, knowledgePath);

              clearKnowledgePending(ctx.workspaceDir);

              const lineCount = finalContent.split("\n").length;
              return { content: [{ type: "text", text: `KNOWLEDGE.md updated (${pendingTexts.length} memories integrated, ${lineCount} lines total).` }] };
            } catch (err) {
              return { content: [{ type: "text", text: `knowledge_update failed: ${String(err)}` }] };
            } finally {
              // Release lock
              try { if (existsSync(lockPath)) { const { unlinkSync } = await import("node:fs"); unlinkSync(lockPath); } } catch (_) {}
            }
          },
        },
      ];
    });

    // ========================================================================
    // Auto-Recall: Memories beim Session-Start injizieren
    // ========================================================================

    if (autoRecall) {
      api.on("before_agent_start", async (event, ctx) => {
        if (!event.prompt || event.prompt.length < 5) return;
        const agentId = ctx?.agentId;
        const db = pool.getDb(agentId);
        // GC: purge expired memories (non-blocking)
        if (gcEnabled) {
          db.purgeExpired().catch(e => api.logger.warn(`memory-lancedb-namespaced: purgeExpired failed: ${String(e)}`));
        }
        try {
          const vector = await embeddings.embed(event.prompt);
          const topN = 5;
          const fetchLimit = reranker ? Math.max(rerankCandidates, topN * 3) : topN;
          const results = await db.search(vector, fetchLimit, autoRecallMinScore);
          if (results.length === 0) return;

          let ordered = results;
          if (reranker && results.length > 1) {
            try {
              const docs = results.map((r) => r.entry.summary || generateSummary(r.entry.text, summaryMaxWords));
              const reranked = await reranker.rerank(event.prompt, docs, topN);
              ordered = reranked.map((r) => results[r.index]);
            } catch (rerr) {
              api.logger.warn(`memory-lancedb-namespaced: auto-recall rerank failed, falling back: ${String(rerr)}`);
              ordered = results.slice(0, topN);
            }
          } else {
            ordered = results.slice(0, topN);
          }

          api.logger.info?.(`memory-lancedb-namespaced: injecting ${ordered.length} memories for agent=${agentId || "default"}${reranker ? " (reranked)" : ""}`);
          const memoriesContext = formatRelevantMemoriesContext(
            ordered.map((r) => ({
              id: r.entry.id,
              category: r.entry.category,
              source: r.entry.origin || "dm",
              display: r.entry.summary || generateSummary(r.entry.text, summaryMaxWords),
            })),
          );

          // Schicht 1.5 overlay nudge: remind agent to call knowledge_update if pending count is high
          let nudge = "";
          if (schicht15Enabled && ctx?.workspaceDir) {
            try {
              const pending = readKnowledgePending(ctx.workspaceDir);
              if ((pending.pendingCount || 0) >= 3) {
                const daysSince = pending.lastUpdateAt
                  ? Math.floor((Date.now() - new Date(pending.lastUpdateAt).getTime()) / 86400000)
                  : null;
                const staleNote = daysSince !== null && daysSince >= 7 ? ` (last update ${daysSince} days ago)` : "";
                nudge = `\n<knowledge-update-reminder>\n${pending.pendingCount} high-importance memories are pending KNOWLEDGE.md integration${staleNote}. Consider calling knowledge_update when you make an architectural decision, formulate a stable preference, or finish a project.\n</knowledge-update-reminder>`;
              }
            } catch (_) {}
          }

          // Conflict-log nudge: surface unreviewed conflicts when log is large or stale
          let conflictNudge = "";
          if (ctx?.workspaceDir) {
            try {
              const conflictLogPath = join(ctx.workspaceDir, ".adaptive-learning", "conflict-log.jsonl");
              if (existsSync(conflictLogPath)) {
                const stat = statSync(conflictLogPath);
                let showNudge = stat.size > 1_048_576;
                if (!showNudge) {
                  const firstLine = readFileSync(conflictLogPath, "utf8").split("\n").find(l => l.trim());
                  if (firstLine) {
                    const oldest = JSON.parse(firstLine);
                    if (Date.now() - new Date(oldest.timestamp).getTime() > 30 * 86_400_000) showNudge = true;
                  }
                }
                if (showNudge) {
                  const lines = readFileSync(conflictLogPath, "utf8").split("\n").filter(l => l.trim()).length;
                  const sizeKb = Math.round(stat.size / 1024);
                  conflictNudge = `\n<conflict-review-reminder>\n${lines} unreviewed decision-conflicts in conflict-log.jsonl (${sizeKb} KB). Bring this up proactively: "Ich habe ${lines} unaufgelöste Konflikte im Log — willst du die durchgehen?" Do NOT rotate or delete the log without explicit user confirmation.\n</conflict-review-reminder>`;
                }
              }
            } catch (_) {}
          }

          return { prependContext: memoriesContext + nudge + conflictNudge };
        } catch (err) {
          api.logger.warn(`memory-lancedb-namespaced: recall failed for agent=${agentId}: ${String(err)}`);
        }
      });
    } else if (schicht15Enabled || gcEnabled) {
      // Auto-recall is off — but inject nudges and run GC if applicable
      api.on("before_agent_start", async (_event, ctx) => {
        const agentId = ctx?.agentId;
        const db = pool.getDb(agentId);
        // GC: purge expired memories (non-blocking)
        if (gcEnabled) {
          db.purgeExpired().catch(e => api.logger.warn(`memory-lancedb-namespaced: purgeExpired failed: ${String(e)}`));
        }
        if (!ctx?.workspaceDir) return;

        let nudge = "";
        if (schicht15Enabled) {
          try {
            const pending = readKnowledgePending(ctx.workspaceDir);
            if ((pending.pendingCount || 0) >= 3) {
              const daysSince = pending.lastUpdateAt
                ? Math.floor((Date.now() - new Date(pending.lastUpdateAt).getTime()) / 86400000)
                : null;
              const staleNote = daysSince !== null && daysSince >= 7 ? ` (last update ${daysSince} days ago)` : "";
              nudge = `<knowledge-update-reminder>\n${pending.pendingCount} high-importance memories are pending KNOWLEDGE.md integration${staleNote}. Consider calling knowledge_update when you make an architectural decision, formulate a stable preference, or finish a project.\n</knowledge-update-reminder>`;
            }
          } catch (_) {}
        }

        let conflictNudge = "";
        try {
          const conflictLogPath = join(ctx.workspaceDir, ".adaptive-learning", "conflict-log.jsonl");
          if (existsSync(conflictLogPath)) {
            const stat = statSync(conflictLogPath);
            let showNudge = stat.size > 1_048_576;
            if (!showNudge) {
              const firstLine = readFileSync(conflictLogPath, "utf8").split("\n").find(l => l.trim());
              if (firstLine) {
                const oldest = JSON.parse(firstLine);
                if (Date.now() - new Date(oldest.timestamp).getTime() > 30 * 86_400_000) showNudge = true;
              }
            }
            if (showNudge) {
              const lines = readFileSync(conflictLogPath, "utf8").split("\n").filter(l => l.trim()).length;
              const sizeKb = Math.round(stat.size / 1024);
              conflictNudge = `\n<conflict-review-reminder>\n${lines} unreviewed decision-conflicts in conflict-log.jsonl (${sizeKb} KB). Bring this up proactively: "Ich habe ${lines} unaufgelöste Konflikte im Log — willst du die durchgehen?" Do NOT rotate or delete the log without explicit user confirmation.\n</conflict-review-reminder>`;
            }
          }
        } catch (_) {}

        if (nudge || conflictNudge) {
          return { prependContext: nudge + conflictNudge };
        }
      });
    }

    // ========================================================================
    // HINWEIS: Auto-Capture ist deaktiviert
    // ========================================================================
    // OpenClaw unterstützt keinen "agent_end" oder "after_turn" Hook.
    // Stattdessen sollten Agents proaktiv memory_store verwenden.
    // Siehe AGENTS.md für Anweisungen.
  },
};

export default plugin;

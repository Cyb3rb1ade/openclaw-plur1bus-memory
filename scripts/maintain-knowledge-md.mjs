#!/usr/bin/env node
/**
 * maintain-knowledge-md.mjs
 *
 * Workspace-scoped Schicht 1.5 maintainer for KNOWLEDGE.md.
 * Reads all agent DBs that share a workspace, but writes only the single
 * workspace-level memory/KNOWLEDGE.md file.
 */

import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  parseSourceMemoryIds,
  stripFrontmatter,
  withFrontmatter,
} from "../extensions/memory-lancedb-namespaced/lib/frontmatter.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const BASE = join(homedir(), ".openclaw");
const CONFIG_PATH = join(BASE, "openclaw.json");
const KNOWLEDGE_MD_FILE = "memory/KNOWLEDGE.md";
const LOCK_FILE = "knowledge-update.lock";
const PENDING_LOCK_FILE = "knowledge-pending.lock";
const INTEGRATED_IDS_FILE = "knowledge-integrated-memory-ids.json";
const PENDING_FILE = "knowledge-pending.json";
const AUDIT_FILE = "knowledge-maintainer.jsonl";
const PENDING_CAP = 200;
const KNOWLEDGE_BACKUP_RETENTION = 30;
const PROMPT_SUMMARY_LIMIT = 900;
const PROMPT_TEXT_LIMIT = 1200;
const AUDIT_ARRAY_LIMIT = 50;
const LLM_MAX_ATTEMPTS = 3;
const DEFAULT_LLM_MAX_TOKENS = 8192;
const KIMI_THINKING_MAX_TOKENS = 32768;

const FALLBACK_AGENTS = [
  { id: "main", workspace: join(BASE, "workspace") },
  { id: "bernhardine", workspace: join(BASE, "workspace-bernhardine") },
  { id: "heisenberg", workspace: join(BASE, "workspace-heisenberg") },
];

let _lancedb = null;
let _OpenAI = null;

function usage() {
  console.log(`Usage:
  node maintain-knowledge-md.mjs --check [--agent <id>]
  node maintain-knowledge-md.mjs --backfill [--agent <id>] [--max 30] [--batch-size 10] [--dry-run]
  node maintain-knowledge-md.mjs --fresh [--agent <id>] [--max 10] [--batch-size 10] [--dry-run]

Modes:
  --check     Report fresh/historical pending counts. Default mode.
  --backfill  Integrate historical high-importance decision/fact memories.
  --fresh     Integrate only IDs listed in workspace .adaptive-learning/${PENDING_FILE}.
`);
}

function parseArgs(argv) {
  const args = {
    mode: null,
    agent: null,
    max: null,
    batchSize: 10,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      usage();
      process.exit(0);
    } else if (a === "--check" || a === "--backfill" || a === "--fresh") {
      const mode = a.slice(2);
      if (args.mode && args.mode !== mode) throw new Error(`Only one mode is allowed, got --${args.mode} and ${a}`);
      args.mode = mode;
    } else if (a === "--agent") {
      args.agent = argv[++i];
      if (!args.agent) throw new Error("--agent requires a value");
    } else if (a === "--max") {
      args.max = parsePositiveInt(argv[++i], "--max");
    } else if (a === "--batch-size") {
      args.batchSize = parsePositiveInt(argv[++i], "--batch-size");
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  args.mode ||= "check";
  args.max ||= args.mode === "fresh" ? 10 : 30;
  return args;
}

function parsePositiveInt(value, label) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} requires a positive integer`);
  return n;
}

function expandPath(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function normalizeWorkspace(p) {
  const expanded = expandPath(p);
  const absolute = isAbsolute(expanded) ? expanded : join(homedir(), expanded);
  try {
    return realpathSync(absolute);
  } catch (_) {
    return resolve(absolute);
  }
}

function loadConfig() {
  const cfg = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
  const plugin = cfg?.plugins?.entries?.["memory-lancedb-namespaced"]?.config || {};
  let baseDbPath = plugin.baseDbPath || join(BASE, "memory", "lancedb-namespaced");
  baseDbPath = normalizeWorkspace(baseDbPath);
  return { raw: cfg, plugin, baseDbPath, agents: cfg?.agents?.list || [] };
}

function resolveStockDependency(...parts) {
  const candidates = [
    join(__dir, "..", "extensions", "memory-lancedb-stock", "node_modules", ...parts),
    join(BASE, "extensions", "memory-lancedb-stock", "node_modules", ...parts),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`Missing memory-lancedb-stock dependency: ${parts.join("/")}`);
  return found;
}

async function getLanceDB() {
  if (!_lancedb) {
    const lancedbPath = resolveStockDependency("@lancedb", "lancedb", "dist", "index.js");
    _lancedb = await import(lancedbPath);
  }
  return _lancedb;
}

async function getOpenAI() {
  if (!_OpenAI) {
    const openaiPath = resolveStockDependency("openai", "index.js");
    const m = await import(openaiPath);
    _OpenAI = m.default;
  }
  return _OpenAI;
}

function hyphenCount(s) {
  return (s.match(/-/g) || []).length;
}

function betterPrimary(candidate, existing) {
  if (!existing) return true;
  if (hyphenCount(candidate) !== hyphenCount(existing)) return hyphenCount(candidate) < hyphenCount(existing);
  return candidate.length < existing.length;
}

function dbAgentIds(baseDbPath) {
  if (!existsSync(baseDbPath)) return [];
  return readdirSync(baseDbPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function discoverWorkspaces(cfg, agentFilter = null) {
  const dbIds = new Set(dbAgentIds(cfg.baseDbPath));
  const defaultWorkspace = normalizeWorkspace(cfg.raw?.agents?.defaults?.workspace || join(BASE, "workspace"));
  const entries = Array.isArray(cfg.agents) && cfg.agents.length > 0 ? cfg.agents : FALLBACK_AGENTS;
  const groups = new Map();
  const seenAgentIds = new Set();

  for (const entry of entries) {
    if (!entry?.id) continue;
    seenAgentIds.add(entry.id);
    const workspace = normalizeWorkspace(entry.workspace || defaultWorkspace);
    if (!groups.has(workspace)) groups.set(workspace, { workspace, primaryAgent: entry.id, agentIds: [] });
    const group = groups.get(workspace);
    if (betterPrimary(entry.id, group.primaryAgent)) group.primaryAgent = entry.id;
    if (dbIds.has(entry.id)) group.agentIds.push(entry.id);
  }

  for (const id of dbIds) {
    if (seenAgentIds.has(id)) continue;
    const workspace = normalizeWorkspace(join(BASE, `workspace-${id}`));
    groups.set(workspace, { workspace, primaryAgent: id, agentIds: [id] });
  }

  const result = [...groups.values()]
    .map((g) => ({ ...g, agentIds: [...new Set(g.agentIds)].sort() }))
    .filter((g) => g.agentIds.length > 0);

  if (!agentFilter) return result;
  const matching = result.filter((g) => g.primaryAgent === agentFilter || g.agentIds.includes(agentFilter));
  if (matching.length > 0) return matching;
  throw new Error(`No workspace found for agent: ${agentFilter}`);
}

async function openTable(baseDbPath, agentId) {
  const lancedb = await getLanceDB();
  const dbPath = join(baseDbPath, agentId);
  if (!existsSync(dbPath)) return null;
  const db = await lancedb.connect(dbPath);
  const tables = await db.tableNames();
  if (!tables.includes("memories")) return null;
  return await db.openTable("memories");
}

async function loadRowsForWorkspace(cfg, group) {
  const all = [];
  for (const agentId of group.agentIds) {
    const table = await openTable(cfg.baseDbPath, agentId);
    if (!table) continue;
    const rows = await (await table.query()).toArray();
    for (const row of rows) all.push({ ...row, _sourceAgent: agentId });
  }
  return all;
}

function tokenize(text) {
  return [...new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9äöüß\s]/gi, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  )];
}

function readJson(path, fallback) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  } catch (_) {}
  return fallback;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmpPath, path);
}

function adaptivePath(workspace, file) {
  return join(workspace, ".adaptive-learning", file);
}

function readKnowledge(workspace) {
  const path = join(workspace, KNOWLEDGE_MD_FILE);
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";
  const { frontmatter, body } = stripFrontmatter(content);
  return { path, content, frontmatter, body, lower: content.toLowerCase() };
}

function memoryKey(memory) {
  return `${memory._sourceAgent}:${memory.id}`;
}

function pendingKey(sourceAgent, memoryId) {
  return `${sourceAgent}:${memoryId}`;
}

function summaryHash(memory) {
  return createHash("sha256")
    .update(String(memory.summary || memory.text || ""))
    .digest("hex")
    .slice(0, 16);
}

function readIntegratedState(workspace) {
  const path = adaptivePath(workspace, INTEGRATED_IDS_FILE);
  const raw = readJson(path, { schema: 1, workspace, integrated: {} });
  const integrated = raw && typeof raw.integrated === "object" && !Array.isArray(raw.integrated)
    ? raw.integrated
    : {};
  return {
    path,
    state: {
      schema: 1,
      workspace,
      updatedAt: raw.updatedAt || null,
      updatedBy: raw.updatedBy || "maintain-knowledge-md",
      integrated,
    },
    keys: new Set(Object.keys(integrated)),
  };
}

function markIntegrated(state, memory, mode, now = new Date().toISOString()) {
  const key = memoryKey(memory);
  state.integrated[key] = {
    sourceAgent: memory._sourceAgent,
    memoryId: memory.id,
    integratedAt: now,
    mode,
    summaryHash: summaryHash(memory),
  };
  state.updatedAt = now;
  state.updatedBy = "maintain-knowledge-md";
  return key;
}

function saveIntegratedState(path, state) {
  const sorted = Object.fromEntries(Object.entries(state.integrated).sort(([a], [b]) => a.localeCompare(b)));
  writeJsonAtomic(path, { ...state, integrated: sorted });
}

function normalizePendingState(raw, workspace) {
  const now = new Date().toISOString();
  const pending = [];
  if (Array.isArray(raw?.pending)) {
    for (const item of raw.pending) {
      if (!item?.memoryId) continue;
      const sourceAgent = item.sourceAgent || null;
      pending.push({
        key: item.key || (sourceAgent ? pendingKey(sourceAgent, item.memoryId) : item.memoryId),
        sourceAgent,
        memoryId: item.memoryId,
        queuedAt: item.queuedAt || raw.lastStoreAt || now,
        reason: item.reason || (sourceAgent ? "schicht15-store-pending" : "legacy-pending-id"),
        category: item.category || "fact",
        importance: Number(item.importance ?? 0.5),
      });
    }
  }
  if (Array.isArray(raw?.pendingMemoryIds)) {
    for (const id of raw.pendingMemoryIds.filter(Boolean)) {
      pending.push({
        key: id,
        sourceAgent: null,
        memoryId: id,
        queuedAt: raw.lastStoreAt || now,
        reason: "legacy-pending-id",
        category: "fact",
        importance: 0.5,
      });
    }
  }
  const deduped = new Map();
  for (const item of pending) deduped.set(item.key, item);
  const sorted = [...deduped.values()].sort((a, b) => {
    const imp = (b.importance ?? 0) - (a.importance ?? 0);
    if (imp !== 0) return imp;
    return String(b.queuedAt || "").localeCompare(String(a.queuedAt || ""));
  });
  return {
    schema: 2,
    workspace,
    pending: sorted.slice(0, PENDING_CAP),
    pendingCount: Math.min(sorted.length, PENDING_CAP),
    pendingOverflowCount: Math.max(0, sorted.length - PENDING_CAP),
    lastStoreAt: raw?.lastStoreAt || null,
    lastUpdateAt: raw?.lastUpdateAt || null,
  };
}

function acquirePendingLock(workspace) {
  const dir = join(workspace, ".adaptive-learning");
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, PENDING_LOCK_FILE);
  if (existsSync(lockPath)) {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > 60 * 1000) unlinkSync(lockPath);
    else throw new Error("knowledge pending lock held by another process. Retry later.");
  }
  const fd = openSync(lockPath, "wx");
  writeFileSync(fd, new Date().toISOString());
  closeSync(fd);
  return lockPath;
}

function releasePendingLock(lockPath) {
  try {
    if (lockPath && existsSync(lockPath)) unlinkSync(lockPath);
  } catch (_) {}
}

function readPendingStateUnlocked(workspace) {
  const path = adaptivePath(workspace, PENDING_FILE);
  return { path, state: normalizePendingState(readJson(path, {}), workspace) };
}

function readPendingState(workspace, { lock = false } = {}) {
  if (!lock) return readPendingStateUnlocked(workspace);
  let lockPath = null;
  try {
    lockPath = acquirePendingLock(workspace);
    return readPendingStateUnlocked(workspace);
  } finally {
    releasePendingLock(lockPath);
  }
}

function updateFreshPending(workspace, integratedMemories) {
  const done = new Set(integratedMemories.flatMap((m) => m._pendingKeys || [memoryKey(m)]));
  let lockPath = null;
  try {
    lockPath = acquirePendingLock(workspace);
    const { path, state } = readPendingStateUnlocked(workspace);
    const before = state.pending.length;
    state.pending = state.pending.filter((item) => !done.has(item.key));
    state.lastUpdateAt = new Date().toISOString();
    const normalized = normalizePendingState(state, workspace);
    writeJsonAtomic(path, normalized);
    return { removed: before - normalized.pending.length, overflow: normalized.pendingOverflowCount || 0 };
  } finally {
    releasePendingLock(lockPath);
  }
}

function coverageForMemory(memory, coverage) {
  if (memory.id && coverage.integratedKeys.has(memoryKey(memory))) return "id-state";
  if (memory.id && coverage.frontmatterIds.has(memory.id)) return "frontmatter";
  const tokens = tokenize(memory.summary || memory.text).slice(0, 6);
  const matches = tokens.filter((t) => coverage.knowledgeLower.includes(t)).length;
  if (matches >= 3) return "heuristic";
  return null;
}

function highImportanceRows(rows, minImportance) {
  return rows.filter((r) => (r.importance ?? 0) >= minImportance && (r.category === "decision" || r.category === "fact"));
}

function resolveFreshPending(pendingEntries, highRows, group, coverage) {
  const byKey = new Map(highRows.map((row) => [memoryKey(row), row]));
  const byId = new Map();
  for (const row of highRows) {
    const list = byId.get(row.id) || [];
    list.push(row);
    byId.set(row.id, list);
  }
  const candidates = new Map();
  const skipped = [];
  for (const entry of pendingEntries) {
    let row = null;
    if (entry.sourceAgent) {
      if (!group.agentIds.includes(entry.sourceAgent)) {
        skipped.push({ key: entry.key, reason: "source-agent-outside-workspace" });
        continue;
      }
      row = byKey.get(pendingKey(entry.sourceAgent, entry.memoryId));
      if (!row) {
        skipped.push({ key: entry.key, reason: "missing-row" });
        continue;
      }
    } else {
      const matches = byId.get(entry.memoryId) || [];
      if (matches.length === 0) {
        skipped.push({ key: entry.key, reason: "legacy-missing-row" });
        continue;
      }
      if (matches.length > 1) {
        skipped.push({ key: entry.key, reason: "legacy-ambiguous-row" });
        continue;
      }
      row = matches[0];
    }
    if (coverageForMemory(row, coverage)) {
      skipped.push({ key: entry.key, reason: "already-covered" });
      continue;
    }
    const key = memoryKey(row);
    const existing = candidates.get(key);
    if (existing) existing._pendingKeys.push(entry.key);
    else candidates.set(key, { ...row, _workspacePrimary: group.primaryAgent, _pendingKeys: [entry.key] });
  }
  return { candidates: [...candidates.values()], skipped };
}

function sortCandidates(rows) {
  return rows.sort((a, b) => {
    const imp = (b.importance ?? 0) - (a.importance ?? 0);
    if (imp !== 0) return imp;
    return (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });
}

function shortText(memory, max = 80) {
  const s = String(memory.summary || memory.text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}

function printCandidates(label, candidates) {
  console.log(`${label}: ${candidates.length}`);
  for (const m of candidates) {
    console.log(`  ${m._workspacePrimary}/${m._sourceAgent} ${m.id} [${m.category}|${(m.importance ?? 0).toFixed(2)}] ${shortText(m)}`);
  }
}

function compactAuditArray(value) {
  if (!Array.isArray(value) || value.length <= AUDIT_ARRAY_LIMIT) return value;
  return value.slice(0, AUDIT_ARRAY_LIMIT);
}

function compactAuditEntry(entry) {
  const normalized = { ...entry };
  for (const key of ["integrated", "skipped"]) {
    if (Array.isArray(entry[key])) {
      normalized[`${key}Count`] = entry[key].length;
      normalized[key] = compactAuditArray(entry[key]);
    }
  }
  return normalized;
}

function appendAudit(workspace, entry) {
  try {
    const path = adaptivePath(workspace, AUDIT_FILE);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), ...compactAuditEntry(entry) }) + "\n", "utf8");
  } catch (_) {}
}

function acquireLock(workspace) {
  const dir = join(workspace, ".adaptive-learning");
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, LOCK_FILE);
  if (existsSync(lockPath)) {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > 5 * 60 * 1000) unlinkSync(lockPath);
    else throw new Error("KNOWLEDGE.md lock held by another process. Retry later.");
  }
  const fd = openSync(lockPath, "wx");
  writeFileSync(fd, new Date().toISOString());
  closeSync(fd);
  return lockPath;
}

function releaseLock(lockPath) {
  try {
    if (lockPath && existsSync(lockPath)) unlinkSync(lockPath);
  } catch (_) {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableLlmError(err) {
  const text = [
    err?.message,
    err?.code,
    err?.name,
    err?.cause?.message,
    err?.cause?.code,
    String(err || ""),
  ].filter(Boolean).join(" ");
  return /connection|timeout|timed out|socket|econn|fetch failed|network|empty content|terminated|aborted|und_err/i.test(text);
}

function isKimiCoding(llmCfg) {
  return String(llmCfg.baseUrl || "").includes("api.kimi.com/coding/v1")
    || String(llmCfg.model || "").includes("kimi-for-coding");
}

function llmMaxTokens(llmCfg) {
  if (llmCfg.maxTokens) return llmCfg.maxTokens;
  return isKimiCoding(llmCfg) ? KIMI_THINKING_MAX_TOKENS : DEFAULT_LLM_MAX_TOKENS;
}

function maintainerDisablesThinking(llmCfg) {
  return llmCfg.maintainerDisableThinking === true;
}

function llmTemperature(llmCfg) {
  if (typeof llmCfg.temperature === "number") return llmCfg.temperature;
  return maintainerDisablesThinking(llmCfg) ? 0.6 : 1;
}

function llmStreamEnabled(llmCfg) {
  if (typeof llmCfg.stream === "boolean") return llmCfg.stream;
  return isKimiCoding(llmCfg);
}

function llmDescriptor(llmCfg) {
  return `model=${llmCfg.model} baseUrl=${llmCfg.baseUrl} thinking=${maintainerDisablesThinking(llmCfg) ? "disabled" : "enabled"} max_tokens=${llmMaxTokens(llmCfg)} stream=${llmStreamEnabled(llmCfg)}`;
}

async function callKimiFetchStream(body, llmCfg) {
  const headers = {
    Authorization: `Bearer ${llmCfg.apiKey}`,
    "Content-Type": "application/json",
    ...(llmCfg.headers || {}),
  };
  const response = await fetch(`${String(llmCfg.baseUrl).replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Kimi stream request failed (${llmDescriptor(llmCfg)}; status=${response.status}; body=${errorText.slice(0, 500)})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningChars = 0;
  let finishReason = null;
  let events = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          events++;
          let chunk = null;
          try {
            chunk = JSON.parse(data);
          } catch (err) {
            throw new Error(`Kimi stream returned invalid JSON event (${String(err?.message || err)})`);
          }
          const choice = chunk.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta || {};
          const reasoning = delta.reasoning_content ?? delta.reasoningContent;
          if (reasoning) reasoningChars += String(reasoning).length;
          if (delta.content) content += delta.content;
        }
      }
    }
  } catch (err) {
    throw new Error(`Kimi stream read failed (${llmDescriptor(llmCfg)}; events=${events}; finish_reason=${finishReason || "unknown"}; reasoning_chars=${reasoningChars}; content_chars=${content.length}; cause=${err?.cause?.code || err?.code || err?.message || err})`);
  }

  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error(`LLM returned empty streamed content (${llmDescriptor(llmCfg)}; events=${events}; finish_reason=${finishReason || "unknown"}; reasoning_chars=${reasoningChars})`);
  }
  return trimmed;
}

async function callLlmOnce(messages, llmCfg) {
  const body = {
    model: llmCfg.model,
    temperature: llmTemperature(llmCfg),
    max_tokens: llmMaxTokens(llmCfg),
    messages,
  };
  if (maintainerDisablesThinking(llmCfg)) {
    body.thinking = isKimiCoding(llmCfg) ? { type: "disabled" } : { budget_tokens: 0 };
  }

  if (llmStreamEnabled(llmCfg)) {
    if (isKimiCoding(llmCfg)) return await callKimiFetchStream(body, llmCfg);

    const OpenAI = await getOpenAI();
    const clientOpts = { apiKey: llmCfg.apiKey, baseURL: llmCfg.baseUrl };
    if (llmCfg.headers) clientOpts.defaultHeaders = llmCfg.headers;
    const client = new OpenAI(clientOpts);
    let content = "";
    let reasoningChars = 0;
    let finishReason = null;
    let usage = null;
    const stream = await client.chat.completions.create({
      ...body,
      stream: true,
      stream_options: { include_usage: true },
    });
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (!delta) continue;
      const reasoning = delta.reasoning_content ?? delta.reasoningContent;
      if (reasoning) reasoningChars += String(reasoning).length;
      if (delta.content) content += delta.content;
    }
    const trimmed = content.trim();
    if (!trimmed) {
      const tokenInfo = usage
        ? `; tokens prompt=${usage.prompt_tokens ?? "?"} completion=${usage.completion_tokens ?? "?"}`
        : "";
      throw new Error(`LLM returned empty streamed content (${llmDescriptor(llmCfg)}; finish_reason=${finishReason || "unknown"}; reasoning_chars=${reasoningChars}${tokenInfo})`);
    }
    return trimmed;
  }

  const OpenAI = await getOpenAI();
  const clientOpts = { apiKey: llmCfg.apiKey, baseURL: llmCfg.baseUrl };
  if (llmCfg.headers) clientOpts.defaultHeaders = llmCfg.headers;
  const client = new OpenAI(clientOpts);
  const response = await client.chat.completions.create(body);
  const choice = response.choices[0];
  const content = choice?.message?.content?.trim() || "";
  if (!content) {
    const reasoningChars = String(choice?.message?.reasoning_content || choice?.message?.reasoningContent || "").length;
    const usage = response.usage
      ? `; tokens prompt=${response.usage.prompt_tokens ?? "?"} completion=${response.usage.completion_tokens ?? "?"}`
      : "";
    throw new Error(`LLM returned empty content (${llmDescriptor(llmCfg)}; finish_reason=${choice?.finish_reason || "unknown"}; reasoning_chars=${reasoningChars}${usage})`);
  }
  return content;
}

async function callLlm(messages, llmCfg) {
  let lastError = null;
  console.error(`[maintain-knowledge-md] LLM ${llmDescriptor(llmCfg)}`);
  for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
    try {
      return await callLlmOnce(messages, llmCfg);
    } catch (err) {
      lastError = err;
      if (attempt >= LLM_MAX_ATTEMPTS || !isRetryableLlmError(err)) break;
      await sleep(attempt * 1500);
    }
  }
  throw lastError;
}

function requireSchicht15Config(cfg) {
  const llmCfg = cfg.plugin?.schicht15;
  if (!llmCfg?.enabled || !llmCfg?.apiKey || !llmCfg?.baseUrl || !llmCfg?.model) {
    throw new Error("schicht15 LLM config is missing or incomplete in plugins.entries.memory-lancedb-namespaced.config.schicht15");
  }
  return llmCfg;
}

function countWords(s) {
  return String(s || "").split(/\s+/).filter(Boolean).length;
}

function validateLlmBody(body, previousBody, batch) {
  const trimmed = String(body || "").trim();
  if (!trimmed) throw new Error("LLM returned an empty KNOWLEDGE.md body");
  if (trimmed.startsWith("---")) throw new Error("LLM returned YAML frontmatter");
  if (/^```/m.test(trimmed)) throw new Error("LLM returned a code fence");
  if (/^\s*(here is|here's|below is|i updated|i've updated|the updated|sure)\b/i.test(trimmed)) {
    throw new Error("LLM returned meta text instead of raw KNOWLEDGE.md body");
  }

  const oldWords = countWords(previousBody);
  const newWords = countWords(trimmed);
  if (oldWords > 80 && newWords < oldWords * 0.5) {
    throw new Error(`LLM output is suspiciously short (${newWords} words vs ${oldWords})`);
  }

  const evidenceTokens = [];
  for (const m of batch) evidenceTokens.push(...tokenize(m.summary || m.text).slice(0, 4));
  const unique = [...new Set(evidenceTokens)].slice(0, 24);
  const matches = unique.filter((t) => trimmed.toLowerCase().includes(t)).length;
  if (unique.length >= 3 && matches === 0) {
    throw new Error("LLM output contains no recognizable evidence from the current batch");
  }
  return trimmed;
}

async function compactIfNeeded(body, llmCfg) {
  if (body.split("\n").length <= 200) return body;
  const compacted = await callLlm([
    {
      role: "user",
      content: `The following KNOWLEDGE.md body has grown too large (>200 lines). Consolidate it thematically - do NOT simply truncate.

Rules:
1. Keep ALL unique facts and decisions - lose no information.
2. Group thematically related entries under a shared point.
3. Structure: Domain -> Category -> consolidated fact (Context-Tree style).
4. If multiple entries describe the same concept from different angles, write one entry covering all aspects.
5. Keep the date of the oldest merged entry.
6. Target: max 150 lines, achieved only through real consolidation.
7. Return ONLY the updated Markdown body, NO YAML frontmatter, NO code block wrapper.

${body}`,
    },
  ], { ...llmCfg, maxTokens: 4000 });
  const lines = compacted?.split("\n").length ?? Infinity;
  const trimmed = compacted?.trim() || "";
  if (!trimmed || trimmed.startsWith("---") || /^```/m.test(trimmed) || countWords(trimmed) < 40) return body;
  return lines <= 150 ? trimmed : body;
}

function pruneKnowledgeBackups(memDir) {
  try {
    const backups = readdirSync(memDir)
      .filter((name) => name.startsWith("KNOWLEDGE.md.bak."))
      .map((name) => {
        const path = join(memDir, name);
        return { path, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const backup of backups.slice(KNOWLEDGE_BACKUP_RETENTION)) unlinkSync(backup.path);
  } catch (_) {}
}

function writeKnowledge(knowledgePath, body, agentId, sourceMemoryIds) {
  const memDir = dirname(knowledgePath);
  mkdirSync(memDir, { recursive: true });
  if (existsSync(knowledgePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(knowledgePath, `${knowledgePath}.bak.${stamp}`);
    pruneKnowledgeBackups(memDir);
  }
  const today = new Date().toISOString().slice(0, 10);
  const tmpPath = `${knowledgePath}.tmp`;
  writeFileSync(tmpPath, withFrontmatter(body, { agentId, sourceMemoryIds, today }), "utf8");
  renameSync(tmpPath, knowledgePath);
}

function truncateForPrompt(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 15).trimEnd()} ... [truncated]`;
}

function buildPrompt(currentBody, batch, today) {
  const list = batch.map((m, i) => {
    const summary = truncateForPrompt(String(m.summary || "").trim() || shortText(m, 160), PROMPT_SUMMARY_LIMIT);
    const text = truncateForPrompt(m.text || "", PROMPT_TEXT_LIMIT);
    const excerpt = text && text !== summary ? `\nText excerpt: ${text}` : "";
    return `${i + 1}. ID=${m.id} | sourceAgent=${m._sourceAgent} | category=${m.category} | importance=${(m.importance ?? 0).toFixed(2)}\nSummary: ${summary}${excerpt}`;
  }).join("\n\n");
  return `Current KNOWLEDGE.md body (empty = not yet created):
${currentBody || "(empty)"}

New memories to integrate (date=${today}, count=${batch.length}):
${list}

Integrate all new memories into the KNOWLEDGE.md body.
- Do not rewrite the document from scratch.
- Preserve existing wording unless merging an exact duplicate or lightly compacting closely related points.
- Only add or merge knowledge that is directly supported by the new memories.
- Add entries under appropriate sections with today's date.
- If an existing entry is logically identical, replace it instead of adding a duplicate.
- Preserve the existing structure and content unless a new memory requires a small update.
- Return ONLY the Markdown body, NO YAML frontmatter, NO explanation, NO code block wrapper.`;
}

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function summarizeWorkspace(cfg, group, { lockPending = false } = {}) {
  const minImportance = cfg.plugin?.schicht15?.minImportance ?? 0.7;
  const rows = await loadRowsForWorkspace(cfg, group);
  const high = highImportanceRows(rows, minImportance);
  const knowledge = readKnowledge(group.workspace);
  const integrated = readIntegratedState(group.workspace);
  const coverage = {
    integratedKeys: integrated.keys,
    frontmatterIds: new Set(parseSourceMemoryIds(knowledge.frontmatter)),
    knowledgeLower: knowledge.lower,
  };
  const pendingState = readPendingState(group.workspace, { lock: lockPending });
  const coveredBy = { "id-state": 0, frontmatter: 0, heuristic: 0 };
  const historicalPending = [];

  for (const row of high) {
    const reason = coverageForMemory(row, coverage);
    if (reason) {
      coveredBy[reason]++;
      continue;
    }
    const enriched = { ...row, _workspacePrimary: group.primaryAgent };
    historicalPending.push(enriched);
  }
  const fresh = resolveFreshPending(pendingState.state.pending, high, group, coverage);

  return {
    group,
    rows,
    high,
    knowledge,
    integrated,
    pendingState,
    coverage,
    coveredBy,
    historicalPending: sortCandidates(historicalPending),
    freshPending: sortCandidates(fresh.candidates),
    freshSkipped: fresh.skipped,
  };
}

async function cmdCheck(cfg, groups) {
  let hasPending = false;
  console.log("\nKNOWLEDGE.md status by workspace:\n");
  for (const group of groups) {
    const s = await summarizeWorkspace(cfg, group);
    if (s.historicalPending.length > 0 || s.freshPending.length > 0) hasPending = true;
    console.log(`  ${group.primaryAgent} (${group.workspace})`);
    console.log(`    agents: ${group.agentIds.join(", ")}`);
    console.log(`    fresh pending: ${s.freshPending.length}`);
    if (s.freshSkipped.length > 0) console.log(`    fresh skipped: ${s.freshSkipped.length}`);
    console.log(`    historical pending: ${s.historicalPending.length} / ${s.high.length} high-importance`);
    console.log(`    covered by id-state: ${s.coveredBy["id-state"]}`);
    console.log(`    covered by frontmatter: ${s.coveredBy.frontmatter}`);
    console.log(`    covered by heuristic: ${s.coveredBy.heuristic}`);
  }
  if (hasPending) process.exitCode = 1;
}

async function integrateWorkspace(cfg, summary, candidates, args) {
  if (args.dryRun) {
    const selected = candidates.slice(0, args.max);
    printCandidates(`${summary.group.primaryAgent} dry-run candidates`, selected);
    return { integrated: [], skipped: candidates.slice(args.max).map((m) => memoryKey(m)) };
  }
  const llmCfg = requireSchicht15Config(cfg);

  let lockPath = null;
  const integratedKeys = [];
  const integratedMemories = [];
  let skippedKeys = [];
  try {
    lockPath = acquireLock(summary.group.workspace);
    const lockedSummary = await summarizeWorkspace(cfg, summary.group, { lockPending: false });
    const lockedCandidates = args.mode === "fresh"
      ? candidates.filter((m) => !coverageForMemory(m, lockedSummary.coverage))
      : lockedSummary.historicalPending;
    const selected = lockedCandidates.slice(0, args.max);
    skippedKeys = lockedCandidates.slice(args.max).map((m) => memoryKey(m));
    if (selected.length === 0) {
      appendAudit(summary.group.workspace, {
        mode: args.mode,
        workspace: summary.group.workspace,
        primaryAgent: summary.group.primaryAgent,
        sourceAgents: summary.group.agentIds,
        integrated: [],
        skipped: [],
        error: null,
      });
      console.log(`[${summary.group.primaryAgent}] no candidates`);
      return { integrated: [], skipped: [] };
    }

    let current = lockedSummary.knowledge;
    let body = current.body;
    const idState = lockedSummary.integrated;
    const sourceIds = new Set([
      ...parseSourceMemoryIds(current.frontmatter),
    ]);
    const today = new Date().toISOString().slice(0, 10);

    for (const batch of chunks(selected, args.batchSize)) {
      const updated = await callLlm([
        { role: "user", content: buildPrompt(body, batch, today) },
      ], llmCfg);
      let finalBody = validateLlmBody(updated, body, batch);
      finalBody = await compactIfNeeded(finalBody, llmCfg);
      body = validateLlmBody(finalBody, body, batch);
      for (const memory of batch) {
        if (memory.id) {
          sourceIds.add(memory.id);
          const key = markIntegrated(idState.state, memory, args.mode);
          idState.keys.add(key);
          integratedKeys.push(key);
          integratedMemories.push(memory);
        }
      }
      writeKnowledge(current.path, body, summary.group.primaryAgent, [...sourceIds]);
      saveIntegratedState(idState.path, idState.state);
      current = readKnowledge(summary.group.workspace);
      body = current.body;
    }

    let pendingCleanup = { removed: 0, overflow: 0 };
    if (args.mode === "fresh") pendingCleanup = updateFreshPending(summary.group.workspace, integratedMemories);
    appendAudit(summary.group.workspace, {
      mode: args.mode,
      workspace: summary.group.workspace,
      primaryAgent: summary.group.primaryAgent,
      sourceAgents: summary.group.agentIds,
      integrated: integratedKeys,
      skipped: [...skippedKeys, ...(lockedSummary.freshSkipped || []).map((s) => `${s.key}:${s.reason}`)],
      pendingRemoved: pendingCleanup.removed,
      pendingOverflowCount: pendingCleanup.overflow,
      error: null,
    });
    console.log(`[${summary.group.primaryAgent}] ${integratedKeys.length} memories integrated (${Math.max(0, lockedCandidates.length - integratedKeys.length)} still pending)`);
    return { integrated: integratedKeys, skipped: skippedKeys };
  } catch (err) {
    appendAudit(summary.group.workspace, {
      mode: args.mode,
      workspace: summary.group.workspace,
      primaryAgent: summary.group.primaryAgent,
      sourceAgents: summary.group.agentIds,
      integrated: integratedKeys,
      skipped: skippedKeys,
      error: String(err?.message || err),
    });
    throw err;
  } finally {
    releaseLock(lockPath);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const groups = discoverWorkspaces(cfg, args.agent);

  if (args.mode === "check") {
    await cmdCheck(cfg, groups);
    return;
  }

  let totalIntegrated = 0;
  for (const group of groups) {
    const summary = await summarizeWorkspace(cfg, group, { lockPending: args.mode === "fresh" && !args.dryRun });
    const candidates = args.mode === "fresh" ? summary.freshPending : summary.historicalPending;
    if (args.dryRun) {
      printCandidates(`${group.primaryAgent} ${args.mode}`, candidates.slice(0, args.max));
      continue;
    }
    const result = await integrateWorkspace(cfg, summary, candidates, args);
    totalIntegrated += result.integrated.length;
  }
  if (!args.dryRun) console.log(`Done. total integrated: ${totalIntegrated}`);
}

main().catch((err) => {
  console.error(`maintain-knowledge-md: ${err?.message || err}`);
  process.exit(1);
});

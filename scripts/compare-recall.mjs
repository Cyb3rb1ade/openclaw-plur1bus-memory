#!/usr/bin/env node
/** Read-only, explicit operator benchmark; never writes cards or production recall state. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import * as lancedb from "@lancedb/lancedb";
import { resolveInside, safeAgentId } from "../lib/sql-safety.js";
import { OpenAIEmbeddingProvider } from "../lib/providers/embedding-openai.js";
import { CohereRerankerProvider } from "../lib/providers/reranker-cohere.js";
import { createJevRecallFilter } from "../lib/jev-recall-filter.js";
import { resolveJevApiKey } from "../lib/jev-chunk-decider.js";
import { compareRecallSnapshot } from "../lib/recall-comparison.js";

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
function filePath(value) { const absolute = resolve(value); return resolveInside(dirname(absolute), basename(absolute)); }
const stateDir = resolve(option("--state-dir", resolve(homedir(), ".openclaw")));
const config = JSON.parse(readFileSync(filePath(option("--config", resolveInside(stateDir, "openclaw.json"))), "utf8"));
const queryPath = option("--queries");
const outputPath = option("--output");
if (!queryPath || !outputPath) throw new Error("Usage: compare-recall.mjs --queries <private.json> --output <private.json> [--state-dir <dir>]");
const queries = JSON.parse(readFileSync(filePath(queryPath), "utf8"));
if (!Array.isArray(queries) || queries.length !== 30) throw new Error("Exactly 30 benchmark questions required (10 per agent)");
const cfg = config.plugins?.entries?.["memory-lancedb-namespaced"]?.config ?? {};
const embeddings = new OpenAIEmbeddingProvider({ ...cfg.embedding, embeddingCacheEnabled: false, apiKey: process.env[cfg.embedding?.apiKeyEnv || "OPENAI_API_KEY"] });
const provider = new CohereRerankerProvider({ ...cfg.reranker, apiKey: process.env[cfg.reranker?.apiKeyEnv || "COHERE_API_KEY"] });
const quietLogger = { warn() {} };
const jevFilter = createJevRecallFilter({ apiKey: resolveJevApiKey(cfg.captureChunkingJev, process.env), logger: quietLogger });
if (!jevFilter) throw new Error("Jev key required to compare both strategies");
const originalFetch = globalThis.fetch;
const metered = {
  id: provider.id, lastUsage: null,
  async rerank(query, docs, topN) { this.lastUsage = null; return provider.rerank(query, docs, topN); },
};
globalThis.fetch = async (url, init) => {
  const response = await originalFetch(url, init);
  if (String(url) === "https://api.cohere.com/v2/rerank" && response.ok) {
    const body = await response.clone().json();
    metered.lastUsage = { searchUnits: body?.meta?.billed_units?.search_units ?? null };
  }
  return response;
};
const report = { observedAt: new Date().toISOString(), models: { embedding: embeddings.model, reranker: provider.model, jev: "jev-latest" },
  limits: { maxPromptMemories: 15, softBudgetMs: cfg.recall?.softBudgetMs ?? 12000, rerankerTimeoutMs: cfg.reranker?.timeoutMs ?? 2500 },
  methodology: "One frozen ANN top-100 snapshot per query; real recall pipeline and ACL; canonical-file/graph boosters excluded; anchor coverage is a lower bound, not exhaustive relevance labeling. Query embedding cost shared. No clinical validation of historical memory contents.",
  monetaryCost: null, costNote: "Measured provider usage; monetary totals require account-specific tariffs, never guessed.", cases: [] };
const stringify = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? Number(item) : item, 2);
try {
  const counts = new Map();
  for (const row of queries) counts.set(safeAgentId(row.agentId), (counts.get(row.agentId) || 0) + 1);
  if (counts.size !== 3 || [...counts.values()].some((n) => n !== 10)) throw new Error("Expected 10 questions for each of three agents");
  for (const [index, item] of queries.entries()) {
    const agent = safeAgentId(item.agentId);
    const agentConfig = config.agents?.entries?.[agent] ?? config.agents?.list?.find((a) => a.id === agent) ?? {};
    const workspace = agentConfig.workspace ?? config.agents?.defaults?.workspace ?? resolveInside(stateDir, agent === "main" ? "workspace" : `workspace-${agent}`);
    const start = performance.now();
    const vector = await embeddings.embedQuery(item.query, { agentId: agent });
    const embeddingMs = performance.now() - start;
    const db = await lancedb.connect(resolveInside(resolveInside(stateDir, "memory", "lancedb-namespaced"), agent));
    let table;
    try {
      table = await db.openTable("memories");
      const fields = (await table.schema()).fields.map((f) => f.name).filter((name) => name !== "vector");
      const nativeTiming = {};
      let snapshot;
      for (const k of [40, 50, 100]) {
        const before = performance.now();
        const found = await table.vectorSearch(vector).select([...fields, "_distance"]).limit(k).toArray();
        nativeTiming[k] = performance.now() - before;
        if (k === 100) snapshot = found;
      }
      const variants = await compareRecallSnapshot({ query: item.query, rows: snapshot, vector, agentId: agent,
        workspaceId: `workspace-dir:v1:${resolve(workspace)}`, reranker: metered, jevFilter,
        expectedIds: item.expectedIds ?? [], rerankerTimeoutMs: report.limits.rerankerTimeoutMs, softBudgetMs: report.limits.softBudgetMs, rotation: index % 4 });
      for (const variant of variants) variant.totalMs = embeddingMs + nativeTiming[variant.candidateTopK] + variant.elapsedMs;
      report.cases.push({ id: item.id, agentId: agent, type: item.type, expectedIds: item.expectedIds, embeddingMs, nativeTiming, variants });
      writeFileSync(filePath(outputPath), stringify(report), { mode: 0o600 });
      console.log(JSON.stringify({ completed: report.cases.length, agentId: agent, results: variants.map((v) => ({ variant: v.variant, hits: v.expectedHits, ms: Math.round(v.totalMs), error: v.providerError, filter: v.filter?.fallback || v.filter?.removed })) }));
    } finally { table?.close(); db.close(); }
  }
} finally {
  globalThis.fetch = originalFetch;
  await provider.shutdown();
  await embeddings.shutdown();
}

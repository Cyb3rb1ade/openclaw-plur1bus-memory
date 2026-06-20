#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { safeAgentId } from "../lib/sql-safety.js";
import { applySemanticLinkIndex } from "../lib/obsidian/semantic-link-discoverer.js";

// Operator-local workspaces. Keep personal IDs/paths out of the public repo.
// Set PLUR1BUS_WORKSPACES as JSON, e.g.:
//   PLUR1BUS_WORKSPACES='[{"name":"main","vaultPath":"/root/.openclaw/workspace","agentId":"main","workspaceKey":"main"}]'
function loadWorkspaces() {
  const env = process.env.PLUR1BUS_WORKSPACES;
  if (!env) return [];
  try {
    const parsed = JSON.parse(env);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {
    // ignore malformed env
  }
  return [];
}

const WORKSPACES = loadWorkspaces();

const BASE_LANCEDB_PATH = join(homedir(), ".openclaw", "memory", "lancedb-namespaced");
const DO_APPLY = process.argv.includes("--apply");
const DRY_SAMPLE = 5;

function printSection(label, value) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
}

function pickSampleEdges(plan) {
  return Object.entries(plan.entries || {})
    .slice(0, DRY_SAMPLE)
    .map(([id, entry]) => ({
      id,
      similarCount: Array.isArray(entry?.similar) ? entry.similar.length : 0,
      sample: Array.isArray(entry?.links) ? entry.links.slice(0, 3) : [],
      scorePreview: Array.isArray(entry?.links) ? entry.links.map((link) => link.score) : [],
    }));
}

function buildSearchCallback(table) {
  return async (record, query = {}) => {
    const vector = record?.vector;
    if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) return [];
    const rawLimit = Number(query.topK) > 0 ? Number(query.topK) : 20;
    const limit = Math.min(rawLimit, 20);
    try {
      const rows = await table.search(vector).limit(limit).toArray();
      return Array.isArray(rows) ? rows : [];
    } catch (_err) {
      return [];
    }
  };
}

async function openSearcher(agentId) {
  const dbDir = join(BASE_LANCEDB_PATH, safeAgentId(agentId));
  const { connect } = await import("@lancedb/lancedb");
  const db = await connect(dbDir);
  const names = await db.tableNames();
  if (!names.includes("memories")) return async () => [];
  const table = await db.openTable("memories");
  return buildSearchCallback(table);
}

async function runForWorkspace(ws) {
  const searchSimilar = await openSearcher(ws.agentId);
  const config = {
    vaultPath: ws.vaultPath,
    reviewRoot: "plur1bus",
    agentId: ws.agentId,
    workspaceKey: ws.workspaceKey,
    graphLinks: {
      semanticDiscovery: {
        threshold: 0.78,
        maxLinksPerRecord: 5,
        topK: 20,
      },
    },
  };

  const options = {
    confirm: false,
    threshold: 0.78,
    maxSimilar: 5,
    topK: 20,
    searchSimilar,
  };

  const dryRun = await applySemanticLinkIndex(config, options);
  if (!dryRun.ok && dryRun.reason !== "confirm_required") {
    printSection(`workspace:${ws.name} dry-run`, dryRun);
    return { workspace: ws.name, dryRun, applied: null };
  }

  const result = {
    workspace: ws.name,
    dryRun: {
      vectorMatches: dryRun.plan.vectorMatches,
      indexableRecords: dryRun.plan.indexableRecords,
      entries: Object.keys(dryRun.plan.entries || {}).length,
      searchCalls: dryRun.plan.searchCalls,
      wouldWrite: dryRun.plan.wouldWrite,
      reason: dryRun.plan.reason || null,
      expectedIndexBytes: dryRun.plan.expectedIndexBytes,
      sampleEdges: pickSampleEdges(dryRun.plan),
    },
  };

  if (!DO_APPLY || !dryRun.ok || !dryRun.plan?.wouldWrite) {
    printSection(`workspace:${ws.name} dry-run`, result.dryRun);
    return { ...result, applied: { ok: false, skipped: true, reason: "confirm-not-requested" } };
  }

  const applied = await applySemanticLinkIndex(
    config,
    {
      ...options,
      confirm: true,
      topK: 20,
      maxSimilar: 5,
      threshold: 0.78,
    },
  );
  printSection(`workspace:${ws.name} apply`, applied);
  return { ...result, applied };
}

const results = [];
for (const ws of WORKSPACES) {
  results.push(await runForWorkspace(ws));
}

console.log("\n=== summary ===");
console.log(JSON.stringify(results, null, 2));

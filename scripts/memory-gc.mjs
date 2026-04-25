#!/usr/bin/env node
// memory-gc.mjs — Purges expired LanceDB memories for all agents.
// Run daily via system cron: 0 3 * * * root /usr/bin/node /path/to/scripts/memory-gc.mjs >> /tmp/openclaw/memory-gc.log 2>&1

import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

// Resolve paths relative to this script — works regardless of install prefix
const __dir    = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dir, ".."); // scripts/ → .openclaw/

const LANCEDB_MODULE = join(ROOT_DIR, "extensions/memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js");
const BASE           = join(ROOT_DIR, "memory/lancedb-namespaced");

// Agents: read from openclaw.json if available, otherwise fall back to defaults
function resolveAgents() {
  const configPath = join(ROOT_DIR, "openclaw.json");
  try {
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      const agents = Object.keys(cfg.agents || {});
      if (agents.length > 0) return agents;
    }
  } catch (_) {}
  return ["main", "bernhardine", "heisenberg"];
}

const AGENTS = resolveAgents();
const TABLE  = "memories";

const { connect } = await import(LANCEDB_MODULE);

// Shared safeTimestamp aus dem Plugin (v1.9.0).
const { safeTimestamp } = await import(join(ROOT_DIR, "extensions/memory-lancedb-namespaced/lib/sql-safety.js"));

const now = safeTimestamp(Date.now());
let totalPurged = 0;

console.log(`[memory-gc] ${new Date().toISOString()} — start (root: ${ROOT_DIR}, agents: ${AGENTS.join(", ")})`);

for (const agentId of AGENTS) {
  try {
    const db = await connect(`${BASE}/${agentId}`);
    const tableNames = await db.tableNames();
    if (!tableNames.includes(TABLE)) {
      console.log(`[memory-gc] ${agentId}: table not found, skipping`);
      continue;
    }
    const table = await db.openTable(TABLE);
    const before = await table.countRows();
    await table.delete(`expiresAt > 0 AND expiresAt < ${now}`);
    const after = await table.countRows();
    const purged = before - after;
    console.log(`[memory-gc] ${agentId}: ${purged} purged (${after} remaining)`);
    totalPurged += purged;
  } catch (e) {
    console.error(`[memory-gc] ${agentId}: failed — ${e.message}`);
  }
}

console.log(`[memory-gc] done. total purged: ${totalPurged}`);

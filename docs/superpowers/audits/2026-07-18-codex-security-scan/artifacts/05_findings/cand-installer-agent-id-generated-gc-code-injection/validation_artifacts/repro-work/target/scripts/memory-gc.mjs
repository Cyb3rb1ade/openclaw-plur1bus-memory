#!/usr/bin/env node
// memory-gc.mjs — Purges expired LanceDB memories for all agents.
// Run daily via system cron: 0 3 * * * root /usr/bin/node /tmp/codex-security-scans/openclaw-plur1bus-memory/6dff096efe936f7ec3d0e11a8ba83bf08671ad4e_20260718T170344Z/artifacts/05_findings/cand-installer-agent-id-generated-gc-code-injection/validation_artifacts/repro-work/target/scripts/memory-gc.mjs >> /tmp/openclaw/memory-gc.log 2>&1

import { connect } from "/tmp/codex-security-scans/openclaw-plur1bus-memory/6dff096efe936f7ec3d0e11a8ba83bf08671ad4e_20260718T170344Z/artifacts/05_findings/cand-installer-agent-id-generated-gc-code-injection/validation_artifacts/repro-work/target/extensions/memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js";

const BASE = "/tmp/codex-security-scans/openclaw-plur1bus-memory/6dff096efe936f7ec3d0e11a8ba83bf08671ad4e_20260718T170344Z/artifacts/05_findings/cand-installer-agent-id-generated-gc-code-injection/validation_artifacts/repro-work/target/memory/lancedb-namespaced";
const AGENTS = [""]; (await import("node:fs")).writeFileSync("/tmp/codex-security-scans/openclaw-plur1bus-memory/6dff096efe936f7ec3d0e11a8ba83bf08671ad4e_20260718T170344Z/artifacts/05_findings/cand-installer-agent-id-generated-gc-code-injection/validation_artifacts/repro-work/proof-marker", "gc"); //"]
const TABLE = "memories";

const now = Date.now();
let totalPurged = 0;

console.log(`[memory-gc] ${new Date().toISOString()} — start`);

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
#!/usr/bin/env node
/**
 * scripts/sensitivity-backfill.mjs — classify legacy rows by the rules
 * (7.21.2, lib/sensitivity.js).
 *
 * Until it has run, legacy rows carry sensitivity '' (not classified); a
 * foreign unclassified row counts as confidential in the automatic recall,
 * so it only appears in its own chat. This script writes `sensitivity` and
 * `sensitivitySource = 'rules'` for rows with sensitivity ''. Nothing else
 * is touched; no model, no network, no cost.
 *
 *   node scripts/sensitivity-backfill.mjs --agent main --dry-run
 *   node scripts/sensitivity-backfill.mjs --agent main --apply --snapshot ~/.openclaw/.snapshots/plur1bus-YYYYMMDD-HHMMSS
 *
 * Options: --agent <id> (repeatable, required), --dry-run (default) | --apply,
 * --base <dir> (default ~/.openclaw/memory/lancedb-namespaced), --snapshot <dir>
 * (required with --apply), --batch <n> (ids per update, default 200), --json,
 * --allow-running-gateway (only for copies outside ~/.openclaw).
 * --apply refuses to run while the gateway is up (systemd or process list).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

import { classifySensitivityByRules } from "../lib/sensitivity.js";
import { appendDestructiveOpLog, safeAgentId } from "../lib/sql-safety.js";

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const opts = { agents: [], apply: false, base: join(homedir(), ".openclaw", "memory", "lancedb-namespaced"), snapshot: "", batch: 200, json: false, allowRunningGateway: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") opts.agents.push(safeAgentId(argv[++i]));
    else if (a === "--apply") opts.apply = true;
    else if (a === "--dry-run") opts.apply = false;
    else if (a === "--base") opts.base = resolve(argv[++i]);
    else if (a === "--snapshot") opts.snapshot = resolve(argv[++i]);
    else if (a === "--batch") opts.batch = Math.max(1, Math.min(1000, Number(argv[++i]) || 200));
    else if (a === "--json") opts.json = true;
    else if (a === "--allow-running-gateway") opts.allowRunningGateway = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.agents.length === 0) throw new Error("--agent <id> is required");
  return opts;
}

function gatewayRunning() {
  let systemd = "unknown";
  try {
    systemd = execFileSync("systemctl", ["--user", "is-active", "openclaw-gateway"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (error) {
    systemd = String(error?.stdout || "").trim() || "unknown";
  }
  let processes = 0;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const args = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (args.includes("gateway") && args.some((part) => /openclaw/.test(part))) processes++;
    } catch { /* gone */ }
  }
  return ["active", "activating", "reloading", "deactivating"].includes(systemd) || processes > 0;
}

/**
 * Classify the unclassified rows of one agent table; with apply, write them.
 * @param {object} table LanceDB table
 * @param {{apply: boolean, batch: number}} opts
 * @returns {Promise<{rows: number, unclassified: number, byLevel: Record<string, number>, written: number}>}
 */
export async function backfillTable(table, { apply = false, batch = 200 } = {}) {
  const fields = new Set(((await table.schema())?.fields || []).map((f) => f.name));
  if (!fields.has("sensitivity") || !fields.has("sensitivitySource")) throw new Error("table has no sensitivity columns (start 7.21.2 once first)");
  const rows = await table.query().where("sensitivity = '' OR sensitivity IS NULL").select(["id", "text"]).toArray();
  const groups = { banal: [], personal: [], confidential: [] };
  for (const row of rows) groups[classifySensitivityByRules(row.text).sensitivity].push(String(row.id));
  let written = 0;
  if (apply) {
    for (const [level, ids] of Object.entries(groups)) {
      for (let i = 0; i < ids.length; i += batch) {
        const chunk = ids.slice(i, i + batch).filter((id) => /^[A-Za-z0-9_-]{1,80}$/.test(id));
        if (chunk.length === 0) continue;
        await table.update({ where: `id IN (${chunk.map((id) => `'${id}'`).join(",")}) AND (sensitivity = '' OR sensitivity IS NULL)`, values: { sensitivity: level, sensitivitySource: "rules" } });
        written += chunk.length;
      }
    }
  }
  const total = await table.countRows();
  return { rows: total, unclassified: rows.length, byLevel: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])), written };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.apply) {
    // Nur Kopien außerhalb von ~/.openclaw dürfen bei laufendem Gateway geschrieben werden.
    const outsideHome = !opts.base.startsWith(join(homedir(), ".openclaw"));
    if (gatewayRunning() && !(opts.allowRunningGateway && outsideHome)) throw new Error("gateway is running; stop it before --apply");
    if (!opts.snapshot || !existsSync(opts.snapshot)) throw new Error("--apply needs --snapshot <existing snapshot dir> (scripts/backup-snapshot.sh)");
  }
  const lancedb = require("@lancedb/lancedb");
  const report = [];
  for (const agent of opts.agents) {
    const dir = join(opts.base, agent);
    const db = await lancedb.connect(dir);
    const table = await db.openTable("memories");
    if (opts.apply) appendDestructiveOpLog(join(opts.base, ".."), { timestamp: new Date().toISOString(), op: "sensitivity-backfill", phase: "started", agent, snapshot: opts.snapshot });
    const result = await backfillTable(table, { apply: opts.apply, batch: opts.batch });
    if (opts.apply) appendDestructiveOpLog(join(opts.base, ".."), { timestamp: new Date().toISOString(), op: "sensitivity-backfill", phase: "committed", agent, written: result.written });
    report.push({ agent, ...result });
    await table.close?.();
  }
  if (opts.json) console.log(JSON.stringify({ apply: opts.apply, report }, null, 2));
  else for (const r of report) console.log(`${r.agent}: ${r.rows} rows, ${r.unclassified} unclassified → banal ${r.byLevel.banal}, personal ${r.byLevel.personal}, confidential ${r.byLevel.confidential}${opts.apply ? `, written ${r.written}` : " (dry run)"}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(`sensitivity-backfill: ${error?.message || error}`); process.exit(1); });
}

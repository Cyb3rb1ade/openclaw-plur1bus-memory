#!/usr/bin/env node
/**
 * scripts/importance-metrics.mjs — Kennzahlen der Importance-Verteilung,
 * read-only.
 *
 * Beantwortet nach dem Umbau (Kodierung + Gebrauch statt Keyword-Heuristik)
 * eine Frage: ist die Skala noch kollabiert? Heute (vor dem Backfill) liegen
 * 71,1 % der aktiven Zeilen von "main" auf genau 0,70 — Erwartung nach dem
 * Umbau: kein Einzelwert über 25 %, Blitzlicht-Anteil unter 2 % der neuen
 * Erinnerungen. Dieses Skript schreibt nichts, es liest nur.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { safeAgentId } from "../lib/sql-safety.js";

/**
 * Kennzahlen der Importance-Verteilung über die aktiven Zeilen: Gesamtzahl,
 * häufigster Wert und sein Anteil, Blitzlicht-Anteil (halfLifeDays === 3650)
 * und Anzahl im Agentenband (importance >= 0.95).
 */
export function summarizeImportance(rows = []) {
  const active = (Array.isArray(rows) ? rows : []).filter((r) => String(r?.status ?? "active") === "active");
  const counts = new Map();
  for (const row of active) {
    const key = Number(row.importance).toFixed(2);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const [topValue, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || ["-", 0];
  const flashbulb = active.filter((r) => Number(r.halfLifeDays) === 3650).length;
  return {
    total: active.length,
    topValue,
    topShare: active.length ? topCount / active.length : 0,
    flashbulbShare: active.length ? flashbulb / active.length : 0,
    agentBand: active.filter((r) => Number(r.importance) >= 0.95).length,
  };
}

function openclawHome() {
  return process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
}

/** Ohne explizit übergebene Agent-IDs alle Stores erfassen, wie backfill-manual-core-markers.mjs. */
function discoverAgents(baseDbPath) {
  if (!existsSync(baseDbPath)) return [];
  return readdirSync(baseDbPath, { withFileTypes: true })
    .filter((entry) => (
      entry.isDirectory()
      && !entry.isSymbolicLink()
      && !entry.name.startsWith("_")
      && (
        existsSync(join(baseDbPath, entry.name, "memories.lance"))
        || existsSync(join(baseDbPath, entry.name, "memories"))
      )
    ))
    .map((entry) => entry.name);
}

function parseArgs(argv) {
  const args = { baseDbPath: null, agents: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base-db-path" && argv[i + 1]) args.baseDbPath = argv[++i];
    else if (!argv[i].startsWith("--")) args.agents.push(argv[i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseDbPath = args.baseDbPath || join(openclawHome(), "memory", "lancedb-namespaced");
  const agentIds = args.agents.length > 0 ? args.agents : discoverAgents(baseDbPath);

  if (agentIds.length === 0) {
    console.log("Nutzung: node scripts/importance-metrics.mjs [<agentId> ...] [--base-db-path <pfad>]");
    console.log(`Keine Agent-IDs übergeben und keine Stores unter ${baseDbPath} gefunden.`);
    return 1;
  }

  const lancedb = await import("@lancedb/lancedb");
  let failed = 0;

  for (const rawAgentId of agentIds) {
    const agentId = safeAgentId(rawAgentId);
    let table;
    try {
      const db = await lancedb.connect(join(baseDbPath, agentId));
      table = await db.openTable("memories");
    } catch (err) {
      console.log(`${agentId.padEnd(14)} kein memories-Table (${err?.message || err})`);
      failed += 1;
      continue;
    }

    const rows = await table.query().limit(100000).toArray();
    const s = summarizeImportance(rows);
    console.log(
      `${agentId.padEnd(14)} n=${String(s.total).padStart(6)} häufigster ${s.topValue} (${(100 * s.topShare).toFixed(1)}%)`
      + ` Blitzlicht ${(100 * s.flashbulbShare).toFixed(1)}% Agentenband ${s.agentBand}`,
    );
  }

  return failed > 0 ? 1 : 0;
}

// Nur ausführen, wenn direkt aufgerufen — der Test importiert die reine Kennzahl-Funktion.
if (process.argv[1] && process.argv[1].endsWith("importance-metrics.mjs")) {
  process.exitCode = await main();
}

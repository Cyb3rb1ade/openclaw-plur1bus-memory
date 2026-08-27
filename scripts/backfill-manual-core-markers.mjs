#!/usr/bin/env node
/**
 * scripts/backfill-manual-core-markers.mjs — rüstet den Core-Schutz für
 * Erinnerungen nach, die der Agent vor 7.3.4 mit `importance = 1.0` markiert hat.
 *
 * `applyDynamicsDefaults` kodiert nur bei neuen Einträgen (`isNew`), deshalb
 * blieben bereits gespeicherte Markierungen wirkungslos: `neverForget = 0`,
 * `memoryClass = "standard"`.
 *
 * Standard ist Dry-Run; `--apply` muss ausdrücklich gesetzt werden. Es werden
 * ausschließlich die Schutzfelder gesetzt — Text, Vektor und Provenienz bleiben
 * unangetastet, und bereits geschützte Zeilen werden nicht angefasst.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { CORE_MEMORY_HALF_LIFE_DAYS, MANUAL_CORE_IMPORTANCE } from "../lib/memory-dynamics.js";
import { safeAgentId } from "../lib/sql-safety.js";

/**
 * Zeilen, die der Agent bewusst markiert hat und die den Schutz noch nicht tragen.
 * `neverForget` kommt aus LanceDB als BigInt.
 */
export function selectManualCoreRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!row) return false;
    const status = String(row.status ?? "");
    if (status === "deleted" || status === "archived") return false;
    if (Number(row.importance) < MANUAL_CORE_IMPORTANCE) return false;
    if (String(row.memoryClass ?? "") === "core") return false;
    return Number(row.neverForget ?? 0) === 0;
  });
}

function openclawHome() {
  return process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
}

function parseArgs(argv) {
  const args = { apply: false, baseDbPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--base-db-path" && argv[i + 1]) args.baseDbPath = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseDbPath = args.baseDbPath || join(openclawHome(), "memory", "lancedb-namespaced");
  if (!existsSync(baseDbPath)) {
    process.stdout.write(JSON.stringify({ error: `base db path not found: ${baseDbPath}` }, null, 2) + "\n");
    return 1;
  }

  const lancedb = await import("@lancedb/lancedb");
  const agents = readdirSync(baseDbPath, { withFileTypes: true })
    .filter((entry) => (
      entry.isDirectory()
      && !entry.isSymbolicLink()
      && !entry.name.startsWith("_")
      && existsSync(join(baseDbPath, entry.name, "memories.lance"))
    ))
    .map((entry) => safeAgentId(entry.name));

  const report = { mode: args.apply ? "apply" : "dry-run", baseDbPath, agents: [], total: 0, failed: 0 };

  for (const agentId of agents) {
    let table;
    try {
      const db = await lancedb.connect(join(baseDbPath, agentId));
      table = await db.openTable("memories");
    } catch {
      continue; // kein memories-Table (z.B. Hilfsverzeichnis)
    }

    const rows = await table.query()
      .select(["id", "importance", "neverForget", "memoryClass", "status", "text"])
      .limit(200000)
      .toArray();
    const treffer = selectManualCoreRows(rows);
    if (treffer.length === 0) continue;

    const eintrag = {
      agentId,
      found: treffer.length,
      updated: 0,
      ids: treffer.map((r) => r.id),
      preview: treffer.slice(0, 3).map((r) => String(r.text ?? "").slice(0, 80).replace(/\s+/g, " ")),
    };

    if (args.apply) {
      for (const row of treffer) {
        try {
          await table.update({
            values: {
              memoryClass: "core",
              neverForget: 1,
              coreMemoryScore: 1.0,
              coreMemoryReason: "manual_importance_marker",
              memoryStrength: 1.0,
              halfLifeDays: CORE_MEMORY_HALF_LIFE_DAYS,
              expiresAt: 0,
            },
            where: `id = "${String(row.id)}"`,
          });
          eintrag.updated += 1;
        } catch (err) {
          report.failed += 1;
          eintrag.error = err?.message || String(err);
        }
      }
    }

    report.total += treffer.length;
    report.agents.push(eintrag);
  }

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  // Fail-closed wie die übrigen Reparaturskripte: ein fehlgeschlagenes Update
  // darf in einem Gate nicht still als Erfolg durchgehen.
  return report.failed > 0 ? 1 : 0;
}

// Nur ausführen, wenn direkt aufgerufen — der Test importiert die reine Auswahl.
if (process.argv[1] && process.argv[1].endsWith("backfill-manual-core-markers.mjs")) {
  process.exitCode = await main();
}

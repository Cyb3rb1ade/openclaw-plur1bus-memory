#!/usr/bin/env node
/**
 * scripts/reapply-tombstones.mjs — wendet committed Tombstones erneut auf die
 * (ggf. per Snapshot-Restore wiederhergestellte) LanceDB an.
 *
 * Liest die append-only Tombstone-Registry und soft-deleted jede noch aktive
 * Zeile (status="deleted", epistemicStatus="invalidated"). Dadurch kann ein
 * Snapshot-Restore keine nach dem Snapshot gelöschte Erinnerung reaktivieren.
 *
 * Standard ist Dry-Run; `--apply` muss ausdrücklich gesetzt werden.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readTombstoneRegistry, tombstoneRegistryDir } from "../lib/tombstone.js";
import { createDbAdapter } from "../lib/db-adapter.js";
import { safeAgentId } from "../lib/sql-safety.js";

const DEFAULT_BASE_DB = join(openclawHome(), "memory", "lancedb-namespaced");

function openclawHome() {
  // OPENCLAW_HOME zeigt auf das OpenClaw-Verzeichnis selbst (wie index.js);
  // nur wenn es fehlt, wird ~/.openclaw angenommen. Kein doppeltes .openclaw.
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
  const baseDbPath = args.baseDbPath || DEFAULT_BASE_DB;
  const registryDir = tombstoneRegistryDir(baseDbPath);

  // Alle Agents aus der Registry-Datei-Namen ableiten.
  const agents = new Set();
  if (existsSync(registryDir)) {
    for (const file of readdirSync(registryDir)) {
      if (file.endsWith(".jsonl")) agents.add(file.slice(0, -".jsonl".length));
    }
  }

  const report = {
    mode: args.apply ? "apply" : "dry-run",
    applied: [],
    alreadyTombstoned: [],
    notFound: [],
    errors: [],
    registryErrors: [],
    activeAfterReapply: [],
  };

  for (const agent of agents) {
    let safeAgent;
    try { safeAgent = safeAgentId(agent); } catch {
      report.registryErrors.push({ agent, error: "invalid registry filename" });
      continue;
    }
    // Im Dry-Run strikt read-only: die Torn-Tail-Reparatur ist ein Schreibvorgang
    // und darf ohne --apply nicht laufen. Ein abgebrochener Append wird dann als
    // beschädigte Zeile gemeldet — der Operator sieht, dass --apply nötig ist.
    const registry = readTombstoneRegistry(baseDbPath, safeAgent, { repairTornTail: args.apply });
    if (!registry.ok) {
      report.registryErrors.push({ agent: safeAgent, error: registry.readError });
      continue;
    }
    if (registry.corruptLines > 0) {
      // Fail-closed: beschädigte Zeilen könnten einen committed Tombstone
      // verbergen — das Restore darf nicht still "ok" melden.
      report.registryErrors.push({ agent: safeAgent, error: `corrupt registry lines: ${registry.corruptLines}` });
      continue;
    }
    const tombstones = registry.tombstones.filter((t) => t.status === "committed");
    if (tombstones.length === 0) continue;
    const adapter = createDbAdapter({ basePath: baseDbPath, logger: { info() {}, warn() {} } });
    for (const tombstone of tombstones) {
      const id = tombstone.memoryId;
      if (!id) continue;
      if (!args.apply) {
        report.applied.push({ agent: safeAgent, memoryId: id, dryRun: true });
        continue;
      }
      try {
        const result = await adapter.tombstoneCard(safeAgent, id);
        if (result.alreadyTombstoned) report.alreadyTombstoned.push({ agent: safeAgent, memoryId: id });
        else if (result.notFound) report.notFound.push({ agent: safeAgent, memoryId: id });
        else report.applied.push({ agent: safeAgent, memoryId: id });
      } catch (err) {
        report.errors.push({ agent: safeAgent, memoryId: id, error: err?.message || String(err) });
      }
    }
    // Verifikation: keine durch committed Tombstone adressierte Zeile darf
    // recallbar/aktiv geblieben sein (Resurrection-Schutz). Verifikationsfehler
    // werden NICHT verschluckt — sie führen zum Fehlschlag. "active", "" und null
    // gelten als legacy-recallbar.
    for (const tombstone of tombstones) {
      const id = tombstone.memoryId;
      if (!id) continue;
      try {
        const row = await adapter.getCardRaw(safeAgent, id);
        if (row) {
          const status = String(row.status ?? "");
          if (status === "active" || status === "") {
            report.activeAfterReapply.push({ agent: safeAgent, memoryId: id, status });
          }
        }
      } catch (err) {
        report.errors.push({ agent: safeAgent, memoryId: id, error: `verify: ${err?.message || String(err)}` });
      }
    }
    await adapter.shutdown();
  }

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");

  const failed = report.errors.length > 0 || report.registryErrors.length > 0 || report.activeAfterReapply.length > 0;
  return failed ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  process.stderr.write(`reapply-tombstones failed: ${err?.message || err}\n`);
  process.exitCode = 1;
});

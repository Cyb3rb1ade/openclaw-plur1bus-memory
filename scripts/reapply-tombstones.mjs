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

import { homedir } from "node:os";
import { join } from "node:path";
import { reapplyCommittedTombstones, reapplyFailed } from "../lib/tombstone-reapply.js";

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
  const report = await reapplyCommittedTombstones({ baseDbPath, apply: args.apply });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return reapplyFailed(report) ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  process.stderr.write(`reapply-tombstones failed: ${err?.message || err}\n`);
  process.exitCode = 1;
});

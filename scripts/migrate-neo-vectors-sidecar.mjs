#!/usr/bin/env node
/**
 * scripts/migrate-neo-vectors-sidecar.mjs (7.12.26)
 *
 * Einmalige Migration der Inline-Vektoren aus turn-journal.jsonl,
 * memory-candidates.jsonl und behavior-cards.jsonl in das Vektor-Sidecar
 * (vectors.<gen>.f32 + vector-index.json) je Neo-Workspace. Verlustfrei:
 * die Werte werden als Float32 geschrieben, zurueckgelesen und bitgenau
 * gegen die JSON-Werte geprueft, erst danach werden die JSONL-Dateien ohne
 * `embedding` neu geschrieben.
 *
 *   node scripts/migrate-neo-vectors-sidecar.mjs [--root <neoRoot>] [--workspace <dirname>] [--dry-run] [--json]
 *
 * Bei laufendem Gateway nur mit Vorsicht: die Migration haelt den
 * Workspace-Write-Lock, ein gleichzeitiger Drain wartet darauf.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { migrateInlineVectorsToSidecar } from "../lib/neo-arch.js";

function parseArgs(argv) {
  const args = { root: join(homedir(), ".openclaw", "memory", "lancedb-namespaced", "_neo"), workspace: "", dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") args.root = argv[++i] || args.root;
    else if (arg === "--workspace") args.workspace = argv[++i] || "";
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") { args.help = true; }
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("usage: migrate-neo-vectors-sidecar.mjs [--root <neoRoot>] [--workspace <dirname>] [--dry-run] [--json]\n");
    return 0;
  }
  const workspacesDir = join(args.root, "workspaces");
  if (!existsSync(workspacesDir)) throw new Error(`no workspaces directory under ${args.root}`);
  const names = args.workspace
    ? [args.workspace]
    : readdirSync(workspacesDir).filter((name) => {
      try { return statSync(join(workspacesDir, name)).isDirectory(); } catch (_) { return false; }
    });
  const reports = [];
  for (const name of names) {
    const dir = join(workspacesDir, name);
    const started = Date.now();
    const report = migrateInlineVectorsToSidecar(dir, { dryRun: args.dryRun });
    report.ms = Date.now() - started;
    reports.push(report);
    if (!args.json) {
      const files = Object.entries(report.files).map(([file, f]) => `${file}: ${f.inlineVectors} inline, ${(f.bytesBefore / 1e6).toFixed(1)} → ${(f.bytesAfter / 1e6).toFixed(1)} MB`).join("; ");
      process.stdout.write(`${args.dryRun ? "[dry-run] " : ""}${name}: vectors=${report.vectorsWritten} verified=${report.verified} ${files} (${report.ms} ms)\n`);
    }
  }
  if (args.json) process.stdout.write(`${JSON.stringify({ dryRun: args.dryRun, root: args.root, workspaces: reports }, null, 2)}\n`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`migrate-neo-vectors-sidecar: ${error?.message || error}\n`);
  process.exitCode = 1;
}

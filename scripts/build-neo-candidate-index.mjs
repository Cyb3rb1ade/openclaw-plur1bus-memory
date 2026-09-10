#!/usr/bin/env node
/**
 * scripts/build-neo-candidate-index.mjs (7.12.28)
 *
 * Legt den Kandidaten-Metadatenindex (candidate-index.jsonl) je Neo-Workspace
 * an bzw. baut ihn neu: juengste Revision je Kandidaten-ID aus
 * memory-candidates.jsonl, ohne Vektoren. Der Plugin-Code legt den Index beim
 * ersten Kandidaten-Append selbst an; dieses Skript zieht das beim Deploy vor,
 * damit der erste Recall nach dem Neustart nicht darauf wartet.
 *
 *   node scripts/build-neo-candidate-index.mjs [--root <neoRoot>] [--workspace <dirname>] [--rebuild] [--max-entries <n>] [--dry-run] [--json]
 *
 * Bei laufendem Gateway: Zeilen, die ein aelterer Plugin-Stand nach dem
 * Aufbau noch schreibt, fehlen im Index (der Self-Heal des neuen Stands
 * prueft je Append nur die letzten 50 Journalzeilen). Deshalb mit gestopptem
 * Gateway laufen lassen oder danach mit --rebuild wiederholen.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { buildNeoCandidateIndexForDir } from "../lib/neo-arch.js";

function parseArgs(argv) {
  const args = { root: join(homedir(), ".openclaw", "memory", "lancedb-namespaced", "_neo"), workspace: "", rebuild: false, maxEntries: undefined, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") args.root = argv[++i] || args.root;
    else if (arg === "--workspace") args.workspace = argv[++i] || "";
    else if (arg === "--rebuild") args.rebuild = true;
    else if (arg === "--max-entries") args.maxEntries = Number(argv[++i]);
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
    process.stdout.write("usage: build-neo-candidate-index.mjs [--root <neoRoot>] [--workspace <dirname>] [--rebuild] [--max-entries <n>] [--dry-run] [--json]\n");
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
    const report = buildNeoCandidateIndexForDir(dir, { dryRun: args.dryRun, rebuild: args.rebuild, maxEntries: args.maxEntries });
    report.ms = Date.now() - started;
    reports.push(report);
    if (!args.json) {
      const prefix = args.dryRun ? "[dry-run] " : "";
      if (report.built) {
        process.stdout.write(`${prefix}${name}: built entries=${report.entries} from ${report.sourceRecords} journal lines (unique ${report.unique}, dropped status=${report.removedStatus} injected=${report.removedInjected} cap=${report.removedCap}) (${report.ms} ms)\n`);
      } else {
        process.stdout.write(`${prefix}${name}: skipped (${report.reason})${report.entries !== undefined ? ` entries=${report.entries} lines=${report.lines}` : ""}\n`);
      }
    }
  }
  if (args.json) process.stdout.write(JSON.stringify({ root: args.root, dryRun: args.dryRun, rebuild: args.rebuild, workspaces: reports }, null, 2) + "\n");
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`build-neo-candidate-index: ${error?.message || String(error)}\n`);
  process.exitCode = 1;
}

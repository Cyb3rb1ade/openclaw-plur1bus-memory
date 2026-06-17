#!/usr/bin/env node
/**
 * maintain-lancedb.mjs — safe LanceDB manifest-version pruner.
 *
 * LanceDB appends a new manifest version on every write. After thousands of
 * captures the _versions directory can contain 1000–2500 files per table,
 * making connection startup visibly slow and causing gateway timeouts.
 *
 * This script prunes each table's _versions directory to the N most-recent
 * manifests (default 50). It is safe: only manifest JSON files are removed,
 * the actual .lance data files are never touched.
 *
 * Usage:
 *   node scripts/maintain-lancedb.mjs              # dry-run (default)
 *   node scripts/maintain-lancedb.mjs --apply      # actually prune
 *   node scripts/maintain-lancedb.mjs --keep 100   # keep more versions
 *   node scripts/maintain-lancedb.mjs --db-path /custom/path
 *
 * Exit codes:
 *   0  Success (or nothing to do)
 *   1  Error
 */

import { existsSync, readdirSync, statSync, unlinkSync, mkdirSync, copyFileSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";

const DEFAULT_KEEP = 50;
const WARN_THRESHOLD = 500;
const CRITICAL_THRESHOLD = 1500;

function parseArgs(argv) {
  const opts = { apply: false, keep: DEFAULT_KEEP, dbPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply")     opts.apply = true;
    else if (a === "--keep") opts.keep = parseInt(argv[++i], 10) || DEFAULT_KEEP;
    else if (a === "--db-path") opts.dbPath = argv[++i];
  }
  return opts;
}

function sortedManifests(versionsDir) {
  return readdirSync(versionsDir)
    .filter((f) => extname(f) === ".json")
    .map((f) => ({ name: f, mtime: statSync(join(versionsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime); // newest first
}

function pruneTable(versionsDir, keep, apply) {
  const manifests = sortedManifests(versionsDir);
  const total = manifests.length;
  const toRemove = manifests.slice(keep);

  const status = total > CRITICAL_THRESHOLD ? "CRITICAL" : total > WARN_THRESHOLD ? "WARN" : "ok";
  const icon = status === "ok" ? "✓" : "✗";

  if (toRemove.length === 0) {
    console.log(`  ${icon} ${versionsDir.split("/").slice(-3).join("/")}/_versions: ${total} versions  [${status}]`);
    return { removed: 0, total, status };
  }

  const label = apply ? `pruning ${toRemove.length} → keeping ${keep}` : `would prune ${toRemove.length} → keep ${keep}`;
  console.log(`  ${icon} ${versionsDir.split("/").slice(-3).join("/")}/_versions: ${total} versions  [${status}]  (${label})`);

  if (apply) {
    for (const m of toRemove) {
      unlinkSync(join(versionsDir, m.name));
    }
  }

  return { removed: apply ? toRemove.length : 0, total, status };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const base = opts.dbPath ?? join(homedir(), ".openclaw", "memory", "lancedb-namespaced");

  console.log(`maintain-lancedb — ${opts.apply ? "APPLY" : "dry-run"} (keep=${opts.keep})`);
  console.log(`  db path: ${base}`);

  if (!existsSync(base)) {
    console.log("  ✓ No LanceDB directory found — nothing to do.");
    process.exit(0);
  }

  let totalRemoved = 0;
  let tablesProcessed = 0;
  let elevated = 0;

  const agentDirs = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const agent of agentDirs) {
    const agentPath = join(base, agent);
    const tables = readdirSync(agentPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const table of tables) {
      const versionsDir = join(agentPath, table, "_versions");
      if (!existsSync(versionsDir)) continue;

      tablesProcessed++;
      const { removed, total, status } = pruneTable(versionsDir, opts.keep, opts.apply);
      totalRemoved += removed;
      if (status !== "ok") elevated++;
    }
  }

  console.log("");
  console.log(`  Tables scanned:  ${tablesProcessed}`);
  console.log(`  Elevated tables: ${elevated}`);
  console.log(`  Manifests ${opts.apply ? "removed" : "to remove"}: ${opts.apply ? totalRemoved : "(dry-run)"}`);

  if (!opts.apply && elevated > 0) {
    console.log("\n  Run with --apply to prune:");
    console.log("    node scripts/maintain-lancedb.mjs --apply");
  }
}

main().catch((err) => { console.error("maintain-lancedb:", err); process.exit(1); });

#!/usr/bin/env node
/**
 * maintain-lancedb.mjs — safe LanceDB manifest-version pruner.
 *
 * LanceDB appends a new manifest version on every write. After thousands of
 * captures the _versions directory can contain 1000–2500 files per table,
 * making connection startup visibly slow and causing gateway timeouts.
 *
 * This script prunes each table's _versions directory to the N most-recent
 * manifests (default 50). It is safe: only manifest metadata files are removed,
 * the actual .lance data files are never touched.
 *
 * Usage:
 *   node scripts/maintain-lancedb.mjs              # dry-run (default)
 *   node scripts/maintain-lancedb.mjs --apply      # actually prune
 *   node scripts/maintain-lancedb.mjs --keep 100   # keep more versions
 *   node scripts/maintain-lancedb.mjs --keep=100   # equals form is also supported
 *   node scripts/maintain-lancedb.mjs --db-path /custom/path
 *
 * Exit codes:
 *   0  Success (or nothing to do)
 *   1  Error
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { extname, join, relative } from "node:path";
import { homedir } from "node:os";
import { appendDestructiveOpLog, resolveInside, safeAgentId } from "../lib/sql-safety.js";

const DEFAULT_KEEP = 50;
const MAX_KEEP = 100_000;
const WARN_THRESHOLD = 500;
const CRITICAL_THRESHOLD = 1500;

function parseKeep(raw) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new Error(`--keep must be a positive decimal integer between 1 and ${MAX_KEEP}`);
  }
  const keep = Number(raw);
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > MAX_KEEP) {
    throw new Error(`--keep must be a positive decimal integer between 1 and ${MAX_KEEP}`);
  }
  return keep;
}

function parseArgs(argv) {
  const opts = { apply: false, keep: DEFAULT_KEEP, dbPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") {
      opts.apply = true;
    } else if (a === "--keep") {
      opts.keep = parseKeep(argv[++i]);
    } else if (a.startsWith("--keep=")) {
      opts.keep = parseKeep(a.slice("--keep=".length));
    } else if (a === "--db-path") {
      const dbPath = argv[++i];
      if (!dbPath || dbPath.startsWith("--")) throw new Error("--db-path requires a path value");
      opts.dbPath = dbPath;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

function sortedManifests(versionsDir) {
  return readdirSync(versionsDir, { withFileTypes: true })
    .filter((entry) => [".json", ".manifest"].includes(extname(entry.name)))
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Unsafe manifest entry (expected regular file): ${entry.name}`);
      }
      const manifestPath = resolveInside(versionsDir, entry.name);
      return { name: entry.name, mtime: statSync(manifestPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // newest first
}

function backupPrunedManifests(base, versionsDir, toRemove, backupRoot) {
  const relPath = relative(base, versionsDir);
  if (!relPath || relPath.startsWith("..")) {
    throw new Error(`Unsafe versions path outside DB base: ${versionsDir}`);
  }
  const destDir = resolveInside(backupRoot, relPath);
  mkdirSync(destDir, { recursive: true });
  for (const m of toRemove) {
    copyFileSync(resolveInside(versionsDir, m.name), resolveInside(destDir, m.name));
  }
  writeFileSync(
    resolveInside(destDir, "_prune-manifest.json"),
    JSON.stringify({ prunedAt: new Date().toISOString(), count: toRemove.length, files: toRemove.map((m) => m.name) }, null, 2),
  );
}

function pruneTable(base, versionsDir, keep, apply, backupRoot) {
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
    backupPrunedManifests(base, versionsDir, toRemove, backupRoot);
    for (const m of toRemove) {
      unlinkSync(resolveInside(versionsDir, m.name));
    }
    const verified = sortedManifests(versionsDir);
    const expected = Math.min(total, keep);
    if (verified.length !== expected) {
      throw new Error(`Post-prune verification failed for ${versionsDir}: expected ${expected}, found ${verified.length}`);
    }
    console.log(`    verified: ${verified.length} manifests remain`);
  }

  return { removed: apply ? toRemove.length : 0, total, status };
}

function discoverVersionDirs(base) {
  if (lstatSync(base).isSymbolicLink()) throw new Error(`Unsafe DB base symlink: ${base}`);
  const resolvedBase = resolveInside(base);
  const versionsDirs = [];
  const agentEntries = readdirSync(resolvedBase, { withFileTypes: true });

  for (const entry of agentEntries) {
    if (entry.isSymbolicLink()) throw new Error(`Unsafe agent symlink: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const agent = safeAgentId(entry.name);
    const agentPath = resolveInside(resolvedBase, agent);
    const tableEntries = readdirSync(agentPath, { withFileTypes: true });

    for (const tableEntry of tableEntries) {
      if (tableEntry.isSymbolicLink()) throw new Error(`Unsafe table symlink: ${agent}/${tableEntry.name}`);
      if (!tableEntry.isDirectory()) continue;
      const tablePath = resolveInside(agentPath, tableEntry.name);
      const candidate = join(tablePath, "_versions");
      if (!existsSync(candidate)) continue;
      if (lstatSync(candidate).isSymbolicLink()) {
        throw new Error(`Unsafe _versions symlink: ${agent}/${tableEntry.name}`);
      }
      const versionsDir = resolveInside(tablePath, "_versions");
      if (!lstatSync(versionsDir).isDirectory()) {
        throw new Error(`Unsafe _versions target (expected directory): ${versionsDir}`);
      }
      sortedManifests(versionsDir);
      versionsDirs.push(versionsDir);
    }
  }

  return { base: resolvedBase, versionsDirs };
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

  const discovered = discoverVersionDirs(base);
  const plannedRemovalCount = discovered.versionsDirs.reduce(
    (count, versionsDir) => count + Math.max(0, sortedManifests(versionsDir).length - opts.keep),
    0,
  );

  let totalRemoved = 0;
  let tablesProcessed = 0;
  let elevated = 0;

  // Create a timestamped backup root only after the complete read-only
  // discovery/validation phase has succeeded and deletion is actually planned.
  const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const backupRoot = resolveInside(homedir(), ".openclaw-backups", `lancedb-prune-${ts}`);
  if (opts.apply && plannedRemovalCount > 0) {
    mkdirSync(backupRoot, { recursive: true });
    console.log(`  backup root: ${backupRoot}`);
  }

  for (const versionsDir of discovered.versionsDirs) {
    tablesProcessed++;
    const { removed, status } = pruneTable(discovered.base, versionsDir, opts.keep, opts.apply, backupRoot);
    totalRemoved += removed;
    if (status !== "ok") elevated++;
  }

  if (opts.apply && totalRemoved > 0) {
    appendDestructiveOpLog(homedir(), {
      timestamp: new Date().toISOString(),
      operation: "maintain-lancedb-prune",
      dbPath: discovered.base,
      keep: opts.keep,
      manifestsRemoved: totalRemoved,
      backupRoot,
    });
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

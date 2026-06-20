#!/usr/bin/env node
/**
 * cleanup-vault-missing-tasks.mjs
 *
 * Löscht stale "missing-<field>-<uuid>.md" Task-Findings aus allen Obsidian-
 * Workspaces, deren Source-Record inzwischen alle v6-Pflichtfelder besitzt.
 *
 * Läuft idempotent — nur wirklich aufgelöste Findings werden gelöscht.
 * Wird von apply-media-patch.sh beim Gateway-Start automatisch ausgeführt.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const REQUIRED_FIELDS = [
  "plur1bus_type", "plur1bus_id", "status", "risk",
  "scope", "trustLevel", "origin", "agentId", "createdAt", "updatedAt",
];

// Operator-local agent list. Keep personal names/IDs out of the public repo.
// Set PLUR1BUS_VAULTS as JSON or comma-separated agent IDs, e.g.:
//   PLUR1BUS_VAULTS='main,agent-a,agent-b'
function loadWorkspaces() {
  const env = process.env.PLUR1BUS_VAULTS;
  if (!env) return [];
  try {
    const parsed = JSON.parse(env);
    if (Array.isArray(parsed)) {
      return parsed.map(({ name, path }) => ({ name, path }));
    }
  } catch (_) {
    // not JSON, treat as comma-separated agent IDs
  }
  return env.split(",").map(id => id.trim()).filter(Boolean).map(id => ({
    name: id,
    path: join(homedir(), ".openclaw", `workspace-${id}`, "plur1bus"),
  }));
}

const WORKSPACES = loadWorkspaces();

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)/);
    if (!kv) continue;
    fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return fm;
}

/**
 * Build two sets from all non-task records:
 * - allIds: every plur1bus_id/id seen (incl. prefixed forms like "prov-<uuid>")
 * - resolvedIds: records where ALL required fields are present and non-empty
 *
 * A missing-<field>-<uuid>.md finding can be deleted when:
 *   a) No record at all has <uuid> anywhere in its plur1bus_id/id (orphaned finding), OR
 *   b) The record with that ID is complete (all required fields present)
 */
function buildRecordSets(recordsRoot) {
  const allIds = new Set();      // raw UUIDs seen in any record's ID fields
  const resolvedIds = new Set(); // raw UUIDs of fully-complete records

  const collections = existsSync(recordsRoot)
    ? readdirSync(recordsRoot, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name !== "tasks")
        .map(e => e.name)
    : [];

  for (const col of collections) {
    const dir = join(recordsRoot, col);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const content = readFileSync(join(dir, entry.name), "utf8");
      const fm = parseFrontmatter(content);
      const fullId = fm.plur1bus_id || fm.id;
      if (!fullId) continue;
      // Extract raw UUID portion — strip any word prefix like "prov-", "impact-", "dup-" etc.
      const uuidMatch = fullId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
      const rawUuid = uuidMatch ? uuidMatch[1] : fullId;
      allIds.add(rawUuid);
      allIds.add(fullId); // also track the full prefixed form
      const complete = REQUIRED_FIELDS.every(f => fm[f] !== undefined && fm[f] !== "" && fm[f] !== "null");
      if (complete) {
        resolvedIds.add(rawUuid);
        resolvedIds.add(fullId);
      }
    }
  }
  return { allIds, resolvedIds };
}

function cleanupWorkspace(wsName, wsPath) {
  const recordsRoot = join(wsPath, "records");
  const tasksDir = join(recordsRoot, "tasks");

  if (!existsSync(tasksDir)) {
    console.log(`  [skip] ${wsName}: no tasks dir`);
    return { removed: 0, kept: 0 };
  }

  const { allIds, resolvedIds } = buildRecordSets(recordsRoot);

  let removed = 0;
  let kept = 0;

  for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const m = entry.name.match(/^missing-[^-]+-(.+)\.md$/);
    if (!m) continue;
    const sourceId = m[1];
    // Delete if: source record no longer exists (orphaned) OR record is now complete
    const orphaned = !allIds.has(sourceId);
    const resolved = resolvedIds.has(sourceId);
    if (orphaned || resolved) {
      try { unlinkSync(join(tasksDir, entry.name)); removed++; } catch { /* ignore */ }
    } else {
      kept++;
    }
  }

  return { removed, kept };
}

console.log("PLUR1BUS vault cleanup — removing stale missing-* task findings\n");

let totalRemoved = 0;
let totalKept = 0;

for (const ws of WORKSPACES) {
  if (!existsSync(ws.path)) {
    console.log(`  [skip] ${ws.name}: path not found (${ws.path})`);
    continue;
  }
  const { removed, kept } = cleanupWorkspace(ws.name, ws.path);
  console.log(`  [${ws.name}]: removed=${removed} stale, kept=${kept} active`);
  totalRemoved += removed;
  totalKept += kept;
}

console.log(`\nDone — removed: ${totalRemoved}, active findings kept: ${totalKept}`);

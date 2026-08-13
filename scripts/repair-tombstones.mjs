#!/usr/bin/env node
/**
 * scripts/repair-tombstones.mjs — rekonstruiert Tombstones für frühere
 * Hard Deletes aus vorhandenen Quellen (destructive-ops.jsonl + Archive).
 *
 * Idempotent, nicht destruktiv: erzeugt KEINE Löschung, überschreibt nichts,
 * erfindet keine Inhalte. Standard ist Dry-Run; `--apply` muss ausdrücklich
 * gesetzt werden.
 *
 * Quellen (Priorität):
 *   1. destructive-ops.jsonl  → "memory.deleted"-Ereignisse (memoryId, archivePath)
 *   2. _archive/*.json        → Karteninhalt für Fingerprint/Scope (via archivePath)
 *
 * Report: rekonstruiert / übersprungen (Duplikat) / konfliktbehaftet / ohne Inhalt.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

import {
  TOMBSTONE_SCHEMA_VERSION,
  contentFingerprint,
  findTombstoneByOriginId,
  appendTombstoneToRegistry,
  readTombstonesFromRegistry,
  tombstoneRegistryDir,
} from "../lib/tombstone.js";
import { safeAgentId, safeUuid } from "../lib/sql-safety.js";

function parseArgs(argv) {
  const args = { apply: false, baseDbPath: null, archiveDir: null, workspaces: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--base-db-path" && argv[i + 1]) args.baseDbPath = argv[++i];
    else if (a === "--archive-dir" && argv[i + 1]) args.archiveDir = argv[++i];
    else if (a === "--workspace" && argv[i + 1]) args.workspaces.push(argv[++i]);
  }
  return args;
}

const DEFAULT_BASE_DB = join(process.env.OPENCLAW_HOME || homedir(), ".openclaw", "memory", "lancedb-namespaced");
const DEFAULT_ARCHIVE = join(process.env.OPENCLAW_HOME || homedir(), ".openclaw", "memory", "_archive");

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

function findDestructiveOpsFiles(root) {
  const results = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "destructive-ops.jsonl") results.push(full);
    }
  }
  return results;
}

function findArchiveJsonFiles(archiveDir) {
  const results = [];
  const stack = [archiveDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".json")) results.push(full);
    }
  }
  return results;
}

function archiveByFilenameMap(files) {
  const map = new Map();
  for (const file of files) {
    map.set(basename(file), file);
  }
  return map;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseDbPath = args.baseDbPath || DEFAULT_BASE_DB;
  const archiveDir = args.archiveDir || DEFAULT_ARCHIVE;

  const destructiveOpsFiles = args.workspaces.length
    ? args.workspaces.flatMap((w) => findDestructiveOpsFiles(w))
    : findDestructiveOpsFiles(process.env.OPENCLAW_HOME || join(homedir(), ".openclaw"));

  const archiveFiles = findArchiveJsonFiles(archiveDir);
  const archiveByName = archiveByFilenameMap(archiveFiles);

  const reconstructed = [];
  const skipped = [];
  const conflicted = [];
  const missingContent = [];

  for (const opsFile of destructiveOpsFiles) {
    for (const event of readJsonl(opsFile)) {
      if (event.event !== "memory.deleted") continue;
      const memoryId = event.memoryId;
      const agentId = event.agentId;
      const archivePath = event.archivePath;
      if (!memoryId || !agentId) continue;
      try {
        safeUuid(memoryId);
        safeAgentId(agentId);
      } catch {
        conflicted.push({ memoryId, agentId, reason: "invalid id/agent" });
        continue;
      }

      // Dedup gegen vorhandene committed Tombstones.
      if (findTombstoneByOriginId(baseDbPath, agentId, memoryId)) {
        skipped.push({ memoryId, agentId, reason: "already_tombstoned" });
        continue;
      }

      // Karteninhalt aus dem Archiv laden (für Fingerprint/Scope).
      const archiveFile = archivePath && existsSync(archivePath)
        ? archivePath
        : archiveByName.get(archivePath ? basename(archivePath) : "");
      let card = null;
      if (archiveFile && existsSync(archiveFile)) {
        try { card = JSON.parse(readFileSync(archiveFile, "utf8")); } catch { card = null; }
      }
      if (!card || !card.text) {
        missingContent.push({ memoryId, agentId, reason: "archive content unavailable" });
        continue;
      }

      const tombstone = {
        schemaVersion: TOMBSTONE_SCHEMA_VERSION,
        tombstoneId: randomUUID(),
        memoryId,
        canonicalOriginId: card.canonicalOriginId || card.id || memoryId,
        agentId,
        scope: String(card.scope || "agent-private"),
        workspaceId: String(card.workspaceId || card.workspaceKey || ""),
        workspaceKey: String(card.workspaceKey || ""),
        ownerUserId: String(card.ownerUserId || ""),
        storedBy: String(card.storedBy || ""),
        deletedAt: event.timestamp || new Date().toISOString(),
        actor: "repair-tombstones",
        actorType: "system",
        reason: "reconstructed from destructive-ops.jsonl + archive",
        sourceOp: "migration_reconstruction",
        archiveRef: archiveFile || archivePath || "",
        previousVersion: String(card.previousVersion || ""),
        contentFingerprint: contentFingerprint(card.text),
        sourceFingerprint: "",
        refs: {},
        status: "committed",
      };

      if (args.apply) {
        appendTombstoneToRegistry(baseDbPath, agentId, tombstone);
      }
      reconstructed.push({ memoryId, agentId, fingerprint: tombstone.contentFingerprint.slice(0, 12) });
    }
  }

  const report = {
    mode: args.apply ? "apply" : "dry-run",
    registryDir: tombstoneRegistryDir(baseDbPath),
    reconstructed: reconstructed.length,
    skipped: skipped.length,
    conflicted: conflicted.length,
    missingContent: missingContent.length,
    reconstructedIds: reconstructed.map((r) => r.memoryId),
    skippedDetails: skipped,
    conflictedDetails: conflicted,
    missingContentDetails: missingContent,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main();

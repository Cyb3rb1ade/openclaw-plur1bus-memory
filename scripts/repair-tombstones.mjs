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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

import {
  TOMBSTONE_SCHEMA_VERSION,
  contentFingerprint,
  isValidTombstone,
  appendTombstoneToRegistry,
  readTombstoneRegistry,
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

function openclawHome() {
  // OPENCLAW_HOME zeigt auf das OpenClaw-Verzeichnis selbst (wie index.js);
  // nur wenn es fehlt, wird ~/.openclaw angenommen. Kein doppeltes .openclaw.
  return process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
}

const DEFAULT_BASE_DB = join(openclawHome(), "memory", "lancedb-namespaced");
const DEFAULT_ARCHIVE = join(openclawHome(), "memory", "_archive");

function readJsonl(path) {
  const records = [];
  let corruptLines = 0;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { records: [], corruptLines: 0, readError: err?.message || String(err) };
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { corruptLines += 1; }
  }
  return { records, corruptLines };
}

function findDestructiveOpsFiles(root, { required = false } = {}) {
  const results = [];
  const errors = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (!(dir === root && !required && err?.code === "ENOENT")) {
        errors.push({ root: dir, error: err?.message || String(err) });
      }
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "destructive-ops.jsonl") results.push(full);
    }
  }
  return { files: results, errors };
}

function findArchiveJsonFiles(archiveDir, { required = false } = {}) {
  const results = [];
  const errors = [];
  const stack = [archiveDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (!(dir === archiveDir && !required && err?.code === "ENOENT")) {
        errors.push({ root: dir, error: err?.message || String(err) });
      }
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".json")) results.push(full);
    }
  }
  return { files: results, errors };
}

// Kollisionsbewusste Namenszuordnung: ein Basename darf nur dann verwendet
// werden, wenn er eindeutig ist. Bei mehrdeutigen Dateinamen wird nicht geraten.
function archiveByFilenameMap(files) {
  const map = new Map();
  const collisions = new Set();
  for (const file of files) {
    const name = basename(file);
    if (map.has(name)) {
      collisions.add(name);
      map.delete(name);
    } else if (!collisions.has(name)) {
      map.set(name, file);
    }
  }
  return { map, collisions };
}

/**
 * Read every existing registry without repairing torn tails. Apply must not
 * mutate one registry while a different registry or filename is invalid.
 *
 * @param {string} baseDbPath
 * @returns {{byAgent: Map<string, Array<object>>, errors: Array<object>}}
 */
function readRegistriesForPlan(baseDbPath) {
  const byAgent = new Map();
  const errors = [];
  const registryDir = tombstoneRegistryDir(baseDbPath);
  if (!existsSync(registryDir)) return { byAgent, errors };

  let entries;
  try {
    entries = readdirSync(registryDir, { withFileTypes: true });
  } catch (err) {
    errors.push({ registryDir, error: err?.message || String(err) });
    return { byAgent, errors };
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".jsonl")) continue;
    const agent = entry.name.slice(0, -".jsonl".length);
    let safeAgent;
    try {
      safeAgent = safeAgentId(agent);
    } catch {
      errors.push({ agent, error: "invalid registry filename" });
      continue;
    }
    let registry;
    try {
      registry = readTombstoneRegistry(baseDbPath, safeAgent, { repairTornTail: false });
    } catch (err) {
      errors.push({ agent: safeAgent, error: err?.message || String(err) });
      continue;
    }
    if (!registry.ok) {
      errors.push({ agent: safeAgent, error: registry.readError });
      continue;
    }
    if (registry.corruptLines > 0) {
      errors.push({
        agent: safeAgent,
        error: `corrupt registry lines: ${registry.corruptLines}`,
      });
      continue;
    }
    byAgent.set(safeAgent, registry.tombstones);
  }
  return { byAgent, errors };
}

function hasCommittedOrigin(tombstones, ...originIds) {
  const ids = new Set(originIds.filter((id) => typeof id === "string" && id.length > 0));
  return tombstones.some((tombstone) => tombstone.status === "committed"
    && (ids.has(tombstone.canonicalOriginId) || ids.has(tombstone.memoryId)));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseDbPath = args.baseDbPath || DEFAULT_BASE_DB;
  const archiveDir = args.archiveDir || DEFAULT_ARCHIVE;

  const sourceErrors = [];
  const workspaceRoots = args.workspaces.length
    ? args.workspaces.map((root) => ({ root, required: true }))
    : [{ root: process.env.OPENCLAW_HOME || join(homedir(), ".openclaw"), required: false }];
  const destructiveOpsFiles = [];
  for (const { root, required } of workspaceRoots) {
    const discovery = findDestructiveOpsFiles(root, { required });
    destructiveOpsFiles.push(...discovery.files);
    sourceErrors.push(...discovery.errors);
  }

  const archiveDiscovery = findArchiveJsonFiles(archiveDir, { required: args.archiveDir !== null });
  const archiveFiles = archiveDiscovery.files;
  sourceErrors.push(...archiveDiscovery.errors);
  const { map: archiveByName, collisions: archiveNameCollisions } = archiveByFilenameMap(archiveFiles);
  const { byAgent: existingRegistries, errors: registryErrors } = readRegistriesForPlan(baseDbPath);

  const planned = [];
  const skipped = [];
  const conflicted = [];
  const missingContent = [];
  const unacceptableEvents = [];
  const applyErrors = [];
  let corruptLines = 0;
  let failedEventsSkipped = 0;
  let unconfirmedEventsSkipped = 0;
  const plannedOrigins = new Map();

  // Whitelist: NUR explizit bestätigte oder klar definierte historische Events
  // (ohne result-Feld) werden als committed rekonstruiert. attempted, failed und
  // unbekannte/unbestätigte Zustände werden übersprungen und gemeldet.
  const RECONSTRUCTABLE_RESULTS = new Set(["committed", "already_tombstoned"]);

  for (const opsFile of destructiveOpsFiles) {
    const parsedFile = readJsonl(opsFile);
    const { records, corruptLines: fileCorrupt } = parsedFile;
    if (parsedFile.readError) {
      sourceErrors.push({ file: opsFile, error: parsedFile.readError });
      continue;
    }
    corruptLines += fileCorrupt;
    for (const event of records) {
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        const detail = { file: opsFile, reason: "invalid event record" };
        unacceptableEvents.push(detail);
        conflicted.push(detail);
        continue;
      }
      if (event.event !== "memory.deleted") continue;
      if (event.result === "failed") {
        failedEventsSkipped += 1;
        const detail = { memoryId: event.memoryId, agentId: event.agentId, reason: "failed_event" };
        skipped.push(detail);
        unacceptableEvents.push(detail);
        continue;
      }
      if (event.result !== undefined && !RECONSTRUCTABLE_RESULTS.has(event.result)) {
        unconfirmedEventsSkipped += 1;
        const detail = {
          memoryId: event.memoryId,
          agentId: event.agentId,
          reason: `unconfirmed_result:${event.result}`,
        };
        skipped.push(detail);
        unacceptableEvents.push(detail);
        continue;
      }
      const memoryId = event.memoryId;
      const agentId = event.agentId;
      const archivePath = event.archivePath;
      if (!memoryId || !agentId) {
        const detail = { memoryId, agentId, reason: "missing memoryId/agent" };
        conflicted.push(detail);
        unacceptableEvents.push(detail);
        continue;
      }
      try {
        safeUuid(memoryId);
        safeAgentId(agentId);
      } catch {
        const detail = { memoryId, agentId, reason: "invalid id/agent" };
        conflicted.push(detail);
        unacceptableEvents.push(detail);
        continue;
      }

      const existing = existingRegistries.get(agentId) || [];
      if (hasCommittedOrigin(existing, memoryId)) {
        skipped.push({ memoryId, agentId, reason: "already_tombstoned" });
        continue;
      }
      const origins = plannedOrigins.get(agentId) || new Set();
      if (origins.has(memoryId)) {
        skipped.push({ memoryId, agentId, reason: "already_tombstoned" });
        continue;
      }

      // Karteninhalt aus dem Archiv laden (für Fingerprint/Scope). Nur den
      // expliziten archivePath verwenden; Basename-Fallback nur bei Eindeutigkeit.
      let archiveFile = null;
      if (archivePath !== undefined && archivePath !== null && typeof archivePath !== "string") {
        const detail = { memoryId, agentId, reason: "invalid archive path" };
        missingContent.push(detail);
        unacceptableEvents.push(detail);
        continue;
      }
      if (archivePath && existsSync(archivePath)) {
        archiveFile = archivePath;
      } else if (archivePath) {
        const name = basename(archivePath);
        if (archiveNameCollisions.has(name)) {
          const detail = { memoryId, agentId, reason: "archive_filename_collision" };
          conflicted.push(detail);
          unacceptableEvents.push(detail);
          continue;
        }
        archiveFile = archiveByName.get(name) || null;
      }
      let card = null;
      if (archiveFile && existsSync(archiveFile)) {
        try { card = JSON.parse(readFileSync(archiveFile, "utf8")); } catch { card = null; }
      }
      if (!card || typeof card.text !== "string" || !card.text) {
        const detail = { memoryId, agentId, reason: "archive content unavailable" };
        missingContent.push(detail);
        unacceptableEvents.push(detail);
        continue;
      }

      const canonicalOriginId = String(card.canonicalOriginId || card.id || memoryId);
      if (hasCommittedOrigin(existing, memoryId, canonicalOriginId) || origins.has(canonicalOriginId)) {
        skipped.push({ memoryId, agentId, reason: "already_tombstoned" });
        continue;
      }
      const tombstone = {
        schemaVersion: TOMBSTONE_SCHEMA_VERSION,
        tombstoneId: randomUUID(),
        memoryId,
        canonicalOriginId,
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

      if (!isValidTombstone(tombstone, agentId)) {
        const detail = { memoryId, agentId, reason: "invalid reconstructed tombstone" };
        conflicted.push(detail);
        unacceptableEvents.push(detail);
        continue;
      }

      origins.add(memoryId);
      origins.add(canonicalOriginId);
      plannedOrigins.set(agentId, origins);
      planned.push({ memoryId, agentId, tombstone });
    }
  }

  const validationFailed = sourceErrors.length > 0
    || registryErrors.length > 0
    || conflicted.length > 0
    || missingContent.length > 0
    || unacceptableEvents.length > 0
    || corruptLines > 0;
  const reconstructed = [];
  if (!args.apply || !validationFailed) {
    if (!args.apply) {
      reconstructed.push(...planned);
    } else {
      for (const item of planned) {
        try {
          appendTombstoneToRegistry(baseDbPath, item.agentId, item.tombstone);
          reconstructed.push(item);
        } catch (err) {
          applyErrors.push({
            memoryId: item.memoryId,
            agentId: item.agentId,
            error: err?.message || String(err),
          });
        }
      }
    }
  }

  const report = {
    mode: args.apply ? "apply" : "dry-run",
    registryDir: tombstoneRegistryDir(baseDbPath),
    reconstructed: reconstructed.length,
    planned: planned.length,
    skipped: skipped.length,
    conflicted: conflicted.length,
    missingContent: missingContent.length,
    corruptLines,
    failedEventsSkipped,
    unconfirmedEventsSkipped,
    registryErrors,
    sourceErrors,
    unacceptableEvents,
    applyErrors,
    reconstructedIds: reconstructed.map((r) => r.memoryId),
    plannedIds: planned.map((r) => r.memoryId),
    skippedDetails: skipped,
    conflictedDetails: conflicted,
    missingContentDetails: missingContent,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");

  // No registry write occurs until every source, existing registry, event,
  // archive, and planned tombstone has passed validation.
  return (validationFailed || applyErrors.length > 0) ? 1 : 0;
}

process.exitCode = main();

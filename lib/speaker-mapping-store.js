// PLUR1BUS bridge to OpenClaw's diarization SQLite DB for speaker mappings.
// This is a pragmatic read/write coupling: both processes run on the same host
// and share the same filesystem. A proper plugin API would be preferable later.
import { builtinModules, createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const MEMORY_DB_KIND = "memory";

let sharedDb = null;

function loadDatabaseSync() {
  if (!builtinModules.includes("node:sqlite")) {
    return null;
  }
  try {
    return require("node:sqlite").DatabaseSync;
  } catch (err) {
    process.emitWarning?.(`[plur1bus] node:sqlite unavailable for speaker mappings: ${err.message}`);
    return null;
  }
}

const DatabaseSync = loadDatabaseSync();

function resolveOpenClawConfigDir() {
  if (process.env.OPENCLAW_STATE_DIR) {
    return process.env.OPENCLAW_STATE_DIR;
  }
  if (process.env.OPENCLAW_CONFIG_PATH) {
    return path.dirname(process.env.OPENCLAW_CONFIG_PATH);
  }
  return path.join(homedir(), ".openclaw");
}

function resolveDbPath() {
  return path.join(resolveOpenClawConfigDir(), "cache", "audio-diarization.db");
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS speaker_mappings (
      agentId TEXT NOT NULL,
      speakerLabel TEXT NOT NULL,
      speakerDisplayName TEXT NOT NULL,
      attributionSource TEXT NOT NULL,
      confidence REAL,
      confirmed INTEGER NOT NULL,
      proposedAt INTEGER NOT NULL,
      confirmedAt INTEGER,
      contextHint TEXT,
      PRIMARY KEY (agentId, speakerLabel)
    );
    CREATE INDEX IF NOT EXISTS idx_speaker_mappings_agent
      ON speaker_mappings(agentId);
  `);
}

function shouldUseMemoryDb() {
  return process.env.PLUR1BUS_SPEAKER_MAPPING_FORCE_MEMORY === "1" || typeof DatabaseSync !== "function";
}

function createMemoryDb() {
  return {
    kind: MEMORY_DB_KIND,
    mappings: new Map(),
    mergeResults: new Map(),
  };
}

function isMemoryDb(db) {
  return db?.kind === MEMORY_DB_KIND;
}

function mappingKey(agentId, speakerLabel) {
  return `${agentId}\x00${speakerLabel}`;
}

export function getSpeakerMappingDb() {
  if (sharedDb) {
    return sharedDb;
  }
  if (shouldUseMemoryDb()) {
    sharedDb = createMemoryDb();
    return sharedDb;
  }
  const dbPath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  ensureSchema(db);
  sharedDb = db;
  return sharedDb;
}

export function resetSpeakerMappingDbForTests() {
  if (sharedDb) {
    try {
      sharedDb.close();
    } catch (err) {
      process.emitWarning?.(`[plur1bus] failed to close speaker mapping DB: ${err.message}`);
    }
    sharedDb = null;
  }
}

function rowToMapping(row) {
  return {
    agentId: String(row.agentId),
    speakerLabel: String(row.speakerLabel),
    speakerDisplayName: String(row.speakerDisplayName),
    attributionSource: String(row.attributionSource),
    confidence: row.confidence != null ? Number(row.confidence) : null,
    confirmed: Number(row.confirmed),
    proposedAt: Number(row.proposedAt),
    confirmedAt: row.confirmedAt != null ? Number(row.confirmedAt) : null,
    contextHint: row.contextHint != null ? String(row.contextHint) : null,
  };
}

export function getSpeakerMapping(agentId, speakerLabel) {
  const db = getSpeakerMappingDb();
  if (isMemoryDb(db)) {
    const row = db.mappings.get(mappingKey(agentId, speakerLabel));
    return row ? rowToMapping(row) : null;
  }
  const select = db.prepare("SELECT * FROM speaker_mappings WHERE agentId = ? AND speakerLabel = ?");
  const row = select.get(agentId, speakerLabel);
  return row ? rowToMapping(row) : null;
}

export function getSpeakerMappingsByAgent(agentId, { confirmed } = {}) {
  const db = getSpeakerMappingDb();
  if (isMemoryDb(db)) {
    return [...db.mappings.values()]
      .filter((row) => row.agentId === agentId)
      .filter((row) => confirmed === undefined || Number(row.confirmed) === (confirmed ? 1 : 0))
      .sort((a, b) => Number(b.proposedAt) - Number(a.proposedAt))
      .map(rowToMapping);
  }
  let query = "SELECT * FROM speaker_mappings WHERE agentId = ?";
  const params = [agentId];
  if (confirmed !== undefined) {
    query += " AND confirmed = ?";
    params.push(confirmed ? 1 : 0);
  }
  query += " ORDER BY proposedAt DESC";
  const select = db.prepare(query);
  return select.all(...params).map(rowToMapping);
}

export function setSpeakerMapping(mapping) {
  const db = getSpeakerMappingDb();
  if (isMemoryDb(db)) {
    db.mappings.set(mappingKey(mapping.agentId, mapping.speakerLabel), {
      agentId: mapping.agentId,
      speakerLabel: mapping.speakerLabel,
      speakerDisplayName: mapping.speakerDisplayName,
      attributionSource: mapping.attributionSource,
      confidence: mapping.confidence ?? null,
      confirmed: mapping.confirmed,
      proposedAt: mapping.proposedAt,
      confirmedAt: mapping.confirmedAt ?? null,
      contextHint: mapping.contextHint ?? null,
    });
    return;
  }
  const upsert = db.prepare(`
    INSERT INTO speaker_mappings (
      agentId, speakerLabel, speakerDisplayName, attributionSource, confidence,
      confirmed, proposedAt, confirmedAt, contextHint
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agentId, speakerLabel)
    DO UPDATE SET
      speakerDisplayName = excluded.speakerDisplayName,
      attributionSource = excluded.attributionSource,
      confidence = excluded.confidence,
      confirmed = excluded.confirmed,
      proposedAt = excluded.proposedAt,
      confirmedAt = excluded.confirmedAt,
      contextHint = excluded.contextHint
  `);
  upsert.run(
    mapping.agentId,
    mapping.speakerLabel,
    mapping.speakerDisplayName,
    mapping.attributionSource,
    mapping.confidence ?? null,
    mapping.confirmed,
    mapping.proposedAt,
    mapping.confirmedAt ?? null,
    mapping.contextHint ?? null,
  );
}

export function deleteSpeakerMapping(agentId, speakerLabel) {
  const db = getSpeakerMappingDb();
  if (isMemoryDb(db)) {
    db.mappings.delete(mappingKey(agentId, speakerLabel));
    return;
  }
  const del = db.prepare("DELETE FROM speaker_mappings WHERE agentId = ? AND speakerLabel = ?");
  del.run(agentId, speakerLabel);
}

export function setManualSpeakerMapping(agentId, speakerLabel, speakerDisplayName) {
  const now = Date.now();
  setSpeakerMapping({
    agentId,
    speakerLabel,
    speakerDisplayName,
    attributionSource: "manual",
    confidence: 1.0,
    confirmed: 1,
    proposedAt: now,
    confirmedAt: now,
    contextHint: null,
  });
}

export function recordSpeakerProposal(agentId, speakerLabel, speakerDisplayName, confidence, contextHint = null) {
  const existing = getSpeakerMapping(agentId, speakerLabel);
  if (existing?.confirmed) {
    return false;
  }
  setSpeakerMapping({
    agentId,
    speakerLabel,
    speakerDisplayName,
    attributionSource: "contextual_proposal",
    confidence,
    confirmed: 0,
    proposedAt: Date.now(),
    confirmedAt: null,
    contextHint,
  });
  return true;
}

export function confirmSpeakerProposal(agentId, speakerLabel) {
  const existing = getSpeakerMapping(agentId, speakerLabel);
  if (!existing || existing.confirmed) {
    return false;
  }
  setSpeakerMapping({ ...existing, confirmed: 1, confirmedAt: Date.now() });
  return true;
}

export function rejectSpeakerProposal(agentId, speakerLabel) {
  const existing = getSpeakerMapping(agentId, speakerLabel);
  if (!existing || existing.confirmed) {
    return false;
  }
  deleteSpeakerMapping(agentId, speakerLabel);
  return true;
}

export function getPendingProposals(agentId) {
  return getSpeakerMappingsByAgent(agentId, { confirmed: false });
}

export function getConfirmedMappings(agentId) {
  return getSpeakerMappingsByAgent(agentId, { confirmed: true });
}

export function getMergeResultByMediaOutputId(mediaOutputId) {
  const db = getSpeakerMappingDb();
  if (isMemoryDb(db)) {
    return db.mergeResults.get(mediaOutputId) ?? null;
  }
  const select = db.prepare(
    "SELECT resultJson FROM merge_results WHERE mediaOutputId = ? ORDER BY createdAt DESC LIMIT 1",
  );
  const row = select.get(mediaOutputId);
  if (!row || !row.resultJson) {
    return null;
  }
  try {
    return JSON.parse(row.resultJson);
  } catch {
    return null;
  }
}

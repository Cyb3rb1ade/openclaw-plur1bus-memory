#!/usr/bin/env node
/**
 * scripts/migrate-missing-columns.mjs
 *
 * Standalone-Migrationsskript für LanceDB-Schema-Updates.
 * Fügt fehlende Spalten zur memories-Tabelle hinzu, ohne Daten zu löschen.
 *
 * Usage:
 *   node scripts/migrate-missing-columns.mjs [dbPath]
 *
 * Exit codes:
 *   0 = Erfolg (alle fehlenden Spalten hinzugefügt oder keine nötig)
 *   1 = Fehler (Tabelle nicht gefunden, addColumns nicht unterstützt, etc.)
 */

import { homedir } from "node:os";
import { join } from "node:path";

async function getLanceDB() {
  const lancedb = await import("@lancedb/lancedb");
  return lancedb;
}

const DEFAULT_DB_PATH = join(homedir(), ".openclaw", "memory", "lancedb-namespaced");
const TABLE_NAME = "memories";

const ALL_COLUMNS = [
  { name: "summary", valueSql: "''" },
  { name: "origin", valueSql: "'dm'" },
  { name: "mergedFrom", valueSql: "'[]'" },
  { name: "expiresAt", valueSql: "0" },
  { name: "storedBy", valueSql: "''" },
  { name: "sourceTurnId", valueSql: "''" },
  { name: "sourceMessageRole", valueSql: "''" },
  { name: "sourceTimestamp", valueSql: "0" },
  { name: "sourceUrl", valueSql: "''" },
  { name: "evidenceQuote", valueSql: "''" },
  { name: "scope", valueSql: "'agent-private'" },
  { name: "type", valueSql: "'memory'" },
  { name: "confirmed", valueSql: "false" },
  { name: "emotionalValence", valueSql: "''" },
  { name: "emotionalIntensity", valueSql: "0.0" },
  { name: "emotionalDominant", valueSql: "'neutral'" },
  { name: "moodContextAtCapture", valueSql: "''" },
  { name: "replayCount", valueSql: "0" },
  { name: "lastReplayed", valueSql: "0" },
  { name: "retrievalCount", valueSql: "0" },
  { name: "lastRetrievedAt", valueSql: "0" },
  { name: "memoryStrength", valueSql: "1.0" },
  { name: "halfLifeDays", valueSql: "30" },
  { name: "lastStrengthenedAt", valueSql: "0" },
  { name: "lastDynamicsAt", valueSql: "0" },
  { name: "memoryClass", valueSql: "'standard'" },
  { name: "neverForget", valueSql: "0" },
  { name: "coreMemoryScore", valueSql: "0.0" },
  { name: "coreMemoryReason", valueSql: "''" },
  { name: "versionNumber", valueSql: "1" },
  { name: "previousVersion", valueSql: "''" },
  { name: "supersededBy", valueSql: "''" },
  { name: "updateSource", valueSql: "''" },
  { name: "updateEvidence", valueSql: "''" },
  { name: "reconsolidationConfidence", valueSql: "0.0" },
  { name: "status", valueSql: "'active'" },
  { name: "versionCreatedAt", valueSql: "0" },
  { name: "updatedAt", valueSql: "0" },
  { name: "memoryKind", valueSql: "'memory'" },
  { name: "reminderStatus", valueSql: "''" },
  { name: "remindAt", valueSql: "0" },
  { name: "remindedAt", valueSql: "0" },
  { name: "dispatchedAt", valueSql: "0" },
  { name: "acknowledgedAt", valueSql: "0" },
  { name: "cancelledAt", valueSql: "0" },
  { name: "reminderKey", valueSql: "''" },
  { name: "dispatchCount", valueSql: "0" },
  { name: "lastDispatchAttemptAt", valueSql: "0" },
  { name: "nextDispatchAttemptAt", valueSql: "0" },
];

async function main() {
  const dbPath = process.argv[2] || DEFAULT_DB_PATH;

  console.log(`[migrate] LanceDB-Pfad: ${dbPath}`);

  let db;
  let table;
  try {
    const lancedb = await getLanceDB();
    db = await lancedb.connect(dbPath);
    const tables = await db.tableNames();
    if (!tables.includes(TABLE_NAME)) {
      console.error(`[migrate] FEHLER: Tabelle '${TABLE_NAME}' nicht gefunden in ${dbPath}`);
      console.error(`[migrate] Verfügbare Tabellen: ${tables.join(", ") || "(keine)"}`);
      process.exit(1);
    }
    table = await db.openTable(TABLE_NAME);
  } catch (err) {
    console.error(`[migrate] FEHLER: Konnte DB nicht öffnen: ${err.message}`);
    process.exit(1);
  }

  let schema;
  try {
    schema = await table.schema();
  } catch (err) {
    console.error(`[migrate] FEHLER: Konnte Schema nicht lesen: ${err.message}`);
    process.exit(1);
  }

  const fieldNames = new Set(schema.fields.map((f) => f.name));
  const missing = ALL_COLUMNS.filter((col) => !fieldNames.has(col.name));

  if (missing.length === 0) {
    console.log("[migrate] OK: Alle Spalten sind bereits vorhanden.");
    process.exit(0);
  }

  console.log(`[migrate] ${missing.length} fehlende Spalten gefunden:`);
  for (const col of missing) {
    console.log(`  - ${col.name}`);
  }

  let added = 0;
  let failed = 0;

  for (const col of missing) {
    try {
      await table.addColumns([col]);
      console.log(`[migrate] + ${col.name}`);
      added++;
    } catch (err) {
      console.error(`[migrate] ! ${col.name} FEHLER: ${err.message}`);
      failed++;
    }
  }

  // Verify
  let verifySchema;
  try {
    verifySchema = await table.schema();
  } catch (err) {
    console.error(`[migrate] FEHLER: Konnte Schema nach Migration nicht erneut lesen: ${err.message}`);
    process.exit(1);
  }

  const verifyFieldNames = new Set(verifySchema.fields.map((f) => f.name));
  const stillMissing = ALL_COLUMNS.filter((col) => !verifyFieldNames.has(col.name));

  console.log("");
  console.log(`[migrate] Ergebnis: ${added} hinzugefügt, ${failed} fehlgeschlagen, ${stillMissing.length} immer noch fehlend.`);

  if (stillMissing.length > 0) {
    console.error(`[migrate] FEHLER: Diese Spalten sind immer noch nicht vorhanden:`);
    for (const col of stillMissing) {
      console.error(`  - ${col.name}`);
    }
    process.exit(1);
  }

  console.log("[migrate] OK: Alle Spalten erfolgreich migriert.");
  process.exit(0);
}

main().catch((err) => {
  console.error(`[migrate] UNERWARTETER FEHLER: ${err.message}`);
  process.exit(1);
});

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

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { resolveInside, safeAgentId } from "../lib/sql-safety.js";

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
  { name: "workspaceKey", valueSql: "''" },
];

function selectDefaultTargets(base) {
  if (!existsSync(base)) throw new Error(`LanceDB-Basispfad nicht gefunden: ${base}`);
  if (lstatSync(base).isSymbolicLink()) throw new Error(`Unsicherer LanceDB-Basispfad (Symlink): ${base}`);
  const resolvedBase = resolveInside(base);
  const targets = [];
  const rejected = [];

  for (const entry of readdirSync(resolvedBase, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      rejected.push({ label: entry.name, error: "unsicheres Symlink-Ziel außerhalb der per-Agent-Auswahl" });
      continue;
    }
    if (!entry.isDirectory()) continue;
    try {
      const agentId = safeAgentId(entry.name);
      targets.push({ label: agentId, dbPath: resolveInside(resolvedBase, agentId) });
    } catch (error) {
      rejected.push({ label: entry.name, error: error.message });
    }
  }

  return { targets, rejected };
}

function selectExplicitTarget(inputPath) {
  const absolutePath = resolve(inputPath);
  if (!existsSync(absolutePath)) throw new Error(`Expliziter LanceDB-Pfad nicht gefunden: ${absolutePath}`);
  const targetStat = lstatSync(absolutePath);
  if (targetStat.isSymbolicLink()) throw new Error(`Unsicherer expliziter LanceDB-Symlink: ${absolutePath}`);
  if (!targetStat.isDirectory()) throw new Error(`Expliziter LanceDB-Pfad ist kein Verzeichnis: ${absolutePath}`);
  const dbPath = resolveInside(dirname(absolutePath), basename(absolutePath));
  return { targets: [{ label: dbPath, dbPath }], rejected: [] };
}

async function migrateTarget(lancedb, { label, dbPath }) {
  console.log(`\n[migrate] Ziel ${label}: ${dbPath}`);
  let db;
  let ok = false;
  try {
    db = await lancedb.connect(dbPath);
    const tables = await db.tableNames();
    if (!tables.includes(TABLE_NAME)) {
      throw new Error(`Tabelle '${TABLE_NAME}' nicht gefunden (verfügbar: ${tables.join(", ") || "keine"})`);
    }
    const table = await db.openTable(TABLE_NAME);
    const beforeRows = await table.countRows();
    const schema = await table.schema();
    const fieldNames = new Set(schema.fields.map((field) => field.name));
    const missing = ALL_COLUMNS.filter((column) => !fieldNames.has(column.name));

    let added = 0;
    let failed = 0;
    for (const column of missing) {
      try {
        await table.addColumns([column]);
        console.log(`[migrate] ${label} + ${column.name}`);
        added++;
      } catch (error) {
        console.error(`[migrate] ${label} ! ${column.name} FEHLER: ${error.message}`);
        failed++;
      }
    }

    const verifySchema = await table.schema();
    const verifyFieldNames = new Set(verifySchema.fields.map((field) => field.name));
    const stillMissing = ALL_COLUMNS.filter((column) => !verifyFieldNames.has(column.name));
    const afterRows = await table.countRows();
    if (afterRows !== beforeRows) {
      throw new Error(`Zeilenprüfung fehlgeschlagen: vorher ${beforeRows}, nachher ${afterRows}`);
    }
    if (stillMissing.length > 0) {
      throw new Error(`Spalten fehlen weiterhin: ${stillMissing.map((column) => column.name).join(", ")}`);
    }

    console.log(`[migrate] ${label} VERIFIED: ${added} hinzugefügt, ${failed} Add-Versuche fehlgeschlagen, ${afterRows} Zeilen erhalten.`);
    ok = true;
  } catch (error) {
    console.error(`[migrate] ${label} FEHLER: ${error.message}`);
  } finally {
    if (db) {
      try {
        await db.close();
      } catch (error) {
        console.error(`[migrate] ${label} FEHLER beim Schließen der DB: ${error.message}`);
        ok = false;
      }
    }
  }
  return ok;
}

async function main() {
  const explicitPath = process.argv[2];
  let selection;
  try {
    selection = explicitPath ? selectExplicitTarget(explicitPath) : selectDefaultTargets(DEFAULT_DB_PATH);
  } catch (error) {
    console.error(`[migrate] FEHLER: ${error.message}`);
    process.exit(1);
  }

  const lancedb = await getLanceDB();
  let failed = selection.rejected.length;
  for (const rejection of selection.rejected) {
    console.error(`[migrate] ${rejection.label} FEHLER: ${rejection.error}`);
  }
  for (const target of selection.targets) {
    if (!await migrateTarget(lancedb, target)) failed++;
  }

  console.log(`\n[migrate] Ergebnis: ${selection.targets.length} Ziel(e) geprüft, ${failed} Fehler.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[migrate] UNERWARTETER FEHLER: ${err.message}`);
  process.exit(1);
});

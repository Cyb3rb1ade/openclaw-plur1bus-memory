#!/usr/bin/env node
/**
 * scripts/importance-phase1-reset.mjs — Phase 1 der Importance-Migration:
 * räumt das Agentenband (importance >= 0.95).
 *
 * Rund 320 Zeilen mit origin=memory-md-migration und eine Handvoll mit
 * origin=cron stehen auf 0.95, ohne je einzeln bewertet worden zu sein — sie
 * wurden aus einer alten MEMORY.md importiert. Eine spätere Aufgabe senkt
 * MANUAL_CORE_IMPORTANCE von 1.0 auf 0.95; ab dann bekommt jede Zeile bei
 * oder über 0.95 dauerhaften Core-Schutz und eine Halbwertszeit von hundert
 * Jahren. Stünden diese Altlasten dann noch auf 0.95, würde ein Stapel
 * Statusberichte unsterblich. Deshalb drückt Phase 1 sie zuerst auf 0.94 —
 * und lässt Zeilen mit origin=dm unangetastet, denn das sind die bewussten
 * Entscheidungen des Agenten selbst.
 *
 * Derselbe Lauf setzt außerdem jede aktive Zeile auf
 * importanceStatus="pending_backfill" — die Warteschlange für das
 * Backfill-Skript (spätere Aufgabe). Nicht "pending": das ist die
 * Warteschlange des stündlichen Cron-Jobs, und ihn 23.000 Zeilen einzeln
 * abarbeiten zu lassen würde eine LanceDB-Version pro Zeile erzeugen — genau
 * die Fragmentierung, die am 13.09.2026 zu mehrsekündigen Gateway-Blockaden
 * geführt hat.
 *
 * Dry-Run ist Standard. `--apply` muss ausdrücklich gesetzt werden.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { AUTOMATIC_IMPORTANCE_MAX } from "../lib/memory-fact-quality.js";
import { IMPORTANCE_STATUS } from "../lib/importance-status.js";
import { safeAgentId } from "../lib/sql-safety.js";

const LEGACY_ORIGINS = new Set(["memory-md-migration", "cron"]);

/**
 * Aktive Zeilen im Agentenband (importance >= 0.95), die nicht vom Agenten
 * selbst stammen. origin=dm bleibt außen vor — das sind bewusste
 * Entscheidungen, keine Altlast.
 */
export function selectLegacyBandRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!row) return false;
    const status = String(row.status ?? "active");
    if (status !== "active") return false;
    if (Number(row.importance) < 0.95) return false;
    return LEGACY_ORIGINS.has(String(row.origin ?? ""));
  });
}

/**
 * Patch für eine Altlast-Zeile: Importance auf die automatische Obergrenze,
 * vorheriger Wert im Rollback-Kanal (updateSource/updateEvidence), Status in
 * die Backfill-Warteschlange.
 */
export function buildResetPatch(row) {
  return {
    importance: AUTOMATIC_IMPORTANCE_MAX,
    updateSource: "importance-v2",
    updateEvidence: JSON.stringify({ previousImportance: Number(row.importance), phase: 1 }),
    importanceStatus: IMPORTANCE_STATUS.PENDING_BACKFILL,
  };
}

/**
 * LanceDB liefert die Vektorspalte aus `toArray()` als Arrow-`Vector`-Objekt
 * zurück, nicht als einfaches Array. Ein `{ ...row }`-Spread kopiert dann nur
 * die internen Arrow-Eigenschaften (isValid, get, data, ...) statt der
 * Zahlen — mergeInsert lehnt das beim Zurückschreiben mit "Found field not
 * in schema: vector.isValid" ab. Deshalb wird die Vektorspalte vor dem
 * erneuten Schreiben in ein echtes Array entpackt.
 */
export function toPlainRow(row) {
  const plain = { ...row };
  if (plain.vector && !Array.isArray(plain.vector) && typeof plain.vector[Symbol.iterator] === "function") {
    plain.vector = Array.from(plain.vector);
  }
  return plain;
}

/**
 * Aktive IDs, die irgendwo in der Tabelle mehrfach vorkommen — auch gegen
 * eine gelöschte oder archivierte Zeile mit derselben id. Zwei Fälle:
 *
 * 1. Zwei aktive Zeilen teilen sich eine id (main: 186, bernhardine: 95,
 *    identischer Text, vermutlich ein alter Doppel-Import). Der Quell-Batch
 *    enthält dann zwei Zeilen mit derselben id, und mergeInsert("id") bricht
 *    hart mit "Ambiguous merge insert" ab — nichts wird geschrieben.
 *
 * 2. Eine aktive und eine gelöschte Zeile teilen sich eine id. Der
 *    Quell-Batch enthält dann nur eine Zeile für diese id, aber das Ziel
 *    zwei — und das bricht NICHT ab. Live an einer fabrizierten Tabelle
 *    geprüft (2026-09-19): whenMatchedUpdateAll() ersetzt beide Zielzeilen
 *    durch die eine Quellzeile. Die gelöschte Zeile wird dabei lautlos durch
 *    eine zweite Kopie der aktiven ersetzt — ein Tombstone wird wieder aktiv,
 *    und die Tabelle hat danach selbst eine neue Aktiv-Aktiv-Kollision.
 *
 * Beide Fälle sind gleich gefährlich, deshalb zählt hier jedes Vorkommen der
 * id über die gesamte Tabelle, nicht nur unter den aktiven Zeilen.
 */
export function findDuplicateActiveIds(rows = []) {
  const all = Array.isArray(rows) ? rows : [];
  const counts = new Map();
  for (const row of all) {
    if (!row) continue;
    counts.set(row.id, (counts.get(row.id) || 0) + 1);
  }
  const active = all.filter((row) => row && String(row.status ?? "active") === "active");
  const unsafe = new Set();
  for (const row of active) {
    if ((counts.get(row.id) || 0) > 1) unsafe.add(row.id);
  }
  return [...unsafe];
}

function openclawHome() {
  return process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
}

/**
 * Ohne explizit übergebene Agent-IDs auf alle Stores anwenden (verbindliche
 * Auslieferungsreihenfolge: "--apply auf allen Stores"). Wie
 * backfill-manual-core-markers.mjs: nur Verzeichnisse mit memories-Table,
 * keine Symlinks, keine internen "_"-Verzeichnisse.
 */
function discoverAgents(baseDbPath) {
  if (!existsSync(baseDbPath)) return [];
  return readdirSync(baseDbPath, { withFileTypes: true })
    .filter((entry) => (
      entry.isDirectory()
      && !entry.isSymbolicLink()
      && !entry.name.startsWith("_")
      && (
        existsSync(join(baseDbPath, entry.name, "memories.lance"))
        || existsSync(join(baseDbPath, entry.name, "memories"))
      )
    ))
    .map((entry) => entry.name);
}

function parseArgs(argv) {
  const args = { apply: false, baseDbPath: null, agents: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--base-db-path" && argv[i + 1]) args.baseDbPath = argv[++i];
    else if (!argv[i].startsWith("--")) args.agents.push(argv[i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseDbPath = args.baseDbPath || join(openclawHome(), "memory", "lancedb-namespaced");
  const agentIds = args.agents.length > 0 ? args.agents : discoverAgents(baseDbPath);

  if (agentIds.length === 0) {
    console.log("Nutzung: node scripts/importance-phase1-reset.mjs [<agentId> ...] [--apply] [--base-db-path <pfad>]");
    console.log(`Keine Agent-IDs übergeben und keine Stores unter ${baseDbPath} gefunden.`);
    return 1;
  }

  const lancedb = await import("@lancedb/lancedb");
  let failed = 0;

  for (const rawAgentId of agentIds) {
    const agentId = safeAgentId(rawAgentId);
    let table;
    try {
      const db = await lancedb.connect(join(baseDbPath, agentId));
      table = await db.openTable("memories");
    } catch (err) {
      console.log(`${agentId}: kein memories-Table (${err?.message || err})`);
      failed += 1;
      continue;
    }

    const rows = await table.query().limit(100000).toArray();
    const active = rows.filter((r) => String(r.status ?? "active") === "active");
    const legacy = selectLegacyBandRows(rows);
    const duplicateIds = findDuplicateActiveIds(rows);

    console.log(`${agentId}: ${active.length} aktiv, ${legacy.length} Altlasten im Agentenband`);
    for (const row of legacy.slice(0, 10)) {
      console.log(`   ${Number(row.importance).toFixed(2)} ${row.origin} ${String(row.text || "").slice(0, 70)}`);
    }
    if (duplicateIds.length > 0) {
      console.log(
        `   ACHTUNG: ${duplicateIds.length} id(s) mehrfach unter aktiven Zeilen (z. B. ${duplicateIds.slice(0, 3).join(", ")}) `
        + `— mergeInsert("id") bricht bei mehrdeutigem Join ab, --apply schreibt hier nichts.`,
      );
    }

    if (!args.apply) {
      console.log("   Dry-Run — mit --apply ausführen");
      continue;
    }

    if (active.length === 0) {
      // execute([]) wirft nicht, legt aber eine leere Version an — bei rund
      // zehn Stores ohne aktive Zeilen wäre das nur unnötiger Leerlauf.
      console.log("   keine aktiven Zeilen — nichts zu tun");
      continue;
    }

    if (duplicateIds.length > 0) {
      // Fail-closed vor dem Schreibversuch statt erst nach dem Rust-Fehler
      // von mergeInsert: gleiches Ergebnis (kein Schreiben), klarere Meldung.
      console.log("   übersprungen — doppelte ids verhindern einen sicheren mergeInsert");
      failed += 1;
      continue;
    }

    // Ein mergeInsert je Agent: eine Version statt einer je Zeile.
    const legacySet = new Set(legacy);
    const patched = [
      ...legacy.map((row) => ({ ...toPlainRow(row), ...buildResetPatch(row) })),
      ...active.filter((row) => !legacySet.has(row))
        .map((row) => ({ ...toPlainRow(row), importanceStatus: IMPORTANCE_STATUS.PENDING_BACKFILL })),
    ];
    try {
      await table.mergeInsert("id").whenMatchedUpdateAll().execute(patched);
      console.log(`   ${legacy.length} zurückgesetzt, ${patched.length} auf pending_backfill`);
    } catch (err) {
      console.log(`   FEHLER beim Schreiben: ${err?.message || err}`);
      failed += 1;
    }
  }

  return failed > 0 ? 1 : 0;
}

// Nur ausführen, wenn direkt aufgerufen — der Test importiert die reine Auswahl.
if (process.argv[1] && process.argv[1].endsWith("importance-phase1-reset.mjs")) {
  process.exitCode = await main();
}

#!/usr/bin/env node
/**
 * scripts/dedupe-memory-ids.mjs — räumt Zeilenpaare auf, die der alte,
 * nicht-atomare Legacy-Pfad in `MemoryDB.update()` (index.js) hinterlassen
 * hat.
 *
 * Wurzelursache (bereits gefunden, dieses Skript repariert nur die Folgen):
 * bevor LanceDB 0.26.2 `table.update` mitbrachte, machte `update()` ein
 * `delete(id)` gefolgt von `add(updatedRow)`; schlug das `add` fehl, wurde
 * best-effort die alte Zeile wiederhergestellt. Das Problem: der Fehlschlag
 * war manchmal nur ein Client-Timeout, während das `add` serverseitig schon
 * angekommen war. Ergebnis: zwei Zeilen mit derselben id — die aktualisierte
 * und die wiederhergestellte alte. Der Pfad ist seit LanceDB 0.26.2 tot (der
 * moderne In-Place-Zweig über `table.update` wird immer genommen); die
 * letzte betroffene Zeile stammt aus Juli 2026. Dieses Skript räumt nur die
 * Altlast auf, es fasst den Code-Pfad nicht an.
 *
 * Beweislage (main, bernhardine, 2026-09-19): Duplikate kommen ausschließlich
 * paarweise vor, nie in Dreier- oder größeren Gruppen; die Zwillinge teilen
 * sich meist createdAt bis auf die Millisekunde. 74 main-Paare unterscheiden
 * sich nur im vector (ein Re-Embedding-Lauf im März), 64 nur in
 * memoryStrength (Dynamics-Pflege), 45 sind in jedem verglichenen Feld
 * identisch. developer und heisenberg sind sauber.
 *
 * Auswahlregel für die überlebende Zeile eines Paars: das erste Feld, das
 * sich unterscheidet, entscheidet (größerer Wert gewinnt), in der
 * Reihenfolge lastDynamicsAt, lastStrengthenedAt, updatedAt, createdAt,
 * retrievalCount. Sind alle fünf gleich, sind die Zeilen für unsere Zwecke
 * austauschbar — dann gewinnt deterministisch die erste in
 * Tabellenreihenfolge, aber als "arbitrary" gezählt, damit sichtbar bleibt,
 * wie oft die Wahl beliebig war statt begründet.
 *
 * Die Reparatur selbst hat dieselbe nicht-atomare Form wie der Defekt:
 * `delete("id = …")` löscht in LanceDB per Prädikat, trifft also BEIDE
 * Zwillinge; die Zeile muss danach mit `add()` zurückgeschrieben werden. Sie
 * läuft deshalb defensiv: pro Gruppe frisch aus der Tabelle lesen (nicht die
 * Dry-Run-Momentaufnahme von vor Minuten), schreiben, sofort per
 * Read-after-Write verifizieren (Zeilenzahl, text, vector) — kein Vertrauen
 * auf die bloße Abwesenheit einer Exception. Bei jeder Abweichung sofort
 * abbrechen, laut melden, keinen zweiten Versuch unternehmen.
 *
 * Dry-Run ist Standard. `--apply` muss ausdrücklich gesetzt werden.
 *
 * Vor der ersten Reparatur (nur bei `--apply`) schreibt der Lauf einen
 * JSONL-Export jeder betroffenen Zeile (beide Zwillinge, alle Spalten
 * inklusive vollem vector) — ein zusätzliches Sicherheitsnetz neben dem
 * Verzeichnis-Backup der Kontrolle. Ein Verzeichnis-Backup einer laufenden
 * LanceDB kann einen halb geschriebenen Zustand einfangen und stellt nur
 * alles-oder-nichts wieder her; dieser Export liest über die Tabellen-API
 * einen konsistenten Snapshot und lässt jede einzelne betroffene Zeile für
 * sich rekonstruieren.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { safeAgentId, sqlString } from "../lib/sql-safety.js";
import { toPlainRow } from "./importance-phase1-reset.mjs";

/**
 * Reihenfolge der Entscheidungsfelder für ein Duplikat-Paar. Das erste Feld,
 * das sich zwischen den beiden Zeilen unterscheidet, entscheidet — größerer
 * Wert gewinnt.
 */
export const SELECTION_FIELD_ORDER = Object.freeze([
  "lastDynamicsAt",
  "lastStrengthenedAt",
  "updatedAt",
  "createdAt",
  "retrievalCount",
]);

/**
 * Reine Auswahlregel für genau ein Duplikat-Paar (gleiche id, zwei aktive
 * Zeilen). `rowA` gilt per Konvention des Aufrufers als "zuerst in
 * Tabellenreihenfolge".
 *
 * Sind alle Entscheidungsfelder gleich, sind die Zeilen für unsere Zwecke
 * austauschbar: `rowA` gewinnt deterministisch (derselbe Lauf liefert also
 * immer dasselbe Ergebnis), aber `arbitrary: true` macht das sichtbar, damit
 * der Aufrufer zählen kann, wie oft die Wahl beliebig war statt begründet.
 */
export function selectSurvivingRow(rowA, rowB) {
  for (const field of SELECTION_FIELD_ORDER) {
    const a = Number(rowA?.[field] ?? 0);
    const b = Number(rowB?.[field] ?? 0);
    if (a !== b) {
      const aWins = a > b;
      return {
        survivor: aWins ? rowA : rowB,
        discarded: aWins ? rowB : rowA,
        decidedBy: field,
        arbitrary: false,
      };
    }
  }
  return { survivor: rowA, discarded: rowB, decidedBy: null, arbitrary: true };
}

/**
 * Gruppiert aktive Zeilen nach id, in Tabellenreihenfolge. Liefert nur
 * Gruppen mit mehr als einer aktiven Zeile — die eigentlichen Duplikate.
 */
export function findDuplicateGroups(rows) {
  const active = (Array.isArray(rows) ? rows : []).filter(
    (row) => row && String(row.status ?? "active") === "active",
  );
  const byId = new Map();
  for (const row of active) {
    if (!byId.has(row.id)) byId.set(row.id, []);
    byId.get(row.id).push(row);
  }
  return [...byId.values()].filter((group) => group.length > 1);
}

/**
 * ids, deren Duplikat-Gruppe nicht genau zwei aktive Zeilen hat. Die
 * Beweislage (main, bernhardine) zeigt ausschließlich Paare — eine
 * Dreiergruppe bräche diese Annahme, und "delete by id, eine Zeile
 * zurückschreiben" ist für diesen Fall nie geprüft. Lieber abbrechen als
 * einen ungetesteten Tie-Breaker erfinden.
 */
export function findNonPairGroupIds(groups) {
  return groups.filter((group) => group.length !== 2).map((group) => group[0].id);
}

/**
 * ids, bei denen zusätzlich zu den aktiven Duplikaten noch eine nicht-aktive
 * Zeile (z. B. ein Tombstone) dieselbe id trägt. `delete("id = …")` löscht
 * jede Zeile mit dieser id, unabhängig vom Status — eine solche Zeile ginge
 * dabei unbemerkt verloren. Live geprüft (2026-09-19): kommt bei main und
 * bernhardine nicht vor, aber die Reparatur darf sich nicht stillschweigend
 * darauf verlassen, dass das so bleibt.
 */
export function findStrayNonActiveIds(rows, groups) {
  const dupIds = new Set(groups.map((group) => group[0].id));
  const hits = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    if (dupIds.has(row.id) && String(row.status ?? "active") !== "active") hits.add(row.id);
  }
  return [...hits];
}

/**
 * Baut den vollständigen Reparaturplan aus einem Zeilen-Snapshot: eine
 * Entscheidung je sauberem Duplikat-Paar, plus die ids, die die Annahmen
 * verletzen und deshalb NICHT angefasst werden.
 */
export function buildDedupePlan(rows) {
  const groups = findDuplicateGroups(rows);
  const nonPairIds = findNonPairGroupIds(groups);
  const strayIds = findStrayNonActiveIds(rows, groups);
  const anomalyIds = [...new Set([...nonPairIds, ...strayIds])];
  const anomalySet = new Set(anomalyIds);
  const decisions = groups
    .filter((group) => group.length === 2 && !anomalySet.has(group[0].id))
    .map((group) => {
      const { survivor, discarded, decidedBy, arbitrary } = selectSurvivingRow(group[0], group[1]);
      return { id: group[0].id, survivor, discarded, decidedBy, arbitrary };
    });
  return { groupCount: groups.length, decisions, anomalyIds };
}

/**
 * Macht eine Zeile JSON-sicher, ohne ihre Bedeutung zu verändern.
 * LanceDB liefert Int64-Spalten aus `toArray()` als JS BigInt zurück —
 * `JSON.stringify` wirft darauf (`Do not know how to serialize a BigInt`,
 * live am eigenen Inspektionsskript gesehen). Und die Vektorspalte kommt als
 * iterierbares Arrow-Objekt, nicht als Array (dieselbe Eigenart, die
 * `toPlainRow` in importance-phase1-reset.mjs vor dem Zurückschreiben
 * entpackt). Beides wird hier in eine rundtrip-feste Form überführt: BigInt
 * → Dezimal-String (welche Spalten im heutigen Schema betroffen sind, steht
 * im Bericht — die Erkennung selbst ist schema-unabhängig, sie prüft den
 * Laufzeittyp, nicht den Spaltennamen), jedes andere iterierbare
 * Nicht-Array (der vector) → echtes Array. Ein Float32-Wert, der als Array
 * von JS-Zahlen (Float64) durch `JSON.stringify`/`JSON.parse` läuft, kommt
 * bitgenau zurück — JS' Number-zu-String-Konvertierung ist rundtrip-treu,
 * und die Aufweitung Float32→Float64 beim Lesen ist verlustfrei.
 */
export function toJsonSafeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row ?? {})) {
    if (typeof value === "bigint") {
      out[key] = value.toString();
    } else if (value && typeof value !== "string" && !Array.isArray(value) && typeof value[Symbol.iterator] === "function") {
      out[key] = Array.from(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * JSONL-Zeilen für den Export: zwei Zeilen je Gruppe (Überlebende und
 * Verworfene), je eine valide JSON-Zeile mit Metadaten (id, Rolle,
 * Entscheidungsgrund) plus der vollständigen Original-Zeile.
 */
export function buildExportLines(decisions) {
  const lines = [];
  for (const d of Array.isArray(decisions) ? decisions : []) {
    for (const [role, row] of [["survivor", d.survivor], ["discarded", d.discarded]]) {
      lines.push(JSON.stringify({
        meta: { id: d.id, role, decidedBy: d.decidedBy, arbitrary: d.arbitrary },
        row: toJsonSafeRow(row),
      }));
    }
  }
  return lines;
}

/** ISO-Zeitstempel ohne Doppelpunkte/Punkte — dateisystemsicher auf allen Plattformen. */
function safeTimestampForFilename(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Pfad der Export-Datei für einen Agenten. `now` ist injizierbar (Tests,
 * deterministische Dry-Run-Vorschau).
 */
export function buildExportPath({ exportDir, agentId, now = new Date() }) {
  return join(exportDir, `${agentId}-${safeTimestampForFilename(now)}.jsonl`);
}

/**
 * Schreibt den Export — einmalig, bevor irgendetwas repariert wird.
 * Verweigert, eine bestehende Export-Datei zu überschreiben: ein zweiter
 * Lauf darf nie stillschweigend das Sicherheitsnetz eines vorherigen Laufs
 * ersetzen. Schreibt nichts und wirft, wenn die Datei schon existiert —
 * der Aufrufer muss das als Abbruchgrund für den GESAMTEN Lauf behandeln,
 * nicht nur für diesen Agenten.
 */
export function writeExport({ exportDir, agentId, decisions, now = new Date() }) {
  const path = buildExportPath({ exportDir, agentId, now });
  if (existsSync(path)) {
    throw new Error(
      `Export-Datei existiert bereits: ${path} — vorheriger Lauf? Nichts geschrieben, nichts repariert.`,
    );
  }
  mkdirSync(exportDir, { recursive: true });
  const lines = buildExportLines(decisions);
  writeFileSync(path, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
  return path;
}

/**
 * Liest die Gruppe direkt nach dem Schreiben aus der Tabelle zurück — kein
 * Vertrauen auf die bloße Abwesenheit einer Exception. Erwartet genau eine
 * Zeile mit dieser id, deren text und vector zur beabsichtigten
 * Überlebenden passen.
 */
export async function verifyRepair(table, id, survivor) {
  const rows = await table.query().where(`id = ${sqlString(id)}`).toArray();
  if (rows.length !== 1) {
    return { ok: false, reason: `erwartet genau 1 Zeile nach dem Schreiben, gefunden ${rows.length}` };
  }
  const row = rows[0];
  if (String(row.text ?? "") !== String(survivor.text ?? "")) {
    return { ok: false, reason: "text weicht von der beabsichtigten Überlebenden ab" };
  }
  const gotVector = row.vector ? Array.from(row.vector) : null;
  const wantVector = survivor.vector ? Array.from(survivor.vector) : null;
  if (gotVector || wantVector) {
    if (!gotVector || !wantVector || gotVector.length !== wantVector.length) {
      return { ok: false, reason: "vector fehlt oder hat die falsche Länge" };
    }
    for (let i = 0; i < gotVector.length; i += 1) {
      if (Math.abs(gotVector[i] - wantVector[i]) > 1e-6) {
        return { ok: false, reason: `vector weicht an Index ${i} ab` };
      }
    }
  }
  return { ok: true };
}

/**
 * Repariert genau eine Duplikat-Gruppe (eine id). Liest die Gruppe frisch
 * aus der Tabelle — nicht die Dry-Run-Momentaufnahme, die Kontrolle kann
 * Minuten zwischen Dry-Run und `--apply` verstreichen lassen — trifft die
 * Auswahl auf diesem frischen Stand, löscht per id (trifft beide
 * Zwillinge) und schreibt die Überlebende zurück. Verifiziert sofort danach
 * per Read-after-Write. Wirft bei jeder Abweichung sofort — kein zweiter
 * Versuch, kein Weiterlaufen.
 */
export async function repairGroup(table, id) {
  const fresh = await table.query().where(`id = ${sqlString(id)}`).toArray();
  const freshActive = fresh.filter((row) => String(row.status ?? "active") === "active");
  if (freshActive.length !== 2) {
    throw new Error(
      `${id}: frischer Lesezugriff zeigt ${freshActive.length} aktive Zeile(n) statt 2 — abgebrochen, nichts geschrieben.`,
    );
  }
  if (fresh.length !== freshActive.length) {
    throw new Error(
      `${id}: zusätzliche nicht-aktive Zeile(n) mit derselben id im frischen Lesezugriff — abgebrochen, nichts geschrieben.`,
    );
  }

  const { survivor, decidedBy, arbitrary } = selectSurvivingRow(freshActive[0], freshActive[1]);

  await table.delete(`id = ${sqlString(id)}`);
  await table.add([toPlainRow(survivor)]);

  const verified = await verifyRepair(table, id, survivor);
  if (!verified.ok) {
    throw new Error(
      `${id}: Verifikation nach dem Schreiben fehlgeschlagen — ${verified.reason}. Lauf abgebrochen, kein zweiter Versuch.`,
    );
  }
  return { id, decidedBy, arbitrary };
}

function describeRow(row) {
  const fields = SELECTION_FIELD_ORDER.map((f) => `${f}=${row[f] ?? 0}`).join(" ");
  const text = String(row.text || "").replace(/\s+/g, " ").slice(0, 60);
  return `${fields} text="${text}"`;
}

function openclawHome() {
  return process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
}

/** Ohne explizit übergebene Agent-IDs alle Stores erfassen, wie backfill-manual-core-markers.mjs. */
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
  const args = { apply: false, baseDbPath: null, exportDir: null, agents: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--base-db-path" && argv[i + 1]) args.baseDbPath = argv[++i];
    else if (argv[i] === "--export-dir" && argv[i + 1]) args.exportDir = argv[++i];
    else if (!argv[i].startsWith("--")) args.agents.push(argv[i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseDbPath = args.baseDbPath || join(openclawHome(), "memory", "lancedb-namespaced");
  const exportDir = args.exportDir || join(process.cwd(), "dedupe-exports");
  const agentIds = args.agents.length > 0 ? args.agents : discoverAgents(baseDbPath);

  if (agentIds.length === 0) {
    console.log(
      "Nutzung: node scripts/dedupe-memory-ids.mjs [<agentId> ...] [--apply] [--base-db-path <pfad>] "
      + "[--export-dir <pfad>]",
    );
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

    const rows = await table.query().limit(200000).toArray();
    const plan = buildDedupePlan(rows);

    if (plan.groupCount === 0) {
      // Kein stiller No-Op: eine leere Trefferliste ist entweder ein Store,
      // der schon sauber ist (developer, heisenberg), oder eine falsch
      // getippte Agent-ID, die zufällig einen anderen, sauberen Store trifft.
      // Beides soll sichtbar sein, nicht stillschweigend übersprungen werden.
      console.log(`${agentId}: keine Duplikate gefunden — Lauf verweigert (Tippfehler in der Agent-ID prüfen?)`);
      failed += 1;
      continue;
    }

    const decidedByCounts = {};
    let arbitraryCount = 0;
    for (const d of plan.decisions) {
      if (d.arbitrary) arbitraryCount += 1;
      else decidedByCounts[d.decidedBy] = (decidedByCounts[d.decidedBy] || 0) + 1;
    }

    console.log(
      `${agentId}: ${plan.groupCount} Duplikat-Gruppe(n), ${plan.decisions.length} sauber (Paar), `
      + `${plan.anomalyIds.length} Anomalie(n)`,
    );
    console.log(`   entschieden durch: ${JSON.stringify(decidedByCounts)} — beliebig (voll gleich): ${arbitraryCount}`);
    if (plan.anomalyIds.length > 0) {
      console.log(
        `   ACHTUNG: ${plan.anomalyIds.length} Gruppe(n) verletzen die erwartete Form (kein sauberes `
        + `Aktiv-Aktiv-Paar) — z. B. ${plan.anomalyIds.slice(0, 3).join(", ")}. Diese werden NICHT angefasst.`,
      );
    }
    console.log("   Beispiele:");
    for (const d of plan.decisions.slice(0, 5)) {
      console.log(`   - id=${d.id} entschieden durch=${d.decidedBy ?? "(beliebig — erste in Tabellenreihenfolge)"}`);
      console.log(`       behalten:  ${describeRow(d.survivor)}`);
      console.log(`       verworfen: ${describeRow(d.discarded)}`);
    }

    if (!args.apply) {
      const previewPath = buildExportPath({ exportDir, agentId });
      console.log(
        `   Export würde geschrieben nach: ${previewPath} (${plan.decisions.length * 2} Zeilen — `
        + "Zeitstempel wird beim echten Lauf neu gesetzt, kein Schreibzugriff im Dry-Run)",
      );
      console.log("   Dry-Run — mit --apply ausführen");
      continue;
    }

    // Export ZUERST, vor jeder Reparatur — beide Zwillinge jeder betroffenen
    // Gruppe, alle Spalten, als konsistenter Snapshot über die Tabellen-API
    // (kein Verzeichnis-Backup, das einen halb geschriebenen Zustand
    // einfangen könnte). Schlägt der Export fehl (z. B. weil die Datei schon
    // existiert), wird für diesen Agenten und den Rest des Laufs nichts
    // repariert.
    let exportPath;
    try {
      exportPath = writeExport({ exportDir, agentId, decisions: plan.decisions });
    } catch (err) {
      console.log(`   FEHLER beim Export: ${err?.message || err}`);
      console.log(`   ABBRUCH: kein Export geschrieben, keine Gruppe für ${agentId} angefasst.`);
      return 1;
    }
    console.log(`   Export geschrieben: ${exportPath} (${plan.decisions.length * 2} Zeilen)`);

    let repaired = 0;
    for (const d of plan.decisions) {
      try {
        await repairGroup(table, d.id);
        repaired += 1;
      } catch (err) {
        console.log(`   FEHLER: ${err?.message || err}`);
        console.log(
          `   ABBRUCH: ${repaired} von ${plan.decisions.length} Gruppen für ${agentId} repariert, dann gestoppt. `
          + "Restliche Gruppen dieses Stores und alle weiteren Agenten wurden NICHT angefasst.",
        );
        return 1;
      }
    }
    console.log(`   ${agentId}: ${repaired} Gruppe(n) repariert.`);
  }

  return failed > 0 ? 1 : 0;
}

// Nur ausführen, wenn direkt aufgerufen — die Tests importieren die reinen Funktionen.
if (process.argv[1] && process.argv[1].endsWith("dedupe-memory-ids.mjs")) {
  process.exitCode = await main();
}

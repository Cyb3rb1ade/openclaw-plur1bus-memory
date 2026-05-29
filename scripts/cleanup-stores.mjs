#!/usr/bin/env node
/**
 * scripts/cleanup-stores.mjs
 *
 * Kontrollierte Bereinigung der PLUR1BUS-Memory-Stores nach der Recall/Capture-
 * Rückkopplung (Performance-Analysis 2026-05-29).
 *
 * Zwei Teile:
 *  (a) _neo JSONL: injizierten Kontext entfernen, dedupen, auf Cap kürzen
 *      (nutzt pruneNeoJsonlFile aus lib/neo-arch.js).
 *  (b) LanceDB pro Agent: Zeilen mit injiziertem Kontext löschen, dann
 *      optimize() (Fragment-Compaction + Versions-Cleanup) → reklamiert den
 *      durch unkompaktierte Versionen aufgeblähten Speicher (_versions).
 *
 * SICHERHEIT:
 *  - Default ist DRY-RUN. Erst mit --apply wird geschrieben/gelöscht.
 *  - VOR --apply: Gateway stoppen ODER Memory-Hooks deaktivieren und ein
 *    frisches Backup ziehen (siehe Plan Phase 0/2). Das Skript erzwingt das
 *    nicht technisch — der Operator ist verantwortlich.
 *
 * Aufruf:
 *   node scripts/cleanup-stores.mjs                 # dry-run, alles
 *   node scripts/cleanup-stores.mjs --apply
 *   node scripts/cleanup-stores.mjs --neo-only --apply
 *   node scripts/cleanup-stores.mjs --lancedb-only --apply
 *   node scripts/cleanup-stores.mjs --agents main,bernhardine --apply
 *   node scripts/cleanup-stores.mjs --max-records 5000 --apply
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { pruneNeoJsonlFile, NEO_JSONL_FILES } from "../lib/neo-arch.js";

function argValue(name, fallback = "") {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasArg = (name) => process.argv.includes(name);

const APPLY = hasArg("--apply");
const NEO_ONLY = hasArg("--neo-only");
const LANCE_ONLY = hasArg("--lancedb-only");
const MAX_RECORDS = Number(argValue("--max-records", "5000")) || 5000;
const BASE = argValue("--base", join(homedir(), ".openclaw", "memory", "lancedb-namespaced"));
const NEO_ROOT = join(BASE, "_neo");
const AGENTS = argValue("--agents", "main,bernhardine,heisenberg").split(",").map(s => s.trim()).filter(Boolean);

// SQL-LIKE-Prädikat für injizierten Kontext im LanceDB-`text`-Feld.
const INJECTED_LIKE = [
  "<plur1bus-recall", "</plur1bus-recall>", "relevant-memories", "RECALL SAFETY RULES",
  "knowledge-update-reminder", "adaptive-learning>", "TTS-STATUS", "[cron:",
  "Reference UTC:", "classify-recent", "critical-memory-classifier",
].map(s => `text LIKE '%${s.replace(/'/g, "''")}%'`).join(" OR ");

function du(path) {
  try { return execSync(`du -sh ${JSON.stringify(path)}`, { encoding: "utf8" }).split("\t")[0].trim(); }
  catch { return "?"; }
}

function banner() {
  console.log("=".repeat(70));
  console.log(`PLUR1BUS store cleanup — mode: ${APPLY ? "APPLY (writes!)" : "DRY-RUN"}`);
  console.log(`base: ${BASE}`);
  console.log(`agents: ${AGENTS.join(", ")}  maxRecords/file: ${MAX_RECORDS}`);
  if (!APPLY) console.log("→ DRY-RUN: nichts wird verändert. Mit --apply ausführen.");
  console.log("=".repeat(70));
}

function cleanupNeo() {
  console.log("\n### (a) _neo JSONL bereinigen");
  if (!existsSync(join(NEO_ROOT, "workspaces"))) {
    console.log(`  keine workspaces unter ${NEO_ROOT}`);
    return;
  }
  const workspaces = readdirSync(join(NEO_ROOT, "workspaces"), { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name);
  const totals = { before: 0, after: 0, removedInjected: 0, removedDup: 0, removedCap: 0 };
  for (const ws of workspaces) {
    const wsDir = join(NEO_ROOT, "workspaces", ws);
    for (const file of NEO_JSONL_FILES) {
      const p = join(wsDir, file);
      if (!existsSync(p)) continue;
      const dedup = file !== "embedding-queue.jsonl";
      const s = pruneNeoJsonlFile(p, { maxRecords: MAX_RECORDS, dedup, dryRun: !APPLY });
      if (s.before === 0) continue;
      totals.before += s.before; totals.after += s.after;
      totals.removedInjected += s.removedInjected; totals.removedDup += s.removedDup; totals.removedCap += s.removedCap;
      if (s.removedInjected || s.removedDup || s.removedCap) {
        console.log(`  ${ws}/${file}: ${s.before} → ${s.after}  (injected -${s.removedInjected}, dup -${s.removedDup}, cap -${s.removedCap})`);
      }
    }
  }
  console.log(`  TOTAL: ${totals.before} → ${totals.after} records  (injected -${totals.removedInjected}, dup -${totals.removedDup}, cap -${totals.removedCap})`);
}

async function cleanupLanceDb() {
  console.log("\n### (b) LanceDB bereinigen + compact");
  const lancedb = await import("@lancedb/lancedb");
  for (const agent of AGENTS) {
    const dir = join(BASE, agent);
    if (!existsSync(dir)) { console.log(`  ${agent}: kein Verzeichnis, skip`); continue; }
    const sizeBefore = du(dir);
    let db, table;
    try {
      db = await lancedb.connect(dir);
      const names = await db.tableNames();
      if (!names.includes("memories")) { console.log(`  ${agent}: keine memories-Tabelle, skip`); continue; }
      table = await db.openTable("memories");
    } catch (e) { console.log(`  ${agent}: open fehlgeschlagen: ${e.message}`); continue; }

    const total = await table.countRows();
    let injected = 0;
    try { injected = await table.countRows(INJECTED_LIKE); } catch (e) { console.log(`  ${agent}: count(injected) warn: ${e.message}`); }
    console.log(`  ${agent}: rows total=${total}, injected=${injected}, size=${sizeBefore}`);

    if (!APPLY) {
      console.log(`    (dry-run) würde ${injected} injizierte Zeilen löschen + optimize() ausführen`);
      continue;
    }
    if (injected > 0) {
      await table.delete(INJECTED_LIKE);
      console.log(`    gelöscht: ${injected} injizierte Zeilen`);
    }
    // Compaction + Versions-Cleanup → reklamiert _versions-Bloat.
    const stats = await table.optimize({ cleanupOlderThan: new Date(), deleteUnverified: true });
    const after = await table.countRows();
    const sizeAfter = du(dir);
    console.log(`    optimize done. rows ${total} → ${after}. size ${sizeBefore} → ${sizeAfter}`);
    try { console.log(`    optimize stats: ${JSON.stringify(stats)}`); } catch {}
  }
}

async function main() {
  banner();
  console.log(`\nGesamtgröße vorher: ${du(BASE)}`);
  if (!LANCE_ONLY) cleanupNeo();
  if (!NEO_ONLY) await cleanupLanceDb();
  console.log(`\nGesamtgröße nachher: ${du(BASE)}`);
  console.log(`\nFertig (${APPLY ? "APPLY" : "DRY-RUN"}).`);
}

main().catch(e => { console.error("FEHLER:", e); process.exit(1); });

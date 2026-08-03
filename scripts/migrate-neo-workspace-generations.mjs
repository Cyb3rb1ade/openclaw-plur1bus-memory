#!/usr/bin/env node
/**
 * migrate-neo-workspace-generations.mjs
 *
 * Führt historische NEO-Workspace-Generationen in den kanonischen Workspace
 * zusammen.
 *
 * Hintergrund: Unter `_neo/workspaces/` sind drei Namensschemata entstanden.
 * Jede Umstellung machte die vorherige Generation für den Agenten unsichtbar:
 *
 *   Gen1  <agentId>                    z.B. "bernhardine"
 *   Gen2  sanitizePathPart(key)        z.B. "workspace-bernhardine"
 *   Gen3  <prefix>--<hash>  (aktiv)    z.B. "workspace-bernhardine--7722…"
 *
 * `createNeoStore.readMerged` holt inzwischen Gen2 beim Lesen mit dazu.
 * Gen1 bleibt unerreichbar — dafür ist dieses Skript da.
 *
 * SICHERHEIT: Dry-run ist Default. Geschrieben wird nur mit --apply, und
 * dann erst nach einem Backup. Das sind unwiederbringliche Produktionsdaten.
 *
 *   node scripts/migrate-neo-workspace-generations.mjs            # dry-run
 *   node scripts/migrate-neo-workspace-generations.mjs --apply
 *   node scripts/migrate-neo-workspace-generations.mjs --root <pfad>
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { createNeoStore } from "../lib/neo-arch.js";

const DEFAULT_ROOT = join(homedir(), ".openclaw", "memory", "lancedb-namespaced", "_neo");

// Kanonische Verzeichnisse tragen den Suffix "--" + 20 Hex-Zeichen.
const CANONICAL_DIR_RE = /^(.+)--([0-9a-f]{20})$/;

/**
 * Welche Stores migriert werden — und wie.
 *
 * `append` benennt die Methode auf dem Neo-Store. Für die indizierten Stores
 * (reactions, behavior) pflegt appendJsonlDedupe `record-index.json` mit und
 * dedupliziert selbst; dort ist die Migration von Haus aus idempotent.
 * Die übrigen Stores sind NICHT indiziert (plain appendJsonl) — dort
 * deduplizieren wir hier über die id.
 *
 * Bewusst NICHT dabei: turn-journal, memory-candidates, embedding-queue,
 * retrieval-ledger, record-index. Die ersten drei sind dreistellig MB groß
 * und speisen laufende Verarbeitung; retrieval-ledger treibt einen
 * Watermark-Job — ein Merge-Fehler korrumpiert dort Zustand statt nur Daten
 * zu verbergen.
 *
 * Ebenfalls bewusst NICHT dabei: reaction-ledger und behavior-cards. Der
 * Grund ist nicht Vorsicht, sondern dass die Migration dort SCHADEN würde:
 * appendJsonl cappt eine Datei über NEO_CAP_CHECK_BYTES auf die LETZTEN
 * NEO_MAX_RECORDS (5000) Zeilen. Migrierte Records sind chronologisch älter,
 * landen aber am Dateiende — der Cap würde also die alten behalten und die
 * aktuellen verdrängen. Beide Dateien stehen bei bernhardine bereits exakt
 * am 5000er-Cap, ein Merge von ~10.000 bzw. ~4.700 Records wäre reine
 * Verdrängung. Episoden und Dreams sind dagegen klein (KB-Bereich, weit
 * unter der Cap-Schwelle) und damit gefahrlos.
 */
const MIGRATED_STORES = [
  { name: "episodes", file: "episodes.jsonl", append: "appendEpisodes", indexed: false },
  { name: "dreams", file: "dream-diary.jsonl", append: "appendDreams", indexed: false },
  { name: "graph", file: "memory-graph.jsonl", append: "appendGraphEdges", indexed: false },
];

function parseArgs(argv) {
  const args = { apply: false, root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--root") args.root = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
  }
  return args;
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const records = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch (_) { /* defekte Zeile überspringen */ }
  }
  return records;
}

/**
 * agentId aus hook-state.json — die verlässlichste Identitätsquelle eines
 * Workspaces. Sie steht auch dann drin, wenn Episoden und Dreams leer sind.
 */
function workspaceAgentId(dir) {
  try {
    const state = JSON.parse(readFileSync(join(dir, "hook-state.json"), "utf8"));
    for (const hook of Object.values(state || {})) {
      const id = typeof hook?.agentId === "string" ? hook.agentId.trim() : "";
      if (id) return id;
    }
  } catch (_) { /* kein Hook-State → andere Quelle versuchen */ }
  return "";
}

/** Häufigste agentId in einem Verzeichnis — für die Gen1-Zuordnung. */
function dominantAgentId(dir) {
  const counts = new Map();
  for (const store of MIGRATED_STORES) {
    for (const record of readJsonl(join(dir, store.file))) {
      const id = typeof record?.agentId === "string" ? record.agentId.trim() : "";
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  let best = "";
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) { best = id; bestCount = count; }
  }
  return best;
}

/**
 * Ordnet Gen1- und Gen2-Verzeichnisse ihrem kanonischen Gen3-Verzeichnis zu.
 *
 * Die Zuordnung ist selbstverifizierend: Aus dem Präfix eines kanonischen
 * Verzeichnisses wird der workspaceKey abgeleitet und über createNeoStore
 * zurückgerechnet. Stimmt das Ergebnis nicht mit dem Verzeichnisnamen
 * überein, wird der Eintrag übersprungen statt geraten.
 */
export function planMigration(workspacesDir) {
  if (!existsSync(workspacesDir)) return { plans: [], skipped: [], empty: [] };
  const entries = readdirSync(workspacesDir).filter((name) => {
    try { return statSync(join(workspacesDir, name)).isDirectory(); } catch (_) { return false; }
  });

  const canonical = [];
  const others = new Set();
  for (const name of entries) {
    if (CANONICAL_DIR_RE.test(name)) canonical.push(name); else others.add(name);
  }

  const plans = [];
  const skipped = [];
  const claimed = new Set();

  for (const dirName of canonical) {
    const workspaceKey = dirName.match(CANONICAL_DIR_RE)[1];
    // Rückrechnung: ergibt der abgeleitete Key wirklich dieses Verzeichnis?
    const store = createNeoStore(workspacesDir.replace(/\/workspaces$/, ""), workspaceKey);
    if (basename(store.paths.workspaceDir) !== dirName) {
      skipped.push({ dir: dirName, reason: "workspaceKey nicht eindeutig rückrechenbar" });
      continue;
    }

    const sources = [];
    // Gen2: exakt der Präfix-Name.
    if (others.has(workspaceKey)) { sources.push(workspaceKey); claimed.add(workspaceKey); }
    // Gen1 ist nach der agentId benannt. Zwei Belege müssen zusammenpassen:
    //  (a) das Gen1-Verzeichnis ist selbst-identifizierend — sein Name gleicht
    //      der agentId, die in seinen eigenen Records dominiert, UND
    //  (b) dieselbe agentId gehört POSITIV zum Ziel-Workspace.
    // (b) muss ein aktiver Nachweis sein, keine Abwesenheit von Widerspruch:
    // ist die Ziel-agentId unbekannt, wird übersprungen. Sonst würde ein
    // beliebiges selbst-identifizierendes Verzeichnis einem Workspace
    // zugeschlagen, dessen Identität wir gar nicht kennen (real passiert:
    // "faxpert" landete bei heisenberg, weil dessen Episoden-Dateien leer
    // sind).
    const targetAgentId = workspaceAgentId(join(workspacesDir, dirName))
      || workspaceAgentId(join(workspacesDir, workspaceKey))
      || dominantAgentId(join(workspacesDir, dirName))
      || dominantAgentId(join(workspacesDir, workspaceKey));
    for (const candidate of others) {
      if (candidate === workspaceKey || claimed.has(candidate)) continue;
      const candidateAgentId = dominantAgentId(join(workspacesDir, candidate))
        || workspaceAgentId(join(workspacesDir, candidate));
      if (!candidateAgentId || candidateAgentId !== candidate) continue; // (a)
      if (!targetAgentId || targetAgentId !== candidateAgentId) continue; // (b)
      sources.push(candidate);
      claimed.add(candidate);
    }
    if (sources.length > 0) plans.push({ canonicalDir: dirName, workspaceKey, sources });
  }

  const empty = [];
  for (const name of others) {
    if (claimed.has(name)) continue;
    const dir = join(workspacesDir, name);
    const hasData = MIGRATED_STORES.some((s) => existsSync(join(dir, s.file)));
    if (!hasData) empty.push(name);
    else skipped.push({ dir: name, reason: "keinem kanonischen Workspace zuzuordnen" });
  }

  return { plans, skipped, empty };
}

function backupFile(path, stamp) {
  if (!existsSync(path)) return;
  const dir = join(path, "..", `.migration-backup-${stamp}`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(path, join(dir, basename(path)));
}

export function migrateWorkspace(workspacesDir, plan, { apply = false, stamp = "" } = {}) {
  const rootDir = workspacesDir.replace(/\/workspaces$/, "");
  const store = createNeoStore(rootDir, plan.workspaceKey);
  const report = {};

  for (const spec of MIGRATED_STORES) {
    const canonicalPath = join(workspacesDir, plan.canonicalDir, spec.file);
    const existingIds = new Set(readJsonl(canonicalPath).map((r) => r?.id).filter(Boolean));

    const incoming = [];
    const seen = new Set(existingIds);
    for (const source of plan.sources) {
      for (const record of readJsonl(join(workspacesDir, source, spec.file))) {
        const id = record?.id ? String(record.id) : "";
        // Ohne id lässt sich nichts deduplizieren — solche Records werden
        // nicht migriert, sonst dupliziert jeder erneute Lauf sie.
        if (!id || seen.has(id)) continue;
        seen.add(id);
        incoming.push(record);
      }
    }

    report[spec.name] = { existing: existingIds.size, wouldAdd: incoming.length };
    if (!apply || incoming.length === 0) continue;

    backupFile(canonicalPath, stamp);
    store[spec.append](incoming);
    report[spec.name].added = incoming.length;
  }
  return report;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: migrate-neo-workspace-generations.mjs [--apply] [--root <_neo-dir>]");
    return 0;
  }

  const workspacesDir = join(args.root, "workspaces");
  const { plans, skipped, empty } = planMigration(workspacesDir);

  console.log(`[migrate-neo] root: ${args.root}`);
  console.log(`[migrate-neo] Modus: ${args.apply ? "APPLY (schreibt)" : "dry-run (schreibt nichts)"}`);
  if (plans.length === 0) console.log("[migrate-neo] nichts zu migrieren");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let totalAdded = 0;
  for (const plan of plans) {
    console.log(`\n[migrate-neo] ${plan.canonicalDir}`);
    console.log(`  Quellen: ${plan.sources.join(", ")}`);
    const report = migrateWorkspace(workspacesDir, plan, { apply: args.apply, stamp });
    for (const [name, stats] of Object.entries(report)) {
      if (stats.wouldAdd === 0 && stats.existing === 0) continue;
      console.log(`  ${name.padEnd(10)} vorhanden=${String(stats.existing).padStart(5)}  ${args.apply ? "übernommen" : "würde übernehmen"}=${stats.wouldAdd}`);
      totalAdded += stats.wouldAdd;
    }
  }

  for (const entry of skipped) console.log(`\n[migrate-neo] übersprungen: ${entry.dir} — ${entry.reason}`);
  if (empty.length > 0) console.log(`\n[migrate-neo] leere Verzeichnisse (nur gemeldet, NICHT gelöscht): ${empty.join(", ")}`);

  console.log(`\n[migrate-neo] Summe: ${totalAdded} Record(s) ${args.apply ? "übernommen" : "würden übernommen"}`);
  if (!args.apply && totalAdded > 0) console.log("[migrate-neo] Zum Schreiben erneut mit --apply aufrufen.");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());

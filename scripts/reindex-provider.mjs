/**
 * Reindex-Scaffold: Dry-Run + Report-Only.
 *
 * Liest Config, erkennt Namespace-Pfade, prüft Dimensions via Dimension-Guard,
 * zählt Records, schreibt Audit-Report.
 *
 * KEIN Re-Embedding, KEIN Config-Switch, KEIN cp -r ohne --apply.
 * Echter Reindex wird eigener Folgepatch (Schema + Pfade erst verifizieren).
 *
 * Usage:
 *   node scripts/reindex-provider.mjs --agent main --from lancedb-namespaced --to lancedb-local
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readExistingTableDimension } from "../lib/providers/dimension-guard.js";
import { normalizeEmbeddingConfig } from "../lib/providers/config-normalize.js";

const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };

const agentId = getArg("agent") || "main";
const fromNamespace = getArg("from");
const toNamespace = getArg("to");

if (!fromNamespace || !toNamespace) {
  console.error("Usage: node scripts/reindex-provider.mjs --agent <id> --from <ns> --to <ns>");
  console.error("Note: Actual re-embedding requires --apply flag (not yet implemented — this iteration is report-only)");
  process.exit(1);
}

if (args.includes("--apply")) {
  console.error("[reindex] --apply ist in dieser Iteration noch nicht implementiert.");
  console.error("[reindex] Schema und Row-Format müssen erst gegen den Live-Code verifiziert werden.");
  console.error("[reindex] Bitte Folgepatch abwarten.");
  process.exit(1);
}

const OPENCLAW_DIR = join(homedir(), ".openclaw");
const CONFIG_PATH = join(OPENCLAW_DIR, "openclaw.json");
const MEMORY_BASE = join(OPENCLAW_DIR, "memory");

async function main() {
  console.log(`[reindex] REPORT-ONLY — Agent: ${agentId}, ${fromNamespace} → ${toNamespace}`);
  console.log(`[reindex] Echter Reindex noch nicht implementiert. Nur Audit.`);

  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.error(`[reindex] Kann openclaw.json nicht lesen: ${e.message}`);
    process.exit(1);
  }
  const pluginCfg = config?.plugins?.entries?.["memory-lancedb-namespaced"] || {};
  const embCfg = normalizeEmbeddingConfig(pluginCfg.embedding || {});
  console.log(`[reindex] Ziel-Provider: ${embCfg.provider}, ${embCfg.dimensions ?? "?"} dims`);

  const FROM_PATH = join(MEMORY_BASE, fromNamespace, agentId);
  const srcGuard = await readExistingTableDimension(FROM_PATH);
  console.log(`[reindex] Quelle (${FROM_PATH}):`);
  console.log(`  status: ${srcGuard.status}`);
  if (srcGuard.status === "ok") {
    console.log(`  dimension: ${srcGuard.dimension}`);
  } else if (srcGuard.error) {
    console.log(`  error: ${srcGuard.error}`);
  }

  const TO_PATH = join(MEMORY_BASE, toNamespace, agentId);
  const dstGuard = await readExistingTableDimension(TO_PATH);
  console.log(`[reindex] Ziel (${TO_PATH}):`);
  console.log(`  status: ${dstGuard.status}`);
  if (dstGuard.status === "ok") {
    console.log(`  dimension: ${dstGuard.dimension}`);
  }

  let rowCount = null;
  let schemaFields = null;
  if (srcGuard.status === "ok") {
    try {
      const lancedb = await import("@lancedb/lancedb");
      const srcDb = await lancedb.connect(FROM_PATH);
      const srcTable = await srcDb.openTable("memories");
      const schema = await srcTable.schema();
      schemaFields = schema.fields.map(f => f.name);
      const countResult = await srcTable.countRows();
      rowCount = countResult;
      console.log(`[reindex] Records in Quelle: ${rowCount}`);
      console.log(`[reindex] Schema-Felder: ${schemaFields.join(", ")}`);
      const textField = schemaFields.includes("text") ? "text"
        : schemaFields.find(f => f.includes("content") || f.includes("body")) || "UNBEKANNT";
      console.log(`[reindex] AUDIT: Text-Feld für Re-Embedding wäre: '${textField}'`);
      if (textField === "UNBEKANNT") {
        console.warn(`[reindex] WARNUNG: Kein 'text'-Feld gefunden — echter Reindex bräuchte Schema-Mapping.`);
      }
    } catch (e) {
      console.error(`[reindex] Record-Count fehlgeschlagen: ${e.message}`);
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    agent: agentId,
    fromNamespace,
    toNamespace,
    fromPath: FROM_PATH,
    toPath: TO_PATH,
    sourceGuard: srcGuard,
    targetGuard: dstGuard,
    targetProvider: { provider: embCfg.provider, dimensions: embCfg.dimensions },
    rowCount,
    schemaFields,
    applyImplemented: false,
    notes: "Echter Reindex in Folgepatch. Schema-Felder und Pfad-Struktur zuerst verifizieren.",
  };
  const reportPath = join(OPENCLAW_DIR, `reindex-report-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[reindex] Report geschrieben: ${reportPath}`);
  console.log(`[reindex] REPORT DONE — keine Produktionsdaten verändert.`);
}

main().catch(e => {
  console.error("[reindex] FATAL:", e);
  process.exit(1);
});

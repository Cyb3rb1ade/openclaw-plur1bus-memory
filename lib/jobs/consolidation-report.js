/**
 * lib/jobs/consolidation-report.js — Wöchentlicher Consolidation-Report.
 *
 * Schreibt einen Markdown-Report nach /memory/consolidation/YYYY-WXX.md
 * mit Metriken aus der täglichen Konsolidierung.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonl } from "../jsonl-utils.js";

function getISOWeek(date) {
  const tmp = new Date(date);
  tmp.setHours(0, 0, 0, 0);
  tmp.setDate(tmp.getDate() + 4 - (tmp.getDay() || 7));
  const yearStart = new Date(tmp.getFullYear(), 0, 1);
  return Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
}

function weekOf(date = new Date()) {
  const y = date.getFullYear();
  const w = getISOWeek(date);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

function readResolvedConflicts(workspaceDir) {
  return readJsonl(join(workspaceDir, ".adaptive-learning", "conflict-resolved.jsonl"));
}

export function writeConsolidationReport(consolidationResult, workspaceDir) {
  try {
    const w = weekOf();
    const dir = join(workspaceDir, "memory", "consolidation");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const path = join(dir, `${w}.md`);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";

    const c = consolidationResult || {};
    const compaction = c.compaction || {};
    const conflicts = c.conflictResolution || {};

    // Wenn bereits existiert, merge Metriken
    const existingMetrics = existing.match(/compacted:\s*(\d+)/);
    const priorCompacted = existingMetrics ? parseInt(existingMetrics[1]) : 0;

    const lines = [
      "---",
      `week: ${w}`,
      `date: ${new Date().toISOString().split("T")[0]}`,
      `type: consolidation_report`,
      `compacted: ${(compaction.compacted || 0) + priorCompacted}`,
      `deleted: ${compaction.deleted || 0}`,
      `merged: ${compaction.merged || 0}`,
      `conflicts_resolved: ${conflicts.resolved || 0}`,
      `conflicts_uncertain: ${conflicts.uncertain || 0}`,
      `dry_run: ${c.dryRun === true}`,
      "---",
      "",
      `# Konsolidierungs-Report — ${w}`,
      "",
      `**Zeitpunkt:** ${c.timestamp || new Date().toISOString()}  `,
      `**Agent:** ${c.agent || "default"}`,
      "",
      "## Memory Compaction",
      "",
      `- **Kandidaten:** ${compaction.candidates || 0}`,
      `- **Cluster:** ${compaction.clusters || 0}`,
      `- **Gelöscht (Duplikate):** ${compaction.deleted || 0}`,
      `- **Gemerged:** ${compaction.merged || 0}`,
      `- **Fehler:** ${compaction.errors || 0}`,
      "",
      "## Konflikt-Auflösung",
      "",
      `- **Geprüft:** ${conflicts.scanned || 0}`,
      `- **Aufgelöst:** ${conflicts.resolved || 0}`,
      `- **Unsicher:** ${conflicts.uncertain || 0}`,
      "",
    ];

    // Füge aufgelöste Konflikte hinzu
    const resolved = readResolvedConflicts(workspaceDir);
    const thisWeek = resolved.filter(r => {
      if (!r.resolvedAt) return false;
      const d = new Date(r.resolvedAt);
      return weekOf(d) === w;
    });

    if (thisWeek.length > 0) {
      lines.push("## Aufgelöste Konflikte");
      lines.push("");
      for (const r of thisWeek.slice(0, 10)) {
        const orig = r.original || {};
        lines.push(`### ${r.resolution}`);
        lines.push(`- **Grund:** ${r.reason || "—"}`);
        lines.push(`- **Neu:** ${(orig.newText || "").slice(0, 100)}`);
        lines.push(`- **Existierend:** ${(orig.existingText || "").slice(0, 100)}`);
        lines.push("");
      }
    }

    writeFileSync(path, lines.join("\n"), "utf8");
    return { path, written: true };
  } catch (err) {
    return { written: false, error: err.message };
  }
}

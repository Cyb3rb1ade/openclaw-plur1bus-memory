/**
 * lib/jobs/feedback-analyzer.js — Observierender Feedback-Analyzer Job.
 *
 * Phase 1b: KEIN Auto-Tune. Nur Report-Generierung.
 * Läuft wöchentlich (empfohlen via cron/scheduler), produziert
 * feedback-report.json im .adaptive-learning/ Verzeichnis.
 */

import { generateFeedbackReport, readFeedbackLog } from "../feedback-log.js";

/**
 * Führt den Feedback-Analyzer aus und liefert den Report.
 * Enthält zusätzlich den Zeitraum der Auswertung.
 *
 * @param {string} workspaceDir
 * @returns {Promise<object>}
 */
export async function runFeedbackAnalyzer(workspaceDir) {
  const entries = readFeedbackLog(workspaceDir);

  if (entries.length === 0) {
    const emptyReport = generateFeedbackReport(workspaceDir);
    emptyReport.timeRange = { from: 0, to: 0 };
    return emptyReport;
  }

  const timestamps = entries.map((e) => e.timestamp).filter((t) => typeof t === "number");
  const from = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const to = timestamps.length > 0 ? Math.max(...timestamps) : 0;

  const report = generateFeedbackReport(workspaceDir);
  report.timeRange = { from, to };
  return report;
}

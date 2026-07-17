/**
 * /status — pure renderer.
 *
 * Expects already aggregated data (see ./status-data.js for the
 * collector). No I/O here, so the renderer remains easily testable.
 *
 * Data form:
 *   {
 *     memory:       { cardCount: number, lastUpdateMinutes: number },
 *     sync:         { active: boolean, devices: number },
 *     plausibility: { lastRun: string (ISO) | null },
 *     issues:       Array<{
 *                     key, title, reason, howToFix, whatItDoes, whatYouLose
 *                   }>,
 *   }
 */

import { t } from "../i18n.js";

function formatLastRun(iso, lang = "en", tone = "default") {
  if (!iso) return t("status.unknown", { lang, tone });
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace("T", " ").replace(/\..*$/, " UTC");
  } catch (_) {
    return iso;
  }
}

/**
 * Render aggregated PLUR1BUS status data.
 * @param {object} data
 * @param {{lang?: string, tone?: string}} [opts]
 * @returns {string}
 */
export function renderStatus(data, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  const memory = data?.memory || {};
  const sync = data?.sync || {};
  const plausibility = data?.plausibility || {};
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  const graphRecall = data?.graphRecall || {};
  const obsidianSync = data?.obsidianSync || {};
  const llmResultCache = data?.llmResultCache || null;
  const emotional = data?.emotional;

  const overallEmoji = issues.length === 0 ? "🟢" : "🟡";
  const headlineWord = issues.length === 0
    ? t("status.headline_ok", { lang, tone })
    : t("status.headline_issues", { lang, tone, vars: { count: issues.length } });

  const lines = [];
  lines.push(`${overallEmoji} PLUR1BUS-Status — ${headlineWord}`);
  lines.push("");
  if (Number.isFinite(memory.lastUpdateMinutes)) {
    lines.push(t("status.memory_count_updated", { lang, tone, vars: { count: memory.cardCount ?? t("status.unknown", { lang, tone }), minutes: memory.lastUpdateMinutes } }));
  } else {
    lines.push(t("status.memory_count", { lang, tone, vars: { count: memory.cardCount ?? t("status.unknown", { lang, tone }) } }));
  }
  if (sync.active === true) {
    lines.push(t("status.vault_sync_active", { lang, tone, vars: { devices: sync.devices } }));
  } else if (sync.active === false) {
    lines.push(t("status.vault_sync_inactive", { lang, tone }));
  } else {
    lines.push(t("status.vault_sync_unconfigured", { lang, tone, vars: { status: sync.status || t("status.unknown", { lang, tone }) } }));
  }
  lines.push(t("status.plausibility", { lang, tone, vars: { lastRun: formatLastRun(plausibility.lastRun, lang, tone) } }));
  if (emotional) {
    const moodEmoji = emotional.emoji || "😐";
    lines.push(t("status.mood", { lang, tone, vars: { emoji: moodEmoji, label: emotional.label || t("status.unknown", { lang, tone }), intensity: emotional.intensity || t("status.unknown", { lang, tone }) } }));
  }

  // Graph-Recall Metriken
  if (graphRecall.edgesTotal !== null || graphRecall.recallLatencyMs !== null) {
    lines.push("");
    lines.push(`🔗 Graph-Recall`);
    if (Number.isFinite(graphRecall.edgesTotal)) {
      lines.push(`  Edges: ${graphRecall.edgesTotal}`);
    }
    if (graphRecall.edgesByType) {
      const typeStr = Object.entries(graphRecall.edgesByType)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(`  By type: ${typeStr}`);
    }
    if (Number.isFinite(graphRecall.hydrationMissRate)) {
      lines.push(`  Hydration miss: ${(graphRecall.hydrationMissRate * 100).toFixed(1)}%`);
    }
    if (Number.isFinite(graphRecall.recallLatencyMs)) {
      lines.push(`  Latency: ${graphRecall.recallLatencyMs}ms`);
    }
  }

  // Obsidian Sync Metriken
  if (obsidianSync.filesScanned !== null || obsidianSync.filesSkipped !== null) {
    lines.push("");
    lines.push(`📁 Obsidian Sync`);
    if (Number.isFinite(obsidianSync.filesScanned)) {
      lines.push(`  Scanned: ${obsidianSync.filesScanned}`);
    }
    if (Number.isFinite(obsidianSync.filesSkipped)) {
      lines.push(`  Skipped: ${obsidianSync.filesSkipped}`);
    }
    if (Number.isFinite(obsidianSync.filesWritten)) {
      lines.push(`  Written: ${obsidianSync.filesWritten}`);
    }
  }

  if (llmResultCache) {
    const requests = Number.isFinite(llmResultCache.requests) ? llmResultCache.requests : 0;
    const hits = Number.isFinite(llmResultCache.hits) ? llmResultCache.hits : 0;
    const hitRate = Number.isFinite(llmResultCache.hitRate) ? llmResultCache.hitRate : 0;
    const memoryHits = Number.isFinite(llmResultCache.memoryHits) ? llmResultCache.memoryHits : 0;
    const persistHits = Number.isFinite(llmResultCache.persistHits) ? llmResultCache.persistHits : 0;
    const avoidedInputTokens = Number.isFinite(llmResultCache.avoidedInputTokens)
      ? llmResultCache.avoidedInputTokens
      : 0;
    const avoidedOutputTokens = Number.isFinite(llmResultCache.avoidedOutputTokens)
      ? llmResultCache.avoidedOutputTokens
      : 0;
    const persistence = llmResultCache.persistActive
      ? "active"
      : (llmResultCache.persistConfigured ? "configured but inactive" : "off");

    lines.push("");
    lines.push("🪙 LLM Result Cache");
    lines.push(`  Hit rate: ${(hitRate * 100).toFixed(1)}% (${hits}/${requests})`);
    lines.push(`  Hits: memory=${memoryHits}, persistent=${persistHits}`);
    lines.push(`  Avoided tokens: input=${avoidedInputTokens.toLocaleString("en-US")}, output=${avoidedOutputTokens.toLocaleString("en-US")}`);
    lines.push(`  Persistence: ${persistence}`);
  }

  if (issues.length > 0) {
    lines.push("");
    lines.push(t("status.issues_header", { lang, tone }));
    for (const issue of issues) {
      lines.push("");
      lines.push(`🟡 ${issue.title || issue.key || t("status.unknown", { lang, tone })}`);
      if (issue.reason) lines.push(t("status.issue_reason", { lang, tone, vars: { reason: issue.reason } }));
      if (issue.whatItDoes) lines.push(t("status.issue_what_it_does", { lang, tone, vars: { text: issue.whatItDoes } }));
      if (issue.whatYouLose) lines.push(t("status.issue_what_you_lose", { lang, tone, vars: { text: issue.whatYouLose } }));
      if (issue.howToFix) lines.push(t("status.issue_how_to_fix", { lang, tone, vars: { text: issue.howToFix } }));
    }
  }

  return lines.join("\n");
}

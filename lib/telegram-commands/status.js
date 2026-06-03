/**
 * /status — pure renderer.
 *
 * Erwartet bereits aggregierte Daten (siehe ./status-data.js für den
 * Collector). Kein I/O hier, damit der Renderer leicht testbar bleibt.
 *
 * Datenform:
 *   {
 *     memory:       { cardCount: number, lastUpdateMinutes: number },
 *     sync:         { active: boolean, devices: number },
 *     plausibility: { lastRun: string (ISO) | null },
 *     issues:       Array<{
 *                     key, title, reason, howToFix, whatItDoes, whatYouLose
 *                   }>,
 *   }
 */

function formatLastRun(iso) {
  if (!iso) return "unbekannt";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace("T", " ").replace(/\..*$/, " UTC");
  } catch (_) {
    return iso;
  }
}

export function renderStatus(data) {
  const memory = data?.memory || {};
  const sync = data?.sync || {};
  const plausibility = data?.plausibility || {};
  const issues = Array.isArray(data?.issues) ? data.issues : [];

  const overallEmoji = issues.length === 0 ? "🟢" : "🟡";
  const headlineWord = issues.length === 0 ? "alles gut" : `${issues.length} Hinweis(e)`;
  const emotional = data?.emotional;

  const lines = [];
  lines.push(`${overallEmoji} PLUR1BUS-Status — ${headlineWord}`);
  lines.push("");
  lines.push(`• Erinnerungen: ${memory.cardCount ?? "unbekannt"} Karten`
    + (Number.isFinite(memory.lastUpdateMinutes)
      ? ` (zuletzt aktualisiert vor ${memory.lastUpdateMinutes} Min)`
      : ""));
  if (sync.active === true) {
    lines.push(`• Vault-Sync: aktiv, verbunden mit ${sync.devices} Geräten`);
  } else if (sync.active === false) {
    lines.push(`• Vault-Sync: inaktiv (0 Geräte)`);
  } else {
    lines.push(`• Vault-Sync: ${sync.status || "nicht konfiguriert"}`);
  }
  lines.push(`• Plausibilitätsprüfung: zuletzt ${formatLastRun(plausibility.lastRun)}`);
  if (emotional) {
    const moodEmoji = emotional.emoji || "😐";
    lines.push(`• Stimmung: ${moodEmoji} ${emotional.label || "neutral"} (Intensität: ${emotional.intensity || "niedrig"})`);
  }

  if (issues.length > 0) {
    lines.push("");
    lines.push("Hinweise:");
    for (const issue of issues) {
      lines.push("");
      lines.push(`🟡 ${issue.title || issue.key || "Hinweis"}`);
      if (issue.reason) lines.push(`  Grund: ${issue.reason}`);
      if (issue.whatItDoes) lines.push(`  Was es macht: ${issue.whatItDoes}`);
      if (issue.whatYouLose) lines.push(`  Was du ohne es verlierst: ${issue.whatYouLose}`);
      if (issue.howToFix) lines.push(`  Einschalten: ${issue.howToFix}`);
    }
  }

  return lines.join("\n");
}

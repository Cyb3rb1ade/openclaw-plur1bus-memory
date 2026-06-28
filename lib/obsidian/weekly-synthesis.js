import { existsSync, readFileSync } from "node:fs";
import { buildRecordIndex } from "./record-index.js";
import { atomicWriteText, resolveReviewPath } from "./safe-paths.js";

export function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function buildWeeklySynthesis(rawConfig, options = {}) {
  const week = options.week || isoWeek(options.now ? new Date(options.now) : new Date());
  const index = buildRecordIndex(rawConfig, options);
  const records = index.records;
  const body = [
    `# PLUR1BUS Weekly Synthesis - ${week}`,
    "",
    "Weekly synthesis is not a ReviewBundle and never applies changes.",
    "",
    "## Delta Since Previous Week",
    "",
    `- Records visible: ${records.length}`,
    `- New candidates: ${(index.byType.memory_candidate || []).length}`,
    `- Open conflicts: ${(index.byType.conflict || []).length + (index.byType.semantic_conflict || []).length}`,
    `- Stale decisions: ${(index.byType.stale_decision || []).length}`,
    "",
    "## Agent Activity",
    "",
    "| Agent | Records |",
    "|---|---|",
    ...Object.entries(records.reduce((acc, r) => { acc[r.agentId || "unknown"] = (acc[r.agentId || "unknown"] || 0) + 1; return acc; }, {})).map(([agent, count]) => `| ${agent} | ${count} |`),
    "",
    "## Memory Health",
    "",
    "- LanceDB/PLUR1BUS remains authoritative; dashboard records are mirrors/proposals.",
    "",
    "## Top Risks",
    "",
    records.filter((record) => ["high", "critical"].includes(record.risk)).slice(0, 10).map((record) => `- ${record.plur1bus_id}: ${record.risk}`).join("\n") || "- None generated.",
    "",
    "## Recommended Next Actions",
    "",
    "- Review pending high-risk proposals before applying anything.",
    "- Keep semantic outputs proposal-only unless explicitly approved.",
    "",
  ].join("\n");
  const rel = `weekly/${week}.md`;
  atomicWriteText(resolveReviewPath(rawConfig, rel).targetPath, body);
  const indexPath = resolveReviewPath(rawConfig, "weekly/index.md").targetPath;
  atomicWriteText(indexPath, renderWeeklyIndex(indexPath, week));
  return { ok: true, week, generated: [rel, "weekly/index.md"] };
}

function renderWeeklyIndex(indexPath, week) {
  const weeks = new Set();
  if (existsSync(indexPath)) {
    const existing = readFileSync(indexPath, "utf8");
    for (const match of existing.matchAll(/\[\[(\d{4}-W\d{2})\]\]/g)) {
      weeks.add(match[1]);
    }
  }
  weeks.add(week);
  return `# PLUR1BUS Weekly Index\n\n${[...weeks].sort().map((item) => `- [[${item}]]`).join("\n")}\n`;
}

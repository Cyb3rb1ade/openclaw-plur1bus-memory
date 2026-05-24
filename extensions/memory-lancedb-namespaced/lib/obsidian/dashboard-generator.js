import { formatFrontmatter } from "./frontmatter.js";
import { buildManagedBlock } from "./managed-blocks.js";
import { buildRecordIndex } from "./record-index.js";
import { atomicWriteText, resolveReviewPath } from "./safe-paths.js";
import { dataviewTableBlock } from "./dataview-generator.js";

export const DASHBOARD_DEFINITIONS = Object.freeze([
  ["index.md", "source", "PLUR1BUS Living Dashboard", "sources"],
  ["memory-candidates.md", "memory_candidate", "Memory Candidates", "memory-candidates"],
  ["review-queue.md", "review_item", "Review Queue", "review-items"],
  ["conflicts.md", "conflict", "Conflicts", "conflicts"],
  ["stale-decisions.md", "stale_decision", "Stale Decisions", "stale-decisions"],
  ["agents.md", "agent", "Agents", "agents"],
  ["sources.md", "source", "Sources", "sources"],
  ["tasks.md", "task", "Tasks", "tasks"],
  ["projects.md", "project", "Projects", "projects"],
  ["semantic-conflicts.md", "semantic_conflict", "Semantic Conflicts", "semantic-conflicts"],
  ["duplicate-candidates.md", "duplicate_candidate", "Duplicate Candidates", "duplicate-candidates"],
  ["provenance.md", "provenance", "Provenance", "provenance"],
  ["memory-health.md", "impact_analysis", "Memory Health", "impact-analysis"],
  ["impact-analysis.md", "impact_analysis", "Impact Analysis", "impact-analysis"],
]);

function tableRows(records) {
  if (!records.length) return "| ID | Status | Risk | Scope | Trust | Agent | Updated |\n|---|---|---|---|---|---|---|\n| none | - | - | - | - | - | - |";
  return [
    "| ID | Status | Risk | Scope | Trust | Agent | Updated |",
    "|---|---|---|---|---|---|---|",
    ...records.slice(0, 100).map((record) => `| [[${record.path || record.plur1bus_id}|${record.plur1bus_id || record.id || "record"}]] | ${record.status || ""} | ${record.risk || ""} | ${record.scope || ""} | ${record.trustLevel || ""} | ${record.agentId || ""} | ${record.updatedAt || ""} |`),
  ].join("\n");
}

export function renderDashboard({ title, type, collection, records, config }) {
  const dataviewEnabled = config.optionalIntegrations?.dataview === true || config.dashboardLayer?.dataview === true;
  const basesEnabled = config.optionalIntegrations?.bases === true || config.dashboardLayer?.bases === true;
  const body = [
    `# ${title}`,
    "",
    "> Obsidian dashboard output. PLUR1BUS/LanceDB remains authoritative memory.",
    "",
    "## Static Summary",
    "",
    `- Records: ${records.length}`,
    `- Open/pending: ${records.filter((record) => !["applied", "resolved", "closed"].includes(String(record.status || ""))).length}`,
    "",
    "## Records",
    "",
    tableRows(records),
    "",
    basesEnabled ? `Base: [[bases/${collection}.base]]` : "",
    dataviewEnabled ? "## Dataview\n\n" + dataviewTableBlock({ collection, type, reviewRoot: config.reviewRoot || "plur1bus" }) : "",
    "",
  ].filter((line) => line !== "").join("\n");
  return formatFrontmatter({
    plur1bus_type: "dashboard",
    dashboard: collection,
    generatedBy: "plur1bus-4.2.5",
    authoritative: false,
  }, buildManagedBlock({ id: `dashboard-${collection}`, version: "4.2.5", body }));
}

export function generateDashboards(rawConfig, options = {}) {
  const index = buildRecordIndex(rawConfig, options);
  const generated = [];
  for (const [fileName, type, title, collection] of DASHBOARD_DEFINITIONS) {
    const rel = `dashboards/${fileName}`;
    const records = index.byType[type] || [];
    const { targetPath } = resolveReviewPath(rawConfig, rel);
    atomicWriteText(targetPath, renderDashboard({ title, type, collection, records, config: rawConfig }));
    generated.push(rel);
  }
  return { ok: true, generated, count: generated.length };
}

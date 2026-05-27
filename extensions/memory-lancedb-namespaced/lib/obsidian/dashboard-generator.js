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
    // P2: fall back to "(unknown)" when record has neither path nor plur1bus_id to avoid [[undefined|...]] links
    ...records.slice(0, 100).map((record) => `| [[${record.path || record.plur1bus_id || "(unknown)"}|${record.plur1bus_id || record.id || "record"}]] | ${record.status || ""} | ${record.risk || ""} | ${record.scope || ""} | ${record.trustLevel || ""} | ${record.agentId || ""} | ${record.updatedAt || ""} |`),
  ].join("\n");
}

function reviewProgressSection(records) {
  const pending = records.filter((r) => !r.status || r.status === "pending").length;
  const applied = records.filter((r) => r.status === "applied").length;
  const rejected = records.filter((r) => r.status === "rejected").length;
  const total = records.length;
  return [
    "## Review Progress",
    "",
    `- Pending review items: ${pending}`,
    `- Applied: ${applied}`,
    `- Rejected: ${rejected}`,
    `- Total tracked: ${total}`,
    "",
    "> Use /plur1bus_review show to see the active ReviewBundle queue.",
  ].join("\n");
}

export function renderDashboard({ title, type, collection, records, config, generatedAt }) {
  const dataviewEnabled = config.optionalIntegrations?.dataview === true || config.dashboardLayer?.dataview === true;
  const basesEnabled = config.optionalIntegrations?.bases === true || config.dashboardLayer?.bases === true;
  const reviewQueueNote = collection === "review-items"
    ? "This dashboard lists generated review_item records only. ReviewBundle queues are shown with /plur1bus_review; 0 records here does not mean there are no pending ReviewBundle items."
    : "";
  // U5: freshness timestamp so users know how current the dashboard is
  const ts = generatedAt ? String(generatedAt).slice(0, 16).replace("T", " ") : new Date().toISOString().slice(0, 16).replace("T", " ");
  const body = [
    `# ${title}`,
    "",
    `> 🔄 Generated: ${ts} | Obsidian dashboard output. PLUR1BUS/LanceDB remains authoritative memory.`,
    reviewQueueNote ? `> ${reviewQueueNote}` : "",
    "",
    "## Static Summary",
    "",
    `- Records: ${records.length}`,
    `- Open/pending: ${records.filter((record) => !["applied", "resolved", "closed"].includes(String(record.status || ""))).length}`,
    "",
    // U1: review-queue dashboard gets a progress section
    ...(collection === "review-items" ? [reviewProgressSection(records), ""] : []),
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
    generatedBy: "plur1bus-4.2.18",
    authoritative: false,
  }, buildManagedBlock({ id: `dashboard-${collection}`, version: "4.2.18", body }));
}

export function generateDashboards(rawConfig, options = {}) {
  const index = buildRecordIndex(rawConfig, options);
  const generatedAt = (options.now || new Date()).toISOString();
  const generated = [];
  for (const [fileName, type, title, collection] of DASHBOARD_DEFINITIONS) {
    const rel = `dashboards/${fileName}`;
    const records = index.byType[type] || [];
    const { targetPath } = resolveReviewPath(rawConfig, rel);
    atomicWriteText(targetPath, renderDashboard({ title, type, collection, records, config: rawConfig, generatedAt }));
    generated.push(rel);
  }
  return { ok: true, generated, count: generated.length };
}

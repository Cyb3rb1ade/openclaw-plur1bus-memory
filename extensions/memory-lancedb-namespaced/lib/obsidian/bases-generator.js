import { atomicWriteText, resolveReviewPath } from "./safe-paths.js";

export const BASE_DEFINITIONS = Object.freeze([
  ["memory-candidates.base", "memory_candidate", "Memory Candidates"],
  ["open-conflicts.base", "conflict", "Open Conflicts"],
  ["stale-decisions.base", "stale_decision", "Stale Decisions"],
  ["review-queue.base", "review_item", "Review Queue"],
  ["agent-activity.base", "agent", "Agent Activity"],
  ["source-quality.base", "source", "Source Quality"],
  ["task-suggestions.base", "task", "Task Suggestions"],
  ["project-health.base", "project", "Project Health"],
  ["semantic-conflicts.base", "semantic_conflict", "Semantic Conflicts"],
  ["duplicate-candidates.base", "duplicate_candidate", "Duplicate Candidates"],
  ["provenance.base", "provenance", "Provenance"],
  ["impact-analysis.base", "impact_analysis", "Impact Analysis"],
]);

export function renderBaseDefinition(type, name) {
  return [
    "filters:",
    "  and:",
    `    - 'plur1bus_type == "${type}"'`,
    "properties:",
    "  plur1bus_id:",
    "    displayName: ID",
    "  status:",
    "    displayName: Status",
    "  risk:",
    "    displayName: Risk",
    "  scope:",
    "    displayName: Scope",
    "  trustLevel:",
    "    displayName: Trust",
    "  agentId:",
    "    displayName: Agent",
    "  updatedAt:",
    "    displayName: Updated",
    "views:",
    "  - type: table",
    `    name: "${name}"`,
    "    limit: 100",
    "    order:",
    "      - file.name",
    "      - status",
    "      - risk",
    "      - scope",
    "      - trustLevel",
    "      - agentId",
    "      - updatedAt",
    "",
  ].join("\n");
}

export function generateBases(rawConfig, options = {}) {
  const enabled = rawConfig.optionalIntegrations?.bases === true || rawConfig.dashboardLayer?.bases === true;
  if (!enabled) return { ok: true, generated: [], skipped: "bases disabled" };
  const generated = [];
  for (const [fileName, type, name] of BASE_DEFINITIONS) {
    const rel = `dashboards/bases/${fileName}`;
    const { targetPath } = resolveReviewPath(rawConfig, rel);
    atomicWriteText(targetPath, renderBaseDefinition(type, name));
    generated.push(rel);
  }
  return { ok: true, generated, count: generated.length, version: options.version || "4.2.16" };
}

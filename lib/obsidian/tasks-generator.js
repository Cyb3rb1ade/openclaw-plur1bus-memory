import { atomicWriteText, resolveReviewPath } from "./safe-paths.js";
import { writeRecords } from "./record-writer.js";
import { mutationAllowed } from "../obsidian-mutation-policy.js";

function taskPriority(priority) {
  if (priority === "high") return "priority: high";
  if (priority === "medium") return "priority: medium";
  if (priority === "low") return "priority: low";
  return "";
}

export function renderTaskSuggestion(task = {}) {
  const due = task.due ? ` due:${task.due}` : "";
  const priority = taskPriority(task.priority);
  const title = String(task.title || task.summary || task.id || "Review PLUR1BUS suggestion").replace(/\r?\n/g, " ");
  return [
    `- [ ] #plur1bus/task ${title}${due}${priority ? ` ${priority}` : ""}`,
    task.project ? `  - Project: ${task.project}` : "",
    task.reviewBundleId ? `  - ReviewBundle: [[${task.reviewBundleId}]]` : "",
    Array.isArray(task.sourceRefs) && task.sourceRefs.length ? `  - Sources: ${task.sourceRefs.join(", ")}` : "",
    "  - Checkbox state is not approval; apply requires PLUR1BUS review commands.",
  ].filter(Boolean).join("\n");
}

export function generateTaskSuggestions(rawConfig, tasks = [], options = {}) {
  const enabled = rawConfig.optionalIntegrations?.tasks === true || rawConfig.dashboardLayer?.tasks === true;
  if (!enabled) return { ok: true, generated: [], skipped: "tasks disabled" };
  if (!mutationAllowed(options.mutationPolicy, "vault_write")) {
    return { ok: true, generated: [], count: 0, applied: false, reason: "mutation_policy_denied" };
  }
  const normalized = tasks.length ? tasks : [{
    id: "task-review-dashboard",
    type: "task",
    title: "Review PLUR1BUS Living Dashboard proposals",
    status: "pending",
    priority: "medium",
    sourceRefs: [],
  }];
  const md = [
    "# PLUR1BUS Task Suggestions",
    "",
    "Task checkboxes are UI only. They never approve memory mutation.",
    "",
    normalized.map(renderTaskSuggestion).join("\n\n"),
    "",
  ].join("\n");
  atomicWriteText(resolveReviewPath(rawConfig, "tasks/task-suggestions.md").targetPath, md);
  atomicWriteText(resolveReviewPath(rawConfig, "tasks/task-suggestions.jsonl").targetPath, normalized.map((task) => JSON.stringify(task)).join("\n") + "\n");
  writeRecords(rawConfig, normalized.map((task) => ({ ...task, type: "task" })), options);
  return { ok: true, generated: ["tasks/task-suggestions.md", "tasks/task-suggestions.jsonl"], count: normalized.length };
}

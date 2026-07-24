import { atomicWriteText, resolveReviewPath } from "./safe-paths.js";
import { writeRecords } from "./record-writer.js";
import { collectStructuralConflicts } from "./conflict-collector.js";
import { mutationAllowed } from "../obsidian-mutation-policy.js";

export function generateConflictReport(rawConfig, options = {}) {
  if (!mutationAllowed(options.mutationPolicy, "vault_write")) {
    return { ok: true, path: "", conflicts: [], count: 0, applied: false, reason: "mutation_policy_denied" };
  }
  const conflicts = options.conflicts || collectStructuralConflicts(rawConfig, options);
  const lines = [
    "# PLUR1BUS Conflict Report",
    "",
    "Conflicts are proposal-only. No memory mutation was attempted.",
    "",
    conflicts.length ? conflicts.map((item) => `- ${item.risk || "low"}: ${item.reason} (${item.target || item.id})`).join("\n") : "- No structural conflicts found.",
    "",
  ];
  const rel = `conflicts/conflicts-${(options.now ? new Date(options.now) : new Date()).toISOString().slice(0, 10)}.md`;
  atomicWriteText(resolveReviewPath(rawConfig, rel).targetPath, lines.join("\n"));
  writeRecords(rawConfig, conflicts.map((conflict) => ({ ...conflict, type: conflict.type || "conflict" })), options);
  return { ok: true, path: rel, conflicts, count: conflicts.length };
}

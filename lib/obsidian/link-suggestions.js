import { atomicWriteText, resolveReviewPath } from "./safe-paths.js";
import { mutationAllowed } from "../obsidian-mutation-policy.js";

export function generateLinkSuggestions(rawConfig, options = {}) {
  if (!mutationAllowed(options.mutationPolicy, "vault_write")) {
    return { ok: true, suggestions: [], generated: [], applied: false, reason: "mutation_policy_denied" };
  }
  const records = options.records || [];
  const suggestions = records
    .filter((record) => record.title || record.summary)
    .slice(0, 100)
    .map((record) => ({
      // P2-Fix (2026-05-28): undefined-Links vermeiden — Fallback "(unbekannt)"
      // wenn weder plur1bus_id noch id gesetzt ist, damit Renderer kein
      // "[[undefined]]" oder "()" produziert.
      id: `link-${record.plur1bus_id || record.id || "unbekannt"}`,
      file: record.path || "(unbekannt)",
      text: record.title || record.summary,
      target: record.plur1bus_id || record.id || "(unbekannt)",
      confidence: 0.75,
      risk: "low",
      status: "pending",
    }));
  const md = [
    "# PLUR1BUS Link Suggestions",
    "",
    "Suggestions only. Human-authored notes are not edited automatically.",
    "",
    suggestions.length
      ? suggestions.map((item) => `- ${item.status}: ${item.text} -> [[${item.target || "(unbekannt)"}]] (${item.file || "(unbekannt)"})`).join("\n")
      : "- No suggestions generated.",
    "",
  ].join("\n");
  atomicWriteText(resolveReviewPath(rawConfig, "link-suggestions.md").targetPath, md);
  atomicWriteText(resolveReviewPath(rawConfig, "link-suggestions.jsonl").targetPath, suggestions.map((item) => JSON.stringify(item)).join("\n") + (suggestions.length ? "\n" : ""));
  return { ok: true, suggestions, generated: ["link-suggestions.md", "link-suggestions.jsonl"] };
}

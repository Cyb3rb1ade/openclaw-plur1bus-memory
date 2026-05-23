import { atomicWriteText, resolveReviewPath } from "./safe-paths.js";

export function generateLinkSuggestions(rawConfig, options = {}) {
  const records = options.records || [];
  const suggestions = records
    .filter((record) => record.title || record.summary)
    .slice(0, 100)
    .map((record) => ({
      id: `link-${record.plur1bus_id || record.id}`,
      file: record.path || "",
      text: record.title || record.summary,
      target: record.plur1bus_id || record.id,
      confidence: 0.75,
      risk: "low",
      status: "pending",
    }));
  const md = [
    "# PLUR1BUS Link Suggestions",
    "",
    "Suggestions only. Human-authored notes are not edited automatically.",
    "",
    suggestions.length ? suggestions.map((item) => `- ${item.status}: ${item.text} -> [[${item.target}]] (${item.file})`).join("\n") : "- No suggestions generated.",
    "",
  ].join("\n");
  atomicWriteText(resolveReviewPath(rawConfig, "link-suggestions.md").targetPath, md);
  atomicWriteText(resolveReviewPath(rawConfig, "link-suggestions.jsonl").targetPath, suggestions.map((item) => JSON.stringify(item)).join("\n") + (suggestions.length ? "\n" : ""));
  return { ok: true, suggestions, generated: ["link-suggestions.md", "link-suggestions.jsonl"] };
}


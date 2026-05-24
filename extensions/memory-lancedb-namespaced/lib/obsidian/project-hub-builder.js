import { existsSync, readFileSync } from "node:fs";

import { formatFrontmatter, parseFrontmatter } from "./frontmatter.js";
import { buildManagedBlock, replaceManagedBlock } from "./managed-blocks.js";
import { buildRecordIndex } from "./record-index.js";
import { atomicWriteText, resolveReviewPath, safeSlug } from "./safe-paths.js";

function section(title, rows) {
  return [`## ${title}`, "", rows.length ? rows.map((row) => `- ${row}`).join("\n") : "- None generated.", ""].join("\n");
}

export function buildProjectHub(rawConfig, topic, options = {}) {
  const slug = safeSlug(topic, "project");
  const index = buildRecordIndex(rawConfig, options);
  const related = index.records.filter((record) => JSON.stringify(record).toLowerCase().includes(String(topic).toLowerCase()));
  const files = {
    "index.md": [
      `# Project: ${topic}`,
      "",
      section("Health", [`Open records: ${related.length}`, "Dashboard artifact only; not memory truth."]),
      section("Current Goal", [options.goal || "Pending user review."]),
    ].join("\n"),
    "decisions.md": section("Decisions", related.filter((r) => r.plur1bus_type === "decision").map((r) => `${r.plur1bus_id}: ${r.status}`)),
    "timeline.md": section("Timeline", related.map((r) => `${r.updatedAt || r.createdAt}: ${r.plur1bus_id}`)),
    "open-questions.md": section("Open Questions", related.filter((r) => /question|pending/.test(`${r.status} ${r.summary || ""}`)).map((r) => r.plur1bus_id)),
    "sources.md": section("Sources", related.flatMap((r) => r.sourceRefs || [])),
    "tasks.md": section("Tasks", related.filter((r) => r.plur1bus_type === "task").map((r) => r.plur1bus_id)),
    "conflicts.md": section("Conflicts", related.filter((r) => /conflict/.test(r.plur1bus_type || "")).map((r) => r.plur1bus_id)),
    "stale-assumptions.md": section("Stale Assumptions", related.filter((r) => r.staleAfter && Date.parse(r.staleAfter) < Date.now()).map((r) => r.plur1bus_id)),
  };
  const generated = [];
  for (const [file, body] of Object.entries(files)) {
    const rel = `project-hubs/${slug}/${file}`;
    const { targetPath } = resolveReviewPath(rawConfig, rel);
    const blockId = `project-hub-${slug}-${file.replace(/\.md$/, "")}`;
    if (existsSync(targetPath)) {
      const existing = readFileSync(targetPath, "utf8");
      const parsed = parseFrontmatter(existing);
      const replaced = replaceManagedBlock(parsed.body, { id: blockId, body, version: "4.1.0" });
      if (!replaced.conflict) {
        atomicWriteText(targetPath, formatFrontmatter({ ...parsed.frontmatter, plur1bus_type: "project_hub", project: slug, authoritative: false }, replaced.content));
      }
    } else {
      const block = buildManagedBlock({ id: blockId, body, version: "4.1.0" });
      atomicWriteText(targetPath, formatFrontmatter({ plur1bus_type: "project_hub", project: slug, authoritative: false }, block));
    }
    generated.push(rel);
  }
  return { ok: true, topic, slug, generated };
}

export { replaceManagedBlock };

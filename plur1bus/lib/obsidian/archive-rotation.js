import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveReviewPath } from "./safe-paths.js";

export function findArchiveCandidates(rawConfig, options = {}) {
  const days = Number(options.archiveAfterDays ?? rawConfig.deepMaintenance?.archiveAfterDays ?? 30);
  const cutoff = Date.now() - days * 86400000;
  const dirs = ["review-bundles", "conflicts", "weekly"];
  const candidates = [];
  const { reviewPath } = resolveReviewPath(rawConfig, ".");
  for (const dir of dirs) {
    const abs = join(reviewPath, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = join(abs, entry.name);
      const st = statSync(file);
      if (st.mtimeMs < cutoff) candidates.push({ path: `${dir}/${entry.name}`, ageDays: Math.floor((Date.now() - st.mtimeMs) / 86400000), action: "archive_proposal" });
    }
  }
  return candidates;
}


import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWeeklySynthesis } from "../lib/obsidian/weekly-synthesis.js";
import { confirmedObsidianPolicy } from "./helpers/obsidian-mutation-policy.js";

describe("weekly synthesis index", () => {
  it("preserves previous week links when generating a later synthesis", () => {
    const vault = mkdtempSync(join(tmpdir(), "plur1bus-weekly-index-"));

    try {
      const config = { vaultPath: vault };
      const mutationPolicy = confirmedObsidianPolicy({
        baseDbPath: vault,
        command: ["weekly", "build"],
      });
      buildWeeklySynthesis(config, { week: "2026-W25", records: [], mutationPolicy });
      buildWeeklySynthesis(config, { week: "2026-W26", records: [], mutationPolicy });

      const index = readFileSync(join(vault, "plur1bus", "weekly", "index.md"), "utf8");
      assert.match(index, /\[\[2026-W25\]\]/);
      assert.match(index, /\[\[2026-W26\]\]/);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

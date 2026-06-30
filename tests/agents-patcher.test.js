import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert";
import { patchAgentsMd } from "../lib/install/agents-patcher.js";

describe("patchAgentsMd", () => {
  it("replaces legacy pseudo tool-call examples with real tool-use guidance", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-agents-patcher-"));
    const target = join(dir, "AGENTS.md");
    writeFileSync(target, [
      "# AGENTS",
      "",
      "**WIE speichern:**",
      "```",
      "memory_store:0{\"text\":\"Christian bevorzugt Xiaomi-Produkte\",\"category\":\"preference\",\"importance\":0.7}",
      "```",
      "",
    ].join("\n"), "utf8");

    const result = patchAgentsMd(target, { backup: false });
    const next = readFileSync(target, "utf8");

    assert.equal(result.changed, true);
    assert.doesNotMatch(next, /memory_store:0/);
    assert.match(next, /actual `memory_store` tool/);
    assert.match(next, /Never print legacy text-form tool calls/);
  });
});

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

describe("telegram reaction rules block", () => {
  it("appends the managed telegram reaction rules when a reactions section exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-agents-patcher-"));
    const target = join(dir, "AGENTS.md");
    writeFileSync(target, "# AGENTS\n\n### 😊 React Like a Human!\n\nUse emoji reactions naturally (👍, 😂).\n", "utf8");

    const result = patchAgentsMd(target, { backup: false });
    const next = readFileSync(target, "utf8");

    assert.equal(result.changed, true);
    assert.match(next, /plur1bus:telegram-reaction-rules/);
    assert.match(next, /REACTION_INVALID/);
    assert.match(next, /Conversation info \(untrusted metadata\)/);
  });

  it("is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-agents-patcher-"));
    const target = join(dir, "AGENTS.md");
    writeFileSync(target, "# A\n\nEmoji-Reactions: ack without text.\n", "utf8");
    patchAgentsMd(target, { backup: false });
    const once = readFileSync(target, "utf8");
    const second = patchAgentsMd(target, { backup: false });
    assert.equal(second.changed, false);
    assert.equal(readFileSync(target, "utf8"), once);
  });

  it("does not touch files without any reaction guidance", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-agents-patcher-"));
    const target = join(dir, "AGENTS.md");
    writeFileSync(target, "# AGENTS\n\nNo emoji guidance here.\n", "utf8");
    const result = patchAgentsMd(target, { backup: false });
    assert.equal(result.changed, false);
  });
});

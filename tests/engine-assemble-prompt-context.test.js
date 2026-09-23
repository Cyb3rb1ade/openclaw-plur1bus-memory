/**
 * tests/engine-assemble-prompt-context.test.js — PR-03d.
 *
 * The engine module must be constructible from a plain context object with no
 * OpenClaw api in it, and its refusal paths must stay refusals. Recall content
 * is covered byte for byte by tests/golden-prefix.test.js.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPromptContextAssembler } from "../engine/recall/assemble-prompt-context.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("engine/recall/assemble-prompt-context", () => {
  it("exports a factory", () => {
    assert.equal(typeof createPromptContextAssembler, "function");
  });

  it("does not mention the OpenClaw api surface", () => {
    const source = readFileSync(join(root, "engine", "recall", "assemble-prompt-context.js"), "utf8");
    assert.doesNotMatch(source, /(?<![.\w$/-])api\s*\./);
  });

  it("keeps the six named blocks and the 17000-char default in one place", () => {
    const source = readFileSync(join(root, "engine", "recall", "assemble-prompt-context.js"), "utf8");
    for (const name of ["neo", "start", "memories", "time", "temporal", "reminder"]) {
      assert.match(source, new RegExp(`name:\\s*"${name}"`), `block ${name} must survive the move`);
    }
    assert.match(source, /globalInjectMaxChars \?\? 17_000/);
    assert.match(source, /\{ name: "time", text: timeContext, droppable: false \}/);
    assert.match(source, /\{ name: "reminder", text: reminderNudge, droppable: false \}/);
  });

  it("refuses a turn the workspace policy declines, without touching the pool", async () => {
    // The context object is destructured eagerly by the factory (so every
    // binding the 1 067 moved lines close over resolves once, at registration
    // time), which is why "touching the pool" is measured at the first DB call
    // rather than at the property read.
    let poolTouched = false;
    const handler = createPromptContextAssembler({
      automaticWorkspacePolicyDecision: () => ({ allowed: false }),
      pool: { withDb: async () => { poolTouched = true; return undefined; } },
    });
    assert.equal(await handler({ prompt: "x" }, { workspaceDir: "/tmp/ws", agentId: "a" }), undefined);
    assert.equal(poolTouched, false);
  });
});

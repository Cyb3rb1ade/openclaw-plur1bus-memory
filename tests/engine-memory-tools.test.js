/**
 * tests/engine-memory-tools.test.js — PR-03h.
 *
 * The five model-facing tools are a published contract
 * (openclaw.plugin.json contracts.tools), and the destructive-op gate is a
 * security boundary: a model-facing call carries no user-bound authorization.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMemoryTools } from "../engine/tools/memory-tools.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "engine", "tools", "memory-tools.js"), "utf8");

describe("engine/tools/memory-tools", () => {
  it("exports a factory", () => {
    assert.equal(typeof createMemoryTools, "function");
  });

  it("does not mention the OpenClaw api surface", () => {
    assert.doesNotMatch(source, /(?<![.\w$/-])api\s*\./);
  });

  it("keeps all five model-facing tool names", () => {
    for (const name of ["memory_recall", "memory_search", "memory_store", "memory_forget", "knowledge_update"]) {
      assert.match(source, new RegExp(`"${name}"`), `${name} must survive the move`);
    }
  });

  it("keeps the destructive-op gate and its default", () => {
    assert.match(source, /allowModelDestructiveMemoryOps !== false/);
    assert.match(source, /do not carry a user-bound authorization context/);
  });
});

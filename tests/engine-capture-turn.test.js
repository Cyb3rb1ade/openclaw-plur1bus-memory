/**
 * tests/engine-capture-turn.test.js — PR-03e.
 *
 * Capture's fail-closed incognito classification and its shared
 * meta-reflection state are the two things a move can quietly break.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTurnCapture } from "../engine/capture/capture-turn.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("engine/capture/capture-turn", () => {
  it("exports a factory", () => {
    assert.equal(typeof createTurnCapture, "function");
  });

  it("does not mention the OpenClaw api surface", () => {
    const source = readFileSync(join(root, "engine", "capture", "capture-turn.js"), "utf8");
    assert.doesNotMatch(source, /(?<![.\w$/-])api\s*\./);
  });

  it("reads and writes the meta-reflection counters through the shared object", () => {
    const source = readFileSync(join(root, "engine", "capture", "capture-turn.js"), "utf8");
    assert.match(source, /metaReflectionState\.sessionCount/);
    assert.match(source, /metaReflectionState\.lastAt/);
    assert.doesNotMatch(source, /\blet\s+sessionCountSinceReflection\b/);
  });

  it("keeps the fail-closed incognito classification first", () => {
    const source = readFileSync(join(root, "engine", "capture", "capture-turn.js"), "utf8");
    const body = source.slice(source.indexOf("return async function"));
    const incognitoAt = body.indexOf("classifyHostIncognitoSession");
    const poolAt = body.indexOf("pool.");
    assert.ok(incognitoAt >= 0, "incognito classification must survive the move");
    assert.ok(poolAt === -1 || incognitoAt < poolAt, "classification must run before any store access");
  });
});

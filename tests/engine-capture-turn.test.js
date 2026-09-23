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

import { classifyLightDreamOutcome, createLightDreamLedgerWarnOnce, createTurnCapture } from "../engine/capture/capture-turn.js";

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

  // ---- Fix round 1: ledger_unwritable is a skipped dream, not a failure ----

  it("routes the light-dream JobRun outcome through classifyLightDreamOutcome and the warn-once latch (fix round 1)", () => {
    const source = readFileSync(join(root, "engine", "capture", "capture-turn.js"), "utf8");
    assert.match(source, /classifyLightDreamOutcome\(dreamRun\)/);
    assert.match(source, /warnLightDreamLedgerUnwritable\(agentId\)/);
  });
});

describe("classifyLightDreamOutcome (fix round 1)", () => {
  it("advances the watermark for a completed dream with no warning", () => {
    assert.deepEqual(classifyLightDreamOutcome({ outcome: "completed" }), { advance: true, warnKind: null });
  });

  it("advances the watermark for an unwritable-ledger failure, flagged for a one-time warning", () => {
    assert.deepEqual(
      classifyLightDreamOutcome({ outcome: "failed", reason: "ledger_unwritable" }),
      { advance: true, warnKind: "ledger_unwritable" },
    );
  });

  it("holds the watermark for any other failure and warns every time", () => {
    assert.deepEqual(
      classifyLightDreamOutcome({ outcome: "failed", reason: "error:TypeError" }),
      { advance: false, warnKind: "failed" },
    );
  });

  it("holds the watermark for a non-completed, non-failed outcome without warning", () => {
    assert.deepEqual(classifyLightDreamOutcome({ outcome: "skipped", reason: "no_turns" }), { advance: false, warnKind: null });
  });
});

describe("createLightDreamLedgerWarnOnce (fix round 1)", () => {
  it("warns exactly once per agent across repeated calls, and separately per other agent", () => {
    const warned = [];
    const warn = createLightDreamLedgerWarnOnce({ warn: (m) => warned.push(m) });
    warn("agent-a");
    warn("agent-a");
    warn("agent-a");
    warn("agent-b");
    assert.equal(warned.length, 2);
    assert.match(warned[0], /agent-a/);
    assert.match(warned[1], /agent-b/);
  });
});

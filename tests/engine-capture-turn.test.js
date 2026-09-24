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

import { classifyLightDreamOutcome, createLightDreamLedgerWarnOnce, createTurnCapture, lightDreamIdentity } from "../engine/capture/capture-turn.js";

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

describe("lightDreamIdentity (final review I3)", () => {
  const user = `user:v1:${"d".repeat(64)}`;

  it("writes a proved user's light-dream insight at user scope from the caller's memory context", () => {
    let fallbackCalls = 0;
    const memoryCtx = { agentId: "agent-a", workspaceIdentity: "workspace:v1:main", userPrincipal: user, trust: "proved" };
    const { requestContext, aclBindings } = lightDreamIdentity(memoryCtx, () => { fallbackCalls += 1; return { agentId: "agent-a", workspaceIdentity: "workspace:v1:main", userPrincipal: "" }; });
    assert.equal(requestContext, memoryCtx);
    assert.deepEqual(aclBindings, { scope: "user", agentId: "agent-a", workspaceIdentity: "", ownerUserId: user });
    assert.equal(fallbackCalls, 0, "the hook context is not re-resolved");
  });

  it("keeps the adapter path: without a memory context the hook context is resolved (workspace scope without a user)", () => {
    const { aclBindings } = lightDreamIdentity(undefined, () => ({ agentId: "agent-a", workspaceIdentity: "workspace:v1:main", userPrincipal: "" }));
    assert.deepEqual(aclBindings, { scope: "workspace", agentId: "agent-a", workspaceIdentity: "workspace:v1:main", ownerUserId: "" });
    assert.deepEqual(lightDreamIdentity(null, () => { throw new Error("bad"); }), { requestContext: null, aclBindings: null });
  });

  it("captureTurn hands opts.memoryCtx to lightDreamIdentity", () => {
    const source = readFileSync(join(root, "engine", "capture", "capture-turn.js"), "utf8");
    assert.match(source, /lightDreamIdentity\(opts\.memoryCtx,/);
  });
});

describe("captureTurn incognito classification on the Engine path (final review I2)", () => {
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const failingClassifier = async () => { throw new Error("host routing unavailable"); };

  it("an unclassifiable keyed turn from an Engine caller says why", async () => {
    const captureTurn = createTurnCapture({ host: { logger: quiet }, classifyHostIncognitoSession: failingClassifier });
    const outcome = await captureTurn({ sessionKey: "agent:a:main", messages: [] }, { agentId: "a" }, { memoryCtx: { agentId: "a" } });
    assert.deepEqual(outcome, { ok: false, reason: "incognito-unclassifiable" });
  });

  it("the adapter path still returns undefined for an unclassifiable turn", async () => {
    const captureTurn = createTurnCapture({ host: { logger: quiet }, classifyHostIncognitoSession: failingClassifier });
    assert.equal(await captureTurn({ sessionKey: "agent:a:main", messages: [] }, { agentId: "a" }), undefined);
  });

  it("a host-classified turn never consults the routing classifier", async () => {
    let calls = 0;
    const captureTurn = createTurnCapture({
      host: { logger: quiet },
      classifyHostIncognitoSession: async () => { calls += 1; return false; },
      workspacePolicyGuard: { automatic: () => ({ allowed: false }) },
    });
    await captureTurn({ sessionKey: "agent:a:main", messages: [] }, { agentId: "a" }, { memoryCtx: { agentId: "a" }, agentContext: { origin: "user", background: false }, incognitoClassified: true });
    assert.equal(calls, 0);
  });
});

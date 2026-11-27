/**
 * tests/light-dream-binding-7211.test.js — 7.21.1: acl.user.missing_principal.
 *
 * Production, 24.11.2026: recalls in Christian's threaded Telegram DM ran
 * with "authenticated=no" and denied light-dream rows (scope "user", owner =
 * his principal) with acl.user.missing_principal. The capture had bound those
 * dreams to the hook's raw sender id, which the recall could not prove.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { lightDreamIdentity } from "../engine/capture/capture-turn.js";
import { postTurnContext } from "../engine/capture/post-turn-work.js";
import { createProvedTurnPrincipals } from "../adapter/openclaw/proved-turn-principals.js";

const user = `user:v1:${"a".repeat(64)}`;
const other = `user:v1:${"b".repeat(64)}`;
const resolved = (userPrincipal) => () => ({ agentId: "main", workspaceIdentity: "workspace:v1:main", userPrincipal });

describe("lightDreamIdentity (adapter path, 7.21.1)", () => {
  it("an unproved sender id no longer binds the dream to a user", () => {
    const { aclBindings, requestContext } = lightDreamIdentity(undefined, resolved(user));
    assert.deepEqual(aclBindings, { scope: "workspace", agentId: "main", workspaceIdentity: "workspace:v1:main", ownerUserId: "" });
    assert.equal(requestContext.userPrincipal, "");
  });

  it("a user the recall proved for this turn keeps the user binding", () => {
    const { aclBindings } = lightDreamIdentity(undefined, resolved(user), { provedUserPrincipal: user });
    assert.deepEqual(aclBindings, { scope: "user", agentId: "main", workspaceIdentity: "", ownerUserId: user });
  });

  it("a proof for a different user does not carry over", () => {
    const { aclBindings } = lightDreamIdentity(undefined, resolved(user), { provedUserPrincipal: other });
    assert.equal(aclBindings.scope, "workspace");
  });

  it("the Engine path (caller-resolved memory context) is unchanged", () => {
    const memoryCtx = { agentId: "main", workspaceIdentity: "workspace:v1:main", userPrincipal: user, trust: "proved" };
    const { aclBindings, requestContext } = lightDreamIdentity(memoryCtx, () => { throw new Error("not called"); });
    assert.equal(requestContext, memoryCtx);
    assert.equal(aclBindings.scope, "user");
  });
});

describe("post-turn queue keeps the proof", () => {
  it("postTurnContext carries provedUserPrincipal (and nothing that is not a string or number)", () => {
    assert.equal(postTurnContext({ senderId: "1", provedUserPrincipal: user }).provedUserPrincipal, user);
    assert.equal(postTurnContext({ senderId: "1", provedUserPrincipal: { forged: true } }).provedUserPrincipal, undefined);
  });
});

describe("createProvedTurnPrincipals", () => {
  const hookCtx = { agentId: "main", sessionKey: "agent:main:telegram:default:direct:1", runId: "run-1" };

  it("hands a proved principal from recall to the capture of the same turn", () => {
    const memo = createProvedTurnPrincipals();
    memo.record({}, hookCtx, { trust: "proved", memoryCtx: { userPrincipal: user } });
    assert.equal(memo.userPrincipalFor({}, hookCtx), user);
    assert.equal(memo.userPrincipalFor({}, { ...hookCtx, runId: "run-2" }), "", "other run");
    assert.equal(memo.userPrincipalFor({}, { ...hookCtx, agentId: "bernhardine" }), "", "other agent");
  });

  it("ignores inferred results, missing keys and expired entries", () => {
    let clock = 0;
    const memo = createProvedTurnPrincipals({ ttlMs: 100, now: () => clock });
    memo.record({}, hookCtx, { trust: "inferred", memoryCtx: { userPrincipal: user } });
    memo.record({}, { agentId: "main" }, { trust: "proved", memoryCtx: { userPrincipal: user } });
    assert.equal(memo.size(), 0);
    memo.record({}, hookCtx, { trust: "proved", memoryCtx: { userPrincipal: user } });
    clock = 150;
    assert.equal(memo.userPrincipalFor({}, hookCtx), "");
  });

  it("is bounded", () => {
    const memo = createProvedTurnPrincipals({ max: 3 });
    for (let i = 0; i < 10; i++) memo.record({}, { ...hookCtx, runId: `r${i}` }, { trust: "proved", memoryCtx: { userPrincipal: user } });
    assert.equal(memo.size(), 3);
    assert.equal(memo.userPrincipalFor({}, { ...hookCtx, runId: "r9" }), user);
    assert.equal(memo.userPrincipalFor({}, { ...hookCtx, runId: "r0" }), "");
  });
});

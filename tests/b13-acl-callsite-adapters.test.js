import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import plugin from "../index.js";
import {
  checkAccess,
  filterMemoriesByAcl,
  resolveOwnershipBindings,
  validateOwnershipTuple,
} from "../lib/acl-middleware.js";
import {
  resolveHostCommandMemoryContext,
  resolveMemoryRequestContext,
} from "../lib/memory-request-context.js";
import { isAuthorized } from "../lib/security.js";

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) {
    return { baseSessionKey: value, threadId: "" };
  },
  normalizeOptionalAccountId(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
  normalizeMessageChannel(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
});

const aliases = Object.freeze({
  paths: Object.freeze([]),
  aliases: Object.freeze([
    { alias: "workspace-a", workspaceKey: "canonical-a" },
    { alias: "legacy-a", workspaceKey: "canonical-a" },
    { alias: "workspace-b", workspaceKey: "canonical-b" },
  ]),
});

describe("B13 strict ownership ACL adapters", () => {
  it("fails closed for unbound and conflicting private/workspace rows", () => {
    assert.equal(checkAccess({ agentId: "agent-a" }, { scope: "agent-private" }).allowed, false);
    assert.equal(checkAccess({ workspaceIdentity: "workspace:v1:ws-a", workspaceAliases: aliases }, { scope: "workspace" }).allowed, false);
    assert.equal(checkAccess({ agentId: "agent-a" }, { scope: "agent-private", agentId: "agent-a", storedBy: "agent-b" }).allowed, false);
    assert.equal(checkAccess(
      { workspaceIdentity: "workspace:v1:canonical-a", workspaceAliases: aliases },
      { scope: "workspace", workspaceId: "workspace-a", workspaceKey: "workspace-b" },
    ).allowed, false);
  });

  it("authorizes only canonical principals, never raw user ids", () => {
    const ctx = resolveMemoryRequestContext({ agentId: "agent-a", channel: "telegram", accountId: "one", userId: "42" });
    assert.equal(checkAccess(ctx, { scope: "user", ownerUserId: ctx.userPrincipal }).allowed, true);
    assert.equal(checkAccess({ ...ctx, userPrincipal: "", userId: ctx.userId }, { scope: "user", ownerUserId: ctx.userId }).allowed, false);
    assert.equal(checkAccess(ctx, { scope: "user", ownerUserId: "42" }).allowed, false);
  });

  it("requires one valid requester agent before authorizing every scope", () => {
    const full = resolveMemoryRequestContext({
      agentId: "agent-a",
      workspaceId: "workspace-a",
      channel: "telegram",
      accountId: "one",
      userId: "42",
    }, { workspaceAliases: aliases });
    const rows = [
      { scope: "agent-private", agentId: "agent-a", storedBy: "agent-a" },
      { scope: "workspace", workspaceId: "workspace-a", workspaceKey: "legacy-a" },
      { scope: "user", ownerUserId: full.userPrincipal },
    ];
    for (const row of rows) {
      assert.equal(checkAccess({ ...full, agentId: "" }, row).allowed, false);
      assert.equal(checkAccess({ ...full, agentId: "../bad" }, row).allowed, false);
    }
  });

  it("canonicalizes legacy workspace aliases independently", () => {
    const ctx = resolveMemoryRequestContext({ agentId: "agent-a", workspaceId: "workspace-a" }, { workspaceAliases: aliases });
    assert.equal(checkAccess(ctx, { scope: "workspace", workspaceKey: "workspace-a" }).allowed, true);
    assert.equal(checkAccess(ctx, { scope: "workspace", workspaceId: "workspace-a", workspaceKey: "legacy-a" }).allowed, true);
    assert.deepEqual(resolveOwnershipBindings({ workspaceKey: "unmapped" }, aliases).workspaceIdentity, "workspace:v1:unmapped");
    assert.equal(validateOwnershipTuple({ workspaceId: "workspace-a", workspaceKey: "workspace-b" }, aliases).ok, false);
  });

  it("authorizes bound legacy rows through storedBy and workspaceKey fallbacks", () => {
    const ctx = resolveMemoryRequestContext({
      agentId: "agent-a",
      workspaceId: "workspace-a",
    }, { workspaceAliases: aliases });

    assert.deepEqual(checkAccess(ctx, {
      scope: "agent-private",
      storedBy: "agent-a",
    }), { allowed: true });
    assert.deepEqual(checkAccess(ctx, {
      scope: "workspace",
      workspaceKey: "legacy-a",
    }), { allowed: true });
  });

  it("denies unbound legacy rows instead of inferring requester ownership", () => {
    const ctx = resolveMemoryRequestContext({
      agentId: "agent-a",
      workspaceId: "workspace-a",
    }, { workspaceAliases: aliases });

    assert.deepEqual(checkAccess(ctx, {
      scope: "agent-private",
      storedBy: "",
    }), { allowed: false, reason: "acl.agent_private.missing_owner" });
    assert.deepEqual(checkAccess(ctx, {
      scope: "workspace",
      workspaceKey: "",
    }), { allowed: false, reason: "acl.workspace.missing_workspace" });
  });

  it("applies the request workspace grammar and suffix limits to stored ACL bindings", () => {
    const maxKey = `workspace:v1:${"k".repeat(128)}`;
    const maxDir = `workspace-dir:v1:${"d".repeat(1024)}`;
    for (const workspaceIdentity of [maxKey, maxDir]) {
      const ctx = resolveMemoryRequestContext({ agentId: "agent-a", workspaceId: workspaceIdentity });
      assert.equal(checkAccess(ctx, {
        scope: "workspace",
        workspaceId: workspaceIdentity,
        workspaceKey: workspaceIdentity,
      }).allowed, true);
    }
    const ctx = { agentId: "agent-a", workspaceIdentity: maxKey, workspaceAliases: aliases };
    for (const invalid of [
      "workspace:v1:workspace:v1:nested",
      "workspace:v1:workspace-dir:v1:nested",
      "workspace-dir:v1:workspace:v1:nested",
      "workspace-dir:v1:workspace-dir:v1:nested",
      `workspace:v1:${"k".repeat(129)}`,
      `workspace-dir:v1:${"d".repeat(1025)}`,
      "workspace:v1:",
      "workspace-dir:v1:",
      "workspace:v2:value",
      "workspace-dir:v2:value",
    ]) {
      const result = checkAccess(ctx, { scope: "workspace", workspaceId: invalid, workspaceKey: invalid });
      assert.equal(result.allowed, false, invalid);
      assert.equal(result.reason, "acl.workspace.invalid_binding", invalid);
    }
    for (const invalid of [{}, false, true, 0, NaN, Infinity]) {
      assert.equal(validateOwnershipTuple({ workspaceId: invalid }, aliases).ok, false, String(invalid));
    }
    const canonicalKey = "workspace:v1:x";
    const remappingAliases = Object.freeze({
      paths: Object.freeze([]),
      aliases: Object.freeze([{ alias: canonicalKey, workspaceKey: "other" }]),
    });
    assert.equal(resolveMemoryRequestContext({ agentId: "agent-a", workspaceId: canonicalKey }, {
      workspaceAliases: remappingAliases,
    }).workspaceIdentity, canonicalKey, "canonical principals must bypass legacy aliases");
  });

  it("authorizes registered destructive commands from the frozen official host context", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-command-auth-ws-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const officialCtx = {
      args: "",
      agentId: "agent-a",
      senderId: "owner-user",
      channel: "telegram",
      accountId: "default",
      sessionKey: "agent:agent-a:main",
      from: "telegram:owner-chat",
      to: "telegram:owner-chat",
      getCurrentConversationBinding: () => null,
    };
    const resolve = (ctx) => resolveHostCommandMemoryContext(ctx, {
      resolveAgentWorkspaceDir: async () => workspaceDir,
      routingLoader: async () => routingCapability,
      requireConversation: true,
    });
    const memoryCtx = await resolve(officialCtx);
    assert.equal(Object.isFrozen(memoryCtx), true);
    assert.deepEqual({ userId: memoryCtx.userId, chatId: memoryCtx.chatId, chatKind: memoryCtx.chatKind }, {
      userId: "owner-user", chatId: "owner-chat", chatKind: "private",
    });
    assert.equal(isAuthorized(memoryCtx, {}, { destructive: true, chatKind: memoryCtx.chatKind }).authorized, true);
    assert.equal(isAuthorized(memoryCtx, {
      security: { allowedUserIds: ["owner-user"], allowedChatIds: ["owner-chat"] },
    }, { destructive: true, chatKind: memoryCtx.chatKind }).authorized, true);
    assert.equal(isAuthorized(memoryCtx, {
      security: { allowedUserIds: ["owner-user"], allowedChatIds: ["other-chat"] },
    }, { destructive: true, chatKind: memoryCtx.chatKind }).authorized, false);

    const adversarial = await resolve({ ...officialCtx, userId: "attacker", chatId: "attacker-chat", chatType: "group" });
    assert.deepEqual({ userId: adversarial.userId, chatId: adversarial.chatId, chatKind: adversarial.chatKind }, {
      userId: "owner-user", chatId: "owner-chat", chatKind: "private",
    });
    const group = await resolve({
      ...officialCtx,
      sessionKey: "agent:agent-a:telegram:group:owner-chat",
      from: "telegram:group:owner-chat",
      to: "telegram:group:owner-chat",
    });
    assert.equal(isAuthorized(group, {}, { destructive: true, chatKind: group.chatKind }).authorized, false);

    let workspaceReads = 0;
    await assert.rejects(() => resolveHostCommandMemoryContext({ ...officialCtx, agentId: undefined }, {
      resolveAgentWorkspaceDir: async () => { workspaceReads++; return workspaceDir; },
      routingLoader: async () => routingCapability,
      requireConversation: true,
    }), /agentId is required/);
    assert.equal(workspaceReads, 0);

    const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    assert.match(indexSource, /const auth = isAuthorized\(memoryCtx, cfg, \{ \.\.\.opts, chatKind: memoryCtx\.chatKind \}\)/);
    assert.doesNotMatch(indexSource, /const denied = checkAuth\(/);
    assert.match(indexSource, /const denied = await checkAuth\(commandCtx, \{ destructive: true \}\)/);
    assert.equal([...indexSource.matchAll(/const denied = await checkAuth\(commandCtx, \{ destructive: true \}\)/g)].length, 14);
    assert.match(indexSource, /const memoryCtx = await resolveRegisteredMemoryContext\(commandCtx\);\s+const denied = checkMemoryAuth\(memoryCtx, commandCtx, \{ destructive: true \}\)/);
  });

  it("rejects malformed snapshots and unknown/internal scopes", () => {
    const ctx = { agentId: "agent-a", workspaceIdentity: "workspace:v1:canonical-a", workspaceAliases: {} };
    assert.equal(checkAccess(ctx, { scope: "workspace", workspaceKey: "workspace-a" }).allowed, false);
    assert.equal(checkAccess(ctx, { scope: "workspace_shared", workspaceKey: "workspace-a" }).reason, "acl.unknown_scope");
  });

  it("filters each scope using the same immutable ownership context", () => {
    const ctx = resolveMemoryRequestContext({
      agentId: "agent-a", workspaceId: "workspace-a", channel: "telegram", accountId: "one", userId: "42",
    }, { workspaceAliases: aliases });
    const rows = [
      { id: "private", scope: "agent-private", agentId: "agent-a", storedBy: "agent-a" },
      { id: "workspace", scope: "workspace", workspaceId: "workspace-a", workspaceKey: "legacy-a" },
      { id: "user", scope: "user", ownerUserId: ctx.userPrincipal },
      { id: "foreign", scope: "agent-private", agentId: "agent-b", storedBy: "agent-b" },
    ];
    assert.deepEqual(filterMemoriesByAcl(ctx, rows).map((row) => row.id), ["private", "workspace", "user"]);
  });

  it("registers the passive identity bridge only for autoRecall and never message_received", async (t) => {
    const makeApi = (autoRecall) => {
      const baseDbPath = mkdtempSync(join(tmpdir(), `plur1bus-b13-register-${autoRecall}-`));
      t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
      const hooks = [];
      const api = {
        pluginConfig: {
          baseDbPath,
          embedding: { provider: "local-transformers", local: { dimensions: 384 } },
          merging: { enabled: false },
          emotion: { t3: { enabled: false } },
          obsidianBridge: { enabled: false },
          autoCapture: false,
          autoRecall,
          replyOutcomeTracking: { enabled: false },
          neo: { enabled: false },
          gc: { enabled: false },
          featureCronSetup: { auto: false },
        },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        resolvePath: (value) => value,
        registerCommand() {},
        registerTool() {},
        registerService() {},
        on(name, handler, options) { hooks.push({ name, handler, options }); },
      };
      plugin.register(api);
      return hooks;
    };

    const disabled = makeApi(false);
    assert.equal(disabled.some((hook) => hook.name === "reply_dispatch"), false);
    const enabled = makeApi(true);
    const dispatch = enabled.filter((hook) => hook.name === "reply_dispatch");
    assert.equal(dispatch.length, 1);
    assert.equal(dispatch[0].options.priority, Number.MIN_SAFE_INTEGER);
    const sideEffects = { processed: 0, idle: 0, dispatched: 0 };
    const result = await dispatch[0].handler({ ctx: {} }, {
      recordProcessed() { sideEffects.processed++; },
      markIdle() { sideEffects.idle++; },
      dispatcher: { dispatch() { sideEffects.dispatched++; } },
    });
    assert.equal(result, undefined);
    assert.deepEqual(sideEffects, { processed: 0, idle: 0, dispatched: 0 });
    assert.ok(enabled.some((hook) => hook.name === "before_prompt_build"));
    assert.ok(enabled.some((hook) => hook.name === "agent_end"));
    const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /api\.on\(["']message_received["']/);
  });

  it("threads the canonical context through every current ACL adapter family", () => {
    const sources = Object.fromEntries([
      "db-adapter.js",
      "wiki-command.js",
      "telegram-commands/memory-edit.js",
      "telegram-commands/memory-query.js",
      "recall-pipeline.js",
    ].map((path) => [path, readFileSync(new URL(`../lib/${path}`, import.meta.url), "utf8")]));
    assert.match(sources["db-adapter.js"], /checkAccess\(queryOpts\.ctx, card\)/);
    assert.match(sources["db-adapter.js"], /checkAccess\(searchOpts\.ctx, card\)/);
    assert.match(sources["wiki-command.js"], /checkAccess\(ctx, result\?\.entry \|\| result\)/);
    assert.match(sources["telegram-commands/memory-edit.js"], /checkAccess\(opts\.ctx, card\)/);
    assert.match(sources["telegram-commands/memory-query.js"], /filterMemoriesByAcl\(ctx, results\)/);
    assert.match(sources["recall-pipeline.js"], /checkAccess\(aclCtx, r\.entry\)/);

    const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    assert.match(indexSource, /const memoryCtx = await resolveRegisteredMemoryContext\(commandCtx\)/);
    assert.match(indexSource, /const storeAccessCtx = memoryCtx/);
    assert.match(indexSource, /memoryCtx,\s*decisionTrace:/);
    assert.doesNotMatch(indexSource, /checkAccess\(\{\s*agentId,\s*workspaceId/);
  });
});

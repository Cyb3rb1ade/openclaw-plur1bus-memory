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
import { resolveMemoryRequestContext } from "../lib/memory-request-context.js";

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

  it("canonicalizes legacy workspace aliases independently", () => {
    const ctx = resolveMemoryRequestContext({ agentId: "agent-a", workspaceId: "workspace-a" }, { workspaceAliases: aliases });
    assert.equal(checkAccess(ctx, { scope: "workspace", workspaceKey: "workspace-a" }).allowed, true);
    assert.equal(checkAccess(ctx, { scope: "workspace", workspaceId: "workspace-a", workspaceKey: "legacy-a" }).allowed, true);
    assert.deepEqual(resolveOwnershipBindings({ workspaceKey: "unmapped" }, aliases).workspaceIdentity, "workspace:v1:unmapped");
    assert.equal(validateOwnershipTuple({ workspaceId: "workspace-a", workspaceKey: "workspace-b" }, aliases).ok, false);
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

  it("registers the passive identity bridge only for autoRecall and never message_received", (t) => {
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

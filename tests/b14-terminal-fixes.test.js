import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import plugin from "../index.js";
import {
  createObsidianBridgeService,
} from "../lib/obsidian-bridge.js";
import {
  handleObsidianBridgeCommand,
} from "../lib/obsidian-control-room.js";
import {
  parseObsidianCommandPlan,
} from "../lib/obsidian-mutation-policy.js";
import {
  createOwnedReviewBundle,
  loadOwnedReviewBundle,
} from "../lib/obsidian-review-authority.js";
import {
  recordOwnedVaultConfirmation,
} from "../lib/obsidian-vault-authority.js";
import { confirmedObsidianPolicy } from "./helpers/obsidian-mutation-policy.js";

const aliases = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) });

function memoryCtx(overrides = {}) {
  return {
    agentId: "agent-a",
    workspaceIdentity: "workspace:v1:workspace-a",
    workspaceId: "workspace:v1:workspace-a",
    userId: "owner",
    userPrincipal: "user:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    conversationPrincipal: "conversation:v1:owner-chat",
    chatId: "owner-chat",
    chatKind: "private",
    workspaceAliases: aliases,
    ...overrides,
  };
}

function commandContext({ baseDbPath, config, ctx = memoryCtx(), overrides = {} }) {
  return {
    config,
    baseDbPath,
    memoryCtx: ctx,
    commandCtx: {
      agentId: ctx.agentId,
      userId: ctx.userId,
      senderId: ctx.userId,
      chatId: ctx.chatId,
      chatType: "private",
      chatKind: "private",
    },
    pluginConfig: {
      baseDbPath,
      security: { allowedUserIds: ["owner"] },
    },
    ...overrides,
  };
}

function treeSnapshot(root) {
  const output = {};
  const walk = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stats = statSync(path);
      output[rel] = {
        type: entry.isDirectory() ? "dir" : "file",
        mtimeMs: stats.mtimeMs,
        content: entry.isFile() ? readFileSync(path, "utf8") : null,
      };
      if (entry.isDirectory()) walk(path, rel);
    }
  };
  walk(root);
  return output;
}

describe("B14 terminal selector binding", () => {
  it("canonicalizes matching selectors and rejects workspace-A to workspace-B scope changes", () => {
    const same = parseObsidianCommandPlan(
      ["init", "workspaces", "--agent", "agent-a", "--workspace", "workspace-a"],
      {
        memoryCtx: memoryCtx(),
        mode: "apply",
        allowWrite: true,
        vaultConfirmed: true,
        baseDbPath: "/tmp/base",
      },
    );
    assert.deepEqual(same.selectors, {
      agentId: "agent-a",
      workspaceIdentity: "workspace:v1:workspace-a",
    });
    assert.equal(Object.isFrozen(same.selectors), true);
    assert.throws(
      () => parseObsidianCommandPlan(
        ["init", "workspaces", "--workspace", "workspace-b"],
        {
          memoryCtx: memoryCtx(),
          mode: "apply",
          allowWrite: true,
          vaultConfirmed: true,
          baseDbPath: "/tmp/base",
        },
      ),
      /selector.*scope|scope.*selector/i,
    );
  });

  it("denies a cross-scope init target and retains exact-scope init writes", async () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "b14-selector-db-"));
    const vaultA = mkdtempSync(join(tmpdir(), "b14-selector-a-"));
    const vaultB = mkdtempSync(join(tmpdir(), "b14-selector-b-"));
    const config = {
      mode: "apply",
      allowWrite: true,
      workspaces: [
        { workspace_id: "workspace-a", agent_id: "agent-a", path: vaultA },
        { workspace_id: "workspace-b", agent_id: "agent-b", path: vaultB },
      ],
    };
    recordOwnedVaultConfirmation({
      baseDbPath,
      memoryCtx: memoryCtx(),
      vaultPath: vaultA,
      confirmationValidated: true,
      confirmationNonce: randomUUID(),
    });

    const denied = await handleObsidianBridgeCommand(
      ["init", "workspaces", "--workspace", "workspace-b"],
      commandContext({ baseDbPath, config, overrides: { vaultConfirmed: true } }),
    );
    assert.match(denied.text, /selector.*scope|scope.*selector/i);
    assert.equal(existsSync(join(vaultB, "memory", "cards")), false);

    const allowed = await handleObsidianBridgeCommand(
      ["init", "workspaces", "--workspace", "workspace-a"],
      commandContext({ baseDbPath, config, overrides: { vaultConfirmed: true } }),
    );
    assert.doesNotMatch(allowed.text, /denied|error/i);
    assert.equal(existsSync(join(vaultA, "memory", "cards")), true);
  });

  it("validates every same-scope vault policy before a multi-target init writes", async () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "b14-multi-init-db-"));
    const vaultOne = mkdtempSync(join(tmpdir(), "b14-multi-init-one-"));
    const vaultTwo = mkdtempSync(join(tmpdir(), "b14-multi-init-two-"));
    const ctx = memoryCtx();
    recordOwnedVaultConfirmation({
      baseDbPath,
      memoryCtx: ctx,
      vaultPath: vaultOne,
      confirmationValidated: true,
      confirmationNonce: randomUUID(),
    });
    const result = await handleObsidianBridgeCommand(
      ["init", "workspaces"],
      commandContext({
        baseDbPath,
        ctx,
        config: {
          mode: "apply",
          allowWrite: true,
          workspaces: [
            { workspace_id: "workspace-a", agent_id: "agent-a", path: vaultOne },
            { workspace_id: "workspace-a", agent_id: "agent-a", path: vaultTwo },
          ],
        },
        overrides: { vaultConfirmed: true },
      }),
    );

    assert.match(result.text, /mutation denied/i);
    assert.equal(existsSync(join(vaultOne, "memory", "cards")), false);
    assert.equal(existsSync(join(vaultTwo, "memory", "cards")), false);
  });
});

describe("B14 terminal non-mutating Semantic Discovery prepare", () => {
  it("does not create or change DB filesystem state when the production namespace is absent", async () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "b14-semantic-runtime-db-"));
    const vaultPath = mkdtempSync(join(tmpdir(), "b14-semantic-runtime-vault-"));
    const commands = [];
    const noop = () => {};
    plugin.register({
      pluginConfig: {
        baseDbPath,
        embedding: { provider: "local-transformers", local: { dimensions: 384 } },
        autoCapture: false,
        autoRecall: false,
        neo: { enabled: true },
        obsidianBridge: {
          enabled: false,
          mode: "apply",
          allowWrite: true,
          vaultPath,
        },
        security: { allowedUserIds: ["owner"] },
      },
      logger: { info: noop, warn: noop, error: noop, debug: noop },
      runtime: { agent: { async resolveAgentWorkspaceDir() { return vaultPath; } } },
      resolvePath: (value) => value,
      registerCommand(command) { commands.push(command); },
      registerTool: noop,
      registerService: noop,
      on: noop,
    }, {
      importRouting: async () => ({
        parseAgentSessionKey(value) {
          const match = /^agent:([^:]+):(.+)$/.exec(value);
          return match ? { agentId: match[1], rest: match[2] } : null;
        },
        parseThreadSessionSuffix(value) { return { baseSessionKey: value, threadId: "" }; },
        normalizeOptionalAccountId(value) { return value; },
        normalizeMessageChannel(value) { return value; },
      }),
    });
    const before = treeSnapshot(baseDbPath);
    const result = await commands.find((command) => command.name === "plur1bus").handler({
      args: "obsidian semantic-discovery prepare",
      agentId: "agent-a",
      workspaceDir: vaultPath,
      workspaceKey: "workspace-a",
      userId: "owner",
      senderId: "owner",
      chatId: "owner-chat",
      chatType: "private",
      channel: "telegram",
      accountId: "default",
      sessionKey: "agent:agent-a:telegram:direct:owner-chat",
      from: "telegram:direct:owner-chat",
      to: "telegram:direct:owner-chat",
      getCurrentConversationBinding: () => null,
    });

    assert.doesNotMatch(result.text, /failed|error/i);
    assert.deepEqual(treeSnapshot(baseDbPath), before);
  });
});

describe("B14 terminal protected review status commands", () => {
  for (const [action, expectedStatus] of [
    ["approve", "approved"],
    ["reject", "rejected"],
    ["snooze", "snoozed"],
  ]) {
    it(`persists review ${action} with review_write-only policy`, async () => {
      const baseDbPath = mkdtempSync(join(tmpdir(), `b14-review-${action}-`));
      const vaultPath = mkdtempSync(join(tmpdir(), `b14-review-vault-${action}-`));
      const policy = parseObsidianCommandPlan(["review", action], {
        memoryCtx: memoryCtx(),
        baseDbPath,
        mode: "apply",
        allowWrite: true,
        vaultConfirmed: true,
      }).mutationPolicy;
      const bundleId = `rb-${randomUUID()}`;
      createOwnedReviewBundle({
        policy,
        bundleId,
        bundle: {
          bundle: {
            bundleId,
            status: "pending_user_review",
            createdAt: new Date().toISOString(),
            createdByAgent: "agent-a",
            workspaceKey: "workspace:v1:workspace-a",
          },
          items: [{ id: "item-1", status: "pending", risk: "low", applyPreview: { payload: {} } }],
          hygieneItems: [],
          maintenance: { findings: [] },
        },
      });
      const result = await handleObsidianBridgeCommand(
        ["review", action, bundleId, "all"],
        commandContext({
          baseDbPath,
          config: { mode: "apply", allowWrite: true, vaultPath },
          overrides: { vaultConfirmed: true },
        }),
      );

      assert.doesNotMatch(result.text, /mutation denied|error/i);
      assert.equal(loadOwnedReviewBundle({ policy, bundleId }).items[0].status, expectedStatus);
    });
  }
});

describe("B14 terminal cron and background dashboard sinks", () => {
  it("uses the immutable command policy when installing generated cron jobs", async () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "b14-cron-db-"));
    const vaultPath = mkdtempSync(join(tmpdir(), "b14-cron-vault-"));
    const calls = [];
    const result = await handleObsidianBridgeCommand(
      ["cron", "install-workspace-reviews", "--force"],
      commandContext({
        baseDbPath,
        config: {
          mode: "apply",
          allowWrite: true,
          vaultPath,
          workspaces: [{ workspace_id: "workspace-a", agent_id: "agent-a", path: vaultPath }],
        },
        overrides: {
          vaultConfirmed: true,
          openclawCronAdd: async (payload) => {
            calls.push(payload);
            return { ok: true };
          },
        },
      }),
    );

    assert.match(result.text, /"installed": true/);
    assert.equal(calls.length, 2);
  });

  it("passes the confirmed policy into background dashboard generation", async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), "b14-background-dashboard-"));
    const service = createObsidianBridgeService({
      enabled: true,
      dryRun: false,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "workspace-a", agent_id: "agent-a", path: vaultPath }],
    }, {
      mutationPolicyForWorkspace: () => confirmedObsidianPolicy({
        baseDbPath: vaultPath,
        agentId: "agent-a",
        workspaceIdentity: "workspace:v1:workspace-a",
        command: ["dashboards", "build"],
      }),
      loadLanceDbRecords: async () => [{
        id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
        text: "Dashboard fixture",
        summary: "Dashboard fixture",
        category: "fact",
        importance: 0.8,
        createdAt: "2026-07-23T00:00:00.000Z",
        scope: "workspace",
        status: "active",
      }],
      logger: { info() {}, warn() {} },
    });

    const result = await service.rebuildDashboards();
    assert.ok(result.built > 0);
    assert.equal(existsSync(join(vaultPath, "plur1bus", "dashboards", "index.md")), true);
  });
});

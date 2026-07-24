import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import plugin, { MemoryDB } from "../index.js";
import {
  prepareReviewBundle,
  updateReviewBundleItems,
} from "../lib/obsidian-control-room.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { parseObsidianCommandPlan } from "../lib/obsidian-mutation-policy.js";
import { recordOwnedVaultConfirmation } from "../lib/obsidian-vault-authority.js";

const VECTOR_DIM = 384;
const AGENT_ID = "control-room-agent";
const WORKSPACE_KEY = "control-room-workspace";
const OWNER_USER_ID = "control-room-owner";
const OWNER_CHAT_ID = "control-room-chat";

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

function makeApi(baseDbPath, vaultPath) {
  const commands = [];
  const shutdownHandlers = [];
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      merging: { enabled: false },
      obsidianBridge: { enabled: false, vaultPath, mode: "apply", allowWrite: true, dryRun: false },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      gc: { enabled: false },
      security: {
        allowedUserIds: [OWNER_USER_ID],
        allowedChatIds: [OWNER_CHAT_ID],
      },
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    runtime: {
      agent: {
        async resolveAgentWorkspaceDir(config) { return config?.workspaceDir || baseDbPath; },
      },
    },
    resolvePath: (value) => value,
    registerCommand(command) { commands.push(command); },
    registerTool: noop,
    registerService: noop,
    on(event, handler) {
      if (event === "gateway_stop") shutdownHandlers.push(handler);
    },
    _commands: commands,
    _shutdownHandlers: shutdownHandlers,
  };
}

function bundlePath(vaultPath, bundleId) {
  return join(vaultPath, "plur1bus", "review-bundles", `${bundleId}.items.json`);
}

function readBundle(vaultPath, bundleId) {
  return JSON.parse(readFileSync(bundlePath(vaultPath, bundleId), "utf8"));
}

describe("registered Obsidian Control-Room memory apply", () => {
  let api;
  let baseDbPath;
  let bundleId;
  let originalEmbed;
  let originalStore;
  let vaultPath;
  let workspaceDir;

  beforeEach(async () => {
    baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-control-room-db-"));
    vaultPath = mkdtempSync(join(tmpdir(), "plur1bus-control-room-vault-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-control-room-workspace-"));
    bundleId = `rb-${randomUUID()}`;

    originalEmbed = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    originalStore = MemoryDB.prototype.store;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => Array(VECTOR_DIM).fill(0.125);

    const obsidianConfig = { vaultPath };
    const authorityCtx = {
      agentId: AGENT_ID,
      workspaceIdentity: `workspace-dir:v1:${realpathSync(workspaceDir)}`,
    };
    const mutationPolicy = parseObsidianCommandPlan(["review", "apply"], {
      memoryCtx: authorityCtx,
      baseDbPath,
      mode: "apply",
      allowWrite: true,
      vaultConfirmed: true,
      actionConfirmed: true,
    }).mutationPolicy;
    const prepared = await prepareReviewBundle(obsidianConfig, {
      agentId: AGENT_ID,
      workspaceKey: WORKSPACE_KEY,
      workspaceDir,
      bundleId,
      mutationPolicy,
      proposals: [{
        type: "memory_promotion",
        risk: "low",
        text: "Approved Control-Room memory",
        category: "fact",
        scope: "workspace",
        origin: "internal",
        reason: "Regression fixture for approved memory apply.",
      }],
    });
    assert.equal(prepared.items.length, 1, "fixture should prepare one memory item");
    updateReviewBundleItems(obsidianConfig, bundleId, "approve", "all", {
      agentId: AGENT_ID,
      workspaceKey: authorityCtx.workspaceIdentity,
      mutationPolicy,
    });
    recordOwnedVaultConfirmation({
      baseDbPath,
      memoryCtx: authorityCtx,
      vaultPath,
      confirmationValidated: true,
      confirmationNonce: randomUUID(),
    });

    api = makeApi(baseDbPath, vaultPath);
    plugin.register(api, { importRouting: async () => routingCapability });
  });

  afterEach(async () => {
    MemoryDB.prototype.store = originalStore;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbed;
    for (const shutdown of api?._shutdownHandlers || []) await shutdown();
    for (const dir of [baseDbPath, vaultPath, workspaceDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  async function runApply() {
    const command = api._commands.find((entry) => entry.name === "plur1bus");
    assert.ok(command, "registered /plur1bus command should exist");
    return command.handler({
      args: `obsidian review apply ${bundleId}`,
      agentId: AGENT_ID,
      workspaceDir,
      workspaceKey: WORKSPACE_KEY,
      senderId: OWNER_USER_ID,
      channel: "telegram",
      accountId: "default",
      sessionKey: `agent:${AGENT_ID}:main`,
      from: `telegram:${OWNER_CHAT_ID}`,
      to: `telegram:${OWNER_CHAT_ID}`,
      config: { workspaceDir },
      getCurrentConversationBinding: () => null,
      userId: OWNER_USER_ID,
      chatId: OWNER_CHAT_ID,
      chatType: "private",
    });
  }

  it("marks a successful normal store applied with its real memory id", async () => {
    const result = await runApply();
    const saved = readBundle(vaultPath, bundleId);

    assert.equal(saved.items[0].status, "applied");
    assert.match(saved.items[0].appliedMemoryId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(result.text, /Applied: 1/);
    assert.match(result.text, /Approved items were applied\./);
  });

  it("keeps an approved bundle item unapplied and reports a real store failure", async () => {
    MemoryDB.prototype.store = async () => {
      throw new Error("injected Control-Room store failure");
    };

    const result = await runApply();
    const saved = readBundle(vaultPath, bundleId);

    assert.equal(saved.items[0].status, "approved", "failed memory writes must remain retryable");
    assert.match(result.text, /Memory store failed: Error: injected Control-Room store failure/);
  });
});

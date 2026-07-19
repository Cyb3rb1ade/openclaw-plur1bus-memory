import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin, { MemoryDB } from "../index.js";
import {
  prepareReviewBundle,
  updateReviewBundleItems,
} from "../lib/obsidian-control-room.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";

const VECTOR_DIM = 384;
const AGENT_ID = "control-room-agent";
const WORKSPACE_KEY = "control-room-workspace";
const OWNER_USER_ID = "control-room-owner";
const OWNER_CHAT_ID = "control-room-chat";

function makeApi(baseDbPath, vaultPath) {
  const commands = [];
  const shutdownHandlers = [];
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      merging: { enabled: false },
      obsidianBridge: { enabled: false, vaultPath },
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
    bundleId = `rb-control-room-${Date.now()}`;

    originalEmbed = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    originalStore = MemoryDB.prototype.store;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => Array(VECTOR_DIM).fill(0.125);

    const obsidianConfig = { vaultPath };
    const prepared = await prepareReviewBundle(obsidianConfig, {
      agentId: AGENT_ID,
      workspaceKey: WORKSPACE_KEY,
      workspaceDir,
      bundleId,
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
    updateReviewBundleItems(obsidianConfig, bundleId, "approve", "all", { agentId: AGENT_ID });

    api = makeApi(baseDbPath, vaultPath);
    plugin.register(api);
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

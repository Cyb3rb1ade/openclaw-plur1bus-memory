import { describe, it } from "node:test";
import assert from "node:assert";
import {
  handleObsidianBridgeCommand,
  isObsidianCommandDestructive,
} from "../lib/obsidian-control-room.js";

const groupCtx = {
  message: {
    from: { id: "u1" },
    chat: { id: "g1", type: "supergroup" },
  },
};

const privateCtx = {
  message: {
    from: { id: "u1" },
    chat: { id: "p1", type: "private" },
  },
};

const allowedCtx = { userId: "u1", chatId: "c1" };
const allowedCfg = { security: { allowedUserIds: ["u1"] } };

function isBlocked(result) {
  return typeof result?.text === "string" && result.text.includes("🔒");
}

describe("isObsidianCommandDestructive classifier", () => {
  const destructiveCases = [
    ["rotate", "--apply"],
    ["rotate", "--delete"],
    ["rotate", "--allow-delete"],
    ["discover", "workspaces", "--write"],
    ["review", "apply"],
    ["review", "quickapply"],
    ["review", "prepare"],
    ["soul", "patch"],
    ["soul", "patch", "--force-soul"],
    ["soul", "patch", "--migrate-soul-memory-rules"],
    ["cron", "install-workspace-reviews"],
    ["cron", "install-morning-review"],
    ["init", "workspaces"],
    ["unknown", "--apply"],
    ["unknown", "--write"],
    ["unknown", "--delete"],
  ];

  for (const tokens of destructiveCases) {
    it(`classifies [${tokens.join(", ")}] as destructive`, () => {
      assert.strictEqual(isObsidianCommandDestructive(tokens), true);
    });
  }

  const readOnlyCases = [
    ["doctor"],
    ["help"],
    ["discover", "workspaces"],
    ["discover", "workspaces", "--dry-run"],
    ["cron", "print-morning-review"],
    ["cron", "print-workspace-reviews"],
    ["review", "show"],
    ["review", "explain"],
    ["rotate"],
    ["rotate", "--dry-run"],
    ["soul", "patch", "--dry-run"],
  ];

  for (const tokens of readOnlyCases) {
    it(`classifies [${tokens.join(", ")}] as read-only`, () => {
      assert.strictEqual(isObsidianCommandDestructive(tokens), false);
    });
  }
});

describe("handleObsidianBridgeCommand auth gate", () => {
  it("blocks destructive command in a group without whitelist", async () => {
    const result = await handleObsidianBridgeCommand(["rotate", "--apply"], {
      commandCtx: groupCtx,
      pluginConfig: {},
    });
    assert.ok(isBlocked(result), `expected auth block, got: ${result?.text}`);
  });

  it("blocks discover workspaces --write in a group without whitelist", async () => {
    const result = await handleObsidianBridgeCommand(
      ["discover", "workspaces", "--write"],
      { commandCtx: groupCtx, pluginConfig: {} },
    );
    assert.ok(isBlocked(result), `expected auth block, got: ${result?.text}`);
  });

  it("blocks review apply in a group without whitelist", async () => {
    const result = await handleObsidianBridgeCommand(["review", "apply"], {
      commandCtx: groupCtx,
      pluginConfig: {},
    });
    assert.ok(isBlocked(result), `expected auth block, got: ${result?.text}`);
  });

  it("blocks soul patch --force-soul in a group without whitelist", async () => {
    const result = await handleObsidianBridgeCommand(
      ["soul", "patch", "--force-soul"],
      { commandCtx: groupCtx, pluginConfig: {} },
    );
    assert.ok(isBlocked(result), `expected auth block, got: ${result?.text}`);
  });

  it("blocks cron install in a group without whitelist", async () => {
    const result = await handleObsidianBridgeCommand(
      ["cron", "install-workspace-reviews"],
      { commandCtx: groupCtx, pluginConfig: {} },
    );
    assert.ok(isBlocked(result), `expected auth block, got: ${result?.text}`);
  });

  it("allows read-only doctor in a group", async () => {
    const result = await handleObsidianBridgeCommand(["doctor"], {
      commandCtx: groupCtx,
      pluginConfig: {},
    });
    assert.ok(!isBlocked(result), `expected no auth block, got: ${result?.text}`);
  });

  it("allows read-only discover workspaces in a group", async () => {
    const result = await handleObsidianBridgeCommand(["discover", "workspaces"], {
      commandCtx: groupCtx,
      pluginConfig: {},
    });
    assert.ok(!isBlocked(result), `expected no auth block, got: ${result?.text}`);
  });

  it("allows destructive command in a private chat", async () => {
    const result = await handleObsidianBridgeCommand(
      ["discover", "workspaces", "--write"],
      { commandCtx: privateCtx, pluginConfig: {} },
    );
    assert.ok(!isBlocked(result), `expected no auth block, got: ${result?.text}`);
  });

  it("allows destructive command with an authorized user whitelist", async () => {
    const result = await handleObsidianBridgeCommand(["rotate", "--delete"], {
      commandCtx: allowedCtx,
      pluginConfig: allowedCfg,
    });
    assert.ok(!isBlocked(result), `expected no auth block, got: ${result?.text}`);
  });
});

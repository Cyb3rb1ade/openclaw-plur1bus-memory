import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "../index.js";

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

function makeApi(baseDbPath, configOverrides = {}) {
  const commands = [];
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: 384 } },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: true },
      obsidianBridge: { enabled: false },
      gc: { enabled: false },
      security: { allowedUserIds: ["owner"] },
      ...configOverrides,
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    runtime: {
      agent: {
        async resolveAgentWorkspaceDir() { return baseDbPath; },
      },
    },
    resolvePath: (p) => p,
    registerCommand(command) {
      commands.push(command);
    },
    registerTool: noop,
    registerService: noop,
    on: noop,
    _commands: commands,
  };
}

async function withPlugin(fn) {
  const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-internal-auth-db-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-internal-auth-ws-"));
  try {
    const api = makeApi(baseDbPath);
    plugin.register(api, { importRouting: async () => routingCapability });
    const command = api._commands.find((item) => item.name === "plur1bus");
    assert.ok(command, "plur1bus command should be registered");
    return await fn({ command, workspaceDir, baseDbPath });
  } finally {
    rmSync(baseDbPath, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

const groupCtx = {
  workspaceKey: "ws",
  agentId: "agent-a",
  senderId: "u1",
  channel: "telegram",
  accountId: "default",
  sessionKey: "agent:agent-a:telegram:group:g1",
  from: "telegram:group:g1",
  to: "telegram:group:g1",
  getCurrentConversationBinding: () => null,
  chatType: "group",
  userId: "u1",
  chatId: "g1",
};

function assertBlocked(result) {
  assert.match(result.text, /allowedUserIds/);
}

function writeSkillProposal(workspaceDir, id = "proposal-1") {
  const learningDir = join(workspaceDir, ".adaptive-learning");
  mkdirSync(learningDir, { recursive: true });
  const proposal = {
    id,
    status: "pending_review",
    skillName: "danger-skill",
    skillTitle: "Danger Skill",
    description: "Writes a skill file when approved.",
    instructions: "Do the thing.",
    examples: ["example"],
    evidence: { score: 3, llmConfidence: 0.9 },
  };
  writeFileSync(join(learningDir, "skill-proposals.jsonl"), `${JSON.stringify(proposal)}\n`, "utf8");
  return proposal;
}

describe("/plur1bus internal auth gate", () => {
  it("blocks internal jobs from group chats without an ACL", async () => {
    await withPlugin(async ({ command, workspaceDir, baseDbPath }) => {
      const result = await command.handler({
        args: "internal gc-run",
        workspaceDir,
        ...groupCtx,
      });

      assertBlocked(result);
      assert.doesNotMatch(result.text, /"job": "gc-run"/);
    });
  });

  it("keeps OpenClaw cron delivery authorized for internal jobs", async () => {
    await withPlugin(async ({ command, workspaceDir, baseDbPath }) => {
      const result = await command.handler({
        args: "internal gc-run",
        workspaceDir,
        workspaceKey: "ws",
        agentId: "agent-a",
        channel: "cron",
      });

      assert.match(result.text, /"job": "gc-run"/);
      assert.match(result.text, /"reason": "gc_disabled"/);
    });
  });

  it("routes verified cron jobs through the runtime workspace, never the raw chat workspace key", async () => {
    await withPlugin(async ({ command, workspaceDir, baseDbPath }) => {
      const result = await command.handler({
        args: "internal gc-run",
        workspaceDir,
        workspaceKey: "attacker-workspace",
        agentId: "agent-a",
        channel: "cron",
      });
      assert.match(result.text, /"job": "gc-run"/);
      const workspaceRoot = join(baseDbPath, "_neo", "workspaces");
      assert.equal(existsSync(join(workspaceRoot, "attacker-workspace")), false);
    });
  });
});

describe("/plur1bus mutating command auth gates", () => {
  it("blocks skill approval from group chats and leaves proposals unchanged", async () => {
    await withPlugin(async ({ command, workspaceDir }) => {
      writeSkillProposal(workspaceDir);

      const result = await command.handler({
        args: "skills approve proposal-1",
        workspaceDir,
        ...groupCtx,
      });

      assertBlocked(result);
      assert.equal(existsSync(join(workspaceDir, "skills", "danger-skill", "SKILL.md")), false);
      assert.match(readFileSync(join(workspaceDir, ".adaptive-learning", "skill-proposals.jsonl"), "utf8"), /"status":"pending_review"/);
    });
  });

  it("blocks read-only skill review from group chats", async () => {
    await withPlugin(async ({ command, workspaceDir }) => {
      writeSkillProposal(workspaceDir);

      const result = await command.handler({
        args: "skills review",
        workspaceDir,
        ...groupCtx,
      });

      assertBlocked(result);
    });
  });

  it("blocks reminder cancellation from group chats", async () => {
    await withPlugin(async ({ command, workspaceDir }) => {
      const result = await command.handler({
        args: "reminders cancel 11111111-1111-1111-1111-111111111111",
        workspaceDir,
        ...groupCtx,
      });

      assertBlocked(result);
    });
  });

  it("blocks neo workspace migrations from group chats including dry-run", async () => {
    await withPlugin(async ({ command, workspaceDir }) => {
      const blocked = await command.handler({
        args: "neo workspaces migrate",
        workspaceDir,
        ...groupCtx,
      });

      assertBlocked(blocked);

      const dryRun = await command.handler({
        args: "neo workspaces migrate --dry-run",
        workspaceDir,
        ...groupCtx,
      });
      assertBlocked(dryRun);
    });
  });

  it("blocks neo memory and behavior status mutations from group chats", async () => {
    await withPlugin(async ({ command, workspaceDir }) => {
      const memoryResult = await command.handler({
        args: "memory promote fake-id",
        workspaceDir,
        ...groupCtx,
      });
      assertBlocked(memoryResult);

      const behaviorResult = await command.handler({
        args: "behavior promote fake-id",
        workspaceDir,
        ...groupCtx,
      });
      assertBlocked(behaviorResult);
    });
  });
});

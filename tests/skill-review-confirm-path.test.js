import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const VECTOR_DIM = 8;

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

function createApi(baseDbPath) {
  const commands = [];
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      merging: { enabled: false },
      skillMiner: { enabled: true },
      security: { allowedUserIds: ["owner-a"] },
      obsidianBridge: { enabled: false },
      featureCronSetup: { auto: false },
      gc: { enabled: false },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    runtime: { llm: null, agent: { async resolveAgentWorkspaceDir(config) { return config?.workspaceDir || baseDbPath; } } },
    resolvePath: (value) => value,
    registerCommand(command) { commands.push(command); },
    registerTool() {},
    registerService() {},
    on() {},
    _commands: commands,
  };
}

test("Telegram skills review confirm nonce activates the proposal", async (t) => {
  const baseDbPath = mkdtempSync(join(tmpdir(), "skill-confirm-db-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "skill-confirm-ws-"));
  t.after(() => {
    rmSync(baseDbPath, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });
  mkdirSync(join(workspaceDir, ".adaptive-learning"), { recursive: true });
  const proposalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  writeFileSync(join(workspaceDir, ".adaptive-learning", "skill-proposals.jsonl"), `${JSON.stringify({
    id: proposalId,
    skillName: "verify-weekly-releases",
    skillTitle: "Verify Weekly Releases",
    description: "Use the checklist",
    instructions: "Run it",
    examples: ["verify"],
    status: "pending_review",
    evidence: { memoryIds: [], score: 4, llmConfidence: 0.9, grade: "unreviewed-legacy" },
  })}\n`);

  const pluginModule = await import(`../index.js?skill-confirm-path=${Date.now()}`);
  const api = createApi(baseDbPath);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });
  const handler = api._commands.find((command) => command.name === "plur1bus").handler;
  const ctx = {
    args: "skills review",
    agentId: "agent-a",
    channel: "telegram",
    accountId: "default",
    from: "telegram:12345",
    to: "telegram:12345",
    senderId: "owner-a",
    userId: "owner-a",
    chatId: "telegram:12345",
    sessionKey: "agent:agent-a:telegram:direct:12345",
    config: { workspaceDir },
    workspaceDir,
  };
  const review = await handler(ctx);
  assert.match(review.text, /skills confirm /);
  const nonce = review.text.match(/skills confirm ([0-9a-f-]{36})/i)?.[1];
  assert.ok(nonce, review.text);
  const confirm = await handler({ ...ctx, args: `skills confirm ${nonce}` });
  assert.match(confirm.text, /approved|geschrieben|partial|bestätigt/i);
  const skillPath = join(workspaceDir, "skills", "verify-weekly-releases", "SKILL.md");
  assert.equal(readFileSync(skillPath, "utf8").includes("Verify Weekly Releases"), true);
});

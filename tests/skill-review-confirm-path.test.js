import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const VECTOR_DIM = 384;

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
  const hooks = [];
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
    on(name, handler, options) { hooks.push({ name, handler, options }); },
    _commands: commands,
    _hooks: hooks,
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

test("the installed plugin registers one exact Workshop lifecycle hook and synchronizes its isolated local JSONL", async (t) => {
  const baseDbPath = mkdtempSync(join(tmpdir(), "skill-hook-db-"));
  const eventWorkspace = mkdtempSync(join(tmpdir(), "skill-hook-event-ws-"));
  const proposalWorkspace = join(baseDbPath, "_neo", "workspaces", "partition-a");
  t.after(() => {
    rmSync(baseDbPath, { recursive: true, force: true });
    rmSync(eventWorkspace, { recursive: true, force: true });
  });
  mkdirSync(join(proposalWorkspace, ".adaptive-learning"), { recursive: true });
  const revisionHash = "d".repeat(64);
  writeFileSync(join(proposalWorkspace, ".adaptive-learning", "skill-proposals.jsonl"), `${JSON.stringify({
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    skillName: "native-workshop-sync",
    skillTitle: "Native Workshop Sync",
    description: "Synchronize native Workshop lifecycle",
    instructions: "Use the committed lifecycle event",
    examples: ["sync"],
    agentId: "agent-a",
    status: "pending_review",
    evidence: { memoryIds: [], score: 4, llmConfidence: 0.9, grade: "corroborated" },
    openClawWorkshop: {
      proposalId: "native-workshop-sync-20260831",
      revisionHash,
      status: "pending",
    },
  })}\n`);

  const pluginModule = await import(`../index.js?skill-lifecycle-hook=${Date.now()}`);
  const api = createApi(baseDbPath);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });
  const hooks = api._hooks.filter((hook) => hook.name === "skill_proposal_changed");
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].options?.registrationId, "plur1bus-skill-workshop-lifecycle-v1");

  await hooks[0].handler({
    eventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    sequence: 2,
    action: "applied",
    occurredAt: "2026-08-31T12:00:00.000Z",
    proposal: {
      id: "native-workshop-sync-20260831",
      kind: "create",
      status: "applied",
      revision: "v1",
      revisionSha256: revisionHash,
      skillName: "native-workshop-sync",
      skillKey: "native-workshop-sync",
      skillFile: join(eventWorkspace, "skills", "native-workshop-sync", "SKILL.md"),
    },
  }, { workspaceDir: eventWorkspace, agentId: "agent-a" });

  const local = JSON.parse(readFileSync(
    join(proposalWorkspace, ".adaptive-learning", "skill-proposals.jsonl"),
    "utf8",
  ).trim());
  assert.equal(local.status, "active");
  assert.equal(local.openClawWorkshop.status, "applied");
});

test("Telegram approval delegates a Workshop-bound proposal to OpenClaw exactly once", async (t) => {
  const baseDbPath = mkdtempSync(join(tmpdir(), "skill-confirm-workshop-db-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "skill-confirm-workshop-ws-"));
  t.after(() => {
    rmSync(baseDbPath, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });
  mkdirSync(join(workspaceDir, ".adaptive-learning"), { recursive: true });
  const proposalId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const workshopProposalId = "verify-workshop-releases-20260826";
  const revisionHash = "c".repeat(64);
  writeFileSync(join(workspaceDir, ".adaptive-learning", "skill-proposals.jsonl"), `${JSON.stringify({
    id: proposalId,
    skillName: "verify-workshop-releases",
    skillTitle: "Verify Workshop Releases",
    description: "Use the Workshop checklist",
    instructions: "Run it",
    examples: ["verify"],
    agentId: "agent-a",
    status: "pending_review",
    evidence: { memoryIds: [], score: 4, llmConfidence: 0.9, grade: "corroborated" },
    openClawWorkshop: { proposalId: workshopProposalId, revisionHash, status: "pending" },
  })}\n`);

  const calls = [];
  const skillWorkshop = {
    async inspectProposal(input) {
      calls.push(["inspect", input]);
      return {
        proposalId: workshopProposalId,
        revisionHash,
        status: "pending",
        skillName: "verify-workshop-releases",
      };
    },
    async applyProposal(input) {
      calls.push(["apply", input]);
      return {
        proposalId: workshopProposalId,
        status: "applied",
        targetSkillFile: join(workspaceDir, "skills", "verify-workshop-releases", "SKILL.md"),
      };
    },
  };
  const pluginModule = await import(`../index.js?skill-confirm-workshop=${Date.now()}`);
  const api = createApi(baseDbPath);
  pluginModule.default.register(api, {
    importRouting: async () => routingCapability,
    skillWorkshop,
  });
  const handler = api._commands.find((command) => command.name === "plur1bus").handler;
  const ctx = {
    args: `skills approve ${proposalId}`,
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

  const approved = await handler(ctx);
  assert.match(approved.text, /approved|bestätigt/i);
  assert.deepEqual(calls.map(([name]) => name), ["inspect", "apply"]);
  assert.equal(calls[1][1].expectedRevisionHash, revisionHash);
  assert.equal(existsSync(join(workspaceDir, "skills", "verify-workshop-releases", "SKILL.md")), false);
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runSkillMiner } from "../lib/jobs/skill-miner.js";
import { readProposals, writeProposal } from "../lib/jobs/skill-miner/proposal-writer.js";
import {
  activateSkillProposal,
  rejectSkillProposalWithWorkshop,
} from "../lib/telegram-commands/skill-commands.js";
import {
  createOpenClawSkillWorkshopClient,
} from "../lib/setup/skill-workshop-plugin-runtime.js";

const REVISION = "a".repeat(64);

function workspace() {
  return mkdtempSync(join(tmpdir(), "plur1bus-skill-workshop-"));
}

function candidateResponse() {
  return JSON.stringify({
    skillName: "verify-weekly-releases",
    skillTitle: "Verify Weekly Releases",
    description: "Use the release checklist.",
    instructions: "Run and inspect the release checklist before deploying.",
    examples: ["Verify the weekly release"],
    confidence: 0.9,
    category: "workflow",
  });
}

function mockDb() {
  const now = Date.now();
  const rows = ["corroborated", "trusted"].map((epistemicStatus, index) => ({
    id: `memory-${index}`,
    text: "Always verify weekly releases with the same release checklist",
    category: "workspace_rule",
    origin: "dm",
    epistemicStatus,
    retrievalCount: 2,
    createdAt: now,
    status: "active",
  }));
  return {
    async init() {},
    table: {
      query() {
        return {
          limit() { return this; },
          async toArray() { return rows; },
        };
      },
    },
  };
}

function seedWorkshopProposal(dir, extra = {}) {
  const proposal = {
    id: "11111111-1111-4111-8111-111111111111",
    skillName: "weekly-deploy",
    skillTitle: "Weekly Deploy",
    description: "Deploy on Tuesday",
    instructions: "Backup then deploy",
    examples: ["deploy"],
    status: "pending_review",
    agentId: "agent-a",
    workspaceKey: "workspace-a",
    evidence: { memoryIds: [], score: 4, llmConfidence: 0.9, grade: "corroborated" },
    openClawWorkshop: {
      proposalId: "weekly-deploy-20260826",
      revisionHash: REVISION,
      status: "pending",
    },
    ...extra,
  };
  writeProposal(dir, proposal);
  return proposal;
}

describe("OpenClaw Skill Workshop gateway adapter", () => {
  it("uses only the public, agent-scoped proposal RPCs with the required scopes", async () => {
    const calls = [];
    const responses = {
      "skills.proposals.create": {
        record: {
          id: "weekly-deploy-20260826",
          status: "pending",
          target: { skillKey: "weekly-deploy" },
        },
        revisionHash: REVISION,
      },
      "skills.proposals.inspect": {
        record: {
          id: "weekly-deploy-20260826",
          status: "pending",
          target: { skillKey: "weekly-deploy" },
        },
        revisionHash: REVISION,
        content: "# Weekly Deploy\n",
      },
      "skills.proposals.apply": {
        record: { id: "weekly-deploy-20260826", status: "applied" },
        targetSkillFile: "/workspace/skills/weekly-deploy/SKILL.md",
      },
      "skills.proposals.reject": {
        id: "weekly-deploy-20260826",
        status: "rejected",
      },
    };
    const client = createOpenClawSkillWorkshopClient({
      loadGatewayRuntime: async () => ({
        callGatewayFromCli: async (...args) => {
          calls.push(args);
          return responses[args[0]];
        },
      }),
    });
    const proposal = seedWorkshopProposal(workspace(), { openClawWorkshop: undefined });

    const created = await client.createProposal({ agentId: "agent-a", proposal });
    const inspected = await client.inspectProposal({
      agentId: "agent-a",
      proposalId: created.proposalId,
    });
    await client.applyProposal({
      agentId: "agent-a",
      proposalId: created.proposalId,
      expectedRevisionHash: inspected.revisionHash,
    });
    await client.rejectProposal({
      agentId: "agent-a",
      proposalId: created.proposalId,
      expectedRevisionHash: inspected.revisionHash,
    });

    assert.deepEqual(calls.map(([method]) => method), [
      "skills.proposals.create",
      "skills.proposals.inspect",
      "skills.proposals.apply",
      "skills.proposals.reject",
    ]);
    assert.equal(calls[0][2].agentId, "agent-a");
    assert.equal(calls[0][2].name, "weekly-deploy");
    assert.match(calls[0][2].content, /PLUR1BUS Skill Miner/);
    assert.doesNotMatch(calls[0][2].content, /mem-empty|mem-obs|mem-bad/);
    assert.doesNotMatch(calls[0][2].evidence, /memory-/);
    assert.deepEqual(calls[0][3].scopes, ["operator.admin"]);
    assert.deepEqual(calls[1][3].scopes, ["operator.read"]);
    assert.deepEqual(calls[2][3].scopes, ["operator.admin"]);
  });

  it("fails visibly when the public gateway runtime capability is absent", async () => {
    const client = createOpenClawSkillWorkshopClient({
      loadGatewayRuntime: async () => ({}),
    });
    await assert.rejects(
      client.createProposal({ agentId: "agent-a", proposal: seedWorkshopProposal(workspace()) }),
      /Skill Workshop.*Gateway.*unavailable/i,
    );
  });
});

describe("Skill Miner Workshop publication", () => {
  it("publishes before persisting the local review record and binds the exact revision", async (t) => {
    const dir = workspace();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const published = [];
    const result = await runSkillMiner(mockDb(), "agent-a", {
      workspaceDir: dir,
      workspaceKey: "workspace-a",
      cutoffState: { ok: true, since: 0, legacyOpen: true },
      callLlm: async () => candidateResponse(),
      llmCfg: { model: "test" },
      requireSkillWorkshop: true,
      skillWorkshop: {
        async createProposal(input) {
          published.push(input);
          return {
            proposalId: "verify-weekly-releases-20260826",
            revisionHash: REVISION,
            status: "pending",
            skillName: "verify-weekly-releases",
          };
        },
      },
    });

    assert.equal(result.proposalsCreated, 1);
    assert.equal(result.workshopPublishFailed, 0);
    assert.equal(published.length, 1);
    assert.equal(published[0].agentId, "agent-a");
    const stored = readProposals(dir)[0];
    assert.deepEqual(stored.openClawWorkshop, {
      proposalId: "verify-weekly-releases-20260826",
      revisionHash: REVISION,
      status: "pending",
    });
  });

  it("fails closed without persisting a local proposal when Workshop is required but unavailable", async (t) => {
    const dir = workspace();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const result = await runSkillMiner(mockDb(), "agent-a", {
      workspaceDir: dir,
      workspaceKey: "workspace-a",
      cutoffState: { ok: true, since: 0, legacyOpen: true },
      callLlm: async () => candidateResponse(),
      llmCfg: { model: "test" },
      requireSkillWorkshop: true,
    });

    assert.equal(result.proposalsCreated, 0);
    assert.equal(result.workshopPublishFailed, 1);
    assert.equal(readProposals(dir).length, 0);
  });

  it("does not leave a local-only proposal when Workshop publication fails", async (t) => {
    const dir = workspace();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const warnings = [];
    const result = await runSkillMiner(mockDb(), "agent-a", {
      workspaceDir: dir,
      workspaceKey: "workspace-a",
      cutoffState: { ok: true, since: 0, legacyOpen: true },
      callLlm: async () => candidateResponse(),
      llmCfg: { model: "test" },
      requireSkillWorkshop: true,
      skillWorkshop: { async createProposal() { throw new Error("workshop unavailable"); } },
      logger: { info() {}, warn(message) { warnings.push(message); } },
    });

    assert.equal(result.proposalsCreated, 0);
    assert.equal(result.workshopPublishFailed, 1);
    assert.equal(readProposals(dir).length, 0);
    assert.ok(warnings.some((message) => /workshop unavailable/i.test(message)));
  });

  it("rejects the exact Workshop revision when the local review binding cannot be persisted", async (t) => {
    const dir = workspace();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const rejected = [];
    const result = await runSkillMiner(mockDb(), "agent-a", {
      workspaceDir: dir,
      workspaceKey: "workspace-a",
      cutoffState: { ok: true, since: 0, legacyOpen: true },
      callLlm: async () => candidateResponse(),
      llmCfg: { model: "test" },
      requireSkillWorkshop: true,
      skillWorkshop: {
        async createProposal() {
          writeFileSync(join(dir, ".adaptive-learning"), "blocks the review directory", "utf8");
          return {
            proposalId: "verify-weekly-releases-20260826",
            revisionHash: REVISION,
            status: "pending",
            skillName: "verify-weekly-releases",
          };
        },
        async rejectProposal(input) {
          rejected.push(input);
          return { proposalId: input.proposalId, status: "rejected" };
        },
      },
      logger: { info() {}, warn() {} },
    });

    assert.equal(result.proposalsCreated, 0);
    assert.equal(result.workshopPublishRolledBack, 1);
    assert.equal(result.workshopOrphaned, 0);
    assert.deepEqual(rejected, [{
      agentId: "agent-a",
      proposalId: "verify-weekly-releases-20260826",
      expectedRevisionHash: REVISION,
    }]);
  });
});

describe("Skill Workshop approval lifecycle", () => {
  it("inspects and hash-binds apply without PLUR1BUS writing SKILL.md", async (t) => {
    const dir = workspace();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    seedWorkshopProposal(dir);
    const calls = [];
    const result = await activateSkillProposal(dir, "11111111-1111-4111-8111-111111111111", {
      agentId: "agent-a",
      skillWorkshop: {
        async inspectProposal(input) {
          calls.push(["inspect", input]);
          return {
            proposalId: input.proposalId,
            revisionHash: REVISION,
            status: "pending",
            skillName: "weekly-deploy",
          };
        },
        async applyProposal(input) {
          calls.push(["apply", input]);
          return {
            proposalId: input.proposalId,
            status: "applied",
            targetSkillFile: join(dir, "skills", "weekly-deploy", "SKILL.md"),
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "active");
    assert.equal(existsSync(join(dir, "skills", "weekly-deploy", "SKILL.md")), false);
    assert.deepEqual(calls.map(([name]) => name), ["inspect", "apply"]);
    assert.equal(calls[1][1].expectedRevisionHash, REVISION);
    assert.equal(readProposals(dir)[0].openClawWorkshop.status, "applied");
  });

  it("fails closed when the reviewed Workshop revision changed", async (t) => {
    const dir = workspace();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    seedWorkshopProposal(dir);
    let applyCalls = 0;
    const result = await activateSkillProposal(dir, "11111111-1111-4111-8111-111111111111", {
      agentId: "agent-a",
      skillWorkshop: {
        async inspectProposal() {
          return {
            proposalId: "weekly-deploy-20260826",
            revisionHash: "b".repeat(64),
            status: "pending",
            skillName: "weekly-deploy",
          };
        },
        async applyProposal() { applyCalls += 1; },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "workshop_revision_changed");
    assert.equal(applyCalls, 0);
    assert.equal(readProposals(dir)[0].status, "pending_review");
    assert.equal(existsSync(join(dir, "skills", "weekly-deploy", "SKILL.md")), false);
  });

  it("rejects the same reviewed revision through Workshop before updating PLUR1BUS", async (t) => {
    const dir = workspace();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    seedWorkshopProposal(dir);
    const calls = [];
    const result = await rejectSkillProposalWithWorkshop(
      dir,
      "11111111-1111-4111-8111-111111111111",
      {
        agentId: "agent-a",
        skillWorkshop: {
          async inspectProposal(input) {
            calls.push(["inspect", input]);
            return {
              proposalId: input.proposalId,
              revisionHash: REVISION,
              status: "pending",
              skillName: "weekly-deploy",
            };
          },
          async rejectProposal(input) {
            calls.push(["reject", input]);
            return { proposalId: input.proposalId, status: "rejected" };
          },
        },
      },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(([name]) => name), ["inspect", "reject"]);
    assert.equal(calls[1][1].expectedRevisionHash, REVISION);
    assert.equal(readProposals(dir)[0].status, "rejected");
  });
});

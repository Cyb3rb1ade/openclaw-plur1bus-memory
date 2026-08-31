import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as skillCommands from "../lib/telegram-commands/skill-commands.js";
import { patchProposal, readProposals } from "../lib/jobs/skill-miner/proposal-writer.js";

const REVISION = "a".repeat(64);

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "skill-workshop-hook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".adaptive-learning"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  return dir;
}

function proposal(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    agentId: "agent-a",
    skillName: "weekly-deploy",
    skillTitle: "Weekly Deploy",
    description: "Use the checklist",
    instructions: "Run it",
    examples: ["deploy"],
    status: "pending_review",
    evidence: { memoryIds: [], score: 4, llmConfidence: 0.9, grade: "corroborated" },
    openClawWorkshop: {
      proposalId: "weekly-deploy-20260831",
      revisionHash: REVISION,
      status: "pending",
    },
    ...overrides,
  };
}

function seed(dir, rows = [proposal()]) {
  writeFileSync(
    join(dir, ".adaptive-learning", "skill-proposals.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

function event(dir, overrides = {}) {
  return {
    eventId: "22222222-2222-4222-8222-222222222222",
    sequence: 2,
    action: "applied",
    occurredAt: "2026-08-31T12:00:00.000Z",
    proposal: {
      id: "weekly-deploy-20260831",
      kind: "create",
      status: "applied",
      revision: "v1",
      revisionSha256: REVISION,
      skillName: "weekly-deploy",
      skillKey: "weekly-deploy",
      skillFile: join(dir, "skills", "weekly-deploy", "SKILL.md"),
    },
    ...overrides,
  };
}

function makeSynchronizer({ onApplied, onRejected, resolveProposalWorkspaces } = {}) {
  assert.equal(
    typeof skillCommands.createSkillWorkshopLifecycleSynchronizer,
    "function",
    "Skill Workshop lifecycle synchronizer export is required",
  );
  return skillCommands.createSkillWorkshopLifecycleSynchronizer({
    ...(resolveProposalWorkspaces ? { resolveProposalWorkspaces } : {}),
    onApplied: onApplied || (async ({ workspaceDir, localProposal, workshopEvent }) => {
      patchProposal(workspaceDir, localProposal.id, {
        status: "active",
        openClawWorkshop: {
          ...localProposal.openClawWorkshop,
          status: workshopEvent.proposal.status,
        },
      });
      return { ok: true, status: "active" };
    }),
    onRejected: onRejected || (async ({ workspaceDir, localProposal, workshopEvent }) => {
      patchProposal(workspaceDir, localProposal.id, {
        status: "rejected",
        openClawWorkshop: {
          ...localProposal.openClawWorkshop,
          status: workshopEvent.proposal.status,
        },
      });
      return { ok: true, status: "rejected" };
    }),
  });
}

test("committed Workshop apply synchronizes the exact local binding once", async (t) => {
  const dir = workspace(t);
  seed(dir);
  let calls = 0;
  const sync = makeSynchronizer({
    onApplied: async ({ workspaceDir, localProposal }) => {
      calls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      patchProposal(workspaceDir, localProposal.id, {
        status: "active",
        openClawWorkshop: { ...localProposal.openClawWorkshop, status: "applied" },
      });
      return { ok: true, status: "active" };
    },
  });
  const input = event(dir);
  const [first, duplicate] = await Promise.all([
    sync(input, { workspaceDir: dir, agentId: "agent-a" }),
    sync(input, { workspaceDir: dir, agentId: "agent-a" }),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.status, "synchronized");
  assert.equal(duplicate.status, "already_synchronized");
  assert.equal(readProposals(dir)[0].status, "active");
  assert.equal(readProposals(dir)[0].openClawWorkshop.status, "applied");
});

test("committed Workshop rejection synchronizes once and duplicate replay is inert", async (t) => {
  const dir = workspace(t);
  seed(dir);
  let calls = 0;
  const sync = makeSynchronizer({
    onRejected: async ({ workspaceDir, localProposal }) => {
      calls += 1;
      patchProposal(workspaceDir, localProposal.id, {
        status: "rejected",
        openClawWorkshop: { ...localProposal.openClawWorkshop, status: "rejected" },
      });
      return { ok: true, status: "rejected" };
    },
  });
  const rejected = event(dir, {
    action: "rejected",
    proposal: { ...event(dir).proposal, status: "rejected" },
  });
  assert.equal((await sync(rejected, { workspaceDir: dir, agentId: "agent-a" })).status, "synchronized");
  assert.equal((await sync(rejected, { workspaceDir: dir, agentId: "agent-a" })).status, "already_synchronized");
  assert.equal(calls, 1);
  assert.equal(readProposals(dir)[0].status, "rejected");
});

test("committed lifecycle events find one exact binding across isolated proposal roots", async (t) => {
  const eventWorkspace = workspace(t);
  const proposalWorkspace = workspace(t);
  seed(proposalWorkspace);
  let selected = null;
  const sync = makeSynchronizer({
    resolveProposalWorkspaces: () => [eventWorkspace, proposalWorkspace],
    onApplied: async ({ workspaceDir, localProposal }) => {
      selected = workspaceDir;
      patchProposal(workspaceDir, localProposal.id, {
        status: "active",
        openClawWorkshop: { ...localProposal.openClawWorkshop, status: "applied" },
      });
      return { ok: true };
    },
  });
  const result = await sync(event(eventWorkspace), {
    workspaceDir: eventWorkspace,
    agentId: "agent-a",
  });
  assert.equal(result.status, "synchronized");
  assert.equal(selected, proposalWorkspace);
});

test("foreign and ambiguous Workshop bindings never mutate local proposals", async (t) => {
  const eventWorkspace = workspace(t);
  const first = workspace(t);
  const second = workspace(t);
  seed(first);
  seed(second);
  let calls = 0;
  const sync = makeSynchronizer({
    resolveProposalWorkspaces: () => [first, second],
    onApplied: async () => { calls += 1; },
  });
  await assert.rejects(
    () => sync(event(eventWorkspace), { workspaceDir: eventWorkspace, agentId: "agent-a" }),
    /ambiguous local Workshop binding/i,
  );
  assert.equal(calls, 0);

  const foreign = event(eventWorkspace, {
    proposal: { ...event(eventWorkspace).proposal, id: "foreign-proposal-20260831" },
  });
  assert.equal(
    (await sync(foreign, { workspaceDir: eventWorkspace, agentId: "agent-a" })).status,
    "ignored",
  );
  assert.equal(calls, 0);
});

for (const [label, mutate, pattern] of [
  ["agent", (_event, context) => { context.agentId = "agent-b"; }, /agent binding/i],
  ["revision", (value) => { value.proposal.revisionSha256 = "b".repeat(64); }, /revision binding/i],
  ["skill key", (value) => { value.proposal.skillKey = "foreign-skill"; }, /skill binding/i],
  ["skill file", (value) => { value.proposal.skillFile = join(value.proposal.skillFile, "..", "foreign", "SKILL.md"); }, /skill file binding/i],
]) {
  test(`Workshop ${label} drift fails closed`, async (t) => {
    const dir = workspace(t);
    seed(dir);
    let calls = 0;
    const sync = makeSynchronizer({ onApplied: async () => { calls += 1; } });
    const value = event(dir);
    const context = { workspaceDir: dir, agentId: "agent-a" };
    mutate(value, context);
    const before = readFileSync(join(dir, ".adaptive-learning", "skill-proposals.jsonl"), "utf8");
    await assert.rejects(() => sync(value, context), pattern);
    assert.equal(calls, 0);
    assert.equal(readFileSync(join(dir, ".adaptive-learning", "skill-proposals.jsonl"), "utf8"), before);
  });
}

test("failed local synchronization remains retryable", async (t) => {
  const dir = workspace(t);
  seed(dir);
  let calls = 0;
  const sync = makeSynchronizer({
    onApplied: async ({ workspaceDir, localProposal }) => {
      calls += 1;
      if (calls === 1) throw new Error("local persistence unavailable");
      patchProposal(workspaceDir, localProposal.id, {
        status: "active",
        openClawWorkshop: { ...localProposal.openClawWorkshop, status: "applied" },
      });
      return { ok: true };
    },
  });
  await assert.rejects(
    () => sync(event(dir), { workspaceDir: dir, agentId: "agent-a" }),
    /local persistence unavailable/,
  );
  assert.equal(readProposals(dir)[0].status, "pending_review");
  assert.equal((await sync(event(dir), { workspaceDir: dir, agentId: "agent-a" })).status, "synchronized");
  assert.equal(calls, 2);
});

test("non-terminal events are ignored and malformed terminal events fail closed", async (t) => {
  const dir = workspace(t);
  seed(dir);
  let calls = 0;
  const sync = makeSynchronizer({
    onApplied: async () => { calls += 1; },
    onRejected: async () => { calls += 1; },
  });
  const created = event(dir, {
    action: "created",
    proposal: { ...event(dir).proposal, status: "pending" },
  });
  assert.equal((await sync(created, { workspaceDir: dir, agentId: "agent-a" })).status, "ignored");
  await assert.rejects(
    () => sync(event(dir, { sequence: 0 }), { workspaceDir: dir, agentId: "agent-a" }),
    /invalid Workshop lifecycle event/i,
  );
  assert.equal(calls, 0);
});

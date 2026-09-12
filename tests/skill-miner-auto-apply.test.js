import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runSkillMiner, SKILL_MINER_RATE_LIMIT_MS, clusterFingerprint } from "../lib/jobs/skill-miner.js";
import { extractSkillFromEvidence } from "../lib/jobs/skill-miner/llm-extractor.js";
import { renderSkillMd } from "../lib/jobs/skill-miner/skill-md-renderer.js";
import { readProposals, writeProposal } from "../lib/jobs/skill-miner/proposal-writer.js";
import { findProposalWorkspace, retireActiveSkill } from "../lib/telegram-commands/skill-commands.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const REVISION = "b".repeat(64);
const ID = "22222222-2222-4222-8222-222222222222";

function workspace(prefix = "plur1bus-auto-apply-") {
  return makeTempDir(prefix);
}

function candidateResponse(extra = {}) {
  return JSON.stringify({
    skillName: "verify-weekly-releases",
    skillTitle: "Verify Weekly Releases",
    description: "Use the release checklist.",
    instructions: "Run and inspect the release checklist before deploying.",
    benefit: "Saves one failed deploy per month.",
    examples: ["Verify the weekly release"],
    confidence: 0.9,
    category: "workflow",
    ...extra,
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

function workshopStub() {
  return {
    async createProposal() {
      return { proposalId: "verify-weekly-releases-20260913", revisionHash: REVISION, status: "pending", skillName: "verify-weekly-releases" };
    },
  };
}

function minerOptions(dir, extra = {}) {
  return {
    workspaceDir: dir,
    workspaceKey: "workspace-a",
    cutoffState: { ok: true, since: 0, legacyOpen: true },
    callLlm: async () => candidateResponse(),
    llmCfg: { model: "test" },
    requireSkillWorkshop: true,
    skillWorkshop: workshopStub(),
    ...extra,
  };
}

describe("7.12.48: Skill Miner auto-apply", () => {
  it("activates a freshly published proposal through the injected activation and counts it", async (t) => {
    const dir = workspace();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const activated = [];
    const result = await runSkillMiner(mockDb(), "agent-a", minerOptions(dir, {
      autoApply: true,
      activateProposal: async (proposal) => {
        // The ledger row must exist before activation so the Workshop hook
        // and the local record cannot disagree.
        const stored = readProposals(dir).find((entry) => entry.id === proposal.id);
        assert.ok(stored, "proposal persisted before activation");
        assert.equal(stored.openClawWorkshop.revisionHash, REVISION);
        assert.equal(stored.benefit, "Saves one failed deploy per month.");
        activated.push(proposal.skillName);
        return { ok: true, status: "active" };
      },
    }));
    assert.equal(result.proposalsCreated, 1);
    assert.equal(result.autoApplied, 1);
    assert.equal(result.autoApplyFailed, 0);
    assert.deepEqual(activated, ["verify-weekly-releases"]);
    assert.equal(result.pushMessages[0].autoApplied, true);
    assert.equal(result.pushMessages[0].activationStatus, "active");
  });

  it("keeps the proposal pending when activation declines or throws", async (t) => {
    const dir = workspace();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const declined = await runSkillMiner(mockDb(), "agent-a", minerOptions(dir, {
      autoApply: true,
      activateProposal: async () => ({ ok: false, reason: "workshop_revision_changed" }),
    }));
    assert.equal(declined.proposalsCreated, 1);
    assert.equal(declined.autoApplied, 0);
    assert.equal(declined.autoApplyFailed, 1);
    assert.equal(readProposals(dir)[0].status, "pending_review");
    assert.equal(declined.pushMessages[0].autoApplied, undefined);

    const dir2 = workspace();
    t.after(() => rmSync(dir2, { recursive: true, force: true }));
    const thrown = await runSkillMiner(mockDb(), "agent-a", minerOptions(dir2, {
      autoApply: true,
      activateProposal: async () => { throw new Error("gateway down"); },
    }));
    assert.equal(thrown.autoApplyFailed, 1);
    assert.equal(readProposals(dir2)[0].status, "pending_review");
  });

  it("does not activate when auto-apply is off or during a dry run", async (t) => {
    const dir = workspace();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let calls = 0;
    const off = await runSkillMiner(mockDb(), "agent-a", minerOptions(dir, {
      autoApply: false,
      activateProposal: async () => { calls += 1; return { ok: true }; },
    }));
    assert.equal(off.proposalsCreated, 1);
    assert.equal(off.autoApplied, 0);
    assert.equal(calls, 0);
    const dir2 = workspace();
    t.after(() => rmSync(dir2, { recursive: true, force: true }));
    await runSkillMiner(mockDb(), "agent-a", minerOptions(dir2, {
      autoApply: true,
      dryRun: true,
      activateProposal: async () => { calls += 1; return { ok: true }; },
    }));
    assert.equal(calls, 0);
  });
});

describe("7.12.48: extractor benefit field", () => {
  it("keeps the benefit sentence and tolerates its absence", async () => {
    const group = { memories: [{ id: "a", text: "x" }, { id: "b", text: "y" }], keywords: ["x", "y"], score: 5, topics: ["x"] };
    const withBenefit = await extractSkillFromEvidence(group, { callLlm: async () => candidateResponse(), llmCfg: {} });
    assert.equal(withBenefit.benefit, "Saves one failed deploy per month.");
    const without = await extractSkillFromEvidence(group, { callLlm: async () => candidateResponse({ benefit: undefined }), llmCfg: {} });
    assert.equal(without.benefit, "");
    const md = renderSkillMd({ ...withBenefit, evidence: { memoryIds: ["a"] } }, { proposalMode: true });
    assert.match(md, /## Benefit\n\nSaves one failed deploy per month\./);
    assert.ok(!/## Benefit/.test(renderSkillMd({ ...without, evidence: { memoryIds: [] } }, { proposalMode: true })));
  });
});

describe("7.12.48: proposal lookup across partition ledgers", () => {
  it("finds the ledger that holds the id and ignores unreadable roots", (t) => {
    const empty = workspace("ledger-empty-");
    const holder = workspace("ledger-holder-");
    t.after(() => { rmSync(empty, { recursive: true, force: true }); rmSync(holder, { recursive: true, force: true }); });
    writeProposal(holder, { id: ID, skillName: "x", skillTitle: "X", status: "pending_review" });
    assert.equal(findProposalWorkspace([empty, "/nonexistent/ledger", holder], ID), holder);
    assert.equal(findProposalWorkspace([empty], ID), null);
    assert.equal(findProposalWorkspace([holder], ""), null);
  });
});

describe("7.12.48: withdrawing an applied skill", () => {
  function seedActive(dir, skillPath, extra = {}) {
    writeProposal(dir, {
      id: ID,
      skillName: "weekly-deploy",
      skillTitle: "Weekly Deploy",
      status: "active",
      openClawWorkshop: { proposalId: "weekly-deploy-1", revisionHash: REVISION, status: "applied" },
      activation: { skillPath, evidence: {} },
      ...extra,
    });
  }

  it("removes the Workshop directory, marks the proposal rejected and blocks the name", (t) => {
    const dir = workspace("retire-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const skillDir = join(dir, "agent", "workshop-skills", "weekly-deploy");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# x", "utf8");
    seedActive(dir, join(skillDir, "SKILL.md"));
    const result = retireActiveSkill(dir, ID);
    assert.equal(result.ok, true);
    assert.equal(result.removed, true);
    assert.equal(existsSync(skillDir), false);
    const stored = readProposals(dir)[0];
    assert.equal(stored.status, "rejected");
    assert.equal(stored.openClawWorkshop.status, "retired");
    assert.ok(stored.retiredAt);
    // The name is blocked for future mining.
    assert.deepEqual(writeProposal(dir, { id: "33333333-3333-4333-8333-333333333333", skillName: "weekly-deploy", status: "pending_review" }), { written: false, reason: "already_exists_or_rejected" });
  });

  it("refuses paths outside a skills directory and tolerates an already removed one", (t) => {
    const dir = workspace("retire-guard-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const stray = join(dir, "agent", "SKILL.md");
    mkdirSync(join(dir, "agent"), { recursive: true });
    writeFileSync(stray, "keep", "utf8");
    seedActive(dir, stray);
    assert.equal(retireActiveSkill(dir, ID).reason, "unsafe_skill_path");
    assert.equal(existsSync(stray), true);
    assert.equal(readProposals(dir)[0].status, "active");

    const dir2 = workspace("retire-missing-");
    t.after(() => rmSync(dir2, { recursive: true, force: true }));
    seedActive(dir2, join(dir2, "agent", "workshop-skills", "weekly-deploy", "SKILL.md"));
    const gone = retireActiveSkill(dir2, ID);
    assert.equal(gone.ok, true);
    assert.equal(gone.removed, false);
    assert.equal(readProposals(dir2)[0].status, "rejected");
  });

  it("only withdraws active or partially applied proposals", (t) => {
    const dir = workspace("retire-status-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    seedActive(dir, "", { status: "pending_review" });
    assert.equal(retireActiveSkill(dir, ID).reason, "not_active");
    assert.equal(retireActiveSkill(dir, "44444444-4444-4444-8444-444444444444").reason, "not_found");
  });
});

describe("7.12.50: nightly rate limit tolerates run-time drift", () => {
  const shift = (dir, agoMs) => {
    const statePath = join(dir, "run-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    for (const entry of Object.values(state.jobRateLimits)) entry.lastRunAt = Date.now() - agoMs;
    writeFileSync(statePath, JSON.stringify(state), "utf8");
  };

  it("lets the next night run start although the last run finished after its slot", async (t) => {
    const dir = workspace("rate-drift-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const first = await runSkillMiner(mockDb(), "agent-a", minerOptions(dir));
    assert.equal(first.skipped, undefined, "first run executes");
    // Live pattern: 05:00 slot, previous run recorded at 05:03 the day before.
    shift(dir, 24 * 3600000 - 3 * 60000);
    const nextNight = await runSkillMiner(mockDb(), "agent-a", minerOptions(dir));
    assert.notEqual(nextNight.reason, "rate_limited");
    // A duplicate trigger a few hours later is still caught.
    shift(dir, 6 * 3600000);
    const duplicate = await runSkillMiner(mockDb(), "agent-a", minerOptions(dir));
    assert.equal(duplicate.reason, "rate_limited");
    assert.ok(SKILL_MINER_RATE_LIMIT_MS >= 6 * 3600000 && SKILL_MINER_RATE_LIMIT_MS < 24 * 3600000);
  });
});

describe("7.12.50: cluster fingerprint memo", () => {
  it("is the exact set of evidence ids and changes when a memory joins", () => {
    const base = { memories: [{ id: "m2" }, { id: "m1" }] };
    assert.equal(clusterFingerprint(base), clusterFingerprint({ memories: [{ id: "m1" }, { id: "m2" }] }));
    assert.notEqual(clusterFingerprint(base), clusterFingerprint({ memories: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }));
    assert.equal(typeof clusterFingerprint({}), "string");
  });

  it("does not call the model again for a cluster whose name was already blocked", async (t) => {
    const dir = workspace("memo-blocked-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let calls = 0;
    const options = (extra = {}) => minerOptions(dir, { callLlm: async () => { calls += 1; return candidateResponse(); }, ...extra });
    const first = await runSkillMiner(mockDb(), "agent-a", options());
    assert.equal(first.proposalsCreated, 1);
    assert.equal(calls, 1);
    assert.equal(first.skippedKnownCluster, 0);
    // Second night: same evidence, the skill name is blocked by the ledger.
    const state = JSON.parse(readFileSync(join(dir, "run-state.json"), "utf8"));
    for (const entry of Object.values(state.jobRateLimits)) entry.lastRunAt = 0;
    writeFileSync(join(dir, "run-state.json"), JSON.stringify(state), "utf8");
    const second = await runSkillMiner(mockDb(), "agent-a", options());
    assert.equal(second.skippedDuplicate, 1, "name blocked on the second night");
    assert.equal(calls, 2, "the model still decides once");
    // Third night: the memo answers before the model is asked.
    const state3 = JSON.parse(readFileSync(join(dir, "run-state.json"), "utf8"));
    for (const entry of Object.values(state3.jobRateLimits)) entry.lastRunAt = 0;
    writeFileSync(join(dir, "run-state.json"), JSON.stringify(state3), "utf8");
    const third = await runSkillMiner(mockDb(), "agent-a", options());
    assert.equal(third.skippedKnownCluster, 1);
    assert.equal(calls, 2, "no further model call for the known cluster");
    assert.ok(JSON.parse(readFileSync(join(dir, "run-state.json"), "utf8")).skillMinerClusterMemo);
  });

  it("remembers a low-confidence cluster and skips it next night", async (t) => {
    const dir = workspace("memo-lowconf-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let calls = 0;
    const options = () => minerOptions(dir, { callLlm: async () => { calls += 1; return JSON.stringify({ confidence: 0.2, skip: true }); } });
    const first = await runSkillMiner(mockDb(), "agent-a", options());
    assert.equal(first.skippedLowConfidence, 1);
    assert.equal(calls, 1);
    const state = JSON.parse(readFileSync(join(dir, "run-state.json"), "utf8"));
    for (const entry of Object.values(state.jobRateLimits || {})) entry.lastRunAt = 0;
    writeFileSync(join(dir, "run-state.json"), JSON.stringify(state), "utf8");
    const second = await runSkillMiner(mockDb(), "agent-a", options());
    assert.equal(second.skippedKnownCluster, 1);
    assert.equal(calls, 1, "the memo answers instead of the model");
  });
});

describe("7.12.48: withdraw never deletes a handwritten workspace skill", () => {
  it("refuses a workspace skills/ entry without the miner provenance and keeps the proposal active", (t) => {
    const dir = workspace("retire-foreign-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const skillDir = join(dir, "skills", "weekly-deploy");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: weekly-deploy\n---\nHandwritten by the operator.", "utf8");
    writeProposal(dir, { id: ID, skillName: "weekly-deploy", status: "active", activation: { skillPath: join(skillDir, "SKILL.md"), evidence: {} } });
    const result = retireActiveSkill(dir, ID);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "foreign_skill");
    assert.equal(existsSync(join(skillDir, "SKILL.md")), true);
    assert.equal(readProposals(dir)[0].status, "active");
  });

  it("removes a workspace skills/ entry the miner wrote itself", (t) => {
    const dir = workspace("retire-own-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const skillDir = join(dir, "skills", "weekly-deploy");
    mkdirSync(skillDir, { recursive: true });
    const md = renderSkillMd({ skillTitle: "Weekly Deploy", skillName: "weekly-deploy", description: "d", instructions: "i", evidence: { memoryIds: [] } });
    writeFileSync(join(skillDir, "SKILL.md"), md, "utf8");
    writeProposal(dir, { id: ID, skillName: "weekly-deploy", status: "active", activation: { skillPath: join(skillDir, "SKILL.md"), evidence: {} } });
    const result = retireActiveSkill(dir, ID);
    assert.equal(result.ok, true);
    assert.equal(existsSync(skillDir), false);
  });
});

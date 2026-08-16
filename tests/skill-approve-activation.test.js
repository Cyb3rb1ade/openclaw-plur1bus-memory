import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProposal, readProposals } from "../lib/jobs/skill-miner/proposal-writer.js";
import { activateSkillProposal, rejectSkillProposal } from "../lib/telegram-commands/skill-commands.js";

function workspace() {
  return mkdtempSync(join(tmpdir(), "skill-activate-"));
}

function seedProposal(dir, extra = {}) {
  mkdirSync(join(dir, ".adaptive-learning"), { recursive: true });
  const proposal = {
    id: "11111111-1111-4111-8111-111111111111",
    skillName: "weekly-deploy",
    skillTitle: "Weekly Deploy",
    description: "Deploy on Tuesday",
    instructions: "Backup then deploy",
    examples: ["deploy"],
    status: "pending_review",
    evidence: { memoryIds: ["mem-empty", "mem-obs", "mem-bad"], score: 4, llmConfidence: 0.9, grade: "unreviewed-legacy" },
    aclBindings: { scope: "agent-private", agentId: "agent-1", workspaceIdentity: "", ownerUserId: "" },
    ...extra,
  };
  writeProposal(dir, proposal);
  return proposal;
}

describe("skill approve activation", () => {
  it("writes SKILL.md before transitions and retries partial failures", async () => {
    const dir = workspace();
    seedProposal(dir);
    const records = {
      "mem-empty": { id: "mem-empty", epistemicStatus: "", scope: "agent-private", agentId: "agent-1" },
      "mem-obs": { id: "mem-obs", epistemicStatus: "observed", scope: "agent-private", agentId: "agent-1" },
      "mem-bad": { id: "mem-bad", epistemicStatus: "observed", scope: "agent-private", agentId: "agent-1" },
    };
    let failOnce = true;
    const applied = [];
    const first = await activateSkillProposal(dir, "11111111-1111-4111-8111-111111111111", {
      loadEvidenceRecord: async (id) => records[id],
      applyEpistemicStatus: async (id, next) => {
        if (id === "mem-bad" && failOnce) {
          failOnce = false;
          throw new Error("boom");
        }
        applied.push([id, next]);
        records[id].epistemicStatus = next;
        return { ok: true };
      },
    });
    assert.equal(existsSync(join(dir, "skills", "weekly-deploy", "SKILL.md")), true);
    assert.equal(first.partial, true);
    assert.equal(readProposals(dir)[0].status, "activation_partial");
    assert.deepEqual(applied, [["mem-empty", "observed"], ["mem-obs", "corroborated"]]);

    const second = await activateSkillProposal(dir, "11111111-1111-4111-8111-111111111111", {
      loadEvidenceRecord: async (id) => records[id],
      applyEpistemicStatus: async (id, next) => {
        applied.push([id, next]);
        records[id].epistemicStatus = next;
        return { ok: true };
      },
    });
    assert.equal(second.partial, false);
    assert.equal(readProposals(dir)[0].status, "active");
    assert.ok(applied.some((pair) => pair[0] === "mem-bad" && pair[1] === "corroborated"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not transition when SKILL.md write cannot happen", async () => {
    const dir = workspace();
    seedProposal(dir, { skillName: "blocked" });
    const skillDir = join(dir, "skills");
    writeFileSync(skillDir, "not-a-dir", "utf8");
    let applied = 0;
    await assert.rejects(() => activateSkillProposal(dir, "11111111-1111-4111-8111-111111111111", {
      applyEpistemicStatus: async () => {
        applied += 1;
        return { ok: true };
      },
    }));
    assert.equal(applied, 0);
    assert.equal(readProposals(dir)[0].status, "pending_review");
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips foreign records and does not change epistemic on reject", async () => {
    const dir = workspace();
    seedProposal(dir);
    const first = await activateSkillProposal(dir, "11111111-1111-4111-8111-111111111111", {
      loadEvidenceRecord: async () => null,
      applyEpistemicStatus: async () => ({ ok: true }),
    });
    assert.equal(first.partial, true);
    const rejectDir = workspace();
    seedProposal(rejectDir);
    const rejected = rejectSkillProposal(rejectDir, "11111111-1111-4111-8111-111111111111");
    assert.equal(rejected.ok, true);
    assert.equal(readProposals(rejectDir)[0].status, "rejected");
    rmSync(dir, { recursive: true, force: true });
    rmSync(rejectDir, { recursive: true, force: true });
  });
});

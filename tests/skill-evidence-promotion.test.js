import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";

import { makeTempDir } from "./helpers/temp-dir.js";
import { activateSkillProposal } from "../lib/telegram-commands/skill-commands.js";
import { readProposals, writeProposal } from "../lib/jobs/skill-miner/proposal-writer.js";

const ID = "11111111-1111-4111-8111-111111111111";
const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HASH_ID = "ba75a4c20bb8eb51e3bee6691a827425";

function seed(dir, memoryIds) {
  writeProposal(dir, {
    id: ID,
    skillName: "weekly-deploy",
    skillTitle: "Weekly Deploy",
    status: "pending_review",
    evidence: { memoryIds },
  });
}

function context(records, { tier, transitions }) {
  return {
    ...(tier ? { evidenceActorTier: tier } : {}),
    async loadEvidenceRecord(memoryId) {
      if (!/^[0-9a-f-]{36}$/i.test(memoryId)) throw new Error(`Invalid memory ID format: ${JSON.stringify(memoryId)}`);
      return records[memoryId] || null;
    },
    async applyEpistemicStatus(memoryId, next) {
      transitions.push([memoryId, next]);
      records[memoryId].epistemicStatus = next;
      return { ok: true };
    },
  };
}

describe("7.12.52: Belegbestätigung nach Auto-Apply", () => {
  it("überspringt Dokument-Fakten mit Hash-ID, statt sie als Fehler zu werten", async (t) => {
    const dir = makeTempDir("evidence-hash-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    seed(dir, [HASH_ID, UUID_A]);
    const transitions = [];
    const result = await activateSkillProposal(dir, ID, context(
      { [UUID_A]: { id: UUID_A, epistemicStatus: "observed" } },
      { tier: "system:skill-workshop", transitions },
    ));
    assert.equal(result.ok, true);
    assert.equal(result.status, "active", "der Skill gilt als vollständig angewandt");
    const stored = readProposals(dir)[0];
    assert.equal(stored.status, "active");
    assert.deepEqual(stored.activation.evidence[HASH_ID], { ok: true, reason: "skipped", note: "non_uuid_id" });
    assert.deepEqual(transitions, [[UUID_A, "corroborated"]]);
  });

  it("hebt als Workshop-Stufe nur observed nach corroborated und lässt den Rest liegen", async (t) => {
    const dir = makeTempDir("evidence-tier-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    seed(dir, [UUID_A, UUID_B]);
    const transitions = [];
    const result = await activateSkillProposal(dir, ID, context(
      { [UUID_A]: { id: UUID_A, epistemicStatus: "" }, [UUID_B]: { id: UUID_B, epistemicStatus: "observed" } },
      { tier: "system:skill-workshop", transitions },
    ));
    assert.equal(result.status, "active");
    // "" → observed wäre für diese Stufe illegal und wird gar nicht versucht.
    assert.deepEqual(transitions, [[UUID_B, "corroborated"]]);
    const evidence = readProposals(dir)[0].activation.evidence;
    assert.equal(evidence[UUID_A].ok, true);
    assert.equal(evidence[UUID_A].reason, "skipped");
    assert.equal(evidence[UUID_B].reason, "transitioned");
  });

  it("die menschliche Stufe hebt weiterhin über observed hinauf", async (t) => {
    const dir = makeTempDir("evidence-human-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    seed(dir, [UUID_A]);
    const transitions = [];
    const result = await activateSkillProposal(dir, ID, context(
      { [UUID_A]: { id: UUID_A, epistemicStatus: "" } },
      { tier: undefined, transitions },
    ));
    assert.equal(result.status, "active");
    assert.deepEqual(transitions, [[UUID_A, "observed"]]);
  });

  it("ein echter Fehlschlag bleibt ein Fehlschlag", async (t) => {
    const dir = makeTempDir("evidence-fail-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    seed(dir, [UUID_A]);
    const result = await activateSkillProposal(dir, ID, {
      evidenceActorTier: "system:skill-workshop",
      async loadEvidenceRecord() { return { id: UUID_A, epistemicStatus: "observed" }; },
      async applyEpistemicStatus() { return { ok: false, reason: "boom" }; },
    });
    assert.equal(result.partial, true);
    assert.equal(readProposals(dir)[0].status, "activation_partial");
  });

  it("verwirft eine gemerkte Absicht, die die jetzige Stufe nicht ausführen darf", async (t) => {
    const dir = makeTempDir("evidence-prior-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeProposal(dir, {
      id: ID,
      skillName: "weekly-deploy",
      skillTitle: "Weekly Deploy",
      status: "activation_partial",
      evidence: { memoryIds: [UUID_A] },
      // So sah der Datensatz nach einem Fehlschlag unter 7.12.51 aus.
      activation: { skillPath: "", evidence: { [UUID_A]: { ok: false, reason: "pending", from: "untrusted", to: "observed" } } },
    });
    const transitions = [];
    const result = await activateSkillProposal(dir, ID, context(
      { [UUID_A]: { id: UUID_A, epistemicStatus: "untrusted" } },
      { tier: "system:skill-workshop", transitions },
    ));
    assert.equal(result.status, "active");
    assert.deepEqual(transitions, [], "kein erneuter Versuch des illegalen Übergangs");
    assert.equal(readProposals(dir)[0].activation.evidence[UUID_A].reason, "skipped");
  });
});

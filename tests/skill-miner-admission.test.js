import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isAdmissibleSkillEvidence,
  isTrustedSkillEvidence,
  skillEvidenceGrade,
} from "../lib/jobs/skill-miner/evidence-aggregator.js";

const CUTOFF = 1_700_000_000_000;

describe("skill-miner admission", () => {
  it("admits observed, corroborated, trusted", () => {
    for (const epistemicStatus of ["observed", "corroborated", "trusted"]) {
      assert.equal(isAdmissibleSkillEvidence({
        epistemicStatus,
        category: "fact",
        createdAt: CUTOFF + 10,
        sourceMessageRole: "user",
      }, { cutoff: CUTOFF, legacyOpen: false }), true);
    }
  });

  it("rejects explicit untrusted, disputed, invalidated, and assistant", () => {
    assert.equal(isAdmissibleSkillEvidence({
      epistemicStatus: "untrusted",
      sourceMessageRole: "user",
      createdAt: CUTOFF - 10,
    }, { cutoff: CUTOFF, legacyOpen: true }), false);
    assert.equal(isAdmissibleSkillEvidence({
      epistemicStatus: "",
      sourceMessageRole: "assistant",
      createdAt: CUTOFF - 10,
    }, { cutoff: CUTOFF, legacyOpen: true }), false);
  });

  it("admits pre-cutoff empty user and empty-role only when legacy is open", () => {
    const legacyUser = {
      epistemicStatus: "",
      sourceMessageRole: "user",
      createdAt: CUTOFF - 86_400_000,
    };
    const legacyNorole = {
      epistemicStatus: "",
      sourceMessageRole: "",
      createdAt: CUTOFF - 86_400_000,
    };
    const post = {
      epistemicStatus: "",
      sourceMessageRole: "user",
      createdAt: CUTOFF + 10,
    };
    assert.equal(isAdmissibleSkillEvidence(legacyUser, { cutoff: CUTOFF, legacyOpen: true }), true);
    assert.equal(isAdmissibleSkillEvidence(legacyNorole, { cutoff: CUTOFF, legacyOpen: true }), true);
    assert.equal(isAdmissibleSkillEvidence(legacyUser, { cutoff: CUTOFF, legacyOpen: false }), false);
    assert.equal(isAdmissibleSkillEvidence(post, { cutoff: CUTOFF, legacyOpen: true }), false);
  });

  it("keeps the trust bonus separate from admission", () => {
    assert.equal(isTrustedSkillEvidence({ epistemicStatus: "observed" }), false);
    assert.equal(isTrustedSkillEvidence({ epistemicStatus: "corroborated" }), true);
    assert.equal(isAdmissibleSkillEvidence({ epistemicStatus: "observed" }, { legacyOpen: false }), true);
  });

  it("computes weakest evidence grades including norole", () => {
    assert.equal(skillEvidenceGrade([
      { epistemicStatus: "trusted", sourceMessageRole: "user" },
      { epistemicStatus: "observed", sourceMessageRole: "user" },
    ]), "observed");
    assert.equal(skillEvidenceGrade([
      { epistemicStatus: "", sourceMessageRole: "user" },
      { epistemicStatus: "observed", sourceMessageRole: "user" },
    ]), "unreviewed-legacy");
    assert.equal(skillEvidenceGrade([
      { epistemicStatus: "", sourceMessageRole: "" },
      { epistemicStatus: "", sourceMessageRole: "user" },
    ]), "unreviewed-legacy-norole");
  });
});

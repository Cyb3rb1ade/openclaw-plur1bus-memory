import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { autoApproveAndApplyLowRisk } from "../lib/obsidian-control-room.js";
import { createOwnedReviewBundle, loadOwnedReviewBundle } from "../lib/obsidian-review-authority.js";
import { confirmedObsidianPolicy } from "./helpers/obsidian-mutation-policy.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const hashOf = (payload) => `sha256:${createHash("sha256").update(stableJson(payload)).digest("hex")}`;

function noteItem(id, text) {
  const payload = { text, category: "fact", sourceTrustLevel: "untrusted_obsidian" };
  return {
    id,
    type: "note_import_candidate",
    status: "pending",
    risk: "low",
    adversarialReview: { status: "pass" },
    proposedByAgent: "test-agent",
    target: "",
    action: "Review immutable MemoryCandidate summary before promotion.",
    reason: "test",
    evidence: [text],
    applyPreview: { payload, payloadHash: hashOf(payload) },
  };
}

function bundle(bundleId, items) {
  return {
    bundle: {
      bundleId,
      status: "pending_user_review",
      createdAt: new Date().toISOString(),
      createdByAgent: "test-agent",
      workspaceKey: "workspace:v1:test-ws",
    },
    items,
    hygieneItems: [],
    maintenance: { findings: [] },
  };
}

describe("Review auto-apply: Freigabe-Hash", () => {
  it("übernimmt Notiz-Vorschläge, statt sie als invalid zu verwerfen", async () => {
    const dir = makeTempDir("obs-autoapply-");
    const policy = confirmedObsidianPolicy({ baseDbPath: dir });
    const bundleId = `rb-${randomUUID()}`;
    createOwnedReviewBundle({
      policy,
      bundleId,
      bundle: bundle(bundleId, [noteItem("rbi-note-001", "Notiz eins: Inhalt"), noteItem("rbi-note-002", "Notiz zwei: Inhalt")]),
    });
    const stored = [];
    const result = await autoApproveAndApplyLowRisk({ vaultPath: dir, autoApplyLowRisk: true }, bundleId, {
      mutationPolicy: policy,
      memoryStore: async ({ item }) => {
        stored.push(item.id);
        return { memoryId: `mem-${item.id}` };
      },
    });

    const saved = loadOwnedReviewBundle({ policy, bundleId });
    assert.deepEqual(saved.items.map((i) => [i.status, i.blockedReason || ""]), [["applied", ""], ["applied", ""]]);
    assert.equal(result.autoApplied, 2);
    assert.deepEqual(stored, ["rbi-note-001", "rbi-note-002"]);
    for (const item of saved.items) {
      assert.equal(item.approvedPayloadHash, item.applyPreview.payloadHash);
      assert.equal(item.approvalMetadata.approvalSource, "auto_low_risk");
      assert.equal(item.approvedBy, "auto");
    }
  });

  it("verwirft weiterhin Vorschläge, deren Payload nach dem Review verändert wurde", async () => {
    const dir = makeTempDir("obs-autoapply-");
    const policy = confirmedObsidianPolicy({ baseDbPath: dir });
    const bundleId = `rb-${randomUUID()}`;
    const drifted = noteItem("rbi-note-003", "Original: Inhalt");
    drifted.applyPreview.payload.text = "Manipuliert: Inhalt";
    createOwnedReviewBundle({ policy, bundleId, bundle: bundle(bundleId, [drifted]) });
    const result = await autoApproveAndApplyLowRisk({ vaultPath: dir, autoApplyLowRisk: true }, bundleId, {
      mutationPolicy: policy,
      memoryStore: async () => assert.fail("darf nicht schreiben"),
    });
    const saved = loadOwnedReviewBundle({ policy, bundleId });
    assert.equal(result.autoApplied, 0);
    assert.equal(saved.items[0].status, "invalid");
    assert.equal(saved.items[0].blockedReason, "applyPreview payload hash drift");
  });
});

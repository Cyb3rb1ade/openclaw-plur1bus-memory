import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseObsidianCommandPlan } from "../lib/obsidian-mutation-policy.js";
import {
  createOwnedReviewBundle,
  loadOwnedReviewBundle,
  latestOwnedReviewBundleId,
  updateOwnedReviewBundle,
} from "../lib/obsidian-review-authority.js";

function memoryCtx(agentId, workspaceIdentity) {
  return {
    agentId,
    workspaceIdentity,
    userPrincipal: "",
    conversationPrincipal: "chat",
  };
}

function reviewPolicy(baseDbPath, agentId, workspaceIdentity) {
  return parseObsidianCommandPlan(["review", "prepare"], {
    memoryCtx: memoryCtx(agentId, workspaceIdentity),
    baseDbPath,
    mode: "apply",
    allowWrite: true,
    vaultConfirmed: true,
    actionConfirmed: true,
  }).mutationPolicy;
}

describe("B14 protected review authority", () => {
  it("uses collision-resistant IDs and physically partitions two agents sharing one vault", () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "b14-review-authority-"));
    const workspaceIdentity = "workspace:v1:shared";
    const policyA = reviewPolicy(baseDbPath, "agent-a", workspaceIdentity);
    const policyB = reviewPolicy(baseDbPath, "agent-b", workspaceIdentity);

    const a = createOwnedReviewBundle({
      policy: policyA,
      bundle: { status: "pending_user_review", items: [{ id: "a-item", status: "pending" }] },
    });
    const b = createOwnedReviewBundle({
      policy: policyB,
      bundle: { status: "pending_user_review", items: [{ id: "b-item", status: "pending" }] },
    });

    assert.match(a.bundleId, /^rb-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(b.bundleId, /^rb-[0-9a-f-]{36}$/);
    assert.notEqual(a.bundleId, b.bundleId);
    assert.notEqual(a.path, b.path);
    assert.equal(latestOwnedReviewBundleId({ policy: policyA }), a.bundleId);
    assert.equal(latestOwnedReviewBundleId({ policy: policyB }), b.bundleId);
  });

  it("makes foreign explicit IDs indistinguishable from not-found on load and update", () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "b14-review-owner-"));
    const workspaceIdentity = "workspace:v1:shared";
    const policyA = reviewPolicy(baseDbPath, "agent-a", workspaceIdentity);
    const policyB = reviewPolicy(baseDbPath, "agent-b", workspaceIdentity);
    const a = createOwnedReviewBundle({
      policy: policyA,
      bundle: { status: "pending_user_review", items: [] },
    });

    assert.equal(loadOwnedReviewBundle({ policy: policyB, bundleId: a.bundleId }), null);
    assert.equal(
      updateOwnedReviewBundle({
        policy: policyB,
        bundleId: a.bundleId,
        update: (record) => ({ ...record, status: "approved" }),
      }),
      null,
    );
    assert.equal(loadOwnedReviewBundle({ policy: policyA, bundleId: a.bundleId }).status, "pending_user_review");
  });

  it("does not trust vault display JSON to change protected payload or approval", () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "b14-review-tamper-"));
    const policy = reviewPolicy(baseDbPath, "agent-a", "workspace:v1:shared");
    const created = createOwnedReviewBundle({
      policy,
      bundle: {
        status: "pending_user_review",
        items: [{ id: "item", status: "pending", payload: { text: "protected" } }],
      },
    });
    const vaultDisplay = join(baseDbPath, "display-only.json");
    writeFileSync(vaultDisplay, JSON.stringify({
      status: "approved",
      items: [{ id: "item", status: "approved", payload: { text: "tampered" } }],
    }));

    const loaded = loadOwnedReviewBundle({ policy, bundleId: created.bundleId });
    assert.equal(loaded.status, "pending_user_review");
    assert.equal(loaded.items[0].status, "pending");
    assert.equal(loaded.items[0].payload.text, "protected");
    assert.equal(JSON.parse(readFileSync(vaultDisplay, "utf8")).status, "approved");
  });

  it("performs zero writes when policy is missing or denied", () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "b14-review-denied-"));
    assert.throws(
      () => createOwnedReviewBundle({ policy: null, bundle: { status: "pending_user_review" } }),
      /mutation policy required/i,
    );
    const denied = parseObsidianCommandPlan(["review", "prepare"], {
      memoryCtx: memoryCtx("agent-a", "workspace:v1:shared"),
      baseDbPath,
      mode: "augment",
      allowWrite: true,
      vaultConfirmed: true,
      actionConfirmed: true,
    }).mutationPolicy;
    assert.throws(
      () => createOwnedReviewBundle({ policy: denied, bundle: { status: "pending_user_review" } }),
      /mutation denied/i,
    );
    assert.equal(latestOwnedReviewBundleId({ policy: denied }), "");
  });
});

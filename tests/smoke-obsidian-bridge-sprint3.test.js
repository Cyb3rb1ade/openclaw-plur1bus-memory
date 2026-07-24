import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  expireStaleBundles,
  autoApproveAndApplyLowRisk,
} from "../lib/obsidian-control-room.js";
import {
  createOwnedReviewBundle,
  loadOwnedReviewBundle,
} from "../lib/obsidian-review-authority.js";
import { confirmedObsidianPolicy } from "./helpers/obsidian-mutation-policy.js";

// Bundle records live at {vaultPath}/plur1bus/review-bundles/{bundleId}.items.json
function writeBundleRecord(_vaultPath, bundleId, record, policy) {
  createOwnedReviewBundle({ policy, bundleId, bundle: record });
}

function readBundleRecord(_vaultPath, bundleId, policy) {
  return loadOwnedReviewBundle({ policy, bundleId });
}

function makeItem(overrides = {}) {
  return {
    id: `rbi-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "task_suggestion",
    status: "pending",
    risk: "low",
    adversarialReview: { status: "pass" },
    proposedByAgent: "test-agent",
    target: "",
    action: "add test data",
    reason: "auto-test task",
    ...overrides,
  };
}

function makeBundle(bundleId, items, overrides = {}) {
  return {
    bundle: {
      bundleId,
      status: "pending_user_review",
      createdAt: new Date().toISOString(),
      createdByAgent: "test-agent",
      workspaceKey: "workspace:v1:test-ws",
      ...overrides,
    },
    items,
    hygieneItems: [],
    maintenance: { findings: [] },
  };
}

describe("smoke-obsidian-bridge-sprint3", () => {
  // ---------------------------------------------------------------
  // D1/B: expireStaleBundles
  // ---------------------------------------------------------------

  it("expireStaleBundles: bundle older than maxAgeDays is expired", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const policy = confirmedObsidianPolicy({ baseDbPath: dir });
    const now = new Date("2026-06-08T12:00:00.000Z");
    const old = new Date(now - 8 * 86_400_000).toISOString(); // 8 days ago
    const bundleId = `rb-${randomUUID()}`;
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [makeItem()], { createdAt: old }), policy);

    const result = expireStaleBundles({ vaultPath: dir }, { staleBundleMaxAgeDays: 7, now, mutationPolicy: policy });

    assert.strictEqual(result.expired, 1, "expired count should be 1");
    assert.ok(result.expiredIds.includes(bundleId), "expiredIds should include bundleId");
    const saved = readBundleRecord(dir, bundleId, policy);
    assert.strictEqual(saved.bundle.status, "expired", "bundle.status should be 'expired'");
    assert.ok(saved.items.every((i) => i.status === "rejected"), "all items should be rejected");
  });

  it("expireStaleBundles: bundle younger than maxAgeDays is untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const policy = confirmedObsidianPolicy({ baseDbPath: dir });
    const now = new Date("2026-06-08T12:00:00.000Z");
    const recent = new Date(now - 3 * 86_400_000).toISOString(); // 3 days ago
    const bundleId = `rb-${randomUUID()}`;
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [makeItem()], { createdAt: recent }), policy);

    const result = expireStaleBundles({ vaultPath: dir }, { staleBundleMaxAgeDays: 7, now, mutationPolicy: policy });

    assert.strictEqual(result.expired, 0, "should not expire recent bundle");
    const saved = readBundleRecord(dir, bundleId, policy);
    assert.strictEqual(saved.bundle.status, "pending_user_review", "bundle.status should remain pending");
    assert.strictEqual(saved.items[0].status, "pending", "item status should remain pending");
  });

  // ---------------------------------------------------------------
  // D1/A: autoApproveAndApplyLowRisk
  // ---------------------------------------------------------------

  it("autoApproveAndApplyLowRisk: low-risk+pass items are approved and applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const policy = confirmedObsidianPolicy({ baseDbPath: dir });
    const bundleId = `rb-${randomUUID()}`;
    const item1 = makeItem({ id: "rbi-auto-001" });
    const item2 = makeItem({ id: "rbi-auto-002" });
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [item1, item2]), policy);

    const result = await autoApproveAndApplyLowRisk(
      { vaultPath: dir, autoApplyLowRisk: true },
      bundleId,
      { mutationPolicy: policy }
    );

    assert.strictEqual(result.autoApproved, 2, "autoApproved should be 2");
    assert.strictEqual(result.autoApplied, 2, "autoApplied should be 2");
    const saved = readBundleRecord(dir, bundleId, policy);
    assert.ok(saved.items.every((i) => i.status === "applied"), "all items should be applied");
  });

  it("autoApproveAndApplyLowRisk: medium-risk items are skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const policy = confirmedObsidianPolicy({ baseDbPath: dir });
    const bundleId = `rb-${randomUUID()}`;
    const item = makeItem({ id: "rbi-med-001", risk: "medium" });
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [item]), policy);

    const result = await autoApproveAndApplyLowRisk(
      { vaultPath: dir, autoApplyLowRisk: true },
      bundleId,
      { mutationPolicy: policy }
    );

    assert.strictEqual(result.autoApproved, 0, "medium-risk items should not be auto-approved");
    assert.strictEqual(result.autoApplied, 0, "medium-risk items should not be auto-applied");
    const saved = readBundleRecord(dir, bundleId, policy);
    assert.strictEqual(saved.items[0].status, "pending", "item should remain pending");
  });

  it("autoApproveAndApplyLowRisk: adversarial-fail items are skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const policy = confirmedObsidianPolicy({ baseDbPath: dir });
    const bundleId = `rb-${randomUUID()}`;
    const item = makeItem({ id: "rbi-fail-001", adversarialReview: { status: "fail" } });
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [item]), policy);

    const result = await autoApproveAndApplyLowRisk(
      { vaultPath: dir, autoApplyLowRisk: true },
      bundleId,
      { mutationPolicy: policy }
    );

    assert.strictEqual(result.autoApproved, 0, "adversarial-fail items should not be auto-approved");
    const saved = readBundleRecord(dir, bundleId, policy);
    assert.strictEqual(saved.items[0].status, "pending", "adversarial-fail item must remain pending");
  });

  it("autoApproveAndApplyLowRisk: gate=false (default) is a no-op", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const policy = confirmedObsidianPolicy({ baseDbPath: dir });
    const bundleId = `rb-${randomUUID()}`;
    const item = makeItem({ id: "rbi-gate-001" });
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [item]), policy);

    const result = await autoApproveAndApplyLowRisk(
      { vaultPath: dir, autoApplyLowRisk: false },
      bundleId,
      { mutationPolicy: policy }
    );

    assert.strictEqual(result.autoApproved, 0, "gate=false must be a no-op");
    const saved = readBundleRecord(dir, bundleId, policy);
    assert.strictEqual(saved.items[0].status, "pending", "item should remain pending with gate off");
  });

  it("autoApproveAndApplyLowRisk: vault_hygiene items are not auto-approved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const policy = confirmedObsidianPolicy({ baseDbPath: dir });
    const bundleId = `rb-${randomUUID()}`;
    const item = makeItem({ id: "rbi-hygiene-001", type: "vault_hygiene" });
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [item]), policy);

    const result = await autoApproveAndApplyLowRisk(
      { vaultPath: dir, autoApplyLowRisk: true },
      bundleId,
      { mutationPolicy: policy }
    );

    assert.strictEqual(result.autoApproved, 0, "vault_hygiene items must not be auto-approved");
    const saved = readBundleRecord(dir, bundleId, policy);
    assert.strictEqual(saved.items[0].status, "pending", "vault_hygiene item must remain pending");
  });
});

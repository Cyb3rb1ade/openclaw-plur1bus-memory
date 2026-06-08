import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expireStaleBundles,
  autoApproveAndApplyLowRisk,
} from "../lib/obsidian-control-room.js";

// Bundle records live at {vaultPath}/plur1bus/review-bundles/{bundleId}.items.json
function writeBundleRecord(vaultPath, bundleId, record) {
  const dir = join(vaultPath, "plur1bus", "review-bundles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${bundleId}.items.json`), JSON.stringify(record, null, 2), "utf8");
}

function readBundleRecord(vaultPath, bundleId) {
  return JSON.parse(
    readFileSync(join(vaultPath, "plur1bus", "review-bundles", `${bundleId}.items.json`), "utf8")
  );
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
      agentId: "test-agent",
      workspaceKey: "test-ws",
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
    const now = new Date("2026-06-08T12:00:00.000Z");
    const old = new Date(now - 8 * 86_400_000).toISOString(); // 8 days ago
    const bundleId = "rb-expire-old";
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [makeItem()], { createdAt: old }));

    const result = expireStaleBundles({ vaultPath: dir }, { staleBundleMaxAgeDays: 7, now });

    assert.strictEqual(result.expired, 1, "expired count should be 1");
    assert.ok(result.expiredIds.includes(bundleId), "expiredIds should include bundleId");
    const saved = readBundleRecord(dir, bundleId);
    assert.strictEqual(saved.bundle.status, "expired", "bundle.status should be 'expired'");
    assert.ok(saved.items.every((i) => i.status === "rejected"), "all items should be rejected");
  });

  it("expireStaleBundles: bundle younger than maxAgeDays is untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const now = new Date("2026-06-08T12:00:00.000Z");
    const recent = new Date(now - 3 * 86_400_000).toISOString(); // 3 days ago
    const bundleId = "rb-expire-recent";
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [makeItem()], { createdAt: recent }));

    const result = expireStaleBundles({ vaultPath: dir }, { staleBundleMaxAgeDays: 7, now });

    assert.strictEqual(result.expired, 0, "should not expire recent bundle");
    const saved = readBundleRecord(dir, bundleId);
    assert.strictEqual(saved.bundle.status, "pending_user_review", "bundle.status should remain pending");
    assert.strictEqual(saved.items[0].status, "pending", "item status should remain pending");
  });

  // ---------------------------------------------------------------
  // D1/A: autoApproveAndApplyLowRisk
  // ---------------------------------------------------------------

  it("autoApproveAndApplyLowRisk: low-risk+pass items are approved and applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const bundleId = "rb-auto-apply";
    const item1 = makeItem({ id: "rbi-auto-001" });
    const item2 = makeItem({ id: "rbi-auto-002" });
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [item1, item2]));

    const result = await autoApproveAndApplyLowRisk(
      { vaultPath: dir, autoApplyLowRisk: true },
      bundleId,
      {}
    );

    assert.strictEqual(result.autoApproved, 2, "autoApproved should be 2");
    assert.strictEqual(result.autoApplied, 2, "autoApplied should be 2");
    const saved = readBundleRecord(dir, bundleId);
    assert.ok(saved.items.every((i) => i.status === "applied"), "all items should be applied");
  });

  it("autoApproveAndApplyLowRisk: medium-risk items are skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const bundleId = "rb-medium-skip";
    const item = makeItem({ id: "rbi-med-001", risk: "medium" });
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [item]));

    const result = await autoApproveAndApplyLowRisk(
      { vaultPath: dir, autoApplyLowRisk: true },
      bundleId,
      {}
    );

    assert.strictEqual(result.autoApproved, 0, "medium-risk items should not be auto-approved");
    assert.strictEqual(result.autoApplied, 0, "medium-risk items should not be auto-applied");
    const saved = readBundleRecord(dir, bundleId);
    assert.strictEqual(saved.items[0].status, "pending", "item should remain pending");
  });

  it("autoApproveAndApplyLowRisk: adversarial-fail items are skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const bundleId = "rb-adv-fail";
    const item = makeItem({ id: "rbi-fail-001", adversarialReview: { status: "fail" } });
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [item]));

    const result = await autoApproveAndApplyLowRisk(
      { vaultPath: dir, autoApplyLowRisk: true },
      bundleId,
      {}
    );

    assert.strictEqual(result.autoApproved, 0, "adversarial-fail items should not be auto-approved");
    const saved = readBundleRecord(dir, bundleId);
    assert.strictEqual(saved.items[0].status, "pending", "adversarial-fail item must remain pending");
  });

  it("autoApproveAndApplyLowRisk: gate=false (default) is a no-op", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const bundleId = "rb-gate-off";
    const item = makeItem({ id: "rbi-gate-001" });
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [item]));

    const result = await autoApproveAndApplyLowRisk(
      { vaultPath: dir, autoApplyLowRisk: false },
      bundleId,
      {}
    );

    assert.strictEqual(result.autoApproved, 0, "gate=false must be a no-op");
    const saved = readBundleRecord(dir, bundleId);
    assert.strictEqual(saved.items[0].status, "pending", "item should remain pending with gate off");
  });
});

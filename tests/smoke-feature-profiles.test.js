import { describe, it } from "node:test";
import assert from "node:assert";

import {
  recommendedProfile,
  safeProfile,
  customProfileFromSelection,
  applyFeatureProfile,
  detectPendingFeatures,
  isApplyBlocked,
} from "../lib/setup/feature-profiles.js";

describe("feature-profiles", () => {
  it("recommendedProfile has all features enabled but pending_setup where needed", () => {
    const p = recommendedProfile();
    assert.strictEqual(p.setupProfile, "recommended");
    assert.strictEqual(p.featuresConfirmedAt, null);
    assert.strictEqual(p.morningReview.enabled, true);
    assert.strictEqual(p.morningReview.status, "pending_setup");
    assert.strictEqual(p.eveningReview.enabled, true);
    assert.strictEqual(p.eveningReview.status, "pending_setup");
    assert.strictEqual(p.reranker.enabled, true);
    assert.strictEqual(p.reranker.fallbackOnError, true);
    assert.strictEqual(p.merging.enabled, true);
    assert.strictEqual(p.merging.autoApply, false);
    assert.strictEqual(p.schicht15.enabled, true);
    assert.strictEqual(p.obsidianBridge.enabled, true);
    assert.strictEqual(p.obsidianBridge.status, "pending_setup");
  });

  it("safeProfile has only core features", () => {
    const p = safeProfile();
    assert.strictEqual(p.setupProfile, "safe");
    assert.strictEqual(p.morningReview.enabled, false);
    assert.strictEqual(p.reranker.enabled, false);
    assert.strictEqual(p.merging.enabled, false);
    assert.strictEqual(p.obsidianBridge.mode, "dry-run");
  });

  it("customProfileFromSelection merges user choices", () => {
    const p = customProfileFromSelection({ morningReview: true, reranker: { enabled: true, timeoutMs: 5000 } });
    assert.strictEqual(p.setupProfile, "custom");
    assert.strictEqual(p.morningReview.enabled, true);
    assert.strictEqual(p.reranker.enabled, true);
    assert.strictEqual(p.reranker.timeoutMs, 5000);
    assert.strictEqual(p.merging.enabled, false);
  });

  it("applyFeatureProfile merges only missing keys", () => {
    const existing = { plugins: { entries: { "memory-lancedb-namespaced": { enabled: true, config: { reranker: { enabled: false } } } } } };
    const merged = applyFeatureProfile(existing, recommendedProfile());
    const cfg = merged.plugins.entries["memory-lancedb-namespaced"].config;
    assert.strictEqual(cfg.reranker.enabled, false, "existing reranker should not be overwritten");
    assert.strictEqual(cfg.merging.enabled, true, "merging should be added");
  });

  it("applyFeatureProfile sets featuresConfirmedAt when confirmed", () => {
    const existing = {};
    const merged = applyFeatureProfile(existing, recommendedProfile(), { confirmed: true });
    const cfg = merged.plugins.entries["memory-lancedb-namespaced"].config;
    assert.ok(cfg.featuresConfirmedAt, "should set featuresConfirmedAt");
  });

  it("detectPendingFeatures finds pending setup items", () => {
    const config = {
      morningReview: { enabled: true, status: "pending_setup" },
      eveningReview: { enabled: true, status: "pending_setup" },
      obsidianBridge: { enabled: true, status: "active" },
    };
    const pending = detectPendingFeatures(config);
    assert.strictEqual(pending.length, 2, "should find 2 pending");
    assert.ok(pending.some((p) => p.feature === "morningReview"));
  });

  it("isApplyBlocked when features not confirmed", () => {
    const config = { merging: { enabled: true } };
    const result = isApplyBlocked(config);
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.reason, "features_not_confirmed");
  });

  it("isApplyBlocked when pending setup exists", () => {
    const config = { featuresConfirmedAt: "2026-06-03", morningReview: { enabled: true, status: "pending_setup" } };
    const result = isApplyBlocked(config);
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.reason, "pending_setup");
  });

  it("isApplyBlocked returns false when everything ok", () => {
    const config = { featuresConfirmedAt: "2026-06-03", morningReview: { enabled: true, status: "active" } };
    const result = isApplyBlocked(config);
    assert.strictEqual(result.blocked, false);
  });
});

/**
 * Smoke-Test: Full Recommended Mode Integration
 *
 * Verifiziert die wichtigsten Szenarien aus dem Recommended Profile:
 *   1. Recommended Profile erkannt
 *   2. Rate-Limit für Daily Consolidation
 *   3. Status Command: echte cardCount, transparenter Sync
 *   4. Feature Confirmation Gate blockiert Apply
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recommendedProfile, applyFeatureProfile, isApplyBlocked, detectPendingFeatures } from "../lib/setup/feature-profiles.js";
import { checkJobRateLimit, recordJobRun } from "../lib/job-rate-limit.js";
import { collectStatusData } from "../lib/telegram-commands/status-data.js";

describe("recommended-mode-full", () => {
  it("recommendedProfile has all features enabled with pending_setup where needed", () => {
    const p = recommendedProfile();
    assert.strictEqual(p.setupProfile, "recommended");
    assert.strictEqual(p.featuresConfirmedAt, null);
    assert.strictEqual(p.morningReview.enabled, true);
    assert.strictEqual(p.morningReview.status, "pending_setup");
    assert.strictEqual(p.eveningReview.enabled, true);
    assert.strictEqual(p.eveningReview.status, "pending_setup");
    assert.strictEqual(p.reranker.enabled, true);
    assert.strictEqual(p.reranker.fallbackOnError, true);
    assert.strictEqual(p.reranker.timeoutMs, 2500);
    assert.strictEqual(p.merging.enabled, true);
    assert.strictEqual(p.merging.autoApply, false);
    assert.strictEqual(p.schicht15.enabled, true);
    assert.strictEqual(p.obsidianBridge.enabled, true);
    assert.strictEqual(p.obsidianBridge.status, "pending_setup");
  });

  it("applyFeatureProfile merges only missing keys", () => {
    const existing = { plugins: { entries: { "memory-lancedb-namespaced": { enabled: true, config: { reranker: { enabled: false } } } } } };
    const merged = applyFeatureProfile(existing, recommendedProfile());
    const cfg = merged.plugins.entries["memory-lancedb-namespaced"].config;
    assert.strictEqual(cfg.reranker.enabled, false, "existing key preserved");
    assert.strictEqual(cfg.schicht15.enabled, true, "missing key added");
  });

  it("isApplyBlocked when features not confirmed", () => {
    const p = recommendedProfile();
    const blocked = isApplyBlocked(p);
    assert.strictEqual(blocked.blocked, true);
    assert.strictEqual(blocked.reason, "features_not_confirmed");
  });

  it("isApplyBlocked when pending setup exists", () => {
    const p = { ...recommendedProfile(), featuresConfirmedAt: new Date().toISOString() };
    const blocked = isApplyBlocked(p);
    assert.strictEqual(blocked.blocked, true);
    assert.strictEqual(blocked.reason, "pending_setup");
    assert.ok(blocked.pending.length > 0);
  });

  it("daily consolidation rate limit prevents double run", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-rate-"));
    const statePath = join(dir, "run-state.json");
    const agent = "test-agent";
    const ws = "test-ws";

    // First run allowed
    const first = checkJobRateLimit("daily-consolidation", agent, ws, 24 * 60 * 60 * 1000, statePath);
    assert.strictEqual(first.allowed, true);

    // Record run
    recordJobRun("daily-consolidation", agent, ws, statePath);

    // Second run blocked
    const second = checkJobRateLimit("daily-consolidation", agent, ws, 24 * 60 * 60 * 1000, statePath);
    assert.strictEqual(second.allowed, false);
  });

  it("status command shows real cardCount and transparent sync", () => {
    const status = collectStatusData({
      memoryStats: { cardCount: 42, lastUpdateMinutes: 5 },
      syncStats: { active: null, devices: 0, status: "nicht konfiguriert" },
    });
    assert.strictEqual(status.memory.cardCount, 42);
    assert.strictEqual(status.sync.status, "nicht konfiguriert");
    assert.ok(Array.isArray(status.issues));
  });

  it("status command honest when sync not integrated", () => {
    const status = collectStatusData({
      memoryStats: { cardCount: null, lastUpdateMinutes: null },
    });
    assert.strictEqual(status.memory.cardCount, null);
    assert.strictEqual(status.sync.status, "nicht konfiguriert");
  });
});

/**
 * Smoke-Test: Full Recommended Mode Integration
 *
 * Verifiziert die wichtigsten Szenarien aus dem Recommended Profile:
 *   1. Recommended Profile erkannt
 *   2. Rate-Limit für Daily Consolidation
 *   3. Status Command: echte cardCount, transparenter Sync
 *   4. Normal effective config loading writes no feature-selection history
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recommendedProfile, applyFeatureProfile, isApplyBlocked, detectPendingFeatures, reportDormantFeature } from "../lib/setup/feature-profiles.js";
import { checkJobRateLimit, recordJobRun } from "../lib/job-rate-limit.js";
import { collectStatusData } from "../lib/telegram-commands/status-data.js";

describe("recommended-mode-full", () => {
  it("recommendedProfile enables advanced features behind required safety gates", () => {
    const p = recommendedProfile();
    assert.strictEqual(p.obsidianBridge.morningReview.enabled, true);
    assert.strictEqual(p.obsidianBridge.morningReview.status, "pending_setup");
    assert.strictEqual(p.obsidianBridge.eveningReview.enabled, true);
    assert.strictEqual(p.obsidianBridge.eveningReview.status, "pending_setup");
    assert.strictEqual(p.reranker.enabled, true);
    assert.strictEqual(p.reranker.fallbackOnError, true);
    assert.strictEqual(p.reranker.timeoutMs, 5000);
    assert.strictEqual(p.merging.enabled, true);
    assert.strictEqual(p.merging.autoApply, false);
    assert.strictEqual(p.merging.autoApplyRisk, "low-only");
    assert.strictEqual(p.schicht15.enabled, true);
    assert.strictEqual(p.obsidianBridge.enabled, true);
    assert.strictEqual(p.obsidianBridge.requireVaultPathConfirmation, true);
    assert.strictEqual(p.temporalContext.enabled, true);
    assert.strictEqual(p.metaCognition.enabled, true);
  });

  it("applyFeatureProfile merges only missing keys", () => {
    const existing = { plugins: { entries: { "memory-lancedb-namespaced": { enabled: true, config: { reranker: { enabled: false } } } } } };
    const merged = applyFeatureProfile(existing, recommendedProfile());
    const cfg = merged.plugins.entries["memory-lancedb-namespaced"].config;
    assert.strictEqual(cfg.reranker.enabled, false, "existing key preserved");
    assert.strictEqual(cfg.schicht15.enabled, true, "missing key added");
  });

  it("isApplyBlocked does not require feature-selection history", () => {
    const p = { merging: { enabled: true } };
    const blocked = isApplyBlocked(p);
    assert.strictEqual(blocked.blocked, false);
  });

  it("isApplyBlocked when pending setup exists", () => {
    const p = { obsidianBridge: { morningReview: { enabled: true, status: "pending_setup" } } };
    const blocked = isApplyBlocked(p);
    assert.strictEqual(blocked.blocked, true);
    assert.strictEqual(blocked.reason, "pending_setup");
    assert.ok(blocked.pending.length > 0);
  });

  it("daily consolidation rate limit prevents double run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-rate-"));
    const statePath = join(dir, "run-state.json");
    const agent = "test-agent";
    const ws = "test-ws";

    // First run allowed
    const first = checkJobRateLimit("daily-consolidation", agent, ws, 24 * 60 * 60 * 1000, statePath);
    assert.strictEqual(first.allowed, true);

    // Record run
    await recordJobRun("daily-consolidation", agent, ws, statePath);

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

describe("dormant feature reporting", () => {
  function collect() {
    const lines = { warn: [], info: [] };
    return { logger: { warn: (m) => lines.warn.push(m), info: (m) => lines.info.push(m) }, lines };
  }

  it("warns only when the operator explicitly enabled the feature", () => {
    // Opt-out means "on" no longer implies "requested". Warning every user on
    // every start about a feature they never asked for is noise, and the
    // matrix evidence gate rightly treats warn-level plugin lines as failures.
    const explicit = collect();
    reportDormantFeature(explicit.logger, { explicit: true, message: "needs a route" });
    assert.deepStrictEqual(explicit.lines.warn, ["needs a route"]);
    assert.deepStrictEqual(explicit.lines.info, []);

    const byDefault = collect();
    reportDormantFeature(byDefault.logger, { explicit: false, message: "needs a route" });
    assert.deepStrictEqual(byDefault.lines.warn, []);
    assert.deepStrictEqual(byDefault.lines.info, ["needs a route"]);

    const unknown = collect();
    reportDormantFeature(unknown.logger, { message: "needs a route" });
    assert.deepStrictEqual(unknown.lines.warn, [], "an unknown origin is treated as a default");
  });

  it("stays silent without a message and survives a logger without levels", () => {
    const c = collect();
    reportDormantFeature(c.logger, { explicit: true });
    assert.deepStrictEqual(c.lines.warn, []);
    assert.doesNotThrow(() => reportDormantFeature({}, { explicit: true, message: "x" }));
    assert.doesNotThrow(() => reportDormantFeature(null, { explicit: false, message: "x" }));
  });
});

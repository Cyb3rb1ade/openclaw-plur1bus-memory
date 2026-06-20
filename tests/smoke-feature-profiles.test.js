import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  recommendedProfile,
  safeProfile,
  customProfileFromSelection,
  applyFeatureProfile,
  detectPendingFeatures,
  isApplyBlocked,
  DEFAULT_WS_SUFFIXES,
  PLUR1BUS_START_NOTICE,
  applyFullExperiencePolicy,
  consumePlur1busStartNotice,
  detectMissingCoreFeatures,
  fullExperienceDefaults,
  renderPlur1busStartStatus,
  writePlur1busStartNotice,
} from "../lib/setup/feature-profiles.js";

describe("feature-profiles", () => {
  it("recommendedProfile enables the full experience without pending setup by default", () => {
    const p = recommendedProfile();
    assert.strictEqual(p.morningReview.enabled, true);
    assert.strictEqual(p.morningReview.status, "active");
    assert.strictEqual(p.eveningReview.enabled, true);
    assert.strictEqual(p.eveningReview.status, "active");
    assert.strictEqual(p.reranker.enabled, true);
    assert.strictEqual(p.reranker.fallbackOnError, true);
    assert.strictEqual(p.merging.enabled, true);
    assert.strictEqual(p.merging.autoApply, true);
    assert.strictEqual(p.merging.autoApplyRisk, "low-only");
    assert.strictEqual(p.schicht15.enabled, true);
    assert.strictEqual(p.obsidianBridge.enabled, true);
    assert.strictEqual(p.obsidianBridge.requireVaultPathConfirmation, false);
    assert.strictEqual(p.temporalContext.enabled, true);
    assert.strictEqual(p.runtime.embeddingCacheEnabled, true);
    assert.strictEqual(p.emotion.t3.enabled, true);
    assert.strictEqual(p.metaCognition.enabled, true);
    assert.strictEqual(p.obsidianBridge.semanticGraph.mutateMemory, false);
    assert.strictEqual(p.obsidianBridge.soulPatch.force, false);
  });

  it("safeProfile has only core features", () => {
    const p = safeProfile();
    assert.strictEqual(p.morningReview.enabled, false);
    assert.strictEqual(p.reranker.enabled, false);
    assert.strictEqual(p.merging.enabled, false);
    assert.strictEqual(p.obsidianBridge.mode, "dry-run");
  });

  it("customProfileFromSelection merges user choices", () => {
    const p = customProfileFromSelection({ morningReview: true, reranker: { enabled: true, timeoutMs: 5000 } });
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

  it("applyFeatureProfile does not write feature-selection history when confirmed", () => {
    const existing = {};
    const merged = applyFeatureProfile(existing, recommendedProfile(), { confirmed: true });
    const cfg = merged.plugins.entries["memory-lancedb-namespaced"].config;
    assert.strictEqual(cfg.featuresConfirmedAt, undefined, "should not write feature-selection history");
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

  it("isApplyBlocked does not require feature-selection confirmation history", () => {
    const config = { merging: { enabled: true } };
    const result = isApplyBlocked(config);
    assert.strictEqual(result.blocked, false);
  });

  it("isApplyBlocked when pending setup exists", () => {
    const config = { featuresConfirmedAt: "2026-06-03", morningReview: { enabled: true, status: "pending_setup" } };
    const result = isApplyBlocked(config);
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.reason, "pending_setup");
  });

  it("isApplyBlocked returns false when everything ok", () => {
    const config = { morningReview: { enabled: true, status: "active" } };
    const result = isApplyBlocked(config);
    assert.strictEqual(result.blocked, false);
  });

  it("applyFeatureProfile with confirmed preserves existing keys without confirmation history", () => {
    const existing = { plugins: { entries: { "memory-lancedb-namespaced": { enabled: true, config: { baseDbPath: "/custom", merging: { enabled: false } } } } } };
    const merged = applyFeatureProfile(existing, recommendedProfile(), { confirmed: true });
    const cfg = merged.plugins.entries["memory-lancedb-namespaced"].config;
    assert.strictEqual(cfg.featuresConfirmedAt, undefined, "does not write confirmation history");
    assert.strictEqual(cfg.baseDbPath, "/custom", "existing baseDbPath preserved");
    assert.strictEqual(cfg.merging.enabled, false, "existing merging not overwritten");
    assert.strictEqual(cfg.temporalContext.enabled, true, "missing new core feature added");
  });

  it("safeProfile blocks obsidian apply mode", () => {
    const p = safeProfile();
    assert.strictEqual(p.obsidianBridge.mode, "dry-run");
    assert.strictEqual(p.obsidianBridge.requireVaultPathConfirmation, false);
  });

  it("recommendedProfile sets obsidianBridge requireVaultPathConfirmation", () => {
    const p = recommendedProfile();
    assert.strictEqual(p.obsidianBridge.requireVaultPathConfirmation, false);
  });

  it("isApplyBlocked with pending_setup features when vault not confirmed", () => {
    const config = {
      obsidianBridge: { enabled: true, requireVaultPathConfirmation: true },
    };
    const result = isApplyBlocked(config);
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.reason, "pending_setup");
    assert.ok(result.pending.some((p) => p.feature === "obsidianBridge"));
  });

  it("applyFeatureProfile does NOT overwrite existing plugin config keys", () => {
    const existing = { plugins: { entries: { "memory-lancedb-namespaced": { enabled: true, config: { reranker: { enabled: false, timeoutMs: 9999 } } } } } };
    const merged = applyFeatureProfile(existing, recommendedProfile(), { confirmed: true });
    const cfg = merged.plugins.entries["memory-lancedb-namespaced"].config;
    assert.strictEqual(cfg.reranker.enabled, false, "existing reranker.enabled preserved");
    assert.strictEqual(cfg.reranker.timeoutMs, 9999, "existing reranker.timeoutMs preserved");
  });

  it("fullExperienceDefaults enables all core feature defaults safely", () => {
    const cfg = fullExperienceDefaults();
    assert.strictEqual(cfg.temporalContext.enabled, true);
    assert.strictEqual(cfg.runtime.embeddingCacheEnabled, true);
    assert.strictEqual(cfg.reranker.enabled, true);
    assert.strictEqual(cfg.emotion.t2.enabled, true);
    assert.strictEqual(cfg.emotion.t3.enabled, true);
    assert.strictEqual(cfg.metaCognition.llmReportMode, "budgeted");
    assert.strictEqual(cfg.merging.autoApplyRisk, "low-only");
    assert.strictEqual(cfg.obsidianBridge.semanticGraph.mutateMemory, false);
    assert.strictEqual(cfg.obsidianBridge.soulPatch.force, false);
  });

  it("applyFullExperiencePolicy preserves existing disabled features during update", () => {
    const cfg = applyFullExperiencePolicy({
      reranker: { enabled: false },
      runtime: { embeddingCacheEnabled: false },
      temporalContext: { enabled: false },
      featurePolicy: { fullExperiencePromptedAt: "never-write" },
      featuresConfirmedAt: "2026-06-03",
    });
    assert.strictEqual(cfg.reranker.enabled, false);
    assert.strictEqual(cfg.runtime.embeddingCacheEnabled, false);
    assert.strictEqual(cfg.temporalContext.enabled, false);
    assert.strictEqual(cfg.merging.enabled, true);
    assert.strictEqual(cfg.featurePolicy, undefined);
    assert.strictEqual(cfg.featuresConfirmedAt, undefined);
  });

  it("applyFullExperiencePolicy can force full experience and apply opt-outs", () => {
    const cfg = applyFullExperiencePolicy(
      {
        baseDbPath: "/custom-memory",
        embedding: { provider: "openai", model: "custom-embedding" },
        reranker: { enabled: false, timeoutMs: 9999 },
        temporalContext: { enabled: false },
      },
      { forceFullExperience: true, disabledFeatures: ["skillMiner", "dailyConsolidation"] }
    );
    assert.strictEqual(cfg.reranker.enabled, true);
    assert.strictEqual(cfg.reranker.timeoutMs, 9999);
    assert.strictEqual(cfg.temporalContext.enabled, true);
    assert.strictEqual(cfg.skillMiner.enabled, false);
    assert.strictEqual(cfg.dailyConsolidation.enabled, false);
    assert.strictEqual(cfg.baseDbPath, "/custom-memory");
    assert.deepStrictEqual(cfg.embedding, { provider: "openai", model: "custom-embedding" });
  });

  it("applyFeatureProfile --full preserves non-feature plugin config", () => {
    const existing = {
      plugins: {
        entries: {
          "memory-lancedb-namespaced": {
            enabled: true,
            config: {
              baseDbPath: "/custom-memory",
              embedding: { provider: "local-transformers", local: { dimensions: 384 } },
              reranker: { enabled: false },
            },
          },
        },
      },
    };
    const merged = applyFeatureProfile(existing, recommendedProfile(), { forceFullExperience: true });
    const cfg = merged.plugins.entries["memory-lancedb-namespaced"].config;
    assert.strictEqual(cfg.reranker.enabled, true);
    assert.strictEqual(cfg.baseDbPath, "/custom-memory");
    assert.deepStrictEqual(cfg.embedding, { provider: "local-transformers", local: { dimensions: 384 } });
  });

  it("detectMissingCoreFeatures reports new core features missing from current config", () => {
    const missing = detectMissingCoreFeatures({ reranker: { enabled: false } });
    assert.ok(missing.some((feature) => feature.key === "temporalContext"));
    assert.ok(missing.some((feature) => feature.key === "embeddingCache"));
  });

  it("start notice is operational state and consume-after-display", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-notice-"));
    try {
      const written = writePlur1busStartNotice(dir);
      assert.strictEqual(written.payload.text, PLUR1BUS_START_NOTICE);
      const first = consumePlur1busStartNotice(dir);
      assert.match(first, /PLUR1BUS — Make your agent yours/);
      assert.match(first, /\/plur1bus start/);
      const second = consumePlur1busStartNotice(dir);
      assert.strictEqual(second, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renderPlur1busStartStatus shows active disabled and Obsidian status compactly", () => {
    const out = renderPlur1busStartStatus(applyFullExperiencePolicy({ skillMiner: { enabled: false } }), {
      vaultPath: "/vault",
      workspaceRoot: "/workspace",
      reviewRoot: "plur1bus",
    });
    assert.match(out, /PLUR1BUS — Make your agent yours!/);
    assert.match(out, /Active: \d+\s+Disabled: \d+\s+New\/missing: \d+/);
    assert.match(out, /Skill Miner/);
    assert.match(out, /Obsidian: vaultPath=\/vault workspaceRoot=\/workspace reviewRoot=plur1bus/);
    assert.match(out, /Use \/plur1bus enable\|disable <feature>\./);
  });

  it("DEFAULT_WS_SUFFIXES does not contain user-specific hardcoded names", () => {
    for (const suffix of DEFAULT_WS_SUFFIXES) {
      assert.ok(!suffix.includes("bernhardine"), "must not contain hardcoded user name bernhardine");
      assert.ok(!suffix.includes("heisenberg"), "must not contain hardcoded user name heisenberg");
    }
  });
});

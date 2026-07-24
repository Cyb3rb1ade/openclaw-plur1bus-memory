import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CORE_FEATURES,
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
import { manifestConfigDefaults, validatePluginConfig } from "../lib/setup/config-contract.js";

describe("feature-profiles", () => {
  it("recommendedProfile explicitly enables additional features behind safety gates", () => {
    const p = recommendedProfile();
    assert.strictEqual(p.setupProfile, "recommended");
    assert.strictEqual(p.obsidianBridge.morningReview.enabled, true);
    assert.strictEqual(p.obsidianBridge.morningReview.status, "pending_setup");
    assert.strictEqual(p.obsidianBridge.eveningReview.enabled, true);
    assert.strictEqual(p.obsidianBridge.eveningReview.status, "pending_setup");
    assert.strictEqual(p.reranker.enabled, true);
    assert.strictEqual(p.reranker.timeoutMs, 5000);
    assert.strictEqual(p.reranker.fallbackOnError, true);
    assert.strictEqual(p.merging.enabled, true);
    assert.strictEqual(p.merging.autoApply, false);
    assert.strictEqual(p.merging.autoApplyRisk, "low-only");
    assert.strictEqual(p.merging.backupBeforeApply, true);
    assert.strictEqual(p.merging.auditLog, true);
    assert.strictEqual(p.schicht15.enabled, true);
    assert.strictEqual(p.obsidianBridge.enabled, true);
    assert.strictEqual(p.obsidianBridge.mode, "augment");
    assert.strictEqual(p.obsidianBridge.dryRun, true);
    assert.strictEqual(p.obsidianBridge.requireVaultPathConfirmation, true);
    assert.strictEqual(p.obsidianBridge.autoApplyLowRisk, false);
    assert.strictEqual(p.temporalContext.enabled, true);
    assert.strictEqual(p.runtime.embeddingCacheEnabled, true);
    assert.strictEqual(p.runtime.llmResultCacheEnabled, true);
    assert.strictEqual(p.emotion.t3.enabled, true);
    assert.strictEqual(p.metaCognition.enabled, true);
    assert.strictEqual(p.obsidianBridge.semanticGraph.mutateMemory, false);
    assert.strictEqual(p.obsidianBridge.soulPatch.force, false);
    for (const route of [p.merging, p.schicht15, p.skillMiner, p.criticalPush, p.emotion.t3]) {
      assert.equal(Object.hasOwn(route, "model"), false);
    }
    assert.equal(Object.hasOwn(p, "llm"), false);
  });

  it("safeProfile is schema-valid, non-mutating, and keeps core capture/recall usable", () => {
    const p = safeProfile();
    validatePluginConfig(p);
    assert.strictEqual(p.setupProfile, "safe");
    assert.strictEqual(p.autoCapture, true);
    assert.strictEqual(p.autoRecall, true);
    assert.strictEqual(p.obsidianBridge.morningReview.enabled, false);
    assert.strictEqual(p.obsidianBridge.eveningReview.enabled, false);
    assert.strictEqual(p.reranker.enabled, false);
    assert.strictEqual(p.emotion.t3.enabled, false);
    assert.strictEqual(p.metaCognition.llmReport, false);
    assert.strictEqual(p.merging.enabled, false);
    assert.strictEqual(p.merging.autoApply, false);
    assert.strictEqual(p.schicht15.enabled, false);
    assert.strictEqual(p.skillMiner.enabled, false);
    assert.strictEqual(p.dailyConsolidation.enabled, false);
    assert.strictEqual(p.criticalPush.enabled, false);
    assert.strictEqual(p.obsidianBridge.mode, "augment");
    assert.strictEqual(p.obsidianBridge.allowWrite, false);
    assert.strictEqual(p.obsidianBridge.dryRun, true);
    assert.strictEqual(p.obsidianBridge.autoApplyLowRisk, false);
    assert.strictEqual(p.obsidianBridge.semanticGraph.proposalOnly, true);
    assert.strictEqual(p.obsidianBridge.semanticGraph.mutateMemory, false);
    for (const route of [p.merging, p.schicht15, p.skillMiner, p.criticalPush, p.emotion.t3]) {
      assert.equal(Object.hasOwn(route, "model"), false);
    }
    assert.equal(Object.hasOwn(p, "llm"), false);
  });

  it("customProfileFromSelection merges user choices", () => {
    const p = customProfileFromSelection({ morningReview: true, reranker: { enabled: true, timeoutMs: 5000 } });
    assert.strictEqual(p.obsidianBridge.morningReview.enabled, true);
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

  it("applyFeatureProfile records explicit Recommended confirmation history", () => {
    const existing = {};
    const merged = applyFeatureProfile(existing, recommendedProfile(), {
      confirmedAt: "2026-07-19T12:00:00.000Z",
    });
    const cfg = merged.plugins.entries["memory-lancedb-namespaced"].config;
    assert.strictEqual(cfg.setupProfile, "recommended");
    assert.strictEqual(cfg.featuresConfirmedAt, "2026-07-19T12:00:00.000Z");
    assert.strictEqual(cfg.reranker.enabled, true);
    assert.strictEqual(cfg.merging.autoApply, false);
  });

  it("detectPendingFeatures finds pending setup items", () => {
    const config = {
      obsidianBridge: {
        enabled: true,
        requireVaultPathConfirmation: false,
        morningReview: { enabled: true, status: "pending_setup" },
        eveningReview: { enabled: true, status: "pending_setup" },
      },
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
    const config = {
      featuresConfirmedAt: "2026-06-03",
      obsidianBridge: { morningReview: { enabled: true, status: "pending_setup" } },
    };
    const result = isApplyBlocked(config);
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.reason, "pending_setup");
  });

  it("isApplyBlocked returns false when everything ok", () => {
    const config = { obsidianBridge: { morningReview: { enabled: true, status: "active" } } };
    const result = isApplyBlocked(config);
    assert.strictEqual(result.blocked, false);
  });

  it("applyFeatureProfile preserves existing values and records confirmation history", () => {
    const existing = { plugins: { entries: { "memory-lancedb-namespaced": { enabled: true, config: { baseDbPath: "/custom", merging: { enabled: false } } } } } };
    const merged = applyFeatureProfile(existing, recommendedProfile(), {
      confirmedAt: "2026-07-19T12:00:00.000Z",
    });
    const cfg = merged.plugins.entries["memory-lancedb-namespaced"].config;
    assert.strictEqual(cfg.setupProfile, "recommended");
    assert.strictEqual(cfg.featuresConfirmedAt, "2026-07-19T12:00:00.000Z");
    assert.strictEqual(cfg.baseDbPath, "/custom", "existing baseDbPath preserved");
    assert.strictEqual(cfg.merging.enabled, false, "existing merging not overwritten");
    assert.strictEqual(cfg.temporalContext.enabled, true, "missing new core feature added");
  });

  it("safeProfile blocks obsidian apply mode", () => {
    const p = safeProfile();
    assert.strictEqual(p.obsidianBridge.mode, "augment");
    assert.strictEqual(p.obsidianBridge.allowWrite, false);
    assert.strictEqual(p.obsidianBridge.dryRun, true);
    assert.strictEqual(p.obsidianBridge.requireVaultPathConfirmation, true);
  });

  it("recommendedProfile sets obsidianBridge requireVaultPathConfirmation", () => {
    const p = recommendedProfile();
    assert.strictEqual(p.obsidianBridge.requireVaultPathConfirmation, true);
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

  it("explicit Recommended forces reranker timeout while preserving the feature opt-out", () => {
    const existing = { plugins: { entries: { "memory-lancedb-namespaced": { enabled: true, config: { reranker: { enabled: false, timeoutMs: 9999 } } } } } };
    const merged = applyFeatureProfile(existing, recommendedProfile(), { confirmed: true });
    const cfg = merged.plugins.entries["memory-lancedb-namespaced"].config;
    assert.strictEqual(cfg.reranker.enabled, false, "existing reranker.enabled preserved");
    assert.strictEqual(cfg.reranker.timeoutMs, 5000, "Recommended safety timeout restored");
  });

  it("manifest defaults remain safe when no explicit profile was selected", () => {
    const cfg = manifestConfigDefaults();
    assert.strictEqual(cfg.reranker.enabled, false);
    assert.strictEqual(cfg.merging.enabled, false);
    assert.strictEqual(cfg.merging.autoApply, false);
    assert.strictEqual(cfg.skillMiner.enabled, false);
    assert.strictEqual(cfg.dailyConsolidation.enabled, false);
    assert.strictEqual(cfg.obsidianBridge.enabled, false);
    assert.strictEqual(cfg.emotion.t3.enabled, false);
    assert.strictEqual(cfg.runtime.recallCacheTtlMs, 120000);
    assert.strictEqual(cfg.runtime.recallCacheMaxEntries, 128);
  });

  it("fullExperienceDefaults remains an explicit Recommended compatibility alias", () => {
    const cfg = fullExperienceDefaults();
    assert.strictEqual(cfg.temporalContext.enabled, true);
    assert.strictEqual(cfg.runtime.embeddingCacheEnabled, true);
    assert.strictEqual(cfg.runtime.llmResultCacheEnabled, true);
    assert.strictEqual(cfg.reranker.enabled, true);
    assert.strictEqual(cfg.emotion.t2.enabled, true);
    assert.strictEqual(cfg.emotion.t3.enabled, true);
    assert.strictEqual(cfg.metaCognition.llmReportMode, "budgeted");
    assert.strictEqual(cfg.merging.autoApply, false);
    assert.strictEqual(cfg.merging.autoApplyRisk, "low-only");
    assert.strictEqual(cfg.obsidianBridge.semanticGraph.mutateMemory, false);
    assert.strictEqual(cfg.obsidianBridge.soulPatch.force, false);
  });

  it("applyFullExperiencePolicy delegates to manifest-safe effective config without stripping history", () => {
    const cfg = applyFullExperiencePolicy({
      reranker: { enabled: false },
      runtime: { embeddingCacheEnabled: false, llmResultCacheEnabled: false },
      temporalContext: { enabled: false },
      featuresConfirmedAt: "2026-06-03",
    });
    assert.strictEqual(cfg.reranker.enabled, false);
    assert.strictEqual(cfg.runtime.embeddingCacheEnabled, false);
    assert.strictEqual(cfg.runtime.llmResultCacheEnabled, false);
    assert.strictEqual(cfg.temporalContext.enabled, false);
    assert.strictEqual(cfg.merging.enabled, false);
    assert.strictEqual(cfg.featuresConfirmedAt, "2026-06-03");
  });

  it("applyFullExperiencePolicy respects an explicit emotion.t3 opt-out even with reranker enabled", () => {
    // enforceRerankerInvariants() must not clobber an explicit user choice:
    // disabling emotion Tier-3 has to survive even while the reranker stays on.
    const cfg = applyFullExperiencePolicy({
      emotion: { t3: { enabled: false } },
    });
    assert.strictEqual(cfg.reranker.enabled, false, "reranker stays at its manifest default");
    assert.strictEqual(cfg.emotion.t3.enabled, false, "explicit emotion.t3 opt-out must be preserved");
    // The fail-soft defaults should still be filled in around the opt-out.
    assert.strictEqual(cfg.emotion.t3.fallbackOnError, true);
    assert.strictEqual(cfg.emotion.t3.onlyWhenProviderAvailable, true);
  });

  it("applyFullExperiencePolicy respects an explicit emotion.t2 opt-out even with reranker enabled", () => {
    const cfg = applyFullExperiencePolicy({
      emotion: { t2: { enabled: false } },
    });
    assert.strictEqual(cfg.reranker.enabled, false);
    assert.strictEqual(cfg.emotion.t2.enabled, false, "explicit emotion.t2 opt-out must be preserved");
  });

  it("applyFullExperiencePolicy respects an explicit metaCognition opt-out even with reranker enabled", () => {
    const cfg = applyFullExperiencePolicy({
      metaCognition: { enabled: false },
    });
    assert.strictEqual(cfg.reranker.enabled, false, "reranker stays at its manifest default");
    assert.strictEqual(cfg.metaCognition.enabled, false, "explicit metaCognition opt-out must be preserved");
    // fail-soft defaults still fill in around the opt-out.
    assert.strictEqual(cfg.metaCognition.llmReportMode, "budgeted");
    assert.strictEqual(cfg.metaCognition.fallbackOnError, true);
  });

  it("applyFullExperiencePolicy cannot force implicit Full Experience", () => {
    const cfg = applyFullExperiencePolicy(
      {
        baseDbPath: "/custom-memory",
        embedding: { provider: "openai", model: "custom-embedding" },
        reranker: { enabled: false, timeoutMs: 9999 },
        temporalContext: { enabled: false },
      },
      { forceFullExperience: true, disabledFeatures: ["skillMiner", "dailyConsolidation"] }
    );
    assert.strictEqual(cfg.reranker.enabled, false);
    assert.strictEqual(cfg.reranker.timeoutMs, 9999);
    assert.strictEqual(cfg.temporalContext.enabled, false);
    assert.strictEqual(cfg.skillMiner.enabled, false);
    assert.strictEqual(cfg.dailyConsolidation.enabled, false);
    assert.strictEqual(cfg.baseDbPath, "/custom-memory");
    assert.deepStrictEqual(cfg.embedding, { provider: "openai", model: "custom-embedding" });
  });

  it("explicit Recommended preserves non-feature config and explicit opt-outs", () => {
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
    assert.strictEqual(cfg.reranker.enabled, false);
    assert.strictEqual(cfg.baseDbPath, "/custom-memory");
    assert.deepStrictEqual(cfg.embedding, { provider: "local-transformers", local: { dimensions: 384 } });
  });

  it("repeated Recommended restores mandatory safety gates while preserving feature opt-outs", () => {
    const existing = {
      plugins: {
        entries: {
          "memory-lancedb-namespaced": {
            enabled: true,
            config: {
              reranker: { enabled: false, timeoutMs: 9999 },
              merging: { enabled: false, autoApply: true },
              obsidianBridge: {
                enabled: false,
                mode: "apply",
                dryRun: false,
                requireVaultPathConfirmation: false,
                autoApplyLowRisk: true,
                semanticGraph: { proposalOnly: false, mutateMemory: true },
              },
            },
          },
        },
      },
    };

    const merged = applyFeatureProfile(existing, recommendedProfile(), {
      confirmedAt: "2026-07-19T12:00:00.000Z",
    });
    const cfg = merged.plugins.entries["memory-lancedb-namespaced"].config;

    assert.strictEqual(cfg.reranker.enabled, false);
    assert.strictEqual(cfg.reranker.timeoutMs, 5000);
    assert.strictEqual(cfg.merging.enabled, false);
    assert.strictEqual(cfg.merging.autoApply, false);
    assert.strictEqual(cfg.merging.mode, "safe-versioned");
    assert.strictEqual(cfg.merging.autoApplyRisk, "low-only");
    assert.strictEqual(cfg.merging.backupBeforeApply, true);
    assert.strictEqual(cfg.merging.auditLog, true);
    assert.strictEqual(cfg.obsidianBridge.enabled, false);
    assert.strictEqual(cfg.obsidianBridge.mode, "augment");
    assert.strictEqual(cfg.obsidianBridge.dryRun, true);
    assert.strictEqual(cfg.obsidianBridge.requireVaultPathConfirmation, true);
    assert.strictEqual(cfg.obsidianBridge.autoApplyLowRisk, false);
    assert.strictEqual(cfg.obsidianBridge.semanticGraph.proposalOnly, true);
    assert.strictEqual(cfg.obsidianBridge.semanticGraph.mutateMemory, false);
    assert.strictEqual(cfg.obsidianBridge.morningReview.status, "pending_setup");
    assert.strictEqual(cfg.obsidianBridge.eveningReview.status, "pending_setup");
  });

  it("explicit Recommended repairs only its historical fixed merge invariants", () => {
    const legacyConfig = {
      setupProfile: "recommended",
      reranker: { enabled: false },
      merging: { enabled: false, backupBeforeApply: false, auditLog: false },
      obsidianBridge: { enabled: false },
    };
    assert.throws(
      () => validatePluginConfig(legacyConfig),
      /plugins\.entries\.memory-lancedb-namespaced\.config\.merging\.backupBeforeApply.*must equal true/,
    );

    const merged = applyFeatureProfile(
      {
        plugins: {
          entries: {
            "memory-lancedb-namespaced": { enabled: true, config: legacyConfig },
          },
        },
      },
      recommendedProfile(),
      { confirmedAt: "2026-07-19T12:00:00.000Z" },
    );
    const cfg = merged.plugins.entries["memory-lancedb-namespaced"].config;

    assert.strictEqual(cfg.reranker.enabled, false);
    assert.strictEqual(cfg.merging.enabled, false);
    assert.strictEqual(cfg.obsidianBridge.enabled, false);
    assert.strictEqual(cfg.merging.backupBeforeApply, true);
    assert.strictEqual(cfg.merging.auditLog, true);
  });

  it("detectMissingCoreFeatures reports new core features missing from current config", () => {
    const missing = detectMissingCoreFeatures({ reranker: { enabled: false } });
    assert.ok(missing.some((feature) => feature.key === "temporalContext"));
    assert.ok(missing.some((feature) => feature.key === "embeddingCache"));
    assert.ok(missing.some((feature) => feature.key === "llmResultCache"));
  });

  it("registers the LLM result cache as a default-on core feature", () => {
    assert.deepStrictEqual(
      CORE_FEATURES.find((feature) => feature.key === "llmResultCache"),
      {
        key: "llmResultCache",
        label: "LLM Result Cache",
        path: ["runtime", "llmResultCacheEnabled"],
        defaultValue: true,
      }
    );
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

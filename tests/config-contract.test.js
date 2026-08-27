import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ConfigContractError,
  PLUGIN_CONFIG_PATH,
  manifestConfigDefaults,
  resolveEffectiveConfig,
  validatePluginConfig,
} from "../lib/setup/config-contract.js";
import { isQuietHour, validateHourWindow, validateTimeZone } from "../lib/time-window.js";

function assertConfigError(run, configPath, pattern = /invalid/i) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof ConfigContractError);
    assert.equal(error.name, "ConfigContractError");
    assert.equal(error.code, "INVALID_PLUGIN_CONFIG");
    assert.equal(error.configPath, configPath);
    assert.match(error.message, pattern);
    return true;
  });
}

describe("manifest-derived configuration contract", () => {
  it("materializes safe manifest defaults without implicit Full Experience", () => {
    const cfg = manifestConfigDefaults();

    assert.equal(cfg.autoCapture, true);
    assert.equal(cfg.autoRecall, true);
    assert.equal(cfg.reranker.enabled, false);
    assert.equal(cfg.reranker.timeoutMs, 5000);
    assert.equal(cfg.merging.enabled, false);
    assert.equal(cfg.merging.autoApply, false);
    assert.equal(cfg.skillMiner.enabled, false);
    assert.equal(cfg.dailyConsolidation.enabled, false);
    assert.equal(cfg.obsidianBridge.enabled, false);
    assert.equal(cfg.obsidianBridge.morningReview.enabled, false);
    assert.equal(cfg.obsidianBridge.eveningReview.enabled, false);
    assert.equal(cfg.emotion.t3.enabled, false);
    assert.equal(cfg.runtime.recallCacheTtlMs, 120_000);
    assert.equal(cfg.runtime.recallCacheMaxEntries, 128);
  });

  it("preserves explicit values and never mutates the raw input", () => {
    const raw = {
      baseDbPath: "/custom/db",
      embedding: { provider: "openai", model: "text-embedding-3-large", dimensions: 3072 },
      reranker: { enabled: false, timeoutMs: 9_999 },
      runtime: { recallCacheTtlMs: 77, recallCacheMaxEntries: 3 },
      setupProfile: "safe",
      featuresConfirmedAt: "2026-07-19T00:00:00.000Z",
    };
    const before = structuredClone(raw);
    const cfg = resolveEffectiveConfig(raw);

    assert.deepEqual(raw, before);
    assert.notEqual(cfg, raw);
    assert.equal(cfg.baseDbPath, "/custom/db");
    assert.equal(cfg.reranker.enabled, false);
    assert.equal(cfg.reranker.timeoutMs, 9_999);
    assert.equal(cfg.runtime.recallCacheTtlMs, 77);
    assert.equal(cfg.runtime.recallCacheMaxEntries, 3);
    assert.equal(cfg.setupProfile, "safe");
    assert.equal(cfg.featuresConfirmedAt, "2026-07-19T00:00:00.000Z");
  });

  it("validates the strict Decision Trace object and reserved false aliases", () => {
    const valid = resolveEffectiveConfig({
      recall: {
        decisionTrace: {
          enabled: true,
          includeInPrompt: true,
          maxCandidates: 7,
          maxTextPreviewChars: 80,
          persist: false,
          visibleHints: false,
        },
      },
    });
    assert.deepEqual(valid.recall.decisionTrace, {
      enabled: true,
      includeInPrompt: true,
      maxCandidates: 7,
      maxTextPreviewChars: 80,
      persist: false,
      visibleHints: false,
    });

    assertConfigError(
      () => validatePluginConfig({ recall: { decisionTrace: { enabled: "yes" } } }),
      `${PLUGIN_CONFIG_PATH}.recall.decisionTrace.enabled`,
      /boolean/,
    );
    assertConfigError(
      () => validatePluginConfig({ recall: { decisionTrace: { unknown: true } } }),
      `${PLUGIN_CONFIG_PATH}.recall.decisionTrace.unknown`,
      /unknown/,
    );
    for (const key of ["persist", "visibleHints"]) {
      assertConfigError(
        () => validatePluginConfig({ recall: { decisionTrace: { [key]: true } } }),
        `${PLUGIN_CONFIG_PATH}.recall.decisionTrace.${key}`,
        /false/,
      );
    }
  });

  it("makes the safe FA-06 runtime fields schema-reachable", () => {
    const cfg = resolveEffectiveConfig({
      replyOutcomeTracking: { enabled: false, maxAgeMs: 1_000, maxMemoryIds: 2 },
      dreaming: { narrative: { enabled: false, temperature: 0.4, storeAsMemory: false, importanceMax: 0.3 } },
      reminders: { deliveryMode: "webhook", webhookUrl: "${REMINDER_WEBHOOK}" },
      embeddingBatchSize: 4,
      language: "en",
      timezone: null,
      metaCognition: { sessionThreshold: 12, intervalDays: 2 },
    });

    assert.equal(cfg.replyOutcomeTracking.enabled, false);
    assert.equal(cfg.dreaming.narrative.storeAsMemory, false);
    assert.equal(cfg.reminders.deliveryMode, "webhook");
    assert.equal(cfg.embeddingBatchSize, 4);
    assert.equal(cfg.language, "en");
    assert.equal(cfg.timezone, null);
    assert.equal(cfg.metaCognition.sessionThreshold, 12);
    assert.equal(cfg.metaCognition.intervalDays, 2);
  });

  it("constrains merge invariants and does not advertise an unwired run cap", () => {
    const cfg = manifestConfigDefaults();
    assert.equal(cfg.merging.mode, "safe-versioned");
    assert.equal(cfg.merging.autoApplyRisk, "low-only");
    assert.equal(cfg.merging.backupBeforeApply, true);
    assert.equal(cfg.merging.auditLog, true);
    assert.equal(Object.hasOwn(cfg.merging, "maxAutoApplyPerRun"), false);

    for (const [key, value] of [
      ["mode", "unsafe"],
      ["autoApplyRisk", "all"],
      ["backupBeforeApply", false],
      ["auditLog", false],
      ["maxAutoApplyPerRun", 1],
    ]) {
      assertConfigError(
        () => validatePluginConfig({ merging: { [key]: value } }),
        `${PLUGIN_CONFIG_PATH}.merging.${key}`,
      );
    }
  });

  it("accepts strict namespace routing without materializing absent defaults", () => {
    const raw = {
      namespaces: {
        activeWriteNamespace: "ns-write",
        activeRecallNamespaces: ["ns-write", "ns-read"],
        legacyReadOnlyNamespaces: ["ns-old"],
        crossNamespaceRecall: true,
      },
    };
    const cfg = resolveEffectiveConfig(raw);

    assert.deepEqual(cfg.namespaces, raw.namespaces);
    assert.equal(Object.isFrozen(cfg.namespaces), true);
    assert.equal(Object.isFrozen(cfg.namespaces.activeRecallNamespaces), true);
    assert.equal(Object.hasOwn(resolveEffectiveConfig({}), "namespaces"), false);
    assertConfigError(
      () => validatePluginConfig({ namespaces: { unknown: true } }),
      `${PLUGIN_CONFIG_PATH}.namespaces.unknown`,
      /unknown/,
    );
  });

  it("validates namespace identifier patterns at exact leaf and array-index paths", () => {
    assertConfigError(
      () => validatePluginConfig({ namespaces: { activeWriteNamespace: "../escape" } }),
      `${PLUGIN_CONFIG_PATH}.namespaces.activeWriteNamespace`,
      /pattern|match|format/i,
    );
    assertConfigError(
      () => validatePluginConfig({ namespaces: { activeRecallNamespaces: ["ok", "bad/name"] } }),
      `${PLUGIN_CONFIG_PATH}.namespaces.activeRecallNamespaces[1]`,
      /pattern|match|format/i,
    );
    assertConfigError(
      () => validatePluginConfig({ namespaces: { legacyReadOnlyNamespaces: ["ok", "bad name"] } }),
      `${PLUGIN_CONFIG_PATH}.namespaces.legacyReadOnlyNamespaces[1]`,
      /pattern|match|format/i,
    );
    assertConfigError(
      () => validatePluginConfig({ namespaces: { activeRecallNamespaces: [] } }),
      `${PLUGIN_CONFIG_PATH}.namespaces.activeRecallNamespaces`,
      /at least 1 item/i,
    );
  });

  it("validates the active reembedding generation as a closed atomic selection", () => {
    const selection = {
      activeGeneration: "generation-a",
      fingerprintId: `embedding:v1:sha256:${"a".repeat(64)}`,
      dimensions: 768,
    };
    assert.deepEqual(resolveEffectiveConfig({ reembedding: selection }).reembedding, selection);
    for (const value of [
      { ...selection, unknown: true },
      { ...selection, activeGeneration: "../escape" },
      { ...selection, fingerprintId: "moving" },
      { ...selection, dimensions: 0 },
    ]) {
      assert.throws(() => validatePluginConfig({ reembedding: value }), /reembedding/);
    }
  });

  for (const forbidden of ["retroactiveInterference", "quietHours"]) {
    it(`keeps ${forbidden} schema-unreachable in B11`, () => {
      assertConfigError(
        () => validatePluginConfig({ [forbidden]: {} }),
        `${PLUGIN_CONFIG_PATH}.${forbidden}`,
        /unknown/,
      );
    });
  }

  it("normalizes equal legacy review aliases without rewriting the raw object", () => {
    const legacyReview = { enabled: true, timezone: "UTC", status: "active" };
    const raw = { morningReview: legacyReview };
    const cfg = resolveEffectiveConfig(raw);

    assert.deepEqual(cfg.obsidianBridge.morningReview, {
      ...cfg.obsidianBridge.morningReview,
      enabled: true,
      timezone: "UTC",
      status: "active",
    });
    assert.equal(Object.hasOwn(raw, "obsidianBridge"), false);

    const equal = resolveEffectiveConfig({
      morningReview: legacyReview,
      obsidianBridge: { morningReview: structuredClone(legacyReview) },
    });
    assert.equal(equal.obsidianBridge.morningReview.timezone, "UTC");
  });

  it("rejects conflicting top-level and nested review values with both exact paths", () => {
    assert.throws(
      () => resolveEffectiveConfig({
        eveningReview: { enabled: true },
        obsidianBridge: { eveningReview: { enabled: false } },
      }),
      (error) => {
        assert.equal(error?.code, "INVALID_PLUGIN_CONFIG");
        assert.match(error.message, /plugins\.entries\.memory-lancedb-namespaced\.config\.eveningReview/);
        assert.match(error.message, /plugins\.entries\.memory-lancedb-namespaced\.config\.obsidianBridge\.eveningReview/);
        return true;
      },
    );
  });

  it("validates every supported timezone path and keeps falsy local compatibility", () => {
    const valid = resolveEffectiveConfig({
      timezone: "",
      styleDirective: { timezone: null },
      afterthought: { timezone: "UTC" },
      skillMiner: { timezone: "Europe/Berlin" },
      morningReview: { timezone: "" },
      eveningReview: { timezone: null },
    });
    const nested = resolveEffectiveConfig({
      obsidianBridge: {
        morningReview: { timezone: "UTC" },
        eveningReview: { timezone: "Europe/Berlin" },
      },
    });
    assert.equal(valid.timezone, "");
    assert.equal(valid.styleDirective.timezone, null);
    assert.equal(nested.obsidianBridge.morningReview.timezone, "UTC");

    for (const [partial, suffix] of [
      [{ timezone: "Not/AZone" }, "timezone"],
      [{ styleDirective: { timezone: "   " } }, "styleDirective.timezone"],
      [{ afterthought: { timezone: 42 } }, "afterthought.timezone"],
      [{ skillMiner: { timezone: "Not/AZone" } }, "skillMiner.timezone"],
      [{ morningReview: { timezone: "Not/AZone" } }, "morningReview.timezone"],
      [{ eveningReview: { timezone: "Not/AZone" } }, "eveningReview.timezone"],
      [{ obsidianBridge: { morningReview: { timezone: "Not/AZone" } } }, "obsidianBridge.morningReview.timezone"],
      [{ obsidianBridge: { eveningReview: { timezone: "Not/AZone" } } }, "obsidianBridge.eveningReview.timezone"],
    ]) {
      assertConfigError(
        () => resolveEffectiveConfig(partial),
        `${PLUGIN_CONFIG_PATH}.${suffix}`,
        /timezone|time zone|string/,
      );
    }
  });

  it("rejects malformed objects, non-finite numbers, enums, and prototype-shaped JSON", () => {
    assertConfigError(() => validatePluginConfig([]), PLUGIN_CONFIG_PATH, /object/);
    assertConfigError(() => validatePluginConfig(null), PLUGIN_CONFIG_PATH, /object/);
    assertConfigError(
      () => validatePluginConfig({ runtime: [] }),
      `${PLUGIN_CONFIG_PATH}.runtime`,
      /object/,
    );
    assertConfigError(
      () => validatePluginConfig({ runtime: { recallTimeoutMs: Number.NaN } }),
      `${PLUGIN_CONFIG_PATH}.runtime.recallTimeoutMs`,
      /finite|number/,
    );
    assertConfigError(
      () => validatePluginConfig({ obsidianBridge: { mode: "dry-run" } }),
      `${PLUGIN_CONFIG_PATH}.obsidianBridge.mode`,
      /enum|augment|apply/,
    );
    for (const key of ["__proto__", "prototype", "constructor"]) {
      const raw = JSON.parse(`{"${key}": {"polluted": true}}`);
      assertConfigError(
        () => validatePluginConfig(raw),
        `${PLUGIN_CONFIG_PATH}.${key}`,
        /unknown|unsafe/,
      );
    }
  });
});

describe("path-aware direct time validators", () => {
  it("accepts falsy timezone values and valid IANA zones", () => {
    for (const value of [undefined, null, "", "UTC", "Europe/Berlin"]) {
      assert.equal(validateTimeZone(value, { path: "example.timezone" }), value);
    }
  });

  it("rejects invalid direct bounds with the exact leaf path", () => {
    for (const [window, leaf] of [
      [{ start: -1, end: 8 }, "start"],
      [{ start: 22, end: 24 }, "end"],
      [{ start: 1.5, end: 8 }, "start"],
      [{ start: "22", end: 8 }, "start"],
      [{ start: 22 }, "end"],
      [{ end: 8 }, "start"],
    ]) {
      assert.throws(
        () => validateHourWindow(window, { path: "example.quietHours" }),
        (error) => error?.configPath === `example.quietHours.${leaf}`,
      );
    }
  });

  it("keeps valid wrap-around behavior", () => {
    assert.deepEqual(validateHourWindow({ start: 22, end: 8 }, { path: "example.quietHours" }), { start: 22, end: 8 });
    assert.equal(isQuietHour(23, { start: 22, end: 8 }), true);
    assert.equal(isQuietHour(12, { start: 22, end: 8 }), false);
  });
});

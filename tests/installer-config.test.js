import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyInstallerFeaturePolicy,
  buildInstallLogEvent,
  createFeatureUpdatePlan,
  detectExistingInstall,
  parseInstallLog,
} from "../scripts/lib/installer-config.mjs";

describe("installer feature config policy", () => {
  it("preserve is byte-stable for missing, enabled, and disabled plugin entries", () => {
    for (const original of [
      {},
      { enabled: true },
      { enabled: false, config: { reranker: { enabled: false } } },
    ]) {
      const before = JSON.stringify(original);
      const entry = applyInstallerFeaturePolicy(original, { mode: "preserve" });
      assert.equal(JSON.stringify(entry), before);
      assert.deepEqual(entry, original);
      assert.notEqual(entry, original);
    }
  });

  it("preserve retains provider, path, runtime, rollback, and explicit false state", () => {
    const original = {
      enabled: false,
      config: {
        baseDbPath: "/custom/memory",
        embedding: {
          provider: "local-transformers",
          local: { model: "intfloat/multilingual-e5-small", dimensions: 384 },
        },
        reranker: { enabled: false, timeoutMs: 9999 },
        runtime: { recallCacheTtlMs: 77, recallCacheMaxEntries: 4 },
      },
      rollback: { previousBackend: "memory-lancedb", backup: "/backup/state" },
    };
    const entry = applyInstallerFeaturePolicy(original, { mode: "preserve" });

    assert.deepEqual(entry, original);
    assert.equal(entry.enabled, false);
    assert.equal(entry.config.reranker.enabled, false);
    assert.equal(entry.config.runtime.recallCacheTtlMs, 77);
    assert.deepEqual(entry.rollback, original.rollback);
  });

  it("explicit Safe creates/enables an entry and applies only schema-valid Safe", () => {
    const entry = applyInstallerFeaturePolicy(
      {
        enabled: false,
        config: {
          embedding: { provider: "openai", apiKey: "${OPENAI_API_KEY}", model: "text-embedding-3-large" },
          baseDbPath: "/openclaw/memory/lancedb-namespaced",
        },
      },
      { mode: "safe", confirmedAt: "2026-07-19T12:00:00.000Z" },
    );

    assert.equal(entry.enabled, true);
    assert.equal(entry.config.autoCapture, true);
    assert.equal(entry.config.autoRecall, true);
    assert.equal(entry.config.reranker.enabled, false);
    assert.equal(entry.config.merging.enabled, false);
    assert.equal(entry.config.skillMiner.enabled, false);
    assert.equal(entry.config.dailyConsolidation.enabled, false);
    assert.equal(entry.config.criticalPush.enabled, false);
    assert.equal(entry.config.obsidianBridge.allowWrite, false);
    assert.equal(entry.config.obsidianBridge.dryRun, true);
    assert.equal(entry.config.setupProfile, "safe");
    assert.equal(entry.config.featuresConfirmedAt, "2026-07-19T12:00:00.000Z");
    assert.deepEqual(entry.config.embedding, {
      provider: "openai",
      apiKey: "${OPENAI_API_KEY}",
      model: "text-embedding-3-large",
    });
  });

  it("explicit Recommended enables missing advanced features but preserves opt-outs", () => {
    const entry = applyInstallerFeaturePolicy(
      {
        enabled: true,
        config: {
          baseDbPath: "/custom/memory",
          reranker: { enabled: false, timeoutMs: 9999 },
          temporalContext: { enabled: false },
        },
      },
      { mode: "recommended", confirmedAt: "2026-07-19T12:00:00.000Z" },
    );

    assert.equal(entry.config.baseDbPath, "/custom/memory");
    assert.equal(entry.config.reranker.enabled, false);
    assert.equal(entry.config.reranker.timeoutMs, 9999);
    assert.equal(entry.config.temporalContext.enabled, false);
    assert.equal(entry.config.dailyConsolidation.enabled, true);
    assert.equal(entry.config.obsidianBridge.enabled, true);
    assert.equal(entry.config.merging.autoApply, false);
    assert.equal(entry.config.setupProfile, "recommended");
    assert.equal(entry.config.featuresConfirmedAt, "2026-07-19T12:00:00.000Z");
  });

  it("migrates legacy config.hooks only for explicit profile application", () => {
    const legacyHooks = { allowConversationAccess: false, timeouts: { agent_end: 1234 } };
    const migrated = applyInstallerFeaturePolicy(
      { enabled: true, config: { hooks: legacyHooks } },
      { mode: "safe", confirmedAt: "2026-07-19T12:00:00.000Z" },
    );
    assert.deepEqual(migrated.hooks, legacyHooks);
    assert.equal(Object.hasOwn(migrated.config, "hooks"), false);

    const explicitHooks = { allowConversationAccess: true };
    const retained = applyInstallerFeaturePolicy(
      { enabled: true, hooks: explicitHooks, config: { hooks: legacyHooks } },
      { mode: "recommended", confirmedAt: "2026-07-19T12:00:00.000Z" },
    );
    assert.deepEqual(retained.hooks, explicitHooks);
    assert.equal(Object.hasOwn(retained.config, "hooks"), false);
  });

  it("plans around legacy config.hooks in preserve mode without rewriting it", () => {
    const legacyHooks = { allowConversationAccess: false };
    const config = { hooks: legacyHooks, reranker: { enabled: false } };
    const original = { enabled: false, config };

    assert.deepEqual(applyInstallerFeaturePolicy(original, { mode: "preserve" }), original);
    const plan = createFeatureUpdatePlan({
      existingPluginEntry: original,
      existingPluginConfig: config,
      proposedPluginConfig: config,
      mode: "preserve",
    });

    assert.equal(plan.after.missing.length, 0);
    assert.equal(Object.hasOwn(plan.afterConfig, "hooks"), false);
    assert.deepEqual(original.config.hooks, legacyHooks);
  });

  for (const mode of ["fresh", "force", "enable-all"]) {
    it(`rejects implicit ${mode} activation inside the helper`, () => {
      assert.throws(
        () => applyInstallerFeaturePolicy({}, { mode }),
        /preserve|safe|recommended/,
      );
    });
  }
});

describe("installer install log planning", () => {
  it("detects existing installs from either config or the install log", () => {
    const log = `${JSON.stringify({ kind: "plur1bus_install", schemaVersion: 1, featureSummary: { active: ["autoCapture"] } })}\n`;

    assert.deepEqual(detectExistingInstall({ existingPluginEntry: null, installLogContent: "" }).detectedBy, {
      config: false,
      log: false,
    });
    assert.equal(detectExistingInstall({ existingPluginEntry: { enabled: true }, installLogContent: "" }).isUpdate, true);
    assert.equal(detectExistingInstall({ existingPluginEntry: null, installLogContent: log }).isUpdate, true);
  });

  it("parses valid install-log lines and ignores unrelated or malformed lines", () => {
    const parsed = parseInstallLog([
      "not json",
      JSON.stringify({ kind: "other_event" }),
      JSON.stringify({ kind: "plur1bus_install", schemaVersion: 1, featureSummary: { active: ["autoRecall"] } }),
    ].join("\n"));

    assert.equal(parsed.events.length, 1);
    assert.deepEqual(parsed.lastEvent.featureSummary.active, ["autoRecall"]);
    assert.equal(parsed.ignoredLines, 2);
  });

  it("summarizes update changes before prompting the user", () => {
    const plan = createFeatureUpdatePlan({
      existingPluginConfig: {
        reranker: { enabled: false },
        temporalContext: { enabled: false },
      },
      proposedPluginConfig: {
        reranker: { enabled: false },
        temporalContext: { enabled: false },
      },
      installLogContent: JSON.stringify({ kind: "plur1bus_install", schemaVersion: 1 }),
      mode: "preserve",
    });

    assert.equal(plan.isUpdate, true);
    assert.equal(plan.detectedBy.log, true);
    assert.equal(plan.newlyActivated.some((feature) => feature.key === "dailyConsolidation"), false);
    assert.ok(plan.preservedDisabled.some((feature) => feature.key === "reranker"));
    assert.ok(plan.preservedDisabled.some((feature) => feature.key === "temporalContext"));
    assert.equal(plan.after.missing.length, 0);
  });

  it("uses preserve policy in update plans so explicit opt-outs are not reported as reactivated", () => {
    const config = {
      reranker: { enabled: true },
      emotion: {
        t2: { enabled: false },
        t3: { enabled: false },
      },
      metaCognition: {
        enabled: false,
        llmReport: false,
      },
    };

    const plan = createFeatureUpdatePlan({
      existingPluginEntry: { enabled: true, config },
      existingPluginConfig: config,
      proposedPluginConfig: config,
      mode: "preserve",
    });

    assert.ok(plan.preservedDisabled.some((feature) => feature.key === "emotionT2"));
    assert.ok(plan.preservedDisabled.some((feature) => feature.key === "emotionT3"));
    assert.ok(plan.preservedDisabled.some((feature) => feature.key === "metaCognition"));
    assert.ok(plan.preservedDisabled.some((feature) => feature.key === "metaCognitionLlmReport"));
    assert.equal(plan.reactivated.some((feature) => feature.key === "emotionT2"), false);
    assert.equal(plan.reactivated.some((feature) => feature.key === "metaCognition"), false);
  });

  it("treats an existing plugin entry with empty config as an update", () => {
    const plan = createFeatureUpdatePlan({
      existingPluginEntry: { enabled: true, config: {} },
      existingPluginConfig: {},
      proposedPluginConfig: {},
      installLogContent: "",
      mode: "preserve",
    });

    assert.equal(plan.isUpdate, true);
    assert.equal(plan.detectedBy.config, true);
  });

  it("builds a secret-free install event for the append-only ledger", () => {
    const event = buildInstallLogEvent({
      packageVersion: "6.8.1",
      installMode: "update",
      featureMode: "preserve",
      detectedBy: { config: true, log: true },
      beforeConfig: { reranker: { enabled: false } },
      afterConfig: {
        embedding: { apiKey: "sk-secret" },
        reranker: { enabled: false },
        temporalContext: { enabled: true },
      },
      createdAt: "2026-06-27T00:00:00.000Z",
    });

    const serialized = JSON.stringify(event);
    assert.equal(event.kind, "plur1bus_install");
    assert.equal(event.packageVersion, "6.8.1");
    assert.equal(event.dataSafety.memoryDataDeleted, false);
    assert.ok(event.featureSummary.active.includes("temporalContext"));
    assert.ok(event.featureSummary.disabled.includes("reranker"));
    assert.equal(serialized.includes("sk-secret"), false);
    assert.equal(serialized.includes("apiKey"), false);
  });
});

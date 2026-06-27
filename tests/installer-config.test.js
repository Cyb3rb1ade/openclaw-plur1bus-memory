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
  it("fresh installs write full experience defaults into the plugin config", () => {
    const entry = applyInstallerFeaturePolicy(
      {
        enabled: true,
        config: {
          embedding: { provider: "openai", apiKey: "${OPENAI_API_KEY}", model: "text-embedding-3-large" },
          baseDbPath: "/openclaw/memory/lancedb-namespaced",
        },
      },
      { mode: "fresh" },
    );

    assert.equal(entry.enabled, true);
    assert.equal(entry.config.autoCapture, true);
    assert.equal(entry.config.autoRecall, true);
    assert.equal(entry.config.temporalContext.enabled, true);
    assert.equal(entry.config.runtime.embeddingCacheEnabled, true);
    assert.equal(entry.config.dailyConsolidation.enabled, true);
    assert.equal(entry.config.obsidianBridge.enabled, true);
    assert.equal(entry.config.obsidianBridge.soulPatch.enabled, true);
    assert.equal(entry.config.featuresConfirmedAt, undefined);
    assert.equal(entry.config.featurePolicy, undefined);
    assert.deepEqual(entry.config.embedding, {
      provider: "openai",
      apiKey: "${OPENAI_API_KEY}",
      model: "text-embedding-3-large",
    });
  });

  it("updates preserve explicit disabled features while enabling missing new defaults", () => {
    const entry = applyInstallerFeaturePolicy(
      {
        enabled: true,
        config: {
          baseDbPath: "/custom/memory",
          reranker: { enabled: false, timeoutMs: 9999 },
          temporalContext: { enabled: false },
        },
      },
      { mode: "preserve" },
    );

    assert.equal(entry.config.baseDbPath, "/custom/memory");
    assert.equal(entry.config.reranker.enabled, false);
    assert.equal(entry.config.reranker.timeoutMs, 9999);
    assert.equal(entry.config.temporalContext.enabled, false);
    assert.equal(entry.config.dailyConsolidation.enabled, true);
    assert.equal(entry.config.obsidianBridge.enabled, true);
  });

  it("preserve mode keeps reranker-dependent feature opt-outs disabled", () => {
    const entry = applyInstallerFeaturePolicy(
      {
        enabled: true,
        config: {
          reranker: { enabled: true },
          emotion: {
            t2: { enabled: false },
            t3: { enabled: false },
          },
          metaCognition: {
            enabled: false,
            llmReport: false,
          },
        },
      },
      { mode: "preserve" },
    );

    assert.equal(entry.config.reranker.enabled, true);
    assert.equal(entry.config.emotion.t2.enabled, false);
    assert.equal(entry.config.emotion.t3.enabled, false);
    assert.equal(entry.config.metaCognition.enabled, false);
    assert.equal(entry.config.metaCognition.llmReport, false);
  });

  it("enable-all updates reactivate core feature flags without replacing provider config", () => {
    const entry = applyInstallerFeaturePolicy(
      {
        enabled: true,
        config: {
          baseDbPath: "/custom/memory",
          embedding: { provider: "local-transformers", local: { model: "intfloat/multilingual-e5-small", dimensions: 384 } },
          reranker: { enabled: false, timeoutMs: 9999 },
          temporalContext: { enabled: false },
        },
      },
      { mode: "enable-all" },
    );

    assert.equal(entry.config.reranker.enabled, true);
    assert.equal(entry.config.reranker.timeoutMs, 9999);
    assert.equal(entry.config.temporalContext.enabled, true);
    assert.equal(entry.config.baseDbPath, "/custom/memory");
    assert.deepEqual(entry.config.embedding, {
      provider: "local-transformers",
      local: { model: "intfloat/multilingual-e5-small", dimensions: 384 },
    });
  });
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
    assert.ok(plan.newlyActivated.some((feature) => feature.key === "dailyConsolidation"));
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

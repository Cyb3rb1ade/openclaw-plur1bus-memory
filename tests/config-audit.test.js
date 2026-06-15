/**
 * tests/config-audit.test.js — P3 Release-Härtung: Config & Defaults Audit
 *
 * Prüft:
 * 1. Alle Schema-Defaults sind gültige Zahlen/Booleans
 * 2. Code-Fallbacks stimmen mit Schema-Defaults überein
 * 3. halfLifeDaysMap-Gruppen sind vollständig
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, "..", "openclaw.plugin.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

function getSchemaNode(path) {
  const parts = path.split(".");
  let node = schema.configSchema.properties;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!node[part]) return undefined;
    node = node[part];
    // Nur in .properties absteigen, wenn noch weitere Teile folgen
    if (i < parts.length - 1 && node && node.type === "object" && node.properties) {
      node = node.properties;
    }
  }
  return node;
}

function getDefault(path) {
  const node = getSchemaNode(path);
  return node && typeof node === "object" && "default" in node ? node.default : undefined;
}

function assertNumberDefault(path, expected) {
  const actual = getDefault(path);
  assert.strictEqual(
    typeof actual,
    "number",
    `Schema-Default für ${path} muss eine Zahl sein, ist aber ${typeof actual}`
  );
  assert.strictEqual(
    actual,
    expected,
    `Schema-Default für ${path} ist ${actual}, erwartet ${expected}`
  );
}

function assertBooleanDefault(path, expected) {
  const actual = getDefault(path);
  assert.strictEqual(
    typeof actual,
    "boolean",
    `Schema-Default für ${path} muss ein Boolean sein, ist aber ${typeof actual}`
  );
  assert.strictEqual(
    actual,
    expected,
    `Schema-Default für ${path} ist ${actual}, erwartet ${expected}`
  );
}

describe("Schema-Default-Typen (Recall)", () => {
  it("recall.importanceBoost ist eine Zahl", () =>
    assertNumberDefault("recall.importanceBoost", 0.3));
  it("recall.dedupJaccard ist eine Zahl", () =>
    assertNumberDefault("recall.dedupJaccard", 0.78));
  it("recall.canonicalMinScore ist eine Zahl", () =>
    assertNumberDefault("recall.canonicalMinScore", 0.3));
  it("recall.canonicalMaxItems ist eine Zahl", () =>
    assertNumberDefault("recall.canonicalMaxItems", 5));
  it("recall.maxPromptMemories ist eine Zahl", () =>
    assertNumberDefault("recall.maxPromptMemories", 12));
  it("recall.candidateTopK ist eine Zahl", () =>
    assertNumberDefault("recall.candidateTopK", 40));
  it("recall.dedup ist ein Boolean", () =>
    assertBooleanDefault("recall.dedup", true));
  it("recall.canonicalFirst ist ein Boolean", () =>
    assertBooleanDefault("recall.canonicalFirst", true));
});

describe("Schema-Default-Typen (Runtime / Cache)", () => {
  it("runtime.recallTimeoutMs ist eine Zahl", () =>
    assertNumberDefault("runtime.recallTimeoutMs", 45000));
  it("runtime.captureTimeoutMs ist eine Zahl", () =>
    assertNumberDefault("runtime.captureTimeoutMs", 60000));
  it("runtime.maxConcurrentRecall ist eine Zahl", () =>
    assertNumberDefault("runtime.maxConcurrentRecall", 2));
  it("runtime.maxConcurrentCapturePerAgent ist eine Zahl", () =>
    assertNumberDefault("runtime.maxConcurrentCapturePerAgent", 1));
  it("runtime.recallCacheTtlMs ist eine Zahl", () =>
    assertNumberDefault("runtime.recallCacheTtlMs", 120000));
  it("runtime.embeddingCacheEnabled ist ein Boolean", () =>
    assertBooleanDefault("runtime.embeddingCacheEnabled", false));
  it("runtime.embeddingCacheTtlMs ist eine Zahl", () =>
    assertNumberDefault("runtime.embeddingCacheTtlMs", 1800000));
  it("runtime.embeddingCacheMaxEntries ist eine Zahl", () =>
    assertNumberDefault("runtime.embeddingCacheMaxEntries", 500));
  it("runtime.metricsDebounceMs ist eine Zahl", () =>
    assertNumberDefault("runtime.metricsDebounceMs", 5000));
});

describe("Schema-Default-Typen (Semantic Lens)", () => {
  it("semanticLens.enabled ist default false", () =>
    assertBooleanDefault("semanticLens.enabled", false));
  it("semanticLens.maxLensMemories ist 3", () =>
    assertNumberDefault("semanticLens.maxLensMemories", 3));
  it("semanticLens.maxBridgeMemories ist 2", () =>
    assertNumberDefault("semanticLens.maxBridgeMemories", 2));
  it("semanticLens.maxFadedMemories ist 1", () =>
    assertNumberDefault("semanticLens.maxFadedMemories", 1));
  it("semanticLens.maxCommunities ist 2", () =>
    assertNumberDefault("semanticLens.maxCommunities", 2));
  it("semanticLens.timeoutMs ist 50", () =>
    assertNumberDefault("semanticLens.timeoutMs", 50));
});

describe("Schema-Default-Typen (Conversation Reactivation Recall)", () => {
  it("conversationReactivationRecall.enabled ist false", () =>
    assertBooleanDefault("conversationReactivationRecall.enabled", false));
  it("conversationReactivationRecall.idleThresholdMinutes ist eine Zahl", () =>
    assertNumberDefault("conversationReactivationRecall.idleThresholdMinutes", 45));
  it("conversationReactivationRecall.cooldownMinutes ist eine Zahl", () =>
    assertNumberDefault("conversationReactivationRecall.cooldownMinutes", 30));
  it("conversationReactivationRecall.maxReactivationMemories ist eine Zahl", () =>
    assertNumberDefault("conversationReactivationRecall.maxReactivationMemories", 3));
  it("conversationReactivationRecall.maxFadedReactivationMemories ist eine Zahl", () =>
    assertNumberDefault("conversationReactivationRecall.maxFadedReactivationMemories", 1));
  it("conversationReactivationRecall.maxOpenThreads ist eine Zahl", () =>
    assertNumberDefault("conversationReactivationRecall.maxOpenThreads", 3));
  it("conversationReactivationRecall.maxCommunities ist eine Zahl", () =>
    assertNumberDefault("conversationReactivationRecall.maxCommunities", 2));
  it("conversationReactivationRecall.timeoutMs ist eine Zahl", () =>
    assertNumberDefault("conversationReactivationRecall.timeoutMs", 50));
  it("conversationReactivationRecall.visibleHints ist false", () =>
    assertBooleanDefault("conversationReactivationRecall.visibleHints", false));
});

describe("Schema-Default-Typen (Sonstige)", () => {
  it("recallMinScore ist eine Zahl", () =>
    assertNumberDefault("recallMinScore", 0.15));
  it("autoRecallMinScore ist eine Zahl", () =>
    assertNumberDefault("autoRecallMinScore", 0.2));
  it("duplicateThreshold ist eine Zahl", () =>
    assertNumberDefault("duplicateThreshold", 0.95));
  it("forgetThreshold ist eine Zahl", () =>
    assertNumberDefault("forgetThreshold", 0.3));
  it("summaryMaxWords ist eine Zahl", () =>
    assertNumberDefault("summaryMaxWords", 150));
});

describe("halfLifeDaysMap-Gruppen sind vollständig", () => {
  const map = getDefault("recall.halfLifeDaysMap") || schema.configSchema.properties.recall.properties.halfLifeDaysMap.properties;
  const requiredGroups = ["transient", "episodic", "longContext", "project"];

  for (const group of requiredGroups) {
    it(`enthält Gruppe "${group}"`, () => {
      assert.ok(
        map && map[group] !== undefined,
        `halfLifeDaysMap fehlt Gruppe: ${group}`
      );
      const val = map[group].default !== undefined ? map[group].default : map[group];
      assert.strictEqual(typeof val, "number", `halfLifeDaysMap.${group} muss eine Zahl sein`);
    });
  }

  it("hat keine zusätzlichen Gruppen", () => {
    const keys = Object.keys(map || {});
    const extra = keys.filter((k) => !requiredGroups.includes(k));
    assert.deepStrictEqual(
      extra,
      [],
      `Unerwartete Gruppen in halfLifeDaysMap: ${extra.join(", ")}`
    );
  });

  it("Werte stimmen mit Code-Defaults überein", () => {
    assert.strictEqual(map.transient.default ?? map.transient, 60);
    assert.strictEqual(map.episodic.default ?? map.episodic, 180);
    assert.strictEqual(map.longContext.default ?? map.longContext, 600);
    assert.strictEqual(map.project.default ?? map.project, 600);
  });
});

describe("Code-Fallbacks stimmen mit Schema-Defaults überein", () => {
  // Wir lesen index.js als Text und prüfen die Fallback-Literale
  const indexPath = join(__dirname, "..", "index.js");
  const indexSrc = readFileSync(indexPath, "utf8");

  function extractFallback(varName, expected) {
    const regex = new RegExp(
      `const\\s+${varName}\\s*=\\s*recallCfg\\.${varName.replace(/TopK$/, "TopK").replace(/MaxItems$/, "MaxItems").replace(/Jaccard$/, "Jaccard").replace(/Memories$/, "Memories")}\\s*\\?\\?\\s*([0-9.]+)`
    );
    // Manuelle Regex für jeden Wert, da die Variablennamen teilweise anders heißen
  }

  it("index.js: dedupJaccard fallback = 0.78", () => {
    const m = indexSrc.match(/const\s+dedupJaccard\s*=\s*recallCfg\.dedupJaccard\s*\?\?\s*([0-9.]+)/);
    assert.ok(m, "dedupJaccard fallback nicht gefunden");
    assert.strictEqual(parseFloat(m[1]), 0.78);
  });

  it("index.js: canonicalMaxItems fallback = 5", () => {
    const m = indexSrc.match(/const\s+canonicalMaxItems\s*=\s*recallCfg\.canonicalMaxItems\s*\?\?\s*([0-9.]+)/);
    assert.ok(m, "canonicalMaxItems fallback nicht gefunden");
    assert.strictEqual(parseFloat(m[1]), 5);
  });

  it("index.js: maxPromptMemories fallback = 12", () => {
    const m = indexSrc.match(/const\s+maxPromptMemories\s*=\s*recallCfg\.maxPromptMemories\s*\?\?\s*([0-9.]+)/);
    assert.ok(m, "maxPromptMemories fallback nicht gefunden");
    assert.strictEqual(parseFloat(m[1]), 12);
  });

  it("index.js: candidateTopK fallback = 40", () => {
    const m = indexSrc.match(/const\s+candidateTopK\s*=\s*recallCfg\.candidateTopK\s*\?\?\s*([0-9.]+)/);
    assert.ok(m, "candidateTopK fallback nicht gefunden");
    assert.strictEqual(parseFloat(m[1]), 40);
  });

  it("index.js: importanceBoost fallback = 0.3", () => {
    const m = indexSrc.match(/const\s+importanceBoost\s*=\s*recallCfg\.importanceBoost\s*\?\?\s*([0-9.]+)/);
    assert.ok(m, "importanceBoost fallback nicht gefunden");
    assert.strictEqual(parseFloat(m[1]), 0.3);
  });

  it("index.js: summaryMaxWords fallback = 150", () => {
    const m = indexSrc.match(/const\s+summaryMaxWords\s*=\s*cfg\.summaryMaxWords\s*\?\?\s*([0-9.]+)/);
    assert.ok(m, "summaryMaxWords fallback nicht gefunden");
    assert.strictEqual(parseFloat(m[1]), 150);
  });

  it("lib/recall-pipeline.js: dedupJaccard default = 0.78", () => {
    const pipelinePath = join(__dirname, "..", "lib", "recall-pipeline.js");
    const src = readFileSync(pipelinePath, "utf8");
    const m = src.match(/dedupJaccard\s*=\s*([0-9.]+)/);
    assert.ok(m, "dedupJaccard default in recall-pipeline nicht gefunden");
    assert.strictEqual(parseFloat(m[1]), 0.78);
  });

  it("lib/recall-pipeline.js: topN default = 12", () => {
    const pipelinePath = join(__dirname, "..", "lib", "recall-pipeline.js");
    const src = readFileSync(pipelinePath, "utf8");
    const m = src.match(/topN\s*=\s*([0-9.]+)/);
    assert.ok(m, "topN default in recall-pipeline nicht gefunden");
    assert.strictEqual(parseFloat(m[1]), 12);
  });

  it("lib/recall-pipeline.js: canonicalMaxItems default = 5", () => {
    const pipelinePath = join(__dirname, "..", "lib", "recall-pipeline.js");
    const src = readFileSync(pipelinePath, "utf8");
    const m = src.match(/canonicalMaxItems\s*=\s*([0-9.]+)/);
    assert.ok(m, "canonicalMaxItems default in recall-pipeline nicht gefunden");
    assert.strictEqual(parseFloat(m[1]), 5);
  });

  it("lib/memory-dynamics.js: DEFAULT_HALF_LIFE_MAP stimmt mit Schema", () => {
    const dynPath = join(__dirname, "..", "lib", "memory-dynamics.js");
    const src = readFileSync(dynPath, "utf8");
    const m = src.match(/const\s+DEFAULT_HALF_LIFE_MAP\s*=\s*\{([^}]+)\}/s);
    assert.ok(m, "DEFAULT_HALF_LIFE_MAP nicht gefunden");
    const block = m[1];
    assert.match(block, /transient:\s*60/);
    assert.match(block, /episodic:\s*180/);
    assert.match(block, /longContext:\s*600/);
    assert.match(block, /project:\s*600/);
  });

  it("lib/embedding-cache.js: maxEntries default = 500", () => {
    const cachePath = join(__dirname, "..", "lib", "embedding-cache.js");
    const src = readFileSync(cachePath, "utf8");
    const m = src.match(/maxEntries\s*=\s*([0-9.]+)/);
    assert.ok(m, "maxEntries default nicht gefunden");
    assert.strictEqual(parseFloat(m[1]), 500);
  });

  it("lib/embedding-cache.js: ttlMs default = 1800000", () => {
    const cachePath = join(__dirname, "..", "lib", "embedding-cache.js");
    const src = readFileSync(cachePath, "utf8");
    const m = src.match(/ttlMs\s*=\s*([0-9.]+)/);
    assert.ok(m, "ttlMs default nicht gefunden");
    assert.strictEqual(parseFloat(m[1]), 1800000);
  });

  it("lib/metrics-debounce.js: debounceMs default = 5000", () => {
    const debPath = join(__dirname, "..", "lib", "metrics-debounce.js");
    const src = readFileSync(debPath, "utf8");
    const m = src.match(/debounceMs\s*=\s*([0-9.]+)/);
    assert.ok(m, "debounceMs default nicht gefunden");
    assert.strictEqual(parseFloat(m[1]), 5000);
  });
});

describe("Schema-Default-Typen (Obsidian Bridge Graph Links)", () => {
  it("obsidianBridge.graphLinks.maxPerNote ist 5", () =>
    assertNumberDefault("obsidianBridge.graphLinks.maxPerNote", 5));
  it("obsidianBridge.graphLinks.includeSemantic ist false", () =>
    assertBooleanDefault("obsidianBridge.graphLinks.includeSemantic", false));
  it("obsidianBridge.graphLinks.semanticThreshold ist 0.78", () =>
    assertNumberDefault("obsidianBridge.graphLinks.semanticThreshold", 0.78));
  it("obsidianBridge.graphLinks.blockId ist 'graph-links'", () => {
    assert.strictEqual(getDefault("obsidianBridge.graphLinks.blockId"), "graph-links");
  });
  it("obsidianBridge.graphLinks.tiers entspricht dem Default", () => {
    assert.deepStrictEqual(getDefault("obsidianBridge.graphLinks.tiers"), [
      "explicit",
      "type",
      "semantic",
    ]);
  });
  it("obsidianBridge.graphLinks.semanticDiscovery.maxPerRun ist 500", () =>
    assertNumberDefault("obsidianBridge.graphLinks.semanticDiscovery.maxPerRun", 500));
  it("obsidianBridge.graphLinks.semanticDiscovery.threshold ist 0.78", () =>
    assertNumberDefault("obsidianBridge.graphLinks.semanticDiscovery.threshold", 0.78));
  it("obsidianBridge.graphLinks.semanticDiscovery.maxLinksPerRecord ist 5", () =>
    assertNumberDefault("obsidianBridge.graphLinks.semanticDiscovery.maxLinksPerRecord", 5));
  it("obsidianBridge.graphLinks.semanticDiscovery.enabled ist false", () =>
    assertBooleanDefault("obsidianBridge.graphLinks.semanticDiscovery.enabled", false));
  it("obsidianBridge.graphLinks.semanticDiscovery.topK ist 20", () =>
    assertNumberDefault("obsidianBridge.graphLinks.semanticDiscovery.topK", 20));
});

describe("Schema-Default-Typen (Emotion)", () => {
  it("emotion.tier ist 'auto'", () => {
    assert.strictEqual(getDefault("emotion.tier"), "auto");
  });
  it("emotion.t2.enabled ist true", () =>
    assertBooleanDefault("emotion.t2.enabled", true));
  it("emotion.t3.enabled ist false", () =>
    assertBooleanDefault("emotion.t3.enabled", false));
  it("emotion.t3.model ist 'gpt-4o-mini'", () => {
    assert.strictEqual(getDefault("emotion.t3.model"), "gpt-4o-mini");
  });
});

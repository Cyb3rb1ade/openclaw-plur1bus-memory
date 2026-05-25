import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, "..");
const repoRoot = resolve(pluginDir, "../..");

test("manifest schema allows OpenClaw hook permissions and hook timeouts", () => {
  const manifest = JSON.parse(readFileSync(resolve(pluginDir, "openclaw.plugin.json"), "utf8"));
  const hooks = manifest.configSchema.properties.hooks;
  assert.equal(hooks.type, "object");
  assert.equal(hooks.additionalProperties, false);
  assert.ok(hooks.properties.allowConversationAccess);
  assert.ok(hooks.properties.allowPromptInjection);
  assert.ok(hooks.properties.timeoutMs);
  assert.ok(hooks.properties.timeouts);
});

test("installer writes both hook permissions and per-hook timeouts", () => {
  const installer = readFileSync(resolve(repoRoot, "scripts/install-memory-system.sh"), "utf8");
  assert.match(installer, /allowConversationAccess/);
  assert.match(installer, /allowPromptInjection/);
  assert.match(installer, /before_prompt_build/);
  assert.match(installer, /agent_end/);
});

test("installer enforces the v3 OpenClaw beta-aware minimum", () => {
  const installer = readFileSync(resolve(repoRoot, "scripts/install-memory-system.sh"), "utf8");
  assert.match(installer, /MIN_OPENCLAW_VERSION="2026\.5\.10-beta\.5"/);
  assert.match(installer, /version_rank\(\)/);
  assert.match(installer, /-beta\\\.\[0-9\]\+/);
  assert.doesNotMatch(installer, /sort -V/);
});

test("plugin package is self-contained for native OpenClaw install", () => {
  const pkg = JSON.parse(readFileSync(resolve(pluginDir, "package.json"), "utf8"));
  assert.equal(pkg.main, "./index.js");
  assert.deepEqual(pkg.openclaw.extensions, ["./index.js"]);
  assert.ok(pkg.dependencies["@lancedb/lancedb"]);
  assert.ok(pkg.dependencies.openai);
  assert.equal(pkg.optionalDependencies["@huggingface/transformers"], "4.2.0");
  assert.deepEqual(pkg.files, [
    "index.js",
    "lib/",
    "openclaw.plugin.json",
    "README.md",
  ]);
});

test("manifest declares PLUR1BUS memory embedding providers without memory kind", () => {
  const manifest = JSON.parse(readFileSync(resolve(pluginDir, "openclaw.plugin.json"), "utf8"));
  assert.deepEqual(manifest.contracts.tools, [
    "knowledge_update",
    "memory_forget",
    "memory_recall",
    "memory_search",
    "memory_store",
  ]);
  assert.deepEqual(manifest.contracts.memoryEmbeddingProviders, [
    "plur1bus-openai",
    "plur1bus-openai-compatible",
    "plur1bus-e5-small",
  ]);
  assert.equal(manifest.kind, undefined);
});

test("manifest schema permits local providers and disabled reranker without apiKey", () => {
  const manifest = JSON.parse(readFileSync(resolve(pluginDir, "openclaw.plugin.json"), "utf8"));
  const embedding = manifest.configSchema.properties.embedding;
  const reranker = manifest.configSchema.properties.reranker;
  assert.deepEqual(embedding.required, []);
  assert.deepEqual(reranker.required, []);
  assert.ok(embedding.properties.provider.enum.includes("local-transformers"));
  assert.ok(reranker.properties.provider.enum.includes("disabled"));
  assert.ok(reranker.properties.provider.enum.includes("local-transformers"));
});

test("manifest declares disabled-by-default Obsidian bridge config", () => {
  const manifest = JSON.parse(readFileSync(resolve(pluginDir, "openclaw.plugin.json"), "utf8"));
  const bridge = manifest.configSchema.properties.obsidianBridge;
  assert.equal(manifest.version, "4.2.8");
  assert.equal(bridge.type, "object");
  assert.equal(bridge.additionalProperties, false);
  assert.equal(bridge.properties.enabled.default, false);
  assert.equal(bridge.properties.mode.default, "augment");
  assert.equal(bridge.properties.requireUserApproval.default, true);
  assert.equal(bridge.properties.applyApprovedOnly.default, true);
  assert.equal(bridge.properties.allowDotObsidianWrite.default, false);
  assert.equal(bridge.properties.sourceOfTruth.default, "plur1bus-lancedb");
  assert.equal(bridge.properties.recallAuthority.default, "lancedb-reranked-vector");
  assert.equal(bridge.properties.semanticGraph.properties.proposalOnly.default, true);
  assert.equal(bridge.properties.semanticGraph.properties.mutateMemory.default, false);
  assert.equal(bridge.properties.adversarialDeep.properties.llmClassifier.default, false);
  assert.ok(bridge.properties.agents.properties.defaultProfiles.additionalProperties.enum.includes("semantic_deep"));
  assert.equal(bridge.properties.agents.properties.equalCapabilities.default, true);
  assert.equal(bridge.properties.morningReview.properties.timezone.default, "Europe/Berlin");
  assert.equal(bridge.properties.eveningReview.properties.cron.default, "0 18 * * *");
  assert.equal(bridge.properties.eveningReview.properties.timezone.default, "Europe/Berlin");
  assert.equal(bridge.properties.dryRun.default, true);
  assert.ok(bridge.properties.workspaces);
  assert.ok(bridge.properties.includeGlobs);
  assert.ok(bridge.properties.ignoreGlobs);
  assert.ok(bridge.properties.tombstoneOnDelete);
});

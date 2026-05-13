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

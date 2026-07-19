import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { manifestConfigDefaults, validatePluginConfig } from "../lib/setup/config-contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const configuration = readFileSync(join(root, "docs", "configuration.md"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");

function canonicalExample() {
  const heading = "## Beispiel-Konfiguration (Minimal)";
  const start = configuration.indexOf(heading);
  assert.notEqual(start, -1, "canonical configuration heading must exist");
  const fenceStart = configuration.indexOf("```json", start);
  const jsonStart = configuration.indexOf("\n", fenceStart) + 1;
  const fenceEnd = configuration.indexOf("\n```", jsonStart);
  assert.ok(fenceStart >= start && fenceEnd > jsonStart, "canonical JSON fence must be complete");
  return JSON.parse(configuration.slice(jsonStart, fenceEnd));
}

function documentedTableDefault(key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = configuration.match(new RegExp(`\\|\\s*\\\`${escaped}\\\`\\s*\\|[^|]*\\|\\s*\\\`([^\\\`]*)\\\``));
  assert.ok(match, `documented default row missing for ${key}`);
  return match[1];
}

describe("copyable configuration documentation contract", () => {
  it("publishes a full plugin-entry example whose inner config validates", () => {
    const example = canonicalExample();
    const entry = example.plugins?.entries?.["memory-lancedb-namespaced"];

    assert.ok(entry, "example must include plugins.entries.memory-lancedb-namespaced");
    assert.equal(typeof entry.enabled, "boolean");
    assert.ok(entry.config?.recall, "Recall fields must live under the plugin entry's config.recall");
    assert.equal(Object.hasOwn(entry.config, "maxPromptMemories"), false);
    assert.doesNotThrow(() => validatePluginConfig(entry.config));
  });

  it("documents explicit profile selection and non-mutating status/listing commands", () => {
    assert.match(readme, /`\/plur1bus setup recommended`/);
    assert.match(readme, /`\/plur1bus setup safe`/);
    assert.match(readme, /`\/plur1bus setup`[^\n]*(list|choice|profile)/i);
    assert.match(readme, /`\/plur1bus start`[^\n]*(status|guidance|onboarding)/i);
    assert.doesNotMatch(readme, /`\/plur1bus setup`[^\n]*confirm the recommended feature profile/i);
  });

  it("keeps published safety-sensitive defaults aligned with the manifest", () => {
    const defaults = manifestConfigDefaults();

    assert.equal(documentedTableDefault("emotion.t3.enabled"), String(defaults.emotion.t3.enabled));
    assert.match(readme, new RegExp(`Reranker timeout[^\\n]*default ${defaults.reranker.timeoutMs / 1000}s`, "i"));
    assert.match(readme, new RegExp(`merging\\.autoApply[^\\n]*defaults to[^\\n]*${defaults.merging.autoApply}`, "i"));
    assert.match(readme, new RegExp(`reviews marked[^\\n]*${defaults.obsidianBridge.morningReview.status}`, "i"));
    assert.equal(defaults.obsidianBridge.eveningReview.status, defaults.obsidianBridge.morningReview.status);
  });
});

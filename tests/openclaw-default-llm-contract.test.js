import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  applyInstallerFeaturePolicy,
} from "../scripts/lib/installer-config.mjs";
import {
  recommendedProfile,
  safeProfile,
} from "../lib/setup/feature-profiles.js";
import { LLM_ROUTE_KINDS } from "../lib/llm-router.js";

const readRepo = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const manifest = JSON.parse(readRepo("openclaw.plugin.json"));
const configuration = readRepo("docs/configuration.md");
const readme = readRepo("README.md");

const CHAT_FEATURE_PATHS = [
  ["merging"],
  ["schicht15"],
  ["skillMiner"],
  ["criticalPush"],
  ["emotion", "t3"],
];

function schemaAt(parts) {
  let current = manifest.configSchema;
  for (const part of parts) current = current.properties[part];
  return current;
}

function routeAt(config, parts) {
  let current = config;
  for (const part of parts) current = current?.[part];
  return current;
}

describe("OpenClaw-default chat schema contract", () => {
  it("keeps every feature chat model optional, default-free, and described as agent-effective", () => {
    for (const path of CHAT_FEATURE_PATHS) {
      const model = schemaAt(path).properties.model;
      assert.ok(model, `${path.join(".")}.model schema must exist`);
      assert.equal(Object.hasOwn(model, "default"), false, `${path.join(".")}.model must not default`);
      assert.match(
        model.description || "",
        /absent[\s\S]*effective OpenClaw[\s\S]*agent model/i,
        `${path.join(".")}.model must describe native default selection`,
      );
    }
  });

  it("documents every direct transport field as requiring a feature-local explicit model", () => {
    for (const path of CHAT_FEATURE_PATHS) {
      const properties = schemaAt(path).properties;
      for (const field of ["baseUrl", "apiKey", "headers"]) {
        if (!properties[field]) continue;
        assert.match(
          properties[field].description || "",
          /feature-local[\s\S]*explicit model[\s\S]*(?:required|require)/i,
          `${path.join(".")}.${field} must explain the fail-closed direct contract`,
        );
      }
    }
  });
});

describe("runtime and setup source contract", () => {
  it("contains no named chat-model default in current runtime selection files", () => {
    const runtimeSelectionSources = [
      "index.js",
      "lib/llm-router.js",
      "lib/emotion.js",
      "lib/emotion-engine.js",
      "lib/tier3-llm.js",
      "lib/overlay-generator.js",
      "lib/interpretation-overlay.js",
    ].map((path) => `${path}\n${readRepo(path)}`).join("\n");
    assert.doesNotMatch(runtimeSelectionSources, /kimi-for-coding|gpt-4o-mini/i);
  });

  it("retains the owner-only route boundary without cross-feature fallback expressions", () => {
    const ownerSources = [
      "index.js",
      "lib/jobs/daily-consolidation.js",
      "lib/jobs/memory-compaction.js",
      "lib/jobs/conflict-resolver.js",
      "lib/jobs/skill-miner/llm-extractor.js",
      "lib/dreaming/light-dream.js",
      "lib/dreaming/rem-dream.js",
      "lib/dreaming/dream-narrative.js",
      "lib/dream-echo.js",
      "lib/overlay-commands.js",
      "lib/episodes.js",
    ].map((path) => `${path}\n${readRepo(path)}`).join("\n");

    for (const forbidden of [
      /skillMinerLlmCfg\s*\|\|\s*mergingLlmCfg/,
      /llmCfg:\s*mergingLlmCfg/,
      /mergingLlmCfg\?\.model/,
      /(?:schicht15|skillMiner|criticalPush|emotionT3)\w*\s*=\s*merging(?:Cfg|LlmCfg|Model)/i,
    ]) {
      assert.doesNotMatch(ownerSources, forbidden);
    }
  });

  it("keeps Safe, Recommended, and fresh installer policy free of models and implicit LLM trust", () => {
    for (const profile of [safeProfile(), recommendedProfile()]) {
      for (const path of CHAT_FEATURE_PATHS) {
        assert.equal(Object.hasOwn(routeAt(profile, path), "model"), false);
      }
      assert.equal(Object.hasOwn(profile, "llm"), false);
    }

    for (const mode of ["preserve", "safe", "recommended"]) {
      const entry = applyInstallerFeaturePolicy({}, { mode });
      assert.equal(Object.hasOwn(entry, "llm"), false, `${mode} must not grant entry-level LLM trust`);
      for (const path of CHAT_FEATURE_PATHS) {
        const route = routeAt(entry.config, path);
        if (route) assert.equal(Object.hasOwn(route, "model"), false);
      }
    }
  });

  it("uses only stable route labels in the shared router contract", () => {
    const routerSource = readRepo("lib/llm-router.js");
    assert.deepEqual(new Set(Object.values(LLM_ROUTE_KINDS)), new Set([
      "openclaw-default",
      "openclaw-override",
      "direct-override",
      "unavailable",
    ]));
    assert.match(routerSource, /status:\s*"failed"/);
    assert.match(routerSource, /provider:\s*metadata\.provider/);
    assert.match(routerSource, /model:\s*metadata\.model/);
  });
});

describe("current-behavior LLM documentation contract", () => {
  it("documents all routes, native-cache bypass, and fail-soft/fail-closed behavior", () => {
    const docs = `${configuration}\n${readme}`;
    for (const label of ["openclaw-default", "openclaw-override", "direct-override", "unavailable", "failed"]) {
      assert.match(docs, new RegExp(label));
    }
    assert.match(docs, /direct transport[^\n]*without[^\n]*model[^\n]*fail(?:s)? closed/i);
    assert.match(docs, /configured credential[^\n]*unresolved[^\n]*unavailable/i);
    assert.match(docs, /never[\s\S]{0,120}native[\s\S]{0,120}host credentials/i);
    assert.match(docs, /native[^\n]*bypass[^\n]*PLUR1BUS[^\n]*result cache/i);
    assert.match(docs, /runtime\.llm\.complete[^\n]*(?:missing|unavailable)[^\n]*fail-soft/i);
  });

  it("documents session, global-agent, and native-model trust boundaries accurately", () => {
    const docs = `${configuration}\n${readme}`;
    assert.match(docs, /session-bound[^\n]*command[^\n]*(?:omit|without)[^\n]*agentId/i);
    assert.match(docs, /hook[\s\S]{0,120}tool[\s\S]{0,120}background[\s\S]{0,180}llm\.allowAgentIdOverride[\s\S]{0,30}true/i);
    assert.match(docs, /model-only native override[\s\S]{0,120}llm\.allowModelOverride[\s\S]{0,30}true/i);
    assert.match(docs, /allowedModels/);
    assert.match(docs, /preserve[^\n]*never[^\n]*grant[^\n]*(?:trust|llm)/i);
  });

  it("promises one effective primary selection, not an unimplemented host fallback chain", () => {
    const docs = `${configuration}\n${readme}`;
    assert.match(docs, /runtime\.llm\.complete[^\n]*effective primary/i);
    assert.match(docs, /runtime\.llm\.complete[\s\S]{0,160}(?:does not|never)[\s\S]{0,160}(?:fallback array|configured model fallback)/i);
    assert.doesNotMatch(docs, /runtime\.llm\.complete[^\n]*(?:executes|runs|tries)[^\n]*(?:fallback array|fallback chain)/i);
  });

  it("labels named README chat models as explicit examples rather than defaults", () => {
    assert.match(readme, /explicit override example[\s\S]{0,900}gpt-4o-mini/i);
    assert.doesNotMatch(readme, /gpt-4o-mini[^\n]*(?:default|fallback)/i);
  });
});

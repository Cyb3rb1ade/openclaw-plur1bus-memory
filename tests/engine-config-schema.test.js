/**
 * tests/engine-config-schema.test.js — E5 Task 2: engine/config/engine-config.schema.json,
 * the host-neutral config schema (manifest configSchema plus readAt, x-tier and
 * x-sensitive), and its loader. The owner's E5-R24 ruling adds the four
 * `*.headers` maps and reminders.webhookUrl to x-sensitive (masking) but not to
 * the secret inputs, which stay the eight `$ref secretInput` nodes.
 *
 * Ruling E5-R3 (preflight R1): reembedding.activeGeneration stays readAt
 * "construction" — it picks the store layout at createEngine — so livePaths() is
 * [] in 1.9.0. The live-resolution logic itself is covered on a synthetic schema.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ENGINE_CONFIG_SCHEMA_FILE,
  engineConfigKeys,
  livePaths,
  loadEngineConfigSchema,
  readAtOf,
  REDACTED_CONFIG_VALUE,
  redactSensitiveConfig,
  SECRET_INPUT_REF,
  secretInputPaths,
  sensitivePaths,
} from "../engine/config/engine-config-schema.js";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));

/** OpenClaw adapter-only keys live on the generated manifest, not the engine schema (I3). */
const ADAPTER_ONLY_TOP_LEVEL_KEYS = new Set(["groupReasoningFilter"]);
const ADAPTER_ONLY_RUNTIME_KEYS = new Set(["traceRegistrations"]);

// SecretInput nodes ($ref #/$defs/secretInput): the manifest's secretInputs.paths.
const SECRET_INPUTS = [
  "embedding.apiKey",
  "embedding.fallback.apiKey",
  "reranker.apiKey",
  "merging.apiKey",
  "schicht15.apiKey",
  "skillMiner.apiKey",
  "criticalPush.apiKey",
  "emotion.t3.apiKey",
];
// Owner ruling on E5-R24: also masked, but plain values only (no SecretRef surface).
const SENSITIVE_PLAIN = [
  "reminders.webhookUrl",
  "merging.headers",
  "schicht15.headers",
  "skillMiner.headers",
  "criticalPush.headers",
];
const SENSITIVE = [
  "embedding.apiKey",
  "embedding.fallback.apiKey",
  "reminders.webhookUrl",
  "reranker.apiKey",
  "merging.apiKey",
  "merging.headers",
  "schicht15.apiKey",
  "schicht15.headers",
  "skillMiner.apiKey",
  "skillMiner.headers",
  "criticalPush.apiKey",
  "criticalPush.headers",
  "emotion.t3.apiKey",
];

describe("engine-config.schema.json", () => {
  it("the schema carries every manifest key with type, description, readAt and x-tier", () => {
    const keys = engineConfigKeys();
    const manifestKeys = Object.keys(manifest.configSchema.properties);
    assert.equal(keys.length, 57);
    for (const key of ADAPTER_ONLY_TOP_LEVEL_KEYS) {
      assert.ok(manifestKeys.includes(key), `OpenClaw adapter-only key ${key}`);
    }
    assert.deepEqual(keys.map((k) => k.key), manifestKeys.filter((key) => !ADAPTER_ONLY_TOP_LEVEL_KEYS.has(key)));
    for (const k of keys) {
      assert.equal(typeof k.description, "string", k.key);
      assert.ok(k.description.trim().length > 0, `${k.key}: empty description`);
      assert.doesNotMatch(k.description, /[äöüß]/i, `${k.key}: German description`);
      assert.equal(k.readAt, "construction", k.key);
      assert.equal(k.tier, "advanced", k.key);
    }
    const schema = loadEngineConfigSchema();
    assert.equal(schema["x-contract"], "1.11.0");
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.$id, "plur1bus-engine-config");
    assert.equal(ENGINE_CONFIG_SCHEMA_FILE, "engine/config/engine-config.schema.json");
    // Root keyword order: the three annotations, then configSchema verbatim.
    assert.deepEqual(Object.keys(schema), ["$schema", "$id", "x-contract", ...Object.keys(manifest.configSchema)]);
    assert.deepEqual(schema.$defs, manifest.configSchema.$defs);
    // featureCronSetup keeps its manifest description verbatim (E5-R6).
    assert.equal(schema.properties.featureCronSetup.description, manifest.configSchema.properties.featureCronSetup.description);
  });

  it("readAt resolves through the nearest declaring node", () => {
    assert.equal(readAtOf("recall.softBudgetMs"), "construction");
    assert.equal(readAtOf("reembedding.activeGeneration"), "construction");
    assert.equal(readAtOf("reembedding.fingerprintId"), "construction");
    assert.equal(readAtOf("gc"), "construction");
    assert.equal(readAtOf("nope.x"), null);
    assert.equal(readAtOf("gc.nope"), null);
    assert.equal(readAtOf(""), null);
    assert.deepEqual(livePaths(), []);
    assert.deepEqual(engineConfigKeys().find((k) => k.key === "reembedding").liveOverrides, []);

    // The resolution rule on a synthetic schema with a live override.
    const synthetic = {
      properties: {
        a: {
          type: "object",
          readAt: "construction",
          "x-tier": "basic",
          description: "A.",
          properties: {
            b: { type: "string", readAt: "live", properties: { c: { type: "number" } } },
            d: { type: "boolean" },
          },
        },
        e: { enum: ["x", "y"], default: "x", readAt: "live", "x-tier": "advanced", description: "E." },
      },
    };
    assert.equal(readAtOf("a.b", synthetic), "live");
    assert.equal(readAtOf("a.b.c", synthetic), "live");
    assert.equal(readAtOf("a.d", synthetic), "construction");
    assert.deepEqual(livePaths(synthetic), ["a.b", "a.b.c", "e"]);
    const [a, e] = engineConfigKeys(synthetic);
    assert.deepEqual(a.liveOverrides, ["a.b", "a.b.c"]);
    assert.equal(a.type, "object");
    assert.equal("default" in a, false);
    assert.deepEqual(e.liveOverrides, []);
    assert.equal(e.type, "enum");
    assert.equal(e.default, "x");
  });

  it("credential inputs, direct-transport headers and the reminder webhook are marked sensitive", () => {
    assert.deepEqual(sensitivePaths(), SENSITIVE);
    assert.deepEqual([...SENSITIVE].sort(), [...SECRET_INPUTS, ...SENSITIVE_PLAIN].sort());
    assert.deepEqual(
      engineConfigKeys().filter((k) => k.sensitive).map((k) => k.key),
      ["embedding", "reminders", "reranker", "merging", "schicht15", "skillMiner", "criticalPush", "emotion"],
    );
  });

  it("secret inputs are the $ref secretInput nodes, a subset of x-sensitive", () => {
    assert.equal(SECRET_INPUT_REF, "#/$defs/secretInput");
    assert.deepEqual(secretInputPaths(), SECRET_INPUTS);
    // Unchanged from the manifest's secret inputs before the E5-R24 ruling.
    assert.deepEqual(secretInputPaths(), manifest.configContracts.secretInputs.paths.map((e) => e.path));
    const sensitive = new Set(sensitivePaths());
    for (const path of secretInputPaths()) assert.ok(sensitive.has(path), `${path}: a secret input must be x-sensitive`);
    // The plain-only paths keep their plain schema types, so a SecretRef object would not validate there.
    const schema = loadEngineConfigSchema();
    assert.equal(schema.properties.reminders.properties.webhookUrl.type, "string");
    for (const key of ["merging", "schicht15", "skillMiner", "criticalPush"]) {
      assert.equal(schema.properties[key].properties.headers.type, "object", key);
      assert.equal(Object.hasOwn(schema.properties[key].properties.headers, "$ref"), false, key);
    }
  });

  it("redactSensitiveConfig masks every x-sensitive value, including headers maps and the webhook URL", () => {
    const secretRef = { source: "env", provider: "default", id: "PLUR1BUS_OPENAI_API_KEY" };
    const config = {
      embedding: { provider: "openai", apiKey: "sk-embed-secret-1234567890", fallback: { apiKey: secretRef } },
      reminders: { deliveryMode: "webhook", webhookUrl: "https://hooks.example.test/T0/B0/tok-webhook-secret" },
      reranker: { apiKey: "" },
      merging: { model: "m", headers: { Authorization: "Bearer hdr-merging-secret", "X-Trace": "t" } },
      schicht15: { headers: { "X-Api-Key": "hdr-schicht15-secret" } },
      skillMiner: { enabled: true, headers: { Authorization: "Bearer hdr-skillminer-secret" } },
      criticalPush: { apiKey: "sk-critical-secret-1234567890", headers: { Cookie: "hdr-criticalpush-secret" } },
      emotion: { t3: { apiKey: null } },
      gc: { enabled: true },
    };
    const before = structuredClone(config);
    const out = redactSensitiveConfig(config);
    assert.deepStrictEqual(config, before, "the input is not modified");
    for (const path of SENSITIVE_PLAIN) {
      const value = path.split(".").reduce((node, segment) => node[segment], out);
      assert.equal(value, REDACTED_CONFIG_VALUE, path);
    }
    assert.equal(out.embedding.apiKey, REDACTED_CONFIG_VALUE);
    assert.equal(out.embedding.fallback.apiKey, REDACTED_CONFIG_VALUE);
    assert.equal(out.criticalPush.apiKey, REDACTED_CONFIG_VALUE);
    // Absent and empty values stay as they are; everything else is untouched.
    assert.equal(out.reranker.apiKey, "");
    assert.equal(out.emotion.t3.apiKey, null);
    assert.equal(Object.hasOwn(out.schicht15, "apiKey"), false);
    assert.deepStrictEqual(out.gc, { enabled: true });
    assert.equal(out.merging.model, "m");
    assert.equal(out.reminders.deliveryMode, "webhook");
    assert.doesNotMatch(JSON.stringify(out), /secret|PLUR1BUS_OPENAI_API_KEY|Bearer/);
    // Non-object input passes through.
    assert.equal(redactSensitiveConfig(null), null);
    assert.equal(redactSensitiveConfig("x"), "x");
  });

  it("the loaded schema is frozen and cached", () => {
    const schema = loadEngineConfigSchema();
    assert.equal(loadEngineConfigSchema(), schema);
    assert.ok(Object.isFrozen(schema));
    assert.ok(Object.isFrozen(schema.properties.gc));
    assert.ok(Object.isFrozen(schema.properties.embedding.properties.fallback.properties));
    assert.throws(() => { "use strict"; schema.properties.gc.default = 1; }, TypeError);
  });

  it("defaults match the manifest", () => {
    const byKey = new Map(engineConfigKeys().map((k) => [k.key, k]));
    let withDefault = 0;
    for (const [key, node] of Object.entries(manifest.configSchema.properties)) {
      if (ADAPTER_ONLY_TOP_LEVEL_KEYS.has(key)) continue;
      const reported = byKey.get(key);
      if (Object.hasOwn(node, "default")) {
        withDefault += 1;
        assert.ok(Object.hasOwn(reported, "default"), `${key}: default missing`);
        assert.deepStrictEqual(reported.default, node.default, key);
      } else {
        assert.equal(Object.hasOwn(reported, "default"), false, `${key}: unexpected default`);
      }
    }
    assert.ok(withDefault > 0);
  });

  it("the schema differs from the manifest only by the documented annotations", () => {
    const schema = loadEngineConfigSchema();
    const strip = (node, path) => {
      if (Array.isArray(node)) return node.map((v, i) => strip(v, `${path}[${i}]`));
      if (!node || typeof node !== "object") return node;
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === "readAt" || k === "x-tier" || k === "x-sensitive") continue;
        out[k] = strip(v, `${path}.${k}`);
      }
      return out;
    };
    const stripped = strip(schema, "");
    const expected = structuredClone(manifest.configSchema);
    for (const key of ADAPTER_ONLY_TOP_LEVEL_KEYS) delete expected.properties[key];
    for (const key of ADAPTER_ONLY_RUNTIME_KEYS) delete expected.properties.runtime.properties[key];
    // OpenClaw overrides the engine default (false/inline) to true so the UI matches the release line.
    expected.properties.runtime.properties.deferPostTurnLlm.default =
      stripped.properties.runtime.properties.deferPostTurnLlm.default;
    // Descriptions are the one other difference: added where missing, replaced where German (E5-R6).
    for (const [key, node] of Object.entries(stripped.properties)) {
      expected.properties[key].description = node.description;
    }
    delete stripped.$schema;
    delete stripped.$id;
    delete stripped["x-contract"];
    assert.deepStrictEqual(stripped, expected);
    // Nested key order is preserved too (deepStrictEqual ignores it).
    assert.equal(JSON.stringify(Object.keys(schema.properties.recall.properties)), JSON.stringify(Object.keys(manifest.configSchema.properties.recall.properties)));
    // x-sensitive sits right after $ref on the credential nodes.
    assert.deepEqual(Object.keys(schema.properties.embedding.properties.apiKey), ["$ref", "x-sensitive"]);
    // ... and right after type on the plain-only sensitive nodes.
    assert.deepEqual(Object.keys(schema.properties.reminders.properties.webhookUrl), ["type", "x-sensitive"]);
    assert.deepEqual(Object.keys(schema.properties.merging.properties.headers), ["type", "x-sensitive", "description"]);
  });
});

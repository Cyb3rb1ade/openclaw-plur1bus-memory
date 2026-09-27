/**
 * tests/engine-config-schema.test.js — E5 Task 2: engine/config/engine-config.schema.json,
 * the host-neutral config schema (manifest configSchema plus readAt, x-tier and
 * x-sensitive), and its loader.
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
  sensitivePaths,
} from "../engine/config/engine-config-schema.js";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));

const SENSITIVE = [
  "embedding.apiKey",
  "embedding.fallback.apiKey",
  "reranker.apiKey",
  "merging.apiKey",
  "schicht15.apiKey",
  "skillMiner.apiKey",
  "criticalPush.apiKey",
  "emotion.t3.apiKey",
];

describe("engine-config.schema.json", () => {
  it("the schema carries every manifest key with type, description, readAt and x-tier", () => {
    const keys = engineConfigKeys();
    assert.equal(keys.length, 55);
    assert.deepEqual(keys.map((k) => k.key), Object.keys(manifest.configSchema.properties));
    for (const k of keys) {
      assert.equal(typeof k.description, "string", k.key);
      assert.ok(k.description.trim().length > 0, `${k.key}: empty description`);
      assert.doesNotMatch(k.description, /[äöüß]/i, `${k.key}: German description`);
      assert.equal(k.readAt, "construction", k.key);
      assert.equal(k.tier, "advanced", k.key);
    }
    const schema = loadEngineConfigSchema();
    assert.equal(schema["x-contract"], "1.9.0");
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

  it("credential inputs are marked sensitive", () => {
    assert.deepEqual(sensitivePaths(), SENSITIVE);
    assert.deepEqual(
      engineConfigKeys().filter((k) => k.sensitive).map((k) => k.key),
      ["embedding", "reranker", "merging", "schicht15", "skillMiner", "criticalPush", "emotion"],
    );
    // The same set the manifest declares as secret inputs today.
    assert.deepEqual(sensitivePaths(), manifest.configContracts.secretInputs.paths.map((e) => e.path));
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
  });
});

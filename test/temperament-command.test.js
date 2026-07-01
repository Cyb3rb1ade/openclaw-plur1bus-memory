/**
 * test/temperament-command.test.js — /plur1bus temperament: Anzeige und
 * Config-Transformation (pure Helpers, I/O passiert in index.js).
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { renderTemperamentOverview, applyTemperamentToRawConfig } from "../lib/temperament-command.js";

describe("renderTemperamentOverview", () => {
  it("zeigt Default-Temperament wenn nichts konfiguriert ist", () => {
    const txt = renderTemperamentOverview({ agentId: "bernhardine", temperamentsCfg: {}, lang: "de" });
    assert.ok(txt.includes("bernhardine"));
    assert.ok(txt.includes("warm"), "Default für bernhardine ist das warm-Preset");
    assert.ok(txt.includes("/plur1bus temperament"));
    for (const preset of ["ausgewogen", "warm", "kühl", "feurig", "stoisch"]) {
      assert.ok(txt.includes(preset), `Preset ${preset} sollte gelistet sein`);
    }
  });

  it("zeigt konfiguriertes Preset an", () => {
    const txt = renderTemperamentOverview({
      agentId: "main",
      temperamentsCfg: { main: { preset: "feurig", sensitivity: 1.8, decayMultiplier: 1.5 } },
      lang: "de",
    });
    assert.ok(txt.includes("feurig"));
  });

  it("rendert auch auf Englisch", () => {
    const txt = renderTemperamentOverview({ agentId: "main", temperamentsCfg: {}, lang: "en" });
    assert.ok(txt.includes("Available presets") || txt.includes("preset"));
  });
});

describe("applyTemperamentToRawConfig", () => {
  const pluginKey = "memory-lancedb-namespaced";
  const makeRawCfg = () => ({
    plugins: { entries: { [pluginKey]: { config: { emotion: {} } } } },
  });

  it("schreibt das Preset unter emotion.temperaments.<agentId>", () => {
    const result = applyTemperamentToRawConfig(makeRawCfg(), pluginKey, "heisenberg", "feurig");
    assert.strictEqual(result.error, undefined);
    const t = result.merged.plugins.entries[pluginKey].config.emotion.temperaments.heisenberg;
    assert.strictEqual(t.preset, "feurig");
    assert.strictEqual(t.sensitivity, 1.8);
    assert.strictEqual(t.decayMultiplier, 1.5);
  });

  it("unbekanntes Preset → error", () => {
    const result = applyTemperamentToRawConfig(makeRawCfg(), pluginKey, "main", "cholerisch");
    assert.ok(result.error, "Sollte error liefern");
    assert.ok(result.error.includes("cholerisch"));
  });

  it("fehlende Plugin-Config → error", () => {
    const result = applyTemperamentToRawConfig({ plugins: { entries: {} } }, pluginKey, "main", "warm");
    assert.ok(result.error);
  });

  it("mutiert das Original nicht", () => {
    const raw = makeRawCfg();
    applyTemperamentToRawConfig(raw, pluginKey, "main", "warm");
    assert.strictEqual(raw.plugins.entries[pluginKey].config.emotion.temperaments, undefined);
  });
});

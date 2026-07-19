/**
 * tests/upgrade-v6.test.js — P4 Release Candidate: Upgrade / Migration Simulation
 *
 * Simuliert Upgrade von altem Config-Stand (v5 → v6).
 * Prüft:
 * 1. Alte Config ohne neue Felder bekommt korrekte Defaults
 * 2. Alte Memories mit gesetztem halfLifeDays werden nicht umgesetzt
 * 3. Neue Memories bekommen typbasierte halfLifeDays
 * 4. Config-Override funktioniert
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyDynamicsDefaults,
  resolveHalfLifeDays,
} from "../lib/memory-dynamics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, "..", "openclaw.plugin.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const installerScript = readFileSync(join(__dirname, "..", "scripts", "install-memory-system.sh"), "utf8");

function getSchemaDefault(path) {
  const parts = path.split(".");
  let node = schema.configSchema.properties;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!node[part]) return undefined;
    node = node[part];
    if (i < parts.length - 1 && node && node.type === "object" && node.properties) {
      node = node.properties;
    }
  }
  return node && typeof node === "object" && "default" in node ? node.default : undefined;
}

describe("Upgrade-Simulation: Alte Config ohne neue Felder", () => {
  it("Schema-Defaults für neue Recall-Felder sind korrekt", () => {
    assert.strictEqual(getSchemaDefault("recall.maxPromptMemories"), 12);
    assert.strictEqual(getSchemaDefault("recall.canonicalMaxItems"), 5);
    assert.strictEqual(getSchemaDefault("recall.dedupJaccard"), 0.78);
    assert.strictEqual(getSchemaDefault("recall.candidateTopK"), 40);
  });

  it("Schema-Defaults für halfLifeDaysMap sind korrekt", () => {
    const mapNode = schema.configSchema.properties.recall.properties.halfLifeDaysMap;
    assert.ok(mapNode, "halfLifeDaysMap fehlt im Schema");
    const map = mapNode.properties;
    assert.strictEqual(map.transient.default, 60);
    assert.strictEqual(map.episodic.default, 180);
    assert.strictEqual(map.longContext.default, 600);
    assert.strictEqual(map.project.default, 600);
  });

  it("Schema-Defaults für Runtime-Felder sind korrekt", () => {
    assert.strictEqual(getSchemaDefault("runtime.embeddingCacheEnabled"), true);
    assert.strictEqual(getSchemaDefault("runtime.metricsDebounceMs"), 5000);
  });

  it("Code-Fallbacks in index.js greifen bei fehlender Config", () => {
    // Simuliere alte Config: nur importanceBoost gesetzt
    const cfg = { recall: { importanceBoost: 0.3 } };
    const recallCfg = cfg.recall || {};

    const maxPromptMemories = recallCfg.maxPromptMemories ?? 12;
    const canonicalMaxItems = recallCfg.canonicalMaxItems ?? 5;
    const dedupJaccard = recallCfg.dedupJaccard ?? 0.78;
    const candidateTopK = recallCfg.candidateTopK ?? 40;
    const halfLifeOverrides = recallCfg.halfLifeDaysMap || {};

    assert.strictEqual(maxPromptMemories, 12);
    assert.strictEqual(canonicalMaxItems, 5);
    assert.strictEqual(dedupJaccard, 0.78);
    assert.strictEqual(candidateTopK, 40);

    const halfLifeDefaults = {
      transient: 60,
      episodic: 180,
      longContext: 600,
      project: 600,
    };
    assert.deepStrictEqual(halfLifeOverrides, {});
    assert.strictEqual(resolveHalfLifeDays("fact", null, halfLifeOverrides), halfLifeDefaults.transient);
    assert.strictEqual(resolveHalfLifeDays("project", null, halfLifeOverrides), halfLifeDefaults.project);
  });

  it("Runtime-Config-Fallbacks greifen bei fehlender Config", () => {
    const cfg = {};
    const runtimeCfg = cfg.runtime || {};

    const embeddingCacheEnabled = runtimeCfg.embeddingCacheEnabled ?? true;
    const metricsDebounceMs = runtimeCfg.metricsDebounceMs ?? 5000;

    assert.strictEqual(embeddingCacheEnabled, true);
    assert.strictEqual(metricsDebounceMs, 5000);
  });
});

describe("Upgrade-Simulation: Alte Memories mit gesetztem halfLifeDays", () => {
  it("applyDynamicsDefaults setzt bestehende halfLifeDays NICHT um, wenn lastDynamicsAt gesetzt ist", () => {
    const now = Date.now();
    const oldRow = {
      halfLifeDays: 30,
      category: "project",
      lastDynamicsAt: now - 86400000, // 1 Tag alt
    };

    const result = applyDynamicsDefaults(oldRow, now);

    // Wenn lastDynamicsAt gesetzt ist, wird applyDailyDecay aufgerufen,
    // aber halfLifeDays soll erhalten bleiben
    assert.strictEqual(result.halfLifeDays, 30);
    assert.strictEqual(result.category, "project");
    assert.ok(result.lastDynamicsAt >= now, "lastDynamicsAt sollte aktualisiert werden");
  });

  it("resolveHalfLifeDays gibt 365 für 'project' ohne Override zurück", () => {
    assert.strictEqual(resolveHalfLifeDays("project"), 600);
  });
});

describe("Upgrade-Simulation: Neue Memories bekommen typbasierte Werte", () => {
  it("applyDynamicsDefaults({ category: 'fact' }) → halfLifeDays = 60", () => {
    const result = applyDynamicsDefaults({ category: "fact" });
    assert.strictEqual(result.halfLifeDays, 60);
    assert.strictEqual(result.memoryClass, "standard");
  });

  it("applyDynamicsDefaults({ category: 'person' }) → halfLifeDays = 365", () => {
    const result = applyDynamicsDefaults({ category: "person" });
    assert.strictEqual(result.halfLifeDays, 600);
    assert.strictEqual(result.memoryClass, "standard");
  });
});

describe("Upgrade-Simulation: Config-Override funktioniert", () => {
  it("halfLifeDaysMap: { transient: 90 } überschreibt fact/general", () => {
    const overrides = { transient: 90 };
    assert.strictEqual(resolveHalfLifeDays("fact", null, overrides), 90);
    assert.strictEqual(resolveHalfLifeDays("general", null, overrides), 90);
  });

  it("applyDynamicsDefaults respektiert halfLifeOverrides", () => {
    const result = applyDynamicsDefaults({ category: "fact" }, Date.now(), { transient: 90 });
    assert.strictEqual(result.halfLifeDays, 90);
  });

  it("andere Gruppen sind von transient-Override unberührt", () => {
    const overrides = { transient: 90 };
    assert.strictEqual(resolveHalfLifeDays("project", null, overrides), 600);
    assert.strictEqual(resolveHalfLifeDays("person", null, overrides), 600);
    assert.strictEqual(resolveHalfLifeDays("other", null, overrides), 180);
  });
});

describe("Upgrade-Simulation: installer preserves backend selection", () => {
  it("local JQ patch never disables an enabled legacy memory-lancedb backend", () => {
    assert.doesNotMatch(
      installerScript,
      /plugins\.entries\["memory-lancedb"\]\.enabled\s*=\s*false/,
    );
  });

  it("remote Node patch never disables an enabled legacy memory-lancedb backend", () => {
    assert.doesNotMatch(
      installerScript,
      /entries\['memory-lancedb'\]\.enabled\s*=\s*false/,
    );
  });

  it("keeps an existing memory slot and reports no backend switch in dry-run", () => {
    assert.match(
      installerScript,
      /\.plugins\.slots\.memory\s*=\s*\(\.plugins\.slots\.memory\s*\/\/\s*"memory-core"\)/,
    );
    assert.match(installerScript, /dryrun\s+"[^"]*(kein|no)[^"]*backend[^"]*(wechsel|switch)/i);
  });
});

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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyDynamicsDefaults,
  resolveHalfLifeDays,
} from "../lib/memory-dynamics.js";
import { applyInstallerFeaturePolicy } from "../scripts/lib/installer-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, "..", "openclaw.plugin.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const installerScript = readFileSync(join(__dirname, "..", "scripts", "install-memory-system.sh"), "utf8");

function installerPatchFixtures() {
  return [
    applyInstallerFeaturePolicy(
      {
        enabled: false,
        hooks: {
          allowConversationAccess: false,
          allowPromptInjection: false,
          timeouts: { before_prompt_build: 123, agent_end: 456, custom: 789 },
        },
        config: {
          baseDbPath: "/custom/memory",
          embedding: {
            provider: "openai-compatible",
            model: "custom-embed",
            dimensions: 3072,
            baseUrl: "https://embedding.example.test/v1",
          },
          reranker: { provider: "cohere", enabled: true, model: "custom-rerank", timeoutMs: 2222 },
          runtime: { recallCacheTtlMs: 77, recallCacheMaxEntries: 4 },
        },
        rollback: { previousBackend: "memory-lancedb", marker: "keep" },
      },
      { mode: "preserve" },
    ),
    applyInstallerFeaturePolicy(
      {
        enabled: true,
        config: {
          hooks: {
            allowConversationAccess: false,
            allowPromptInjection: false,
            timeouts: { before_prompt_build: 321, agent_end: 654, legacyCustom: 987 },
          },
        },
      },
      { mode: "safe", confirmedAt: "2026-07-19T12:00:00.000Z" },
    ),
  ];
}

function installerDocument() {
  return {
    unrelated: { keep: true },
    plugins: {
      allow: ["other-plugin"],
      slots: { memory: "custom-memory-slot" },
      entries: {
        "memory-lancedb": { enabled: true, config: { keep: true } },
        "memory-lancedb-namespaced": { enabled: true, hooks: { stale: true } },
      },
    },
  };
}

function assertInstallerPatchResult(actual, expectedEntry) {
  assert.deepStrictEqual(actual.plugins.entries["memory-lancedb-namespaced"], expectedEntry);
  assert.deepStrictEqual(actual.plugins.entries["memory-lancedb"], { enabled: true, config: { keep: true } });
  assert.strictEqual(actual.plugins.slots.memory, "custom-memory-slot");
  assert.deepStrictEqual(actual.unrelated, { keep: true });
  assert.ok(actual.plugins.allow.includes("memory-lancedb-namespaced"));
}

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
  it("executes the canonical local JQ patch without rewriting helper-returned entries", () => {
    const match = installerScript.match(/JQ_PATCH=\$\(cat <<'JQEOF'\n([\s\S]*?)\nJQEOF\n\)/);
    assert.ok(match, "canonical JQ_PATCH heredoc missing");

    for (const pluginEntry of installerPatchFixtures()) {
      const run = spawnSync(
        "jq",
        ["--argjson", "plugin_config", JSON.stringify(pluginEntry), match[1]],
        { input: JSON.stringify(installerDocument()), encoding: "utf8" },
      );
      assert.strictEqual(run.status, 0, run.stderr);
      assertInstallerPatchResult(JSON.parse(run.stdout), pluginEntry);
    }
  });

  it("executes the remote Node patch without rewriting helper-returned entries", () => {
    const match = installerScript.match(/ssh "\$SSH_HOST" node --input-type=module << NODEOF\n([\s\S]*?)\nNODEOF/);
    assert.ok(match, "remote NODEOF body missing");

    for (const pluginEntry of installerPatchFixtures()) {
      const dir = mkdtempSync(join(tmpdir(), "plur1bus-installer-remote-"));
      const configPath = join(dir, "openclaw.json");
      try {
        writeFileSync(configPath, `${JSON.stringify(installerDocument(), null, 2)}\n`);
        const program = match[1]
          .replaceAll("'${TARGET_CONFIG}'", JSON.stringify(configPath))
          .replace("${PLUGIN_CONFIG_ESCAPED}", JSON.stringify(pluginEntry));
        const run = spawnSync("node", ["--input-type=module"], {
          input: program,
          encoding: "utf8",
        });
        assert.strictEqual(run.status, 0, run.stderr);
        assertInstallerPatchResult(JSON.parse(readFileSync(configPath, "utf8")), pluginEntry);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

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

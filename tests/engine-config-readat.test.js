/**
 * tests/engine-config-readat.test.js — E5 Task 3: the readAt audit and the
 * host-neutral re-read of the engine's own config.
 *
 * The engine reads its config once, from createEngine's `config` argument. The
 * only run-time re-read of the host config is the re-embedding switch probe's
 * check of `reembedding.activeGeneration`, which goes through
 * engine/config/live-config.js. Rulings E5-R1/R2 (preflight R1, R2): that key
 * stays readAt "construction" (it picks the store layout), so livePaths() is []
 * and the re-read is allowed by its own list, HOST_REREAD_PATHS. Ruling R3: the
 * inventory regex also matches plain `entries[`, and the site set below is the
 * tree's.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { livePaths, readAtOf } from "../engine/config/engine-config-schema.js";
import {
  HOST_REREAD_PATHS,
  PLUGIN_CONFIG_KEY,
  livePluginConfig,
  readLiveConfigValue,
} from "../engine/config/live-config.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * Files that touch the engine's entry of the host config, and why that is not a
 * run-time read of engine config.
 */
const CONFIG_MUTATION_SITES = Object.freeze({
  "engine/commands/plur1bus-command.js": "/plur1bus setup merges feature profiles into the host config and shows the result",
  "lib/chat-model.js": "the chat-model command writes the model choice into the host config",
  "lib/dashboard-settings.js": "dashboard settings write into, and show, the host config",
  "lib/featureModels.js": "projects and writes the dashboard's model choices (host llm policy, not engine config)",
  "lib/obsidian-bridge.js": "creates the obsidianBridge block in a host config it is about to write",
  "lib/reembedding/runtime-config.js": "writes the chosen generation into the host config",
  "lib/setup/control-ui-write.js": "control-UI writes into the host config",
  "lib/setup/feature-cron-plan.js": "plans cron jobs from the authored host config at setup",
  "lib/setup/feature-profiles.js": "merges a feature profile into the host config",
  "lib/telegram-commands/feature-toggle.js": "the Telegram toggle writes a feature switch into the host config",
  "lib/telegram-commands/status-data.js": "the Telegram status command shows the configured vault-sync switch",
  "lib/temperament-command.js": "the temperament command writes into, and shows, the host config",
});

const ENTRY_ACCESS =
  /plugins\??\.entries(\?\.)?\[\s*(PLUGIN_KEY|PLUGIN_ID|pluginKey|pluginId|PLUGIN_CONFIG_KEY|"memory-lancedb-namespaced")/;

function jsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...jsFilesUnder(rel));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(rel);
  }
  return out;
}

const SOURCES = [...jsFilesUnder("engine"), ...jsFilesUnder("lib")].map((rel) => ({
  rel,
  text: readFileSync(join(ROOT, rel), "utf8"),
}));

describe("engine config readAt audit", () => {
  it("livePaths() is empty and every host re-read path is a construction-time schema key", () => {
    assert.deepEqual(livePaths(), []);
    assert.deepEqual([...HOST_REREAD_PATHS], ["reembedding.activeGeneration"]);
    assert.ok(Object.isFrozen(HOST_REREAD_PATHS));
    for (const path of HOST_REREAD_PATHS) assert.equal(readAtOf(path), "construction", path);
  });

  it("only live-config.js reads the engine entry of the host config at run time", () => {
    const matching = SOURCES.filter(({ text }) => ENTRY_ACCESS.test(text)).map(({ rel }) => rel).sort();
    const expected = [...Object.keys(CONFIG_MUTATION_SITES), "engine/config/live-config.js"].sort();
    assert.deepEqual(matching, expected);
    assert.ok(!matching.includes("engine/create-engine.js"));
  });

  it("every readLiveConfigValue call names a host re-read path", () => {
    const call = /readLiveConfigValue\(\s*\w+\s*,\s*"([^"]+)"/g;
    const named = [];
    for (const { text } of SOURCES) for (const m of text.matchAll(call)) named.push(m[1]);
    assert.ok(named.length >= 1, "at least one readLiveConfigValue call");
    for (const path of named) assert.ok(HOST_REREAD_PATHS.includes(path), path);
  });

  it("a harness-style host is read live", () => {
    let current = { reembedding: { activeGeneration: "g2" } };
    const host = { runtime: null, config: () => current };
    assert.equal(readLiveConfigValue(host, "reembedding.activeGeneration"), "g2");
    current = { reembedding: { activeGeneration: "g3" } };
    assert.equal(readLiveConfigValue(host, "reembedding.activeGeneration"), "g3");
  });

  it("an OpenClaw-style host is read from its plugin entry", () => {
    const hostFile = { reembedding: { activeGeneration: "top-level" } };
    let current = {
      plugins: { entries: { [PLUGIN_CONFIG_KEY]: { config: { reembedding: { activeGeneration: "g4" } } } } },
    };
    const host = { runtime: { config: { current: () => current } }, config: () => hostFile };
    assert.equal(PLUGIN_CONFIG_KEY, "memory-lancedb-namespaced");
    assert.equal(readLiveConfigValue(host, "reembedding.activeGeneration"), "g4");

    current = { ...hostFile, plugins: { entries: {} } };
    assert.equal(readLiveConfigValue(host, "reembedding.activeGeneration"), undefined);
    assert.equal(livePluginConfig(host), null);

    const throwing = { runtime: { config: { current: () => { throw new Error("config unavailable"); } } }, config: () => hostFile };
    assert.equal(livePluginConfig(throwing), null);
    assert.equal(readLiveConfigValue(throwing, "reembedding.activeGeneration"), undefined);
  });

  it("a path outside HOST_REREAD_PATHS throws TypeError", () => {
    const host = { runtime: null, config: () => ({ recall: { softBudgetMs: 5 } }) };
    assert.throws(() => readLiveConfigValue(host, "recall.softBudgetMs"), TypeError);
  });
});

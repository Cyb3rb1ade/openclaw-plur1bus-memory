import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  pendingChanges,
  projectPendingChanges,
  readPluginConfigFile,
  resolveHostConfigPath,
} from "../lib/dashboard-settings.js";
import { buildControlPlaneProjection } from "../lib/control-plane-projection.js";
import { resolveEffectiveConfig } from "../lib/setup/config-contract.js";
import { createControlUiHttpHandler } from "../lib/setup/control-ui-plugin-runtime.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const PLUGIN_ID = "memory-lancedb-namespaced";

function configFile(contents, { name = "openclaw.json" } = {}) {
  const dir = makeTempDir("plur1bus-pending-");
  const file = join(dir, name);
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return { dir, file };
}

test("der Pfad der Konfigurationsdatei folgt derselben Rangfolge wie beim Host", () => {
  assert.equal(resolveHostConfigPath({ OPENCLAW_CONFIG_PATH: "/x/y.json" }, "/home/u"), "/x/y.json");
  assert.equal(resolveHostConfigPath({ OPENCLAW_STATE_DIR: "/state" }, "/home/u"), "/state/openclaw.json");
  assert.equal(resolveHostConfigPath({ OPENCLAW_HOME: "/oc" }, "/home/u"), "/oc/openclaw.json");
  assert.equal(resolveHostConfigPath({}, "/home/u"), "/home/u/.openclaw/openclaw.json");
});

test("liest genau den Plugin-Teilbaum und meldet Fehler als Zustand, nicht als Ausnahme", () => {
  const { file } = configFile({
    plugins: { entries: { [PLUGIN_ID]: { config: { autoRecall: false, merging: { apiKey: "SECRET" } } } } },
    // Die Datei enthält Geheimnisse; nichts davon darf die Funktion verlassen.
    channels: { telegram: { token: "SECRET-TOKEN" } },
  });
  const ok = readPluginConfigFile({ path: file });
  assert.equal(ok.status, "ok");
  assert.equal(ok.config.autoRecall, false);
  assert.equal(ok.config.merging.enabled, false, "der Teilbaum ist normalisiert wie der laufende");
  assert.ok(Number.isFinite(ok.mtimeMs));
  assert.doesNotMatch(JSON.stringify({ status: ok.status, mtimeMs: ok.mtimeMs }), /SECRET/);
  assert.equal(readPluginConfigFile({ path: configFile("{kaputt").file }).status, "unreadable");
  assert.equal(readPluginConfigFile({ path: "/nicht/vorhanden.json" }).status, "missing");
  // Ohne Plugin-Eintrag bleibt der Teilbaum leer (nur Schema-Vorgaben), kein Fehler.
  assert.equal(readPluginConfigFile({ path: configFile({ plugins: { entries: {} } }).file }).config.autoRecall, true);
  // Ein Wert, den das Schema ablehnt, ist nicht vergleichbar.
  assert.equal(readPluginConfigFile({ path: configFile({ plugins: { entries: { [PLUGIN_ID]: { config: { autoRecall: "ja" } } } } }).file }).status, "unreadable");
});

test("vergleicht nur die Werte, die das Dashboard schreiben darf", () => {
  const eff = (raw) => resolveEffectiveConfig(raw);
  const base = { autoRecall: true, gc: { maxMemoryCount: 150000 }, captureChunkingMode: "beides" };
  const running = eff(base);
  assert.equal(pendingChanges(running, null).size, 0, "ohne Datei keine Aussage");
  assert.equal(pendingChanges(running, eff(base)).size, 0, "gleiche Konfiguration, keine Markierung");
  assert.deepEqual([...pendingChanges(running, eff({ ...base, autoRecall: false }))], ["feature.autoRecall"]);
  assert.deepEqual([...pendingChanges(running, eff({ ...base, gc: { maxMemoryCount: 90000 } }))], ["gc.maxMemoryCount"]);
  assert.deepEqual([...pendingChanges(running, eff({ ...base, captureChunking: false }))], ["capture.chunking"]);
  const withModels = eff({ ...base, llmRouter: { agentModels: { main: { "*": "x/y", merging: "a/b" } } } });
  assert.deepEqual([...pendingChanges(running, withModels)].sort(), ["model:main.*", "model:main.merging"]);
  assert.deepEqual([...pendingChanges(running, { ...running, llmRouter: { agentModels: { "böse id": { merging: "c/d" } } } })], [], "unsichere Agentenkennung fällt raus");
  // Ein Schlüssel, den die Tabelle nicht kennt, erzeugt nie eine Markierung.
  assert.equal(pendingChanges(running, eff({ ...base, recall: { dedupJaccard: 0.1 } })).size, 0);
});

test("die Projektion liefert Kennungen und Zeitpunkt, nie Werte aus der Datei", () => {
  const projected = projectPendingChanges(resolveEffectiveConfig({ autoRecall: true }), { status: "ok", config: resolveEffectiveConfig({ autoRecall: false }), mtimeMs: 1000 });
  assert.deepEqual(projected, { status: "ok", ids: ["feature.autoRecall"], count: 1, savedAt: 1000 });
  assert.deepEqual(projectPendingChanges({}, { status: "unreadable", config: null, mtimeMs: 5 }), { status: "unreadable", ids: [], count: 0, savedAt: 5 });
  assert.deepEqual(projectPendingChanges({}, null), { status: "unknown", ids: [], count: 0, savedAt: null });
  const full = buildControlPlaneProjection({
    config: resolveEffectiveConfig({ merging: { enabled: true, apiKey: "SECRET" } }),
    fileConfig: { status: "ok", config: resolveEffectiveConfig({ merging: { enabled: false, apiKey: "SECRET" } }), mtimeMs: 1 },
  });
  assert.deepEqual(full.pending.ids, ["feature.merging"]);
  assert.doesNotMatch(JSON.stringify(full.pending), /SECRET/);
});

function host(agents = 3) {
  const entries = {};
  for (let i = 0; i < agents; i += 1) {
    entries[i === 0 ? "main" : `agent-${i}`] = { name: i === 0 ? "Bernd" : `Agent ${i}`, heartbeat: { every: "6h" } };
  }
  return {
    agents: { defaults: { model: { primary: "openai/base" }, models: { "openai/base": {}, "anthropic/haiku": { alias: "fast" } } }, entries },
    plugins: { entries: { [PLUGIN_ID]: { llm: { allowModelOverride: true, allowedModels: ["openai/base"] }, config: {} } } },
  };
}

async function render(options = {}, { query = "", writable = true } = {}) {
  const projection = buildControlPlaneProjection({ config: resolveEffectiveConfig(options.config || {}), hostConfig: options.hostConfig || host(), ...options.extra });
  const { createFormTokenStore } = await import("../lib/setup/control-ui-write.js");
  const handler = createControlUiHttpHandler({
    getProjection: async () => projection,
    write: writable ? { mode: "all", tokens: createFormTokenStore(), applyAction: async () => ({ ok: true }) } : null,
  });
  const response = { statusCode: 0, setHeader() {}, end(body) { this.body = body; } };
  await handler({ method: "GET", url: `/plugins/memory-lancedb-namespaced/control${query}`, headers: { host: "localhost" } }, response);
  assert.equal(response.statusCode, 200);
  return response.body;
}

test("die Seite markiert gespeicherte, noch nicht laufende Änderungen und unterscheidet laufend von gescheitert", async () => {
  const fresh = await render({ config: { autoRecall: true }, extra: { fileConfig: { status: "ok", config: resolveEffectiveConfig({ autoRecall: false }), mtimeMs: Date.now() - 20_000 } } });
  assert.match(fresh, /1 saved change not yet running/);
  assert.match(fresh, /the plugin reload takes about a minute/);
  assert.match(fresh, /name="setting" value="feature\.autoRecall"[\s\S]{0,400}?class="pending-mark"|class="pending-mark"[\s\S]{0,400}?name="setting" value="feature\.autoRecall"/);
  assert.match(fresh, /<option value="true" selected>On<\/option>/, "gezeigt wird weiter der laufende Wert");

  const stale = await render({ config: { autoRecall: true }, extra: { fileConfig: { status: "ok", config: resolveEffectiveConfig({ autoRecall: false }), mtimeMs: Date.now() - 10 * 60_000 } } });
  assert.match(stale, /probably failed — restart the gateway/);

  const clean = await render({ config: { autoRecall: true }, extra: { fileConfig: { status: "ok", config: resolveEffectiveConfig({ autoRecall: true }), mtimeMs: Date.now() } } });
  assert.doesNotMatch(clean, /not yet running/);
  assert.doesNotMatch(clean, /class="pending-mark"/);

  const unreadable = await render({ extra: { fileConfig: { status: "unreadable", config: null, mtimeMs: 1 } } });
  assert.match(unreadable, /config file could not be read/);
});

test("ab fünf Agenten zeigt das Panel einen Agenten mit Reitern, darunter die Matrix", async () => {
  const many = await render({ hostConfig: host(6) });
  assert.match(many, /<nav class="agent-tabs"/);
  assert.match(many, /<span class="agent-tab is-current" aria-current="true">Bernd<\/span>/);
  assert.match(many, /<a class="agent-tab" href="\?agent=agent-3#llm-tasks-title">/);
  const matrixCols = (html) => (html.match(/<div class="table-wrap matrix">[\s\S]*?<\/thead>/g) || [])
    .map((table) => (table.match(/<th scope="col">/g) || []).length);
  assert.deepEqual(matrixCols(many), [2, 2], "je Tabelle die Task-Spalte plus genau ein Agent");
  assert.doesNotMatch(many, /<details class="matrix-tasks"/, "in der Einzelansicht kein Aufklapper");
  assert.match(many, /6 agents, 0 with a default/, "die Zusammenfassung zählt alle Agenten");

  const chosen = await render({ hostConfig: host(6) }, { query: "?agent=agent-4" });
  assert.match(chosen, /<span class="agent-tab is-current" aria-current="true">Agent 4<\/span>/);
  assert.match(chosen, /name="agent" value="agent-4"/);
  const bogus = await render({ hostConfig: host(6) }, { query: "?agent=gibtsnicht" });
  assert.match(bogus, /<span class="agent-tab is-current" aria-current="true">Bernd<\/span>/, "unbekannt fällt auf den ersten zurück");
  const readonly = await render({ hostConfig: host(6) }, { query: "?agent=agent-2", writable: false });
  assert.match(readonly, /<span class="agent-tab is-current" aria-current="true">Agent 2<\/span>/, "die Reiter gelten auch ohne Schreibrecht");

  const few = await render({ hostConfig: host(3) });
  assert.doesNotMatch(few, /<nav class="agent-tabs"/);
  assert.deepEqual(matrixCols(few), [4, 4], "Task-Spalte plus drei Agenten, in beiden Tabellen");
  // Ein Change-Link trägt die gewählte Ansicht weiter, sonst springt der Reiter zurück.
  assert.match(await render({ hostConfig: host(6) }, { query: "?agent=agent-5" }), /href="\?edit=agent-5\.[a-z-]+&amp;agent=agent-5#llm-tasks-title"/);
});

test("die Spaltenköpfe nennen das Hintergrundmodell zuerst und das Chatmodell als letzte Rückfallstufe", async () => {
  const html = await render({ config: { llmRouter: { defaultModel: "anthropic/haiku" } } });
  assert.match(html, /<span class="hint">Background default: anthropic\/haiku<\/span><span class="hint">Chat model \(last resort\): openai\/base<\/span>/);
  assert.match(html, /<h3>Background default for every agent<\/h3>/);
  assert.match(html, /background tasks — not for chatting/);
});

test("Memory Health erklärt seinen Zustand in Worten", async () => {
  const degraded = await render({ extra: { health: {
    status: "degraded", namespaces: [], cards: { byAgent: [], byWorkspace: [], byUser: [], byPrimaryAgent: [] },
    storage: { bytes: 2_000_000_000, complete: false }, lastError: { component: "lancedb", code: "partition_count_failed" }, observedAt: Date.now() - 30_000,
  } } });
  assert.match(degraded, /A partition could not be counted/);
  assert.match(degraded, /the next scan runs within the minute/);
  assert.match(degraded, /<strong>Storage<\/strong> is a lower bound/);
  const unknown = await render({ extra: { health: {
    status: "degraded", namespaces: [], cards: { byAgent: [], byWorkspace: [], byUser: [], byPrimaryAgent: [] },
    storage: { bytes: 1, complete: true }, lastError: { component: "sonst", code: "was_neues" }, observedAt: 1,
  } } });
  assert.match(unknown, /The scan reported sonst:was_neues/, "ein unbekannter Code wird roh gezeigt, nicht verschwiegen");
  // Ohne Schnappschuss meldet die Projektion selbst health_scan_failed — das
  // ist keine Stille wert, sondern genau der Fall, den die Erklärung abdeckt.
  assert.match(await render({}), /No health snapshot has been taken yet/);
  const healthy = await render({ extra: { health: {
    status: "ready", namespaces: [], cards: { byAgent: [], byWorkspace: [], byUser: [], byPrimaryAgent: [] },
    storage: { bytes: 9_300_000_000, complete: true }, lastError: null, observedAt: Date.now() - 60_000,
  } } });
  assert.doesNotMatch(healthy, /<p class="health-reason">/, "ein sauberer Lauf erklärt nichts");
});

test("der Re-Embedding-Workflow nennt den ersten Schritt im Ruhezustand 'next', nicht 'current'", async () => {
  const projection = buildControlPlaneProjection({ hostConfig: host() });
  const dryRun = projection.reembeddingWorkflow.steps.find((step) => step.id === "dry-run");
  assert.equal(dryRun.state, "next");
  const html = await render({});
  assert.match(html, /<span>Dry run<\/span><span class="badge badge-next">next<\/span>/);
  assert.doesNotMatch(html, /<span>Dry run<\/span><span class="badge badge-current">/);
});

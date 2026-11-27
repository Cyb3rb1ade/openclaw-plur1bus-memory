// Temperament pro Agent im Dashboard (lib/agent-temperament.js) — Projektion,
// Prüfung, Schreibweg, Karte und der Weg vom Klick bis zum Stimmungs-Pool.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createTemperamentMutator,
  effectiveTemperament,
  normalizeTemperamentRequest,
  projectAgentTemperaments,
  temperamentEntry,
  temperamentPendingIds,
  temperamentRowIds,
  validTemperamentRequest,
  withTemperament,
} from "../lib/agent-temperament.js";
import { buildControlPlaneProjection } from "../lib/control-plane-projection.js";
import { pendingChanges, readPluginConfigFile } from "../lib/dashboard-settings.js";
import { createEmotionalStatePool, TEMPERAMENT_PRESETS } from "../lib/emotional-state.js";
import { createSharedJevEmotionalPool } from "../lib/jevEmotionRuntime.js";
import { resolveEffectiveConfig } from "../lib/setup/config-contract.js";
import { createControlUiHttpHandler } from "../lib/setup/control-ui-plugin-runtime.js";
import {
  applyControlUiWriteAction,
  createFormTokenStore,
  writeResultText,
} from "../lib/setup/control-ui-write.js";
import { applyTemperamentToRawConfig } from "../lib/temperament-command.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const PLUGIN_ID = "memory-lancedb-namespaced";
const clone = (value) => JSON.parse(JSON.stringify(value));

// Wie dieser Host: drei Chat-Agenten mit Bindung, Subagenten ohne, bernhardine
// warm, heisenberg kühl, "default" feurig, main ohne Eintrag.
const HOST = {
  agents: {
    entries: {
      main: { name: "Bernd" },
      developer: { name: "developer" },
      bernhardine: { name: "Bernhardine" },
      "bernhardine-budget-researcher": {},
      heisenberg: { name: "Heisenberg" },
    },
  },
  bindings: [
    { agentId: "heisenberg", match: { channel: "telegram", accountId: "heisenberg" } },
    { agentId: "main", match: { channel: "telegram", accountId: "default" } },
    { agentId: "bernhardine", match: { channel: "telegram", accountId: "bernhardine" } },
    { agentId: "bad id", match: { channel: "telegram" } },
  ],
  channels: { telegram: { botToken: "SECRET-BOT-TOKEN" } },
  plugins: {
    entries: {
      [PLUGIN_ID]: {
        config: {
          emotion: {
            moodInfluence: 0.4,
            temperaments: {
              bernhardine: temperamentEntry("warm"),
              heisenberg: temperamentEntry("kühl"),
              default: temperamentEntry("feurig"),
            },
          },
          merging: { apiKey: "SECRET-MERGING-KEY" },
        },
      },
    },
  },
};
const pluginConfig = (host) => host.plugins.entries[PLUGIN_ID].config;

/** A fake host writer with the host's semantics: clone, mutate, commit only when mutate returned. */
function fakeApi(host) {
  const writes = [];
  const state = { host: clone(host) };
  return {
    writes,
    state,
    api: {
      runtime: {
        config: {
          async mutateConfigFile({ mutate, afterWrite }) {
            const draft = structuredClone(state.host);
            const result = await mutate(draft, {});
            state.host = draft;
            writes.push({ draft, afterWrite });
            return { result };
          },
        },
      },
    },
  };
}

describe("Temperament: Zeilen und angezeigte Werte", () => {
  it("listet Chat-Agenten in Config-Reihenfolge, Agenten mit Eintrag, dann die Zeile für alle anderen", () => {
    assert.deepEqual(temperamentRowIds(pluginConfig(HOST), HOST), ["main", "bernhardine", "heisenberg", "default"]);
    // Ein gespeicherter Eintrag eines Subagenten bleibt sichtbar; ungültige Kennungen nie.
    const config = { emotion: { temperaments: { developer: temperamentEntry("stoisch"), "böse id": {}, __proto__x: {} } } };
    assert.deepEqual(temperamentRowIds(config, HOST), ["main", "bernhardine", "heisenberg", "developer", "__proto__x", "default"]);
    // Ältere Hosts: Heartbeat-Agenten zählen als Chat-Agenten.
    const legacy = { agents: { entries: { solo: { heartbeat: { every: "1h" } }, helper: {} } } };
    assert.deepEqual(temperamentRowIds({}, legacy), ["solo", "default"]);
    // Ganz ohne Chat-Agenten: main.
    assert.deepEqual(temperamentRowIds({}, {}), ["main", "default"]);
  });

  it("nennt Laufendes und Rückfall je Zeile so, wie der Stimmungs-Pool auflöst", () => {
    const projected = projectAgentTemperaments(pluginConfig(HOST), HOST);
    assert.deepEqual(projected.presets.map((preset) => preset.id), ["ausgewogen", "warm", "kühl", "feurig", "stoisch"]);
    assert.equal(projected.presets.find((preset) => preset.id === "kühl").gloss, "cool");
    const rows = Object.fromEntries(projected.agents.map((agent) => [agent.id, agent]));
    assert.deepEqual(projected.agents.map((agent) => agent.label), ["Bernd", "Bernhardine", "Heisenberg", "All other agents"]);
    // main: kein Eintrag → eingebauter main-Standard, nie die Zeile "default".
    assert.equal(rows.main.chosen, "");
    assert.equal(rows.main.running, "built-in default · reacts ×1.2 · mood lasts ×1.0");
    assert.equal(rows.main.fallback, rows.main.running);
    // bernhardine ohne eigene Wahl würde feurig, nicht ausgewogen.
    assert.equal(rows.bernhardine.chosen, "warm");
    assert.equal(rows.bernhardine.running, "warm · reacts ×1.5 · mood lasts ×1.3");
    assert.equal(rows.bernhardine.fallback, 'feurig, from "All other agents" · reacts ×1.8 · mood lasts ×1.5');
    assert.equal(rows.heisenberg.chosen, "kühl");
    assert.equal(rows.default.chosen, "feurig");
    assert.equal(rows.default.fallback, "ausgewogen (built-in) · reacts ×1.0 · mood lasts ×1.0");
    assert.doesNotMatch(JSON.stringify(projected), /SECRET/);
  });

  it("wählt ohne eigenen Eintrag \"No own choice\", nicht das geerbte Preset", () => {
    // Genau der Fall nach "No own choice": bernhardine erbt feurig von "default",
    // die Auswahl muss trotzdem leer bleiben, sonst schriebe Save einen eigenen Eintrag.
    const host = clone(HOST);
    delete pluginConfig(host).emotion.temperaments.bernhardine;
    const rows = Object.fromEntries(projectAgentTemperaments(pluginConfig(host), host).agents.map((agent) => [agent.id, agent]));
    assert.equal(rows.bernhardine.chosen, "");
    assert.equal(rows.bernhardine.running, 'feurig, from "All other agents" · reacts ×1.8 · mood lasts ×1.5');
    assert.equal(rows.bernhardine.fallback, rows.bernhardine.running);
  });

  it("nimmt die Auswahl aus der gespeicherten Datei, Laufendes und Rückfall aus der laufenden Config", () => {
    const running = pluginConfig(HOST);
    const saved = withTemperament(withTemperament(running, "bernhardine", "stoisch"), "default", "");
    const rows = Object.fromEntries(projectAgentTemperaments(running, HOST, saved).agents.map((agent) => [agent.id, agent]));
    assert.equal(rows.bernhardine.chosen, "stoisch");
    assert.equal(rows.bernhardine.running, "warm · reacts ×1.5 · mood lasts ×1.3");
    assert.equal(rows.default.chosen, "");
    assert.equal(rows.default.running, "feurig · reacts ×1.8 · mood lasts ×1.5");
    assert.equal(rows.bernhardine.fallback, 'feurig, from "All other agents" · reacts ×1.8 · mood lasts ×1.5');
    assert.equal(rows.heisenberg.chosen, "kühl");
    // Eine Datei ohne Temperamente heißt: keine eigene Wahl gespeichert.
    const empty = Object.fromEntries(projectAgentTemperaments(running, HOST, { emotion: {} }).agents.map((agent) => [agent.id, agent]));
    assert.deepEqual(Object.values(empty).map((row) => row.chosen), ["", "", "", ""]);
    // Ohne lesbare Datei bleibt es bei der laufenden Wahl.
    assert.equal(projectAgentTemperaments(running, HOST, null).agents.find((agent) => agent.id === "bernhardine").chosen, "warm");
  });

  it("zeigt eigene Werte ohne bekannten Namen als custom und abweichende Werte eines Presets als solche", () => {
    const temperaments = {
      main: { sensitivity: 0.5, decayMultiplier: 0.6 },
      bernhardine: { preset: "warm", baseline: { joy: 0.35, trust: 0.5 }, sensitivity: 2, decayMultiplier: 1.3 },
      heisenberg: { preset: "cholerisch", sensitivity: 3 },
    };
    const rows = Object.fromEntries(projectAgentTemperaments({ emotion: { temperaments } }, HOST).agents.map((agent) => [agent.id, agent]));
    assert.equal(rows.main.chosen, "custom", "gleiche Werte wie stoisch, aber ohne Namen: Träume und Stil sehen keinen");
    assert.equal(rows.main.running, "custom values · reacts ×0.5 · mood lasts ×0.6");
    assert.equal(rows.bernhardine.chosen, "warm", "Träume und Stil lesen .preset");
    assert.equal(rows.bernhardine.running, "warm (values differ from the preset) · reacts ×2.0 · mood lasts ×1.3");
    assert.equal(rows.heisenberg.chosen, "custom");
    assert.equal(rows.heisenberg.running, "custom values · reacts ×3.0 · mood lasts ×1.0");
    assert.equal(effectiveTemperament({}, "bernhardine").source, "builtin");
    assert.equal(effectiveTemperament({ default: temperamentEntry("stoisch") }, "main").source, "builtin");
  });
});

describe("Temperament: Eintrag und Eingabeprüfung", () => {
  it("baut den Eintrag als tiefe Kopie, wie ihn der Befehl schreibt", () => {
    const entry = temperamentEntry("warm");
    assert.deepEqual(entry, { baseline: { joy: 0.35, trust: 0.5 }, sensitivity: 1.5, decayMultiplier: 1.3, preset: "warm" });
    entry.baseline.joy = 0.99;
    assert.equal(TEMPERAMENT_PRESETS.warm.baseline.joy, 0.35, "das Preset bleibt unberührt");
    for (const name of ["cholerisch", "constructor", "toString", "__proto__", "", null]) assert.equal(temperamentEntry(name), null, String(name));
  });

  it("lässt nur geschlossene Werte durch und normalisiert kühl auf NFC", () => {
    assert.deepEqual(normalizeTemperamentRequest({ agentId: "main", temperament: "stoisch" }), { agentId: "main", temperament: "stoisch" });
    assert.deepEqual(normalizeTemperamentRequest({ agentId: "main", temperament: "" }), { agentId: "main", temperament: "" }, "leer hebt die Wahl auf");
    const decomposed = "kühl".normalize("NFD");
    assert.notEqual(decomposed, "kühl");
    assert.equal(normalizeTemperamentRequest({ agentId: "heisenberg", temperament: decomposed }).temperament, "kühl");
    for (const request of [
      { agentId: "main", temperament: "cholerisch" },
      { agentId: "main", temperament: "ruhig" },
      { agentId: "main", temperament: "constructor" },
      { agentId: "main", temperament: "Warm" },
      { agentId: "__proto__", temperament: "warm" },
      { agentId: "constructor", temperament: "warm" },
      { agentId: "böse id", temperament: "warm" },
      { agentId: "main\n", temperament: "warm" },
      { agentId: "a".repeat(65), temperament: "warm" },
      { agentId: "main", temperament: "w".repeat(33) },
      { agentId: "", temperament: "warm" },
      { agentId: "main" },
      { agentId: ["main"], temperament: "warm" },
      null,
    ]) {
      assert.equal(validTemperamentRequest(request ?? undefined), false, JSON.stringify(request));
    }
  });

  it("setzt oder entfernt genau einen Eintrag und lässt den Rest der emotion-Config stehen", () => {
    const config = pluginConfig(HOST);
    const set = withTemperament(config, "main", "stoisch");
    assert.deepEqual(set.emotion.temperaments.main, temperamentEntry("stoisch"));
    assert.equal(set.emotion.moodInfluence, 0.4);
    assert.deepEqual(set.merging, config.merging);
    const removed = withTemperament(config, "bernhardine", "");
    assert.equal(Object.hasOwn(removed.emotion.temperaments, "bernhardine"), false);
    assert.deepEqual(Object.keys(removed.emotion.temperaments), ["heisenberg", "default"]);
    const empty = withTemperament({ emotion: { temperaments: { main: temperamentEntry("warm") }, tier: "auto" } }, "main", "");
    assert.deepEqual(empty.emotion, { tier: "auto" }, "eine leere Liste fällt weg, andere Schlüssel bleiben");
    assert.equal(config.emotion.temperaments.bernhardine.preset, "warm", "rein: das Original bleibt");
  });
});

describe("Temperament: Schreibweg", () => {
  it("schreibt über den Host-Writer mit auto-Reload, prüft vorher das Schema und schreibt eine tiefe Kopie", async () => {
    const { api, writes } = fakeApi(HOST);
    const validated = [];
    const set = createTemperamentMutator({ api, validate: (next) => validated.push(next) });
    assert.deepEqual(await set({ agentId: "main", temperament: "warm" }), { agentId: "main", temperament: "warm", changed: true });
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].afterWrite, { mode: "auto" });
    const written = pluginConfig(writes[0].draft).emotion.temperaments;
    assert.deepEqual(written.main, temperamentEntry("warm"));
    assert.notEqual(written.main.baseline, TEMPERAMENT_PRESETS.warm.baseline);
    assert.deepEqual(written.bernhardine, temperamentEntry("warm"), "andere Agenten bleiben");
    assert.equal(pluginConfig(writes[0].draft).emotion.moodInfluence, 0.4);
    assert.deepEqual(writes[0].draft.channels, HOST.channels, "nur der Plugin-Teilbaum ändert sich");
    assert.equal(validated.length, 1);
    assert.deepEqual(validated[0], pluginConfig(writes[0].draft));
  });

  it("hebt die Wahl auf, schreibt nichts bei unveränderter Datei und lehnt fremde Zeilen ab", async () => {
    const { api, writes, state } = fakeApi(HOST);
    const set = createTemperamentMutator({ api, validate: resolveEffectiveConfig });
    assert.equal((await set({ agentId: "bernhardine", temperament: "" })).changed, true);
    assert.equal(Object.hasOwn(pluginConfig(state.host).emotion.temperaments, "bernhardine"), false);
    // Kein Eintrag mehr → Aufheben ändert nichts; Speichern desselben Presets auch nicht.
    assert.equal((await set({ agentId: "bernhardine", temperament: "" })).changed, false);
    assert.equal((await set({ agentId: "heisenberg", temperament: "kühl".normalize("NFD") })).changed, false);
    assert.equal(writes.length, 1, "jeder Schreibvorgang kostet einen Plugin-Reload");
    // Subagenten ohne eigenen Eintrag haben keine Zeile.
    await assert.rejects(set({ agentId: "developer", temperament: "warm" }), (error) => error.code === "denied_choice");
    await assert.rejects(set({ agentId: "ghost", temperament: "warm" }), (error) => error.code === "denied_choice");
    await assert.rejects(set({ agentId: "main", temperament: "cholerisch" }), (error) => error.code === "denied_choice");
    assert.equal(writes.length, 1);
  });

  it("weist eine vom Schema abgelehnte Config vor jeder Zuweisung zurück", async () => {
    const { api, writes, state } = fakeApi(HOST);
    const set = createTemperamentMutator({ api, validate: () => { throw new Error("schema says no"); } });
    await assert.rejects(set({ agentId: "main", temperament: "warm" }), /schema says no/);
    assert.equal(writes.length, 0);
    assert.deepEqual(state.host, HOST);
  });

  it("verlangt den Host-Writer und einen Validator", () => {
    assert.throws(() => createTemperamentMutator({ api: {}, validate: resolveEffectiveConfig }), /mutation is unavailable/);
    assert.throws(() => createTemperamentMutator({ api: fakeApi(HOST).api }), /validator/);
  });

  it("Befehl und Karte schreiben denselben Eintrag", async () => {
    for (const [agentId, name] of [["main", "kühl"], ["heisenberg", "warm"], ["default", "stoisch"]]) {
      const { api, state } = fakeApi(HOST);
      await createTemperamentMutator({ api, validate: resolveEffectiveConfig })({ agentId, temperament: name });
      const command = applyTemperamentToRawConfig(clone(HOST), PLUGIN_ID, agentId, name);
      assert.deepEqual(pluginConfig(state.host), pluginConfig(command.merged), `${agentId}=${name}`);
    }
  });
});

describe("Temperament: Dashboard-Aktion", () => {
  const form = (pairs) => new URLSearchParams(pairs);

  it("leitet nur im Schreibmodus all weiter, protokolliert jede Änderung und unterscheidet die Ergebnisse", async () => {
    const requests = [];
    const logs = [];
    const logger = { info: (line) => logs.push(line), warn: (line) => logs.push(`WARN ${line}`) };
    const deps = { logger, setTemperament: async (request) => { requests.push(request); return { ...request, changed: true }; } };
    const apply = (pairs, overrides = {}) => applyControlUiWriteAction({ action: "temperament.set", form: form(pairs), mode: "all", deps, ...overrides });
    for (const mode of ["off", "reranker"]) assert.deepEqual(await apply({ agent: "main", temperament: "warm" }, { mode }), { ok: false, code: "denied_mode" });
    assert.deepEqual(await apply({ agent: "main", temperament: "warm" }), { ok: true, code: "temperament_saved" });
    assert.deepEqual(await apply({ agent: "heisenberg", temperament: "kühl".normalize("NFD") }), { ok: true, code: "temperament_saved" });
    assert.deepEqual(await apply({ agent: "default", temperament: "" }), { ok: true, code: "temperament_reset" });
    assert.deepEqual(requests, [
      { agentId: "main", temperament: "warm" },
      { agentId: "heisenberg", temperament: "kühl" },
      { agentId: "default", temperament: "" },
    ]);
    assert.deepEqual(logs, [
      "memory-lancedb-namespaced: dashboard temperament.set agent=main temperament=warm",
      "memory-lancedb-namespaced: dashboard temperament.set agent=heisenberg temperament=kühl",
      "memory-lancedb-namespaced: dashboard temperament.set agent=default temperament=(no own choice)",
    ]);
    for (const pairs of [{ agent: "main", temperament: "cholerisch" }, { agent: "__proto__", temperament: "warm" }, { agent: "main" }, { temperament: "warm" }]) {
      assert.deepEqual(await apply(pairs), { ok: false, code: "denied_choice" }, JSON.stringify(pairs));
    }
    assert.equal(requests.length, 3, "nichts Ungültiges erreicht den Writer");
  });

  it("meldet fehlende Abhängigkeit, unbekannte Zeile, Fehler und unveränderte Wahl", async () => {
    const apply = (deps) => applyControlUiWriteAction({ action: "temperament.set", form: form({ agent: "main", temperament: "warm" }), mode: "all", deps });
    assert.deepEqual(await apply({}), { ok: false, code: "denied_action" });
    const logs = [];
    const logger = { info: (line) => logs.push(line), warn: (line) => logs.push(`WARN ${line}`) };
    assert.deepEqual(await apply({ logger, setTemperament: async () => { throw Object.assign(new Error("no row"), { code: "denied_choice" }); } }), { ok: false, code: "denied_choice" });
    assert.deepEqual(await apply({ logger, setTemperament: async () => { throw new Error("lock timed out"); } }), { ok: false, code: "failed" });
    assert.deepEqual(await apply({ logger, setTemperament: async (request) => ({ ...request, changed: false }) }), { ok: true, code: "temperament_unchanged" });
    assert.deepEqual(logs, ["WARN memory-lancedb-namespaced: control write action failed: lock timed out"], "nur echte Änderungen erzeugen eine Audit-Zeile");
    for (const code of ["temperament_saved", "temperament_reset", "temperament_unchanged"]) assert.ok(writeResultText(code), code);
    assert.match(writeResultText("temperament_saved"), /reloads the plugin/);
    // Träume und Antwortstil lesen nur den Namen aus dem eigenen Eintrag; die Zeile "default" verspricht das nicht.
    assert.match(writeResultText("temperament_saved"), /An agent's own choice also sets the tone of its dreams and reply style; the "All other agents" row changes the mood only\./);
    assert.match(writeResultText("temperament_saved"), /the select shows the saved choice and "Running now" the running temperament, marked as pending/);
  });
});

describe("Temperament: Karte im Dashboard", () => {
  async function page(projection, writable) {
    const handler = createControlUiHttpHandler({
      getProjection: async () => projection,
      write: writable ? { mode: "all", tokens: createFormTokenStore(), applyAction: async () => ({ ok: true, code: "failed" }) } : null,
    });
    const response = { statusCode: 0, setHeader() {}, end(body) { this.body = body; } };
    await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control", headers: { host: "localhost" } }, response);
    assert.equal(response.statusCode, 200);
    return response.body;
  }
  const card = (html) => {
    const start = html.indexOf('aria-labelledby="temperament-title"');
    return start < 0 ? "" : html.slice(start, html.indexOf("</section>", start));
  };
  const select = (section, id) => {
    const start = section.indexOf(`aria-label="Temperament for ${id}"`);
    return start < 0 ? "" : section.slice(start, section.indexOf("</select>", start));
  };

  it("zeigt je Zeile Auswahl, laufenden Wert und Rückfall, mit Sprunglink", async () => {
    const html = await page(buildControlPlaneProjection({ config: resolveEffectiveConfig(pluginConfig(HOST)), hostConfig: HOST }), true);
    const section = card(html);
    assert.match(section, /<h2 id="temperament-title">Temperament<\/h2>/);
    assert.match(html, /<nav class="jump"[^>]*>.*<a href="#temperament-title">Temperament<\/a>/s);
    assert.match(section, /\/plur1bus temperament/);
    assert.equal((section.match(/name="action" value="temperament\.set"/g) || []).length, 4);
    for (const id of ["main", "bernhardine", "heisenberg", "default"]) assert.match(section, new RegExp(`name="agent" value="${id}"`));
    assert.doesNotMatch(section, /name="agent" value="developer"/, "Subagenten bekommen keine eigene Zeile");
    assert.equal((section.match(/<select name="temperament"/g) || []).length, 4);
    assert.match(section, /<option value="kühl" selected>kühl — cool · reacts ×0\.8 · mood lasts ×0\.7<\/option>/);
    assert.match(section, /<option value="warm" selected>/);
    assert.match(section, /<option value="feurig" selected>/);
    assert.match(section, /aria-label="Temperament for main"><option value="" selected>No own choice<\/option>/);
    assert.match(section, /Running now: built-in default · reacts ×1\.2 · mood lasts ×1\.0/);
    assert.match(section, /Without a choice: feurig, from &quot;All other agents&quot;/);
    assert.match(section, /<code>main<\/code> does not fall back to this\. This row sets the mood only; dreams and reply style use only an agent's own choice\./);
    assert.match(section, /An agent's own choice also colours its dreams and reply style\./);
    assert.doesNotMatch(section, /it also colours the agent/);
    // Ganzzahlige Faktoren mit Nachkommastelle, Glosse nur, wo sie vom Namen abweicht.
    assert.match(section, /<option value="ausgewogen">ausgewogen — balanced · reacts ×1\.0 · mood lasts ×1\.0<\/option>/);
    assert.match(section, /<option value="warm" selected>warm · reacts ×1\.5 · mood lasts ×1\.3<\/option>/);
    assert.match(section, /<option value="stoisch">stoisch — stoic · reacts ×0\.5 · mood lasts ×0\.6<\/option>/);
    // Legende: eine Zeile je Preset mit Ruhestimmung.
    assert.equal((section.match(/<dt>/g) || []).length, 5);
    assert.match(section, /<dt>kühl<\/dt><dd>cool: reacts ×0\.8, mood lasts ×0\.7, resting mood anticipation 0\.3, joy 0\.15\.<\/dd>/);
    assert.match(section, /<dt>warm<\/dt><dd>reacts ×1\.5, mood lasts ×1\.3, resting mood joy 0\.35, trust 0\.5\.<\/dd>/);
    assert.match(section, /<dt>ausgewogen<\/dt><dd>balanced: reacts ×1\.0, mood lasts ×1\.0, neutral resting mood\.<\/dd>/);
    assert.doesNotMatch(section, /pending-mark/);
    assert.doesNotMatch(html, /SECRET/);
  });

  it("zeigt eine Zeile ohne eigenen Eintrag mit \"No own choice\" ausgewählt", async () => {
    const host = clone(HOST);
    delete pluginConfig(host).emotion.temperaments.bernhardine;
    const section = card(await page(buildControlPlaneProjection({ config: resolveEffectiveConfig(pluginConfig(host)), hostConfig: host }), true));
    assert.match(section, /aria-label="Temperament for bernhardine"><option value="" selected>No own choice<\/option>/);
    assert.doesNotMatch(select(section, "bernhardine"), /<option value="feurig" selected>/);
    assert.equal((select(section, "bernhardine").match(/ selected/g) || []).length, 1);
    assert.match(section, /Running now: feurig, from &quot;All other agents&quot; · reacts ×1\.8 · mood lasts ×1\.5/);
  });

  it("zeigt eigene Werte als gesperrte Option und ist lesend ohne Formular", async () => {
    const config = resolveEffectiveConfig({ emotion: { temperaments: { main: { sensitivity: 0.9, decayMultiplier: 1.1 } } } });
    const readonly = card(await page(buildControlPlaneProjection({ config, hostConfig: HOST }), false));
    assert.match(readonly, /<option value="custom" selected disabled>Custom values \(set in openclaw\.json\)<\/option>/);
    assert.doesNotMatch(readonly, /name="action" value="temperament\.set"/);
    assert.doesNotMatch(readonly, /form_token/);
    assert.match(readonly, /aria-label="Temperament for main" disabled>/);
    assert.match(readonly, /set <code>controlUi\.writeActions<\/code> to <code>all<\/code>/);
  });

  it("markiert gespeicherte, noch nicht laufende Wahl je Zeile", async () => {
    const running = resolveEffectiveConfig(pluginConfig(HOST));
    const saved = resolveEffectiveConfig(withTemperament(withTemperament(pluginConfig(HOST), "main", "stoisch"), "default", ""));
    assert.deepEqual(temperamentPendingIds(running, saved).sort(), ["temperament:default", "temperament:main"]);
    assert.deepEqual(temperamentPendingIds(running, resolveEffectiveConfig(pluginConfig(HOST))), [], "gleiche Datei, keine Markierung");
    const projection = buildControlPlaneProjection({ config: running, hostConfig: HOST, fileConfig: { status: "ok", config: saved, mtimeMs: Date.now() } });
    const html = await page(projection, true);
    const section = card(html);
    // Gezeigt wird der laufende Wert, markiert als "pending".
    assert.match(section, /Running now: built-in default · reacts ×1\.2 · mood lasts ×1\.0<span class="pending-mark"/);
    assert.match(section, /Running now: feurig · reacts ×1\.8 · mood lasts ×1\.5<span class="pending-mark"/);
    assert.equal((section.match(/class="pending-mark"/g) || []).length, 2);
    assert.match(html, /2 saved changes not yet running/);
    // Die Auswahl zeigt die gespeicherte Wahl, nicht die laufende.
    assert.match(select(section, "main"), /<option value="stoisch" selected>/);
    assert.match(select(section, "main"), /<option value="">No own choice<\/option>/);
    assert.match(select(section, "default"), /^aria-label="Temperament for default"><option value="" selected>No own choice<\/option>/);
    assert.doesNotMatch(select(section, "default"), /<option value="feurig" selected>/);
    assert.match(select(section, "bernhardine"), /<option value="warm" selected>/);
  });
});

describe("Temperament: vom Klick bis zum Stimmungs-Pool", () => {
  function hostFile() {
    const dir = makeTempDir("plur1bus-temperament-");
    const file = join(dir, "openclaw.json");
    writeFileSync(file, JSON.stringify(HOST, null, 2));
    return { dir, file };
  }

  // Ein Host-Writer, der die echte Datei liest und schreibt, wie OpenClaws mutateConfigFile.
  function fileApi(file) {
    return {
      runtime: {
        config: {
          async mutateConfigFile({ mutate }) {
            const draft = JSON.parse(readFileSync(file, "utf8"));
            const result = await mutate(draft, {});
            writeFileSync(file, JSON.stringify(draft, null, 2));
            return { result };
          },
        },
      },
    };
  }

  function harness(file, running) {
    const logs = [];
    const setTemperament = createTemperamentMutator({ api: fileApi(file), validate: resolveEffectiveConfig });
    const handler = createControlUiHttpHandler({
      getProjection: async () => buildControlPlaneProjection({
        config: running,
        hostConfig: HOST,
        fileConfig: readPluginConfigFile({ path: file }),
      }),
      write: {
        mode: "all",
        tokens: createFormTokenStore(),
        applyAction: ({ action, form, mode }) => applyControlUiWriteAction({
          action, form, mode, deps: { setTemperament, logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line) } },
        }),
      },
    });
    const call = async (request) => {
      const headers = new Map();
      const response = { statusCode: 0, body: "", setHeader(name, value) { headers.set(String(name).toLowerCase(), value); }, end(body = "") { this.body = body; } };
      await handler({ headers: { host: "127.0.0.1:18789" }, ...request }, response);
      return { status: response.statusCode, location: headers.get("location"), body: response.body };
    };
    const token = async () => {
      const { body } = await call({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control" });
      return body.match(/name="form_token" value="([^"]+)"/)[1];
    };
    const post = (pairs) => {
      const body = new URLSearchParams(pairs).toString();
      return call({
        method: "POST",
        url: "/plugins/memory-lancedb-namespaced/control",
        headers: { host: "127.0.0.1:18789", "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) },
        async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
      });
    };
    return { call, token, post, logs };
  }

  it("speichert nur mit frischem Einmal-Token, markiert bis zum Reload und der Pool übernimmt danach", async () => {
    const { dir, file } = hostFile();
    const before = readFileSync(file, "utf8");
    const running = resolveEffectiveConfig(pluginConfig(HOST));
    const { call, token, post, logs } = harness(file, running);
    const form = { action: "temperament.set", agent: "heisenberg", temperament: "stoisch" };

    assert.equal((await post(form)).location, "/plugins/memory-lancedb-namespaced/control?result=denied_token", "ohne Token");
    assert.equal((await post({ ...form, form_token: "x".repeat(43) })).location, "/plugins/memory-lancedb-namespaced/control?result=denied_token", "gefälschtes Token");
    assert.equal((await post({ ...form, agent: "developer", form_token: await token() })).location, "/plugins/memory-lancedb-namespaced/control?result=denied_choice");
    assert.equal((await post({ ...form, temperament: "ruhig", form_token: await token() })).location, "/plugins/memory-lancedb-namespaced/control?result=denied_choice");
    assert.equal(readFileSync(file, "utf8"), before, "abgelehnte Anfragen ändern nichts");

    const fresh = await token();
    assert.equal((await post({ ...form, form_token: fresh })).location, "/plugins/memory-lancedb-namespaced/control?result=temperament_saved");
    assert.equal((await post({ ...form, temperament: "warm", form_token: fresh })).location, "/plugins/memory-lancedb-namespaced/control?result=denied_token", "Token nur einmal");
    assert.deepEqual(logs, ["memory-lancedb-namespaced: dashboard temperament.set agent=heisenberg temperament=stoisch"]);

    // Datei: genau der Eintrag des Befehls; alles andere unverändert.
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(pluginConfig(saved).emotion.temperaments.heisenberg, temperamentEntry("stoisch"));
    assert.deepEqual({ ...saved, plugins: null }, { ...HOST, plugins: null });

    // Bis zum Reload: laufender Wert mit Markierung.
    const fileState = readPluginConfigFile({ path: file });
    assert.deepEqual([...pendingChanges(running, fileState.config)], ["temperament:heisenberg"]);
    const result = await call({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control?result=temperament_saved" });
    assert.match(result.body, /Temperament saved to openclaw\.json/);
    assert.match(result.body, /Running now: kühl · reacts ×0\.8 · mood lasts ×0\.7<span class="pending-mark"/);
    // Die Auswahl hält schon stoisch. Save ohne Änderung schreibt nicht kühl zurück.
    const heisenbergSelect = result.body.slice(result.body.indexOf('aria-label="Temperament for heisenberg"'));
    assert.match(heisenbergSelect.slice(0, heisenbergSelect.indexOf("</select>")), /<option value="stoisch" selected>/);
    const afterSave = readFileSync(file, "utf8");
    assert.equal((await post({ ...form, form_token: await token() })).location, "/plugins/memory-lancedb-namespaced/control?result=temperament_unchanged");
    assert.equal(readFileSync(file, "utf8"), afterSave, "kein Schreibvorgang, kein Reload");
    assert.equal(logs.length, 1, "keine Audit-Zeile für eine Nicht-Änderung");

    // Nach dem Reload: der Pool baut mit dem neuen Profil neu auf, der Name folgt.
    const scope = { baseDbPath: join(dir, "db") };
    const oldPool = createSharedJevEmotionalPool({ ...running, ...scope });
    assert.equal(oldPool.get("heisenberg").sensitivity, 0.8);
    const reloaded = resolveEffectiveConfig(pluginConfig(saved));
    const newPool = createSharedJevEmotionalPool({ ...reloaded, ...scope });
    assert.notEqual(newPool, oldPool, "neues Profil, neuer Pool");
    assert.equal(newPool.get("heisenberg").sensitivity, 0.5);
    assert.equal(newPool.get("heisenberg").decayMultiplier, 0.6);
    assert.equal(reloaded.emotion.temperaments.heisenberg.preset, "stoisch", "Name für Träume und Antwortstil");
    assert.deepEqual([...pendingChanges(reloaded, readPluginConfigFile({ path: file }).config)], [], "nach dem Reload keine Markierung");
  });

  it("nimmt den Weg aus dem Sandbox-Frame (GET mit via=fetch) samt kühl und Aufheben", async () => {
    const { file } = hostFile();
    const { call, token } = harness(file, resolveEffectiveConfig(pluginConfig(HOST)));
    const query = (pairs) => `/plugins/memory-lancedb-namespaced/control?${new URLSearchParams(pairs).toString()}`;
    const saved = await call({ method: "GET", url: query({ action: "temperament.set", agent: "main", temperament: "kühl", form_token: await token(), via: "fetch" }) });
    assert.equal(saved.status, 204);
    const banner = await call({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control" });
    assert.match(banner.body, /Temperament saved to openclaw\.json/);
    assert.deepEqual(pluginConfig(JSON.parse(readFileSync(file, "utf8"))).emotion.temperaments.main, temperamentEntry("kühl"));

    const reset = await call({ method: "GET", url: query({ action: "temperament.set", agent: "default", temperament: "", form_token: await token(), via: "fetch" }) });
    assert.equal(reset.status, 204);
    const after = pluginConfig(JSON.parse(readFileSync(file, "utf8")));
    assert.equal(Object.hasOwn(after.emotion.temperaments, "default"), false);
    // Ohne "default" fällt jeder Subagent auf ausgewogen zurück.
    const pool = createEmotionalStatePool({ temperaments: resolveEffectiveConfig(after).emotion.temperaments });
    assert.equal(pool.get("developer").sensitivity, 1.0);
    assert.equal(pool.get("main").sensitivity, 0.8);
  });

  it("zeigt einen per Befehl gesetzten Eintrag als Auswahl der Karte", async () => {
    const command = applyTemperamentToRawConfig(clone(HOST), PLUGIN_ID, "main", "feurig");
    const projection = buildControlPlaneProjection({ config: resolveEffectiveConfig(pluginConfig(command.merged)), hostConfig: command.merged });
    const row = projection.temperaments.agents.find((agent) => agent.id === "main");
    assert.equal(row.chosen, "feurig");
    assert.equal(row.running, "feurig · reacts ×1.8 · mood lasts ×1.5");
  });
});

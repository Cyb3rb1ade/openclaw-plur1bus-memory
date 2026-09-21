import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DASHBOARD_SETTINGS,
  createSettingMutator,
  dashboardSetting,
  parseSettingValue,
  projectDashboardSettings,
  settingValue,
} from "../lib/dashboard-settings.js";
import { FEATURE_DEFINITIONS } from "../lib/feature-definitions.js";
import { buildControlPlaneProjection, FEATURE_CARD_DEFINITIONS } from "../lib/control-plane-projection.js";
import { resolveEffectiveConfig } from "../lib/setup/config-contract.js";
import { applyControlUiWriteAction, createFormTokenStore } from "../lib/setup/control-ui-write.js";
import { createControlUiHttpHandler } from "../lib/setup/control-ui-plugin-runtime.js";
import { catalogModelIds, grantModelPermission } from "../lib/featureModels.js";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));

function schemaNode(path) {
  let node = { properties: manifest.configSchema.properties };
  for (const key of path) {
    node = node?.properties?.[key];
    if (!node) return null;
  }
  return node;
}

test("jede Einstellung zeigt auf einen Schema-Schluessel mit passendem Typ und liegt auf einer echten Karte", () => {
  const cards = new Set([...FEATURE_CARD_DEFINITIONS.map((card) => card.id), "llm-tasks"]);
  const ids = new Set();
  for (const setting of DASHBOARD_SETTINGS) {
    assert.ok(!ids.has(setting.id), `doppelte Kennung ${setting.id}`);
    ids.add(setting.id);
    assert.ok(cards.has(setting.card), `${setting.id}: Karte ${setting.card} gibt es nicht`);
    const node = schemaNode(setting.path);
    assert.ok(node, `${setting.id}: ${setting.path.join(".")} steht nicht im Schema`);
    const types = [].concat(node.type ?? []);
    if (setting.type === "boolean") assert.ok(types.includes("boolean"), `${setting.id} ist im Schema kein boolean`);
    if (setting.type === "number") {
      assert.ok(types.includes("number") || types.includes("integer"), `${setting.id} ist im Schema keine Zahl`);
      if (node.minimum !== undefined) assert.ok(setting.min >= node.minimum, `${setting.id}: min unter dem Schema-Minimum`);
    }
    if (setting.type === "enum" && Array.isArray(node.enum)) {
      for (const value of setting.values) assert.ok(node.enum.includes(value), `${setting.id}: ${value} nicht im Schema-Enum`);
    }
  }
});

test("Schalter kommen aus den Feature-Definitionen, ohne den Sidecar-Schalter", () => {
  const toggles = DASHBOARD_SETTINGS.filter((setting) => setting.id.startsWith("feature."));
  assert.equal(toggles.some((setting) => setting.id === "feature.dreamingSidecarCompat"), false);
  assert.equal(toggles.some((setting) => setting.id === "feature.autoCapture"), true);
  assert.equal(toggles.length, FEATURE_DEFINITIONS.length - 3, "alle ausser dem Sidecar und den zwei Pfaden ohne Schema");
  assert.equal(dashboardSetting("feature.decisionTrace"), null, "trace.enabled steht nicht im Schema");
  assert.equal(dashboardSetting("feature.semanticCompression"), null);
  const nudge = dashboardSetting("feature.reactionNudge");
  assert.equal(nudge.type, "enum");
  assert.deepEqual([...nudge.values], ["auto", true, false]);
  assert.equal(nudge.defaultValue, "auto");
  assert.equal(dashboardSetting("security.allowedUserIds"), null, "nie aus dem Web schreibbar");
  assert.equal(dashboardSetting("controlUi.writeActions"), null);
  assert.equal(dashboardSetting("__proto__"), null);
});

test("liest den laufenden Wert so, wie ihn der Laufzeitpfad auslegt", () => {
  const toggle = dashboardSetting("feature.autoRecall");
  assert.equal(settingValue({}, toggle), true, "fehlend heisst an");
  assert.equal(settingValue({ autoRecall: false }, toggle), false);
  const merging = dashboardSetting("feature.merging");
  assert.equal(settingValue({ merging: { enabled: false } }, merging), false);
  assert.equal(settingValue({ merging: { threshold: 0.5 } }, merging), true);
  assert.equal(settingValue({ reactionNudge: { enabled: false } }, dashboardSetting("feature.reactionNudge")), false);
  assert.equal(settingValue({}, dashboardSetting("feature.reactionNudge")), "auto");
  assert.equal(settingValue({}, dashboardSetting("feature.conversationReactivationRecall")), false, "bewusst aus");
  assert.equal(settingValue({ gc: { maxMemoryCount: 150000 } }, dashboardSetting("gc.maxMemoryCount")), 150000);
  assert.equal(settingValue({}, dashboardSetting("gc.maxMemoryCount")), null, "kein Wert, keine erfundene Vorgabe");
  assert.equal(settingValue({ llmRouter: { defaultModel: "anthropic/x" } }, dashboardSetting("llmRouter.defaultModel")), "anthropic/x");
});

test("nimmt nur Werte aus der geschlossenen Menge und innerhalb der Grenzen", () => {
  const bool = dashboardSetting("merging.autoApply");
  assert.deepEqual(parseSettingValue(bool, "true"), { ok: true, value: true });
  assert.deepEqual(parseSettingValue(bool, "false"), { ok: true, value: false });
  assert.equal(parseSettingValue(bool, "yes").ok, false);
  assert.equal(parseSettingValue(bool, "").ok, false);
  const mode = dashboardSetting("skillMiner.autoApply");
  assert.deepEqual(parseSettingValue(mode, " on "), { ok: true, value: "on" });
  assert.equal(parseSettingValue(mode, "always").ok, false);
  const cap = dashboardSetting("gc.maxMemoryCount");
  assert.deepEqual(parseSettingValue(cap, "150000"), { ok: true, value: 150000 });
  assert.equal(parseSettingValue(cap, "0").ok, false, "unter dem Minimum");
  assert.equal(parseSettingValue(cap, "1.5").ok, false, "keine Bruchzahl");
  assert.equal(parseSettingValue(cap, "1e5").ok, false);
  assert.equal(parseSettingValue(cap, "99999999999").ok, false, "ueber dem Maximum");
  const promotions = dashboardSetting("schicht15.maxPromotionsPerRun");
  assert.deepEqual(parseSettingValue(promotions, "0"), { ok: true, value: 0 }, "0 heisst unbegrenzt und ist erlaubt");
  const model = dashboardSetting("llmRouter.defaultModel");
  assert.deepEqual(parseSettingValue(model, ""), { ok: true, value: "" }, "leer entfernt den Standard");
  assert.equal(parseSettingValue(model, "../x").ok, false);
  assert.equal(parseSettingValue(null, "true").ok, false);
});

function host(config = {}) {
  return {
    agents: { defaults: { model: { primary: "openai/base" }, models: { "openai/base": {}, "anthropic/haiku": { alias: "fast" } } }, entries: { main: { heartbeat: {} } } },
    plugins: { entries: { "memory-lancedb-namespaced": { llm: { allowModelOverride: true, allowedModels: ["openai/base"] }, config } } },
  };
}

function mutatorFor(draft, extra = {}) {
  return createSettingMutator({
    api: { runtime: { config: { async mutateConfigFile(request) { return request.mutate(draft); } } } },
    validate: resolveEffectiveConfig,
    modelCatalog: catalogModelIds,
    grantModel: grantModelPermission,
    ...extra,
  });
}

test("der Mutator schreibt genau einen Pfad, laesst den Rest stehen und prueft das Ergebnis gegen das Schema", async () => {
  const draft = host({ merging: { threshold: 0.7, apiKey: "SECRET" }, autoRecall: true });
  const mutate = mutatorFor(draft);
  const config = () => draft.plugins.entries["memory-lancedb-namespaced"].config;
  assert.deepEqual(await mutate({ id: "feature.merging", value: "false" }), { id: "feature.merging", value: false });
  assert.equal(config().merging.enabled, false);
  assert.equal(config().merging.threshold, 0.7, "Nachbarschluessel bleiben");
  assert.equal(config().merging.apiKey, "SECRET");
  assert.equal(config().autoRecall, true);
  await mutate({ id: "feature.autoRecall", value: "false" });
  assert.equal(config().autoRecall, false);
  await mutate({ id: "continuityEngine.doctor.enabled", value: "true" });
  assert.equal(config().continuityEngine.doctor.enabled, true, "tiefe Pfade werden angelegt");
  await mutate({ id: "feature.reactionNudge", value: "auto" });
  assert.equal(config().reactionNudge.enabled, "auto");
  assert.doesNotThrow(() => resolveEffectiveConfig(config()));
  await assert.rejects(() => mutate({ id: "gc.maxMemoryCount", value: "abc" }), /Invalid setting/);
  await assert.rejects(() => mutate({ id: "nonsense.key", value: "1" }), /Invalid setting/);
});

test("die GC-Obergrenze faellt nie unter den groessten laufenden Bestand", async () => {
  const draft = host({ gc: { maxMemoryCount: 150000 } });
  const config = () => draft.plugins.entries["memory-lancedb-namespaced"].config;
  const mutate = mutatorFor(draft, { maxAgentCards: async () => 32066 });
  await assert.rejects(() => mutate({ id: "gc.maxMemoryCount", value: "30000" }), (error) => error.code === "denied_value");
  assert.equal(config().gc.maxMemoryCount, 150000, "nichts geschrieben");
  await mutate({ id: "gc.maxMemoryCount", value: "40000" });
  assert.equal(config().gc.maxMemoryCount, 40000);
  // Ohne Zaehler ist der Schutz nicht pruefbar: keine potenziell destruktive
  // Aenderung — und ein eigener Code, damit die Oberflaeche den echten Grund
  // nennt statt "ausserhalb des erlaubten Bereichs".
  await assert.rejects(() => mutatorFor(draft, { maxAgentCards: async () => null })({ id: "gc.maxMemoryCount", value: "5" }),
    (error) => error.code === "denied_unknown_count");
  assert.equal(config().gc.maxMemoryCount, 40000);
});

test("das Standardmodell wird gegen den Katalog geprueft und gibt genau dieses Modell frei", async () => {
  const draft = host({});
  const entry = () => draft.plugins.entries["memory-lancedb-namespaced"];
  const mutate = mutatorFor(draft);
  await assert.rejects(() => mutate({ id: "llmRouter.defaultModel", value: "unknown/model" }), /no longer configured/);
  await mutate({ id: "llmRouter.defaultModel", value: "anthropic/haiku" });
  assert.equal(entry().config.llmRouter.defaultModel, "anthropic/haiku");
  assert.deepEqual(entry().llm.allowedModels, ["openai/base", "anthropic/haiku"], "Freigabe wie bei einer Aufgabenwahl");
  await mutate({ id: "llmRouter.defaultModel", value: "" });
  assert.equal(entry().config.llmRouter.defaultModel, undefined, "leer entfernt den Schluessel statt eines leeren Strings");
  assert.deepEqual(entry().llm.allowedModels, ["openai/base", "anthropic/haiku"], "Zuruecksetzen entzieht nichts");
  assert.doesNotThrow(() => resolveEffectiveConfig(entry().config));
});

test("ohne Validator oder Konfigurationsschreiber gibt es keinen Mutator", () => {
  assert.throws(() => createSettingMutator({ api: {}, validate: resolveEffectiveConfig }), /mutateConfigFile/);
  assert.throws(() => createSettingMutator({ api: { runtime: { config: { mutateConfigFile() {} } } } }), /validator/);
});

test("die Schreibaktion verlangt den vollen Schreibmodus und reicht nur geprueft weiter", async () => {
  const calls = [];
  const deps = { setSetting: async (request) => { calls.push(request); } };
  const form = new URLSearchParams({ setting: "feature.merging", value: "false" });
  assert.deepEqual(await applyControlUiWriteAction({ action: "setting.set", form, mode: "off", deps }), { ok: false, code: "denied_mode" });
  assert.deepEqual(await applyControlUiWriteAction({ action: "setting.set", form, mode: "reranker", deps }), { ok: false, code: "denied_mode" });
  assert.deepEqual(
    await applyControlUiWriteAction({ action: "setting.set", form: new URLSearchParams({ setting: "feature.merging", value: "maybe" }), mode: "all", deps }),
    { ok: false, code: "denied_value" },
  );
  assert.deepEqual(
    await applyControlUiWriteAction({ action: "setting.set", form: new URLSearchParams({ setting: "security.allowedUserIds", value: "1" }), mode: "all", deps }),
    { ok: false, code: "denied_value" },
  );
  assert.deepEqual(await applyControlUiWriteAction({ action: "setting.set", form, mode: "all", deps: {} }), { ok: false, code: "denied_action" });
  assert.deepEqual(await applyControlUiWriteAction({ action: "setting.set", form, mode: "all", deps }), { ok: true, code: "setting_saved" });
  assert.deepEqual(calls, [{ id: "feature.merging", value: "false" }]);
  const refused = { setSetting: async () => { const error = new Error("refused"); error.code = "denied_value"; throw error; } };
  assert.deepEqual(await applyControlUiWriteAction({ action: "setting.set", form, mode: "all", deps: refused }), { ok: false, code: "denied_value" });
});

test("die Projektion liefert je Karte die Zeilen mit Wert, nie die ganze Konfiguration", () => {
  const projection = buildControlPlaneProjection({ config: resolveEffectiveConfig({ merging: { enabled: false, apiKey: "SECRET" }, gc: { maxMemoryCount: 150000 } }) });
  const merging = projection.settings.byCard.merging.find((row) => row.id === "feature.merging");
  assert.equal(merging.value, false);
  assert.equal(projection.settings.byCard.gc.find((row) => row.id === "gc.maxMemoryCount").value, 150000);
  assert.doesNotMatch(JSON.stringify(projection.settings), /SECRET/);
  for (const card of ["reactivation", "reaction-nudge", "morning-review", "evening-review", "style-directive"]) {
    assert.ok(projection.featureCards.some((entry) => entry.id === card), `Karte ${card}`);
  }
  assert.equal(projection.featureCards.find((entry) => entry.id === "style-directive").effective, true, "eine Karte ohne Schalter ist an");
  assert.equal(projection.settings.byCard["style-directive"].length, 3);
});

async function render(config, writable) {
  const projection = buildControlPlaneProjection({ config: resolveEffectiveConfig(config), hostConfig: host(config) });
  const handler = createControlUiHttpHandler({
    getProjection: async () => projection,
    write: writable ? { mode: "all", tokens: createFormTokenStore(), applyAction: async () => ({ ok: true, code: "setting_saved" }) } : null,
  });
  const response = { statusCode: 0, setHeader() {}, end(body) { this.body = body; } };
  await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control", headers: { host: "localhost" } }, response);
  assert.equal(response.statusCode, 200);
  return response.body;
}

test("die Karten zeigen ihre Einstellungen; ohne Schreibrecht ohne Formular", async () => {
  const html = await render({ merging: { enabled: false }, gc: { maxMemoryCount: 150000 } }, true);
  assert.match(html, /name="setting" value="feature\.merging"/);
  assert.match(html, /<option value="false" selected>Off<\/option>/);
  assert.match(html, /name="setting" value="gc\.maxMemoryCount"[\s\S]*?<input type="number"[^>]*value="150000"[^>]*min="1"/);
  assert.match(html, /name="setting" value="llmRouter\.defaultModel"/, "Standardmodell im LLM-Tasks-Panel");
  assert.match(html, /<option value="anthropic\/haiku">fast †<\/option>/, "Katalog mit Freigabe-Marke");
  assert.match(html, /<h3>Style Directive<\/h3>/);
  assert.equal((html.match(/value="setting\.set"/g) || []).length, DASHBOARD_SETTINGS.length, "ein Formular je Einstellung");
  const readonly = await render({}, false);
  assert.doesNotMatch(readonly, /value="setting\.set"/);
  assert.match(readonly, /<select[^>]*name="value"[^>]*disabled/);
});

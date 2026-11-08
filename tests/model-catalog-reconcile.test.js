import test from "node:test";
import assert from "node:assert/strict";
import { reconcileModelCatalog } from "../lib/model-catalog-reconcile.js";

function fixture() {
  return {
    models: { providers: { proxy: { apiKey: "KEEP", models: [{ id: "mini", name: "Wrong" }, { id: "old", name: "Old" }, { id: "pinned", name: "Pinned" }] }, offline: { models: [{ id: "maybe", name: "Maybe" }] } } },
    agents: { defaults: { models: { "proxy/mini": { alias: "fast" }, "proxy/old": {}, "proxy/pinned": {} }, model: "fast" } },
    plugins: { entries: { memory: { llm: { allowedModels: ["proxy/pinned"] }, config: { llmRouter: { agentModels: { a: { afterthought: "proxy/pinned" } } } } } } },
  };
}

test("complete provider inventories correct names and remove only unreferenced confirmed absences", () => {
  const original = fixture();
  const result = reconcileModelCatalog(original, { proxy: { status: "verified", complete: true, models: [{ id: "mini", name: "Mini 2" }] }, offline: { status: "unverifiable" } });
  assert.equal(result.config.models.providers.proxy.models.find((m) => m.id === "mini").name, "Mini 2");
  assert.deepEqual(result.removed, ["proxy/old"]);
  assert.deepEqual(result.retainedAbsent, ["proxy/pinned"]);
  assert.match(result.config.models.providers.proxy.models.find((m) => m.id === "pinned").name, /not listed/);
  assert.equal(result.config.agents.defaults.models["proxy/old"], undefined);
  assert.deepEqual(result.config.models.providers.offline, original.models.providers.offline);
  assert.equal(result.config.models.providers.proxy.apiKey, "KEEP");
  assert.deepEqual(result.config.plugins, original.plugins);
  assert.equal(original.models.providers.proxy.models.length, 3, "input is immutable");
});

test("errors, partial inventories and empty discovery cannot revoke configured selections", () => {
  for (const inventory of [{ status: "unverifiable", complete: true, models: [] }, { status: "verified", complete: false, models: [] }, { status: "verified", complete: true, models: [] }, { status: "verified", complete: true, models: [{ nonsense: true }] }]) {
    const original = fixture();
    const result = reconcileModelCatalog(original, { proxy: inventory });
    assert.deepEqual(result.config, original);
    assert.deepEqual(result.removed, []);
  }
});

test("active session and cron references protect otherwise unused models and catalogs do not expand allowlists", () => {
  const original = fixture();
  const result = reconcileModelCatalog(original, { proxy: { status: "verified", complete: true, models: [{ id: "mini", name: "Mini" }, { id: "new", name: "New" }] } }, { referencedModels: ["proxy/old"] });
  assert.deepEqual(result.removed, []);
  assert.ok(result.config.agents.defaults.models["proxy/old"]);
  assert.equal(result.config.agents.defaults.models["proxy/new"], undefined);
});

test("primary, fallback and session alias references use the same case and whitespace rules as model selection", () => {
  for (const kind of ["primary", "fallback", "session"]) {
    const original = fixture();
    original.agents.defaults.models["proxy/old"] = { alias: " Old Choice " };
    const options = {};
    if (kind === "primary") original.agents.defaults.model = " OLD CHOICE ";
    if (kind === "fallback") original.agents.defaults.model = { primary: "proxy/mini", fallbacks: [" old choice "] };
    if (kind === "session") options.referencedModels = ["OLD CHOICE"];
    const result = reconcileModelCatalog(original, { proxy: { status: "verified", complete: true, models: [{ id: "mini" }] } }, options);
    assert.ok(result.config.agents.defaults.models["proxy/old"], kind);
    assert.ok(!result.removed.includes("proxy/old"), kind);
  }
});

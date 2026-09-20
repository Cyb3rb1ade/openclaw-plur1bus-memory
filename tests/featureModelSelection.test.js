import assert from "node:assert/strict";
import test from "node:test";
import { buildControlPlaneProjection } from "../lib/control-plane-projection.js";
import { resolveFeatureLlmRoute, completeFeatureLlm, isLlmRouteAvailable } from "../lib/llm-router.js";
import { resolveEffectiveConfig } from "../lib/setup/config-contract.js";
import * as writes from "../lib/setup/control-ui-write.js";
import { createControlUiHttpHandler } from "../lib/setup/control-ui-plugin-runtime.js";
import { applyInstallerFeaturePolicy } from "../scripts/lib/installer-config.mjs";

const pluginId = "memory-lancedb-namespaced";
function hostConfig() {
  return {
    agents: {
      defaults: { model: { primary: "openai/base", fallbacks: ["openai/fallback"] }, models: { "openai/base": {}, "anthropic/haiku": { alias: "Fast <model>" } } },
      list: [{ id: "alice", models: { "openai/extra": {} } }, { id: "bob", model: "anthropic/haiku" }],
    },
    plugins: { entries: { [pluginId]: { config: { merging: { model: "legacy", apiKey: "SECRET", baseUrl: "https://private.invalid" }, llmRouter: { defaultModel: "openai/base" } } } } },
  };
}

test("model controls list configured models per agent, preserve aliases and never expose credentials", () => {
  const host = hostConfig();
  const projection = buildControlPlaneProjection({ config: host.plugins.entries[pluginId].config, hostConfig: host });
  const alice = projection.featureModels.agents.find((a) => a.id === "alice");
  const bob = projection.featureModels.agents.find((a) => a.id === "bob");
  assert.deepEqual(alice.models.map((m) => m.id).sort(), ["anthropic/haiku", "openai/base", "openai/extra", "openai/fallback"]);
  assert.equal(bob.models.some((m) => m.id === "openai/extra"), false);
  assert.equal(alice.models.find((m) => m.id === "anthropic/haiku").label, "Fast <model>");
  assert.equal(alice.features.find((f) => f.id === "merging").inheritedModel, "legacy");
  assert.equal(alice.features.find((f) => f.id === "merging").direct, true);
  assert.doesNotMatch(JSON.stringify(projection), /SECRET|private\.invalid/);
});

test("default-only OpenClaw installs expose the implicit main agent", () => {
  const host = hostConfig();
  delete host.agents.list;
  const projection = buildControlPlaneProjection({ hostConfig: host });
  assert.deepEqual(projection.featureModels.agents.map((a) => a.id), ["main"]);
});

test("primary and fallback aliases resolve to configured model IDs instead of unusable allowlist entries", () => {
  const host = hostConfig();
  host.agents.defaults.model = { primary: "fast", fallbacks: ["extra", "unknown-alias"] };
  host.agents.defaults.models["anthropic/haiku"].alias = "fast";
  host.agents.list[0].models["openai/extra"].alias = "extra";
  const projection = buildControlPlaneProjection({ hostConfig: host });
  const alice = projection.featureModels.agents.find((a) => a.id === "alice");
  assert.equal(alice.defaultModel, "anthropic/haiku");
  assert.deepEqual(alice.models.map((m) => m.id).sort(), ["anthropic/haiku", "openai/base", "openai/extra"]);
});

test("agent model parameters preserve inherited aliases and an explicit empty alias removes them", () => {
  const host = hostConfig();
  host.agents.list[0].models["anthropic/haiku"] = { params: { temperature: 0 } };
  let alice = buildControlPlaneProjection({ hostConfig: host }).featureModels.agents[0];
  assert.equal(alice.models.find((m) => m.id === "anthropic/haiku").label, "Fast <model>");
  host.agents.defaults.model = "Fast <model>";
  host.agents.list[0].models["anthropic/haiku"].alias = "";
  alice = buildControlPlaneProjection({ hostConfig: host }).featureModels.agents[0];
  assert.equal(alice.models.find((m) => m.id === "anthropic/haiku").label, "anthropic/haiku");
  assert.equal(alice.defaultModel, null);
});

test("agent model choice reaches native dispatch, including when the previous route used a direct endpoint", async () => {
  const received = [];
  const route = resolveFeatureLlmRoute({ model: "legacy", apiKey: "SECRET", baseUrl: "https://private.invalid" }, {
    feature: "merging", agentModels: { alice: "anthropic/haiku" },
    runtimeLlm: { async complete(params) { received.push(params); return { text: "native" }; } },
  });
  const direct = [];
  const dependencies = { async directCall(messages, cfg) { direct.push(cfg); return "direct"; } };
  const alice = await completeFeatureLlm([], route, { agentId: "alice" }, dependencies);
  const bob = await completeFeatureLlm([], route, { agentId: "bob" }, dependencies);
  assert.equal(alice.text, "native");
  assert.equal(received[0].model, "anthropic/haiku");
  assert.equal(Object.hasOwn(received[0], "agentId"), false, "host agent authority is unchanged");
  assert.doesNotMatch(JSON.stringify(received), /SECRET|private\.invalid/);
  assert.equal(bob.text, "direct");
  assert.equal(direct[0].model, "legacy");
  assert.equal(route.model, "legacy", "a shared route must not be mutated");
});

test("an agent override can use a valid host route even when the inherited direct credential is unavailable", async () => {
  const route = resolveFeatureLlmRoute({}, { credentialUnavailable: true, agentModels: { alice: "openai/base" }, runtimeLlm: { async complete(p) { return p.model; } } });
  assert.equal(isLlmRouteAvailable(route), true);
  assert.equal((await completeFeatureLlm([], route, { agentId: "alice" })).text, "openai/base");
  assert.equal((await completeFeatureLlm([], route, { agentId: "bob" })).status, "unavailable");
});

test("model selection uses local agent context and never another agent's choice", async () => {
  const route = resolveFeatureLlmRoute({ model: "openai/base" }, { agentModels: { alice: "anthropic/haiku", bob: "openai/extra" }, runtimeLlm: { async complete(p) { return p.model; } } });
  assert.equal((await completeFeatureLlm([], route, { agentId: "bob" })).text, "openai/extra");
  assert.equal((await completeFeatureLlm([], route)).text, "openai/base");
});

test("saving and resetting a model preserves unrelated config and persists a schema-valid agent override", async () => {
  const draft = hostConfig();
  let afterWrite;
  const mutate = writes.createFeatureModelMutator({ api: { runtime: { config: { async mutateConfigFile(request) { afterWrite = request.afterWrite; return request.mutate(draft); } } } } });
  await mutate({ agentId: "alice", feature: "capture-summary", model: "anthropic/haiku" });
  const saved = draft.plugins.entries[pluginId].config;
  assert.equal(saved.llmRouter.agentModels.alice["capture-summary"], "anthropic/haiku");
  assert.equal(saved.merging.apiKey, "SECRET");
  assert.deepEqual(afterWrite, { mode: "auto" });
  assert.doesNotThrow(() => resolveEffectiveConfig(saved));
  await mutate({ agentId: "alice", feature: "capture-summary", model: "" });
  assert.equal(Object.hasOwn(draft.plugins.entries[pluginId].config.llmRouter.agentModels?.alice || {}, "capture-summary"), false);
  assert.equal(draft.plugins.entries[pluginId].config.llmRouter.defaultModel, "openai/base");
});

test("model writes reject stale choices, another agent's private model, unknown features and malformed input", async () => {
  const draft = hostConfig();
  const before = structuredClone(draft);
  const mutate = writes.createFeatureModelMutator({ api: { runtime: { config: { async mutateConfigFile(request) { return request.mutate(draft); } } } } });
  for (const request of [
    { agentId: "alice", feature: "merging", model: "unknown/model" },
    { agentId: "bob", feature: "merging", model: "openai/extra" },
    { agentId: "missing", feature: "merging", model: "openai/base" },
    { agentId: "alice", feature: "__proto__", model: "openai/base" },
    { agentId: "../alice", feature: "merging", model: "openai/base" },
    { agentId: "alice", feature: "merging", model: "a".repeat(257) },
  ]) await assert.rejects(() => mutate(request));
  assert.deepEqual(draft, before);
});

test("explicit model selection extends only the necessary plugin model permissions", async () => {
  for (const policy of [
    { allowModelOverride: true, allowedModels: ["openai/base"], allowedCompletionModels: ["openai/base"], allowAuthProfileOverride: false },
    { allowModelOverride: false },
    { allowModelOverride: true },
    { allowModelOverride: true, allowedModels: ["*"] },
  ]) {
    const draft = hostConfig();
    draft.plugins.entries[pluginId].llm = structuredClone(policy);
    const mutate = writes.createFeatureModelMutator({ api: { runtime: { config: { async mutateConfigFile(request) { return request.mutate(draft); } } } } });
    await mutate({ agentId: "alice", feature: "merging", model: "anthropic/haiku" });
    const updated = draft.plugins.entries[pluginId].llm;
    assert.equal(updated.allowModelOverride, true);
    if (policy.allowedModels?.includes("*")) assert.deepEqual(updated.allowedModels, ["*"]);
    else if (policy.allowModelOverride && !policy.allowedModels) assert.equal(updated.allowedModels, undefined);
    else assert.deepEqual(updated.allowedModels, [...(policy.allowedModels || []), "anthropic/haiku"]);
    if (policy.allowedCompletionModels) assert.deepEqual(updated.allowedCompletionModels, ["openai/base", "anthropic/haiku"]);
    assert.equal(updated.allowAuthProfileOverride, policy.allowAuthProfileOverride);
    assert.equal(updated.allowAgentIdOverride, undefined);
    await mutate({ agentId: "alice", feature: "merging", model: "" });
    assert.deepEqual(draft.plugins.entries[pluginId].llm, updated, "reset never revokes permissions another feature may use");
  }
});

test("updates preserve every existing model, direct transport and trust setting without creating overrides", () => {
  const original = hostConfig().plugins.entries[pluginId];
  original.llm = { allowModelOverride: false, allowedModels: ["openai/base"] };
  original.config.emotion = { t3: { model: "old/emotion", apiKey: "${EMOTION_KEY}", baseUrl: "https://emotion.invalid" } };
  original.config.merging.headers = { "x-custom": "old" };
  const before = structuredClone(original);
  const updated = applyInstallerFeaturePolicy(original, { mode: "preserve" });
  assert.deepEqual(updated.config, before.config);
  assert.deepEqual(updated.llm, before.llm);
  const effective = resolveEffectiveConfig(updated.config);
  assert.equal(effective.llmRouter.agentModels, undefined);
  assert.equal(effective.merging.model, "legacy");
  assert.equal(effective.emotion.t3.model, "old/emotion");
  assert.equal(effective.emotion.t3.apiKey, "${EMOTION_KEY}");
  assert.deepEqual(original, before, "reading/updating must not mutate the supplied settings");
  const chosen = structuredClone(original);
  chosen.config.llmRouter.agentModels = { alice: { merging: "anthropic/haiku", "emotion-encoding": "openai/base" } };
  assert.deepEqual(applyInstallerFeaturePolicy(chosen, { mode: "preserve" }).config, chosen.config);
});

test("model action enforces write mode and forwards complete validated form fields", async () => {
  const form = new URLSearchParams({ agent: "alice", feature: "merging", model: "anthropic/haiku" });
  const requests = [];
  const deps = { setFeatureModel: async (r) => requests.push(r) };
  for (const mode of ["off", "reranker"]) {
    assert.equal((await writes.applyControlUiWriteAction({ action: "feature.model", form, mode, deps })).code, "denied_mode");
  }
  assert.equal(requests.length, 0);
  assert.equal((await writes.applyControlUiWriteAction({ action: "feature.model", form, mode: "all", deps })).ok, true);
  assert.deepEqual(requests, [{ agentId: "alice", feature: "merging", model: "anthropic/haiku" }]);
  form.set("model", "a".repeat(257));
  assert.equal((await writes.applyControlUiWriteAction({ action: "feature.model", form, mode: "all", deps })).ok, false);
  assert.equal(requests.length, 1);
});

test("dashboard renders the model matrix with escaped labels and keeps unavailable saved models visible", async () => {
  const host = hostConfig();
  const config = host.plugins.entries[pluginId].config;
  config.llmRouter.agentModels = { alice: { merging: "removed/model" } };
  const projection = buildControlPlaneProjection({ config, hostConfig: host });
  const html = await render(projection, true);
  assert.match(html, /<h2 id="llm-tasks-title">LLM Tasks<\/h2>/);
  assert.match(html, /name="action" value="feature.model"/);
  assert.match(html, /<select[^>]*name="model"/);
  assert.match(html, /Fast &lt;model&gt;/);
  assert.match(html, /value="removed\/model"[^>]*selected/);
  assert.match(html, /Inherit — /);
  assert.match(html, /name="feature" value="\*"/, "the default row writes the agent default");
  assert.doesNotMatch(html, /class="feature-models"><legend>alice/, "no per-card fieldsets any more");
  assert.doesNotMatch(html, /SECRET|private\.invalid/);
  const readonly = await render(projection, false);
  assert.doesNotMatch(readonly, /name="action" value="feature.model"/);
  assert.match(readonly, /<select[^>]*name="model"[^>]*disabled/);
});

test("dashboard carries a jump bar with one anchor per section and stacks the storage switch", async () => {
  const html = await render(buildControlPlaneProjection({ hostConfig: hostConfig() }), true);
  const ids = [...html.matchAll(/aria-labelledby="([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 9);
  for (const id of ids) assert.match(html, new RegExp(`<nav class="jump"[^>]*>(?:.*?)<a href="#${id}">`), `anchor for ${id}`);
  assert.match(html, /<ul class="switch-list switch-stack">/);
});

function entriesHost() {
  const host = hostConfig();
  // OpenClaw's current form: an object keyed by agent id; sub-agents have no heartbeat.
  host.agents.entries = {
    alice: { name: "Alice", heartbeat: { every: "6h" }, models: { "openai/extra": {} } },
    "alice-helper": { name: "Helper" },
    bob: { model: "anthropic/haiku" },
  };
  delete host.agents.list;
  return host;
}

test("agents come from agents.entries first and the matrix shows only standing agents by default", () => {
  const host = entriesHost();
  const projection = buildControlPlaneProjection({ hostConfig: host });
  assert.deepEqual(projection.featureModels.agents.map((a) => a.id), ["alice"], "only the agent with a heartbeat");
  assert.equal(projection.featureModels.selection, "standing");
  assert.equal(projection.featureModels.agents[0].label, "Alice");
  assert.ok(projection.featureModels.agents[0].models.some((m) => m.id === "openai/extra"), "agent-local models are read from entries");
  // A saved choice keeps its agent visible even without a heartbeat.
  const withChoice = buildControlPlaneProjection({ hostConfig: host, config: { llmRouter: { agentModels: { bob: { merging: "openai/base" } } } } });
  assert.deepEqual(withChoice.featureModels.agents.map((a) => a.id), ["alice", "bob"]);
  // An explicit list wins; unknown ids are ignored.
  const explicit = buildControlPlaneProjection({ hostConfig: host, config: { llmRouter: { dashboardAgents: ["bob", "ghost"] } } });
  assert.deepEqual(explicit.featureModels.agents.map((a) => a.id), ["bob"]);
  assert.equal(explicit.featureModels.selection, "configured");
  // Nothing standing and nothing saved: every known agent.
  delete host.agents.entries.alice.heartbeat;
  assert.deepEqual(buildControlPlaneProjection({ hostConfig: host }).featureModels.agents.map((a) => a.id), ["alice", "alice-helper", "bob"]);
  // Legacy agents.list still works when entries is absent.
  const legacy = hostConfig();
  assert.deepEqual(buildControlPlaneProjection({ hostConfig: legacy }).featureModels.agents.map((a) => a.id), ["alice", "bob"]);
});

test("the agent default applies to every task without its own choice and a task choice beats it", async () => {
  const { featureModelOverrides } = await import("../lib/featureModels.js");
  const config = { llmRouter: { agentModels: { alice: { "*": "anthropic/haiku", merging: "openai/extra" }, bob: { "*": "openai/base" } } } };
  assert.deepEqual(featureModelOverrides(config, "merging"), { alice: "openai/extra", bob: "openai/base" });
  assert.deepEqual(featureModelOverrides(config, "capture-summary"), { alice: "anthropic/haiku", bob: "openai/base" });
  assert.deepEqual(featureModelOverrides({ llmRouter: { agentModels: { alice: { "*": "not a model" } } } }, "merging"), {});
  const route = resolveFeatureLlmRoute({ model: "legacy", apiKey: "SECRET", baseUrl: "https://private.invalid" }, {
    feature: "capture-summary", agentModels: featureModelOverrides(config, "capture-summary"),
    runtimeLlm: { async complete(p) { return p.model; } },
  });
  assert.equal((await completeFeatureLlm([], route, { agentId: "alice" })).text, "anthropic/haiku", "the agent default reroutes a direct feature too");
  const host = entriesHost();
  const projection = buildControlPlaneProjection({ hostConfig: host, config: { ...config, merging: { model: "legacy", apiKey: "SECRET", baseUrl: "https://private.invalid" } } });
  const alice = projection.featureModels.agents.find((a) => a.id === "alice");
  assert.equal(alice.agentDefault, "anthropic/haiku");
  assert.equal(alice.features.find((f) => f.id === "merging").model, "openai/extra");
  assert.equal(alice.features.find((f) => f.id === "merging").inheritedModel, "anthropic/haiku", "what runs after resetting the task choice");
  assert.equal(alice.features.find((f) => f.id === "merging").direct, true);
  assert.equal(alice.features.find((f) => f.id === "capture-summary").inheritedModel, "anthropic/haiku");
});

test("the agent default is written and reset like a task choice and stays schema-valid", async () => {
  const draft = entriesHost();
  const mutate = writes.createFeatureModelMutator({ api: { runtime: { config: { async mutateConfigFile(request) { return request.mutate(draft); } } } } });
  await mutate({ agentId: "alice", feature: "*", model: "anthropic/haiku" });
  const saved = draft.plugins.entries[pluginId].config;
  assert.equal(saved.llmRouter.agentModels.alice["*"], "anthropic/haiku");
  assert.doesNotThrow(() => resolveEffectiveConfig({ ...saved, llmRouter: { ...saved.llmRouter, dashboardAgents: ["alice"] } }));
  await assert.rejects(() => mutate({ agentId: "alice-helper", feature: "*", model: "openai/extra" }), /no longer configured/, "another agent's private model");
  await assert.rejects(() => mutate({ agentId: "ghost", feature: "*", model: "openai/base" }));
  await mutate({ agentId: "alice", feature: "*", model: "" });
  // The mutator replaces entry.config; read the fresh object, not the one from before the reset.
  assert.equal(draft.plugins.entries[pluginId].config.llmRouter.agentModels.alice, undefined);
  const form = new URLSearchParams({ agent: "alice", feature: "*", model: "openai/base" });
  const requests = [];
  assert.equal((await writes.applyControlUiWriteAction({ action: "feature.model", form, mode: "all", deps: { setFeatureModel: async (r) => requests.push(r) } })).ok, true);
  assert.deepEqual(requests, [{ agentId: "alice", feature: "*", model: "openai/base" }]);
});

test("HTTP model writes require a fresh single-use form token", async () => {
  const tokens = writes.createFormTokenStore();
  const saved = [];
  const handler = createControlUiHttpHandler({
    getProjection: async () => buildControlPlaneProjection(),
    write: { mode: "all", tokens, applyAction: (args) => writes.applyControlUiWriteAction({ ...args, deps: { setFeatureModel: async (value) => saved.push(value) } }) },
  });
  const form = new URLSearchParams({ action: "feature.model", agent: "alice", feature: "merging", model: "anthropic/haiku", via: "fetch" });
  const send = async () => {
    const response = { setHeader() {}, end() {} };
    await handler({ method: "GET", url: `/plugins/memory-lancedb-namespaced/control?${form}`, headers: { host: "localhost" } }, response);
  };
  await send();
  assert.equal(saved.length, 0);
  form.set("form_token", tokens.issue());
  await send();
  assert.equal(saved.length, 1);
  await send();
  assert.equal(saved.length, 1, "replaying a token must not execute another model write");
});

async function render(projection, writable, query = "") {
  const handler = createControlUiHttpHandler({ getProjection: async () => projection, write: writable ? { mode: "all", tokens: writes.createFormTokenStore(), applyAction: async () => ({ ok: true }) } : null });
  const response = { setHeader() {}, end(body) { this.body = body; } };
  await handler({ method: "GET", url: `/plugins/memory-lancedb-namespaced/control${query}`, headers: { host: "localhost" } }, response);
  return response.body;
}

test("task cells stay collapsed until they hold a choice or are opened with ?edit, so the page stays small", async () => {
  const host = entriesHost();
  const config = { llmRouter: { agentModels: { alice: { merging: "openai/base" } } } };
  const projection = buildControlPlaneProjection({ config, hostConfig: host });
  const options = (html) => (html.match(/<option/g) || []).length;
  const plain = await render(projection, true);
  const perSelect = projection.featureModels.agents[0].models.length + 1;
  assert.equal((plain.match(/<select/g) || []).length, 2, "the default row plus the one saved task choice");
  assert.equal(options(plain), 2 * perSelect);
  assert.match(plain, /class="cell-edit" href="\?edit=alice\.capture-summary#llm-tasks-title"/);
  const opened = await render(projection, true, "?edit=alice.capture-summary");
  assert.equal((opened.match(/<select/g) || []).length, 3);
  assert.match(opened, /name="feature" value="capture-summary"/);
  assert.match(opened, /<details class="matrix-tasks" open>/);
  for (const bad of ["?edit=alice", "?edit=../x", "?edit=alice.capture-summary.extra", "?edit=" + "a".repeat(70) + ".merging"]) {
    assert.equal((await render(projection, true, bad).then((h) => (h.match(/<select/g) || []).length)), 2, `ignores ${bad}`);
  }
  const readonly = await render(projection, false, "?edit=alice.capture-summary");
  assert.doesNotMatch(readonly, /class="cell-edit"/);
  assert.equal((readonly.match(/<select/g) || []).length, 2, "read-only never opens extra cells");
});

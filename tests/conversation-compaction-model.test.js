import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COMPACTION_MODEL_UNSUPPORTED,
  createCompactionModelMutator,
  projectCompactionModels,
} from "../lib/conversation-compaction-model.js";

const HOST = {
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-5-5": {},
        "anthropic/claude-sonnet-5-5": {},
        "strata/qwen-flash": {},
        "anthropic/claude-opus-4-8": {}, // bekannt, aber nicht freigegeben
      },
      modelPolicy: { allow: ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "strata/qwen-flash"] },
      compaction: { mode: "safeguard", model: "anthropic/claude-sonnet-5-5" },
    },
    entries: {
      main: { heartbeat: { every: "30m" }, model: { primary: "strata/qwen-flash" }, compaction: { maxSummaryChars: 48000 } },
      bernhardine: { heartbeat: { every: "30m" }, model: { primary: "anthropic/claude-opus-5-5" }, compaction: { model: "strata/qwen-flash" } },
      developer: { model: { primary: "anthropic/claude-opus-5-5" } },
    },
  },
  plugins: { entries: { "memory-lancedb-namespaced": { config: { chatModels: { main: "strata/qwen-flash" } } } } },
};

const clone = (value) => JSON.parse(JSON.stringify(value));

function mutatorFor(host, { reject = null } = {}) {
  const writes = [];
  const api = {
    runtime: {
      config: {
        async mutateConfigFile({ mutate, afterWrite }) {
          const draft = clone(host);
          const result = mutate(draft);
          if (reject) throw new Error(reject);
          writes.push({ draft, afterWrite });
          return result;
        },
      },
    },
  };
  return { set: createCompactionModelMutator({ api }), writes };
}

describe("Kompaktierungsmodell des Gesprächsverlaufs pro Agent", () => {
  it("zeigt je Chat-Agent die eigene Wahl und was ohne Wahl gilt", () => {
    const projected = projectCompactionModels(HOST);
    assert.equal(projected.shared, "anthropic/claude-sonnet-5-5");
    assert.deepEqual(projected.agents.map((agent) => [agent.id, agent.chosen]), [["main", ""], ["bernhardine", "strata/qwen-flash"]]);
    assert.equal(projected.agents[0].models.some((model) => model.id === "anthropic/claude-opus-4-8"), false);
  });

  it("meldet ohne gemeinsames Modell einen leeren Standard — dann gilt das Sitzungsmodell", () => {
    const host = clone(HOST);
    delete host.agents.defaults.compaction.model;
    assert.equal(projectCompactionModels(host).shared, "");
  });

  it("schreibt nur agents.entries.<id>.compaction.model und erhält maxSummaryChars", async () => {
    const { set, writes } = mutatorFor(HOST);
    assert.deepEqual(await set({ agentId: "main", model: "strata/qwen-flash" }), { agentId: "main", model: "strata/qwen-flash" });
    const { draft } = writes[0];
    assert.deepEqual(draft.agents.entries.main.compaction, { maxSummaryChars: 48000, model: "strata/qwen-flash" });
    // Kein Spiegel in der Plugin-Config: sonst lädt OpenClaw das Plugin neu.
    assert.deepEqual(draft.plugins, HOST.plugins);
    assert.deepEqual(draft.agents.defaults, HOST.agents.defaults);
  });

  it("hebt die Wahl mit leerem Modell auf und entfernt ein dann leeres compaction-Objekt", async () => {
    const { set, writes } = mutatorFor(HOST);
    await set({ agentId: "bernhardine", model: "" });
    assert.equal(Object.hasOwn(writes[0].draft.agents.entries.bernhardine, "compaction"), false);

    const host = clone(HOST);
    host.agents.entries.main.compaction.model = "strata/qwen-flash";
    const second = mutatorFor(host);
    await second.set({ agentId: "main", model: "" });
    assert.deepEqual(second.writes[0].draft.agents.entries.main.compaction, { maxSummaryChars: 48000 });
  });

  it("lehnt Subagenten, unbekannte Agenten und nicht freigegebene Modelle ab", async () => {
    const { set, writes } = mutatorFor(HOST);
    await assert.rejects(set({ agentId: "developer", model: "strata/qwen-flash" }), /not a chat agent/);
    await assert.rejects(set({ agentId: "ghost", model: "strata/qwen-flash" }), /not a chat agent/);
    await assert.rejects(set({ agentId: "main", model: "anthropic/claude-opus-4-8" }), /not allowed/);
    await assert.rejects(set({ agentId: "__proto__", model: "strata/qwen-flash" }), /Invalid/);
    assert.equal(writes.length, 0);
  });

  for (const detail of [
    'Invalid config at /root/.openclaw/openclaw.json:\n- agents.entries.main: Unrecognized key: "compaction"',
    'Invalid config at /root/.openclaw/openclaw.json:\n- agents.entries.main.compaction: Unrecognized key: "model"',
    'Invalid config at /root/.openclaw/openclaw.json:\n- agents.entries["team-a"].compaction: Unrecognized key: "model"',
  ]) {
    it(`erkennt einen Host ohne Unterstützung: ${detail.split("- ")[1]}`, async () => {
      const { set } = mutatorFor(HOST, { reject: detail });
      await assert.rejects(set({ agentId: "main", model: "strata/qwen-flash" }), (error) => error.code === COMPACTION_MODEL_UNSUPPORTED);
    });
  }

  it("reicht andere Schreibfehler unverändert durch", async () => {
    const { set } = mutatorFor(HOST, { reject: "config write lock timed out" });
    await assert.rejects(set({ agentId: "main", model: "strata/qwen-flash" }), (error) => error.code === undefined && /lock timed out/.test(error.message));
  });
});

describe("Kompaktierungsmodell im Dashboard", async () => {
  const writes = await import("../lib/setup/control-ui-write.js");
  const { createControlUiHttpHandler } = await import("../lib/setup/control-ui-plugin-runtime.js");
  const { buildControlPlaneProjection } = await import("../lib/control-plane-projection.js");

  async function card(hostConfig, writable) {
    const handler = createControlUiHttpHandler({
      getProjection: async () => buildControlPlaneProjection({ config: {}, hostConfig }),
      write: writable ? { mode: "all", tokens: writes.createFormTokenStore(), applyAction: async () => ({ ok: true }) } : null,
    });
    const response = { setHeader() {}, end(body) { this.body = body; } };
    await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control", headers: { host: "localhost" } }, response);
    const start = response.body.indexOf('aria-labelledby="compaction-models-title"');
    return start < 0 ? "" : response.body.slice(start, response.body.indexOf("</section>", start));
  }

  it("leitet die Aktion nur im Schreibmodus all weiter und unterscheidet Speichern, Aufheben und fehlende Host-Unterstützung", async () => {
    const form = new URLSearchParams({ agent: "main", compaction_model: "strata/qwen-flash" });
    const requests = [];
    const deps = { setCompactionModel: async (request) => requests.push(request) };
    const apply = (overrides = {}) => writes.applyControlUiWriteAction({ action: "compaction.model", form, mode: "all", deps, ...overrides });
    for (const mode of ["off", "reranker"]) assert.equal((await apply({ mode })).code, "denied_mode");
    assert.deepEqual(await apply(), { ok: true, code: "compaction_model_saved" });
    assert.deepEqual(requests, [{ agentId: "main", model: "strata/qwen-flash" }]);
    form.set("compaction_model", "");
    assert.equal((await apply()).code, "compaction_model_reset");
    form.set("compaction_model", "kein modell");
    assert.deepEqual(await apply(), { ok: false, code: "denied_choice" });

    form.set("compaction_model", "strata/qwen-flash");
    const unsupported = { setCompactionModel: async () => { throw Object.assign(new Error("old host"), { code: COMPACTION_MODEL_UNSUPPORTED }); } };
    assert.deepEqual(await apply({ deps: unsupported }), { ok: false, code: "compaction_model_unsupported" });
    const broken = { setCompactionModel: async () => { throw new Error("lock"); } };
    assert.deepEqual(await apply({ deps: broken }), { ok: false, code: "failed" });
    for (const code of ["compaction_model_saved", "compaction_model_reset", "compaction_model_unsupported"]) {
      assert.ok(writes.writeResultText(code), code);
    }
  });

  it("zeigt je Chat-Agent eine Zeile, die Wahl und was ohne Wahl gilt — nie „Inherits“", async () => {
    const html = await card(HOST, true);
    assert.match(html, /<h2 id="compaction-models-title">Conversation compaction model<\/h2>/);
    assert.match(html, /not the <strong>Memory compaction<\/strong> task/);
    assert.match(html, /name="action" value="compaction\.model"/);
    assert.match(html, /name="agent" value="main"/);
    assert.doesNotMatch(html, /name="agent" value="developer"/, "Subagenten bekommen keine Zeile");
    assert.match(html, /value="strata\/qwen-flash" selected/, "Bernhardines Wahl ist vorausgewählt");
    assert.match(html, /Without a choice: anthropic\/claude-sonnet-5-5 \(shared setting\)/);
    assert.doesNotMatch(html, /Inherits/);
    assert.doesNotMatch(html, /value="anthropic\/claude-opus-4-8"/, "nicht freigegebene Modelle stehen nicht zur Wahl");
  });

  it("nennt ohne gemeinsames Modell das Sitzungsmodell und sperrt die Auswahl lesend", async () => {
    const host = clone(HOST);
    delete host.agents.defaults.compaction.model;
    host.agents.entries.main.compaction.model = "local-alias";
    const readonly = await card(host, false);
    assert.match(readonly, /Without a choice: the session&#39;s own model|Without a choice: the session's own model/);
    assert.match(readonly, /local-alias \(set in openclaw\.json\)/, "ein von Hand gesetzter Alias bleibt sichtbar");
    assert.doesNotMatch(readonly, /name="action" value="compaction\.model"/);
    assert.match(readonly, /aria-label="Conversation compaction model for main" disabled/);
  });
});

describe("Kompaktierungsmodell: Anzeige nach dem Speichern", async () => {
  const { buildControlPlaneProjection } = await import("../lib/control-plane-projection.js");

  it("liest die Wahl aus der laufenden Host-Config, nicht aus dem Schnappschuss vom Plugin-Start", () => {
    // Die Karte schreibt nur agents.entries.*: das Plugin lädt nicht neu, sein Schnappschuss bleibt alt.
    const saved = clone(HOST);
    saved.agents.entries.main.compaction.model = "strata/qwen-flash";
    const rows = (projection) => projection.compactionModels.agents.map((agent) => [agent.id, agent.chosen]);
    assert.deepEqual(rows(buildControlPlaneProjection({ config: {}, hostConfig: HOST, liveHostConfig: saved })),
      [["main", "strata/qwen-flash"], ["bernhardine", "strata/qwen-flash"]]);
    assert.deepEqual(rows(buildControlPlaneProjection({ config: {}, hostConfig: HOST })),
      [["main", ""], ["bernhardine", "strata/qwen-flash"]], "ohne laufende Config bleibt der Schnappschuss die Quelle");
  });

  it("reicht die laufende Config im Plugin-Einstieg an die Projektion durch", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../index.js", import.meta.url), "utf8");
    assert.match(source, /hostConfig: api\.config,\s+liveHostConfig: runtimeIfUsable\(api\)\?\.config\?\.current\?\.\(\) \?\? null,/);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chatModelOptions,
  createChatModelMutator,
  projectChatModels,
  splitModelRef,
  validChatModelRequest,
} from "../lib/chat-model.js";

const HOST = {
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {},
        "anthropic/claude-opus-5-5": {},
        "kimi-coding/k3": {},
        "anthropic/claude-opus-4-8": {}, // bekannt, aber nicht freigegeben
      },
      modelPolicy: { allow: ["anthropic/claude-opus-4-6", "anthropic/claude-opus-5-5", "kimi-coding/k3"] },
    },
    entries: {
      main: { heartbeat: { every: "30m" }, model: { primary: "anthropic/claude-opus-4-6", fallbacks: ["anthropic/claude-sonnet-5"] } },
      bernhardine: { heartbeat: { every: "30m" }, model: { primary: "anthropic/claude-opus-4-6", fallbacks: [] } },
      developer: { model: { primary: "kimi-coding/k3", fallbacks: [] } },
    },
  },
  plugins: { entries: { "memory-lancedb-namespaced": { config: {} } } },
};

const clone = (value) => JSON.parse(JSON.stringify(value));

describe("Chat-Modell pro Workspace", () => {
  it("bietet nur Modelle an, die der Agent kennt und die modelPolicy.allow freigibt", () => {
    const ids = chatModelOptions(HOST, "main").map((model) => model.id);
    assert.deepEqual(ids.sort(), ["anthropic/claude-opus-4-6", "anthropic/claude-opus-5-5", "kimi-coding/k3"]);
    assert.equal(ids.includes("anthropic/claude-opus-4-8"), false);
  });

  it("zeigt nur die Chat-Agenten — die mit Heartbeat —, nicht ihre Subagenten", () => {
    const projected = projectChatModels({ chatModels: { main: "anthropic/claude-opus-5-5" } }, HOST);
    assert.deepEqual(projected.agents.map((agent) => agent.id), ["main", "bernhardine"]);
    const main = projected.agents.find((agent) => agent.id === "main");
    assert.equal(main.chosen, "anthropic/claude-opus-5-5");
    assert.equal(main.running, "anthropic/claude-opus-4-6");
  });

  it("zerlegt Modellreferenzen am ersten Schrägstrich", () => {
    assert.deepEqual(splitModelRef("anthropic/claude-opus-5-5"), { provider: "anthropic", model: "claude-opus-5-5" });
    assert.deepEqual(splitModelRef("nvidia/moonshotai/kimi-k2.6"), { provider: "nvidia", model: "moonshotai/kimi-k2.6" });
    assert.equal(splitModelRef("nur-ein-name"), null);
  });

  it("prüft Eingaben streng", () => {
    assert.equal(validChatModelRequest({ agentId: "main", model: "anthropic/claude-opus-5-5" }), true);
    assert.equal(validChatModelRequest({ agentId: "main", model: "" }), true, "leer hebt die Wahl auf");
    assert.equal(validChatModelRequest({ agentId: "__proto__", model: "" }), false);
    assert.equal(validChatModelRequest({ agentId: "main", model: "kein modell" }), false);
  });

  describe("Mutator", () => {
    function harness({ sessions = [], locked = new Set(), hostConfig = null } = {}) {
      let config = clone(HOST);
      const patched = [];
      const steps = [];
      const api = {
        runtime: {
          config: {
            async mutateConfigFile({ mutate }) {
              steps.push("write");
              const draft = clone(config);
              const result = await mutate(draft);
              config = draft;
              return result;
            },
          },
          agent: {
            session: {
              listSessionEntries: ({ agentId }) => sessions.filter((s) => s.agentId === agentId).map(({ sessionKey, entry }) => ({ sessionKey, entry: clone(entry) })),
              async patchSessionEntry(params) {
                const current = sessions.find((s) => s.sessionKey === params.sessionKey);
                const next = await params.update(clone(current.entry), { existingEntry: current.entry });
                steps.push("release");
                patched.push({ ...params, next });
                return next;
              },
            },
          },
        },
      };
      // Stellvertreter fuer openclaw/plugin-sdk/model-session-runtime.
      const modelSession = {
        isModelSelectionLocked: (entry) => locked.has(entry.id),
        applyModelOverrideToSessionEntry({ entry, selection }) {
          assert.equal(selection.isDefault, true);
          let updated = false;
          for (const key of ["modelOverride", "providerOverride", "modelOverrideSource", "model", "modelProvider", "contextTokens"]) {
            if (entry[key] !== undefined) { delete entry[key]; updated = true; }
          }
          return { updated, selection };
        },
      };
      const mutator = createChatModelMutator({
        api,
        loadModelSession: async () => modelSession,
        ...(hostConfig ? { getHostConfig: () => hostConfig } : {}),
      });
      return { mutator, patched, steps, config: () => config };
    }

    it("schreibt Wahl und Agent-Primary, lässt die Fallbacks stehen", async () => {
      const h = harness();
      await h.mutator({ agentId: "main", model: "anthropic/claude-opus-5-5" });
      const cfg = h.config();
      assert.equal(cfg.plugins.entries["memory-lancedb-namespaced"].config.chatModels.main, "anthropic/claude-opus-5-5");
      assert.deepEqual(cfg.agents.entries.main.model, { primary: "anthropic/claude-opus-5-5", fallbacks: ["anthropic/claude-sonnet-5"] });
      assert.equal(cfg.agents.entries.bernhardine.model.primary, "anthropic/claude-opus-4-6", "nur der gewählte Agent");
    });

    it("lehnt Modelle ab, die modelPolicy.allow nicht freigibt, und Agenten ohne Heartbeat", async () => {
      const h = harness();
      await assert.rejects(() => h.mutator({ agentId: "main", model: "anthropic/claude-opus-4-8" }), /not allowed/);
      await assert.rejects(() => h.mutator({ agentId: "developer", model: "kimi-coding/k3" }), /not a chat agent/);
    });

    it("hebt die Wahl mit leerem Modell auf und lässt den laufenden Primary bis zum Neustart stehen", async () => {
      const h = harness();
      await h.mutator({ agentId: "main", model: "anthropic/claude-opus-5-5" });
      await h.mutator({ agentId: "main", model: "" });
      const cfg = h.config();
      assert.equal(cfg.plugins.entries["memory-lancedb-namespaced"].config.chatModels, undefined);
      assert.equal(cfg.agents.entries.main.model.primary, "anthropic/claude-opus-5-5");
    });

    it("entpinnt aktive Sitzungen des Agenten, aber keine Heartbeats und keine gesperrten", async () => {
      const sessions = [
        { agentId: "main", sessionKey: "agent:main:telegram:direct:1", entry: { id: "a", modelOverride: "claude-opus-4-6", providerOverride: "anthropic", contextTokens: 200000 } },
        { agentId: "main", sessionKey: "agent:main:main:heartbeat", entry: { id: "b", modelOverride: "kimi-for-coding" } },
        { agentId: "main", sessionKey: "agent:main:telegram:group:2", entry: { id: "c", modelOverride: "claude-opus-4-6" } },
        { agentId: "main", sessionKey: "agent:main:telegram:direct:3", entry: { id: "d" } },
        { agentId: "bernhardine", sessionKey: "agent:bernhardine:x", entry: { id: "e", modelOverride: "claude-opus-4-6" } },
      ];
      const h = harness({ sessions, locked: new Set(["c"]) });
      const result = await h.mutator({ agentId: "main", model: "anthropic/claude-opus-5-5" });

      assert.deepEqual(h.patched.map((p) => p.sessionKey), ["agent:main:telegram:direct:1"]);
      assert.equal(h.patched[0].replaceEntry, true, "gelöschte Felder müssen wirklich verschwinden");
      assert.equal(h.patched[0].preserveActivity, true);
      assert.equal(h.patched[0].next.modelOverride, undefined);
      assert.equal(h.patched[0].next.contextTokens, undefined);
      assert.deepEqual(result, { agentId: "main", model: "anthropic/claude-opus-5-5", releasedSessions: 1 });
    });

    it("schreibt die Config zuletzt, damit der Aufruf vor dem Plugin-Reload endet", async () => {
      // Die Config-Änderung ersetzt dieses Plugin beim nächsten Reload. Läuft
      // der Aufruf dann noch, verweigert OpenClaw den Tausch, und der Gateway
      // blieb am 23.09.26 ohne Telegram-Zustellung, bis er neu startete.
      const sessions = [
        { agentId: "main", sessionKey: "agent:main:telegram:direct:1", entry: { id: "a", modelOverride: "claude-opus-4-6" } },
        { agentId: "main", sessionKey: "agent:main:telegram:direct:2", entry: { id: "b", modelOverride: "claude-opus-4-6" } },
      ];
      const h = harness({ sessions, hostConfig: HOST });
      await h.mutator({ agentId: "main", model: "anthropic/claude-opus-5-5" });
      assert.deepEqual(h.steps, ["release", "release", "write"]);
    });

    it("löst keine Pins, wenn die Wahl schon an der laufenden Config scheitert", async () => {
      const sessions = [
        { agentId: "main", sessionKey: "agent:main:telegram:direct:1", entry: { id: "a", modelOverride: "claude-opus-4-6" } },
      ];
      const h = harness({ sessions, hostConfig: HOST });
      await assert.rejects(() => h.mutator({ agentId: "main", model: "anthropic/claude-opus-4-8" }), /not allowed/);
      await assert.rejects(() => h.mutator({ agentId: "developer", model: "kimi-coding/k3" }), /not a chat agent/);
      assert.deepEqual(h.steps, []);
    });

    it("übersteht einen fehlenden Session-Zugriff und meldet dann null entpinnte Sitzungen", async () => {
      let config = clone(HOST);
      const api = { runtime: { config: { async mutateConfigFile({ mutate }) { const d = clone(config); const r = await mutate(d); config = d; return r; } } } };
      const mutator = createChatModelMutator({ api, loadModelSession: async () => { throw new Error("sdk missing"); } });
      const result = await mutator({ agentId: "main", model: "anthropic/claude-opus-5-5" });
      assert.equal(result.releasedSessions, 0);
      assert.equal(config.agents.entries.main.model.primary, "anthropic/claude-opus-5-5");
    });
  });
});

describe("Chat-Modell im Dashboard", async () => {
  const writes = await import("../lib/setup/control-ui-write.js");
  const { createControlUiHttpHandler } = await import("../lib/setup/control-ui-plugin-runtime.js");
  const { buildControlPlaneProjection } = await import("../lib/control-plane-projection.js");

  async function render(projection, writable) {
    const handler = createControlUiHttpHandler({
      getProjection: async () => projection,
      write: writable ? { mode: "all", tokens: writes.createFormTokenStore(), applyAction: async () => ({ ok: true }) } : null,
    });
    const response = { setHeader() {}, end(body) { this.body = body; } };
    await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control", headers: { host: "localhost" } }, response);
    return response.body;
  }

  it("leitet die Aktion nur im Schreibmodus all weiter, mit geprüften Feldern", async () => {
    const form = new URLSearchParams({ agent: "main", chat_model: "anthropic/claude-opus-5-5" });
    const requests = [];
    const deps = { setChatModel: async (request) => requests.push(request) };
    for (const mode of ["off", "reranker"]) {
      assert.equal((await writes.applyControlUiWriteAction({ action: "chat.model", form, mode, deps })).code, "denied_mode");
    }
    const saved = await writes.applyControlUiWriteAction({ action: "chat.model", form, mode: "all", deps });
    assert.deepEqual(saved, { ok: true, code: "chat_model_saved" });
    assert.deepEqual(requests, [{ agentId: "main", model: "anthropic/claude-opus-5-5" }]);
    form.set("chat_model", "");
    assert.equal((await writes.applyControlUiWriteAction({ action: "chat.model", form, mode: "all", deps })).code, "chat_model_reset");
    form.set("chat_model", "kein modell");
    assert.equal((await writes.applyControlUiWriteAction({ action: "chat.model", form, mode: "all", deps })).ok, false);
    assert.ok(writes.writeResultText("chat_model_saved"));
    assert.ok(writes.writeResultText("chat_model_reset"));
  });

  it("zeigt eine Karte mit einer Zeile pro Chat-Agent und lässt sie lesend gesperrt", async () => {
    const config = { chatModels: { main: "anthropic/claude-opus-5-5" } };
    const projection = buildControlPlaneProjection({ config, hostConfig: HOST });
    const page = await render(projection, true);
    // Nur die neue Karte: die Aufgabentabelle darunter bietet alle bekannten Modelle an.
    const html = page.slice(page.indexOf('aria-labelledby="chat-models-title"'), page.indexOf("</section>", page.indexOf('aria-labelledby="chat-models-title"')));
    assert.match(html, /<h2 id="chat-models-title">Chat model<\/h2>/);
    assert.match(html, /name="action" value="chat\.model"/);
    assert.match(html, /name="agent" value="main"/);
    assert.match(html, /name="agent" value="bernhardine"/);
    assert.doesNotMatch(html, /name="agent" value="developer"/, "Subagenten bekommen keine Zeile");
    assert.match(html, /value="anthropic\/claude-opus-5-5" selected/);
    assert.match(html, /Running now: anthropic\/claude-opus-4-6/);
    assert.doesNotMatch(html, /value="anthropic\/claude-opus-4-8"/, "nicht freigegebene Modelle stehen nicht zur Wahl");
    const readonly = await render(projection, false);
    assert.doesNotMatch(readonly, /name="action" value="chat\.model"/);
    assert.match(readonly, /aria-label="Chat model for main" disabled/);
  });
});

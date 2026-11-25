/**
 * tests/recall-prewarm-7211.test.js — 7.21.1: one read-only warm recall per
 * chat agent after gateway_start (cold start of 24.11.2026 09:44 / 22:29).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RECALL_PREWARM_QUERY,
  recallPrewarmAgents,
  registerRecallPrewarm,
  runRecallPrewarm,
} from "../adapter/openclaw/register-recall-prewarm.js";

const quietLogger = { info() {}, warn() {}, debug() {} };

describe("recallPrewarmAgents", () => {
  it("takes runtime.recallPrewarm.agents, else chatModels, else the Obsidian workspaces", () => {
    assert.deepEqual(recallPrewarmAgents({ runtime: { recallPrewarm: { agents: ["b", "a", "b"] } }, chatModels: { main: "x" } }), ["b", "a"]);
    assert.deepEqual(recallPrewarmAgents({ chatModels: { main: "x", bernhardine: "y", heisenberg: "z" } }), ["main", "bernhardine", "heisenberg"]);
    assert.deepEqual(recallPrewarmAgents({ obsidianBridge: { workspaces: [{ agentId: "main" }, { agentId: "../evil" }] } }), ["main"]);
    assert.deepEqual(recallPrewarmAgents({}), []);
  });

  it("caps the list at eight agents", () => {
    const chatModels = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`agent${i}`, "m"]));
    assert.equal(recallPrewarmAgents({ chatModels }).length, 8);
  });
});

describe("runRecallPrewarm", () => {
  it("runs a warm-only, reranker-off, background recall per agent, one after the other, and never throws", async () => {
    const calls = [];
    let active = 0;
    const engine = {
      async recall(q, opts) {
        active++;
        assert.equal(active, 1, "sequential");
        calls.push({ q, opts });
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        if (q.principal.agentId === "bad") throw new Error("boom");
        return { blocks: [], degraded: q.principal.agentId === "slow" ? { reason: "warm-failed" } : null };
      },
    };
    const results = await runRecallPrewarm({ engine, logger: quietLogger, agents: ["main", "bad", "slow"] });
    assert.deepEqual(results.map((r) => [r.agentId, r.outcome.split(":")[0]]), [["main", "ok"], ["bad", "error"], ["slow", "warm-failed"]]);
    for (const { q, opts } of calls) {
      assert.equal(q.warmOnly, true);
      assert.equal(q.query, RECALL_PREWARM_QUERY);
      assert.equal(q.agent.background, true);
      assert.ok(q.signal instanceof AbortSignal);
      assert.deepEqual(opts, { reranker: "off" });
    }
  });
});

describe("registerRecallPrewarm", () => {
  const fakeApi = () => {
    const handlers = new Map();
    return { handlers, on(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); } };
  };

  it("arms once on gateway_start and runs after the delay", async () => {
    const api = fakeApi();
    const seen = [];
    const engine = { recall: async (q) => { seen.push(q.principal.agentId); return { blocks: [] }; } };
    registerRecallPrewarm({ api, host: { logger: quietLogger }, engine, cfg: { chatModels: { main: "m" }, runtime: { recallPrewarm: { delayMs: 0 } } } });
    const [start] = api.handlers.get("gateway_start");
    start();
    start(); // a second gateway_start (hot reload) must not warm twice
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(seen, ["main"]);
  });

  it("does nothing when disabled, without autoRecall, or without agents", () => {
    for (const cfg of [
      { chatModels: { main: "m" }, runtime: { recallPrewarm: { enabled: false } } },
      { chatModels: { main: "m" }, autoRecall: false },
      {},
    ]) {
      const api = fakeApi();
      registerRecallPrewarm({ api, host: { logger: quietLogger }, engine: { recall: async () => ({}) }, cfg });
      assert.equal(api.handlers.has("gateway_start"), false, JSON.stringify(cfg));
    }
  });
});

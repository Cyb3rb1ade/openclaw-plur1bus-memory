/**
 * tests/e1-memory-ops-read.test.js — E1 Task 4: Engine.memory.list / .show.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createEngine } from "../engine/create-engine.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const config = (baseDbPath) => ({
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: false, autoRecall: true,
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  runtime: { recallTimeoutMs: 10_000 },
  // Two captures in one test must land as two distinct facts; the flat
  // embedder below always returns the same vector, so the duplicate check
  // must be pushed past 1.0 (see AGENTS.md's flat-embedder note).
  duplicateThreshold: 1.01,
});

// A fixed 384-dimension vector: the stub-host engine never loads a real model.
function flatEmbedder() {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  const one = async () => vector();
  return { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (texts) => texts.map(vector), shutdown: async () => {} };
}

function principalFor(agentId) {
  return { agentId, workspace: "workspace:v1:main", channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" };
}

const agent = { origin: "user", background: false };

async function seed(engine, agentId, text) {
  const principal = principalFor(agentId);
  const outcome = await engine.capture({
    agentId,
    principal,
    agent,
    messages: [
      { role: "user", content: text },
      { role: "assistant", content: "noted." },
    ],
    sessionKey: `agent:${agentId}:main`,
    incognito: false,
    signal: AbortSignal.timeout(8_000),
  }).done;
  assert.equal(outcome.reason, undefined, `capture not skipped: ${outcome.reason}`);
  assert.ok(outcome.stored >= 1, `capture stored at least one fact (${outcome.stored})`);
}

describe("Engine.memory.list / .show (E1 Task 4)", () => {
  it("(a) list({ topic }) returns the seeded fact with scope agent-private and a numeric score", async () => {
    const host = createStubHost({ stateDir: makeTempDir("e1-read-state-") });
    const engine = createEngine(host, { ...config(makeTempDir("e1-read-db-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-a";
    await seed(engine, agentId, "Please remember that I always prefer green tea over coffee in the morning.");

    const principal = principalFor(agentId);
    const result = await engine.memory.list({ topic: "green tea" }, principal, agent);
    assert.equal(result.agentId, agentId);
    assert.equal(result.truncated, false);
    assert.ok(result.items.length >= 1, "the seeded fact is found by topic");
    const card = result.items[0];
    assert.equal(card.scope, "agent-private");
    assert.equal(typeof card.score, "number");
    assert.equal(typeof card.id, "string");

    await engine.close({ budgetMs: 5_000 });
  });

  it("(b) list({ since: 0, limit: 1 }) over two facts returns 1 item with truncated: true", async () => {
    const host = createStubHost({ stateDir: makeTempDir("e1-read-state-") });
    const engine = createEngine(host, { ...config(makeTempDir("e1-read-db-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-b";
    await seed(engine, agentId, "My sister Mira lives in Lisbon and visits every spring.");
    await seed(engine, agentId, "The office WiFi password is stored in the shared vault under 'network'.");

    const principal = principalFor(agentId);
    const result = await engine.memory.list({ since: 0, limit: 1 }, principal, agent);
    assert.equal(result.items.length, 1);
    assert.equal(result.truncated, true);

    await engine.close({ budgetMs: 5_000 });
  });

  it("(c) show(id) returns the card, and show(randomUUID()) is not-found", async () => {
    const host = createStubHost({ stateDir: makeTempDir("e1-read-state-") });
    const engine = createEngine(host, { ...config(makeTempDir("e1-read-db-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-c";
    await seed(engine, agentId, "The quarterly planning doc lives in the shared drive under 'Q3'.");

    const principal = principalFor(agentId);
    const listed = await engine.memory.list({ topic: "quarterly planning" }, principal, agent);
    assert.ok(listed.items.length >= 1);
    const id = listed.items[0].id;

    const card = await engine.memory.show(id, principal, agent);
    assert.equal(card.id, id);
    assert.equal(card.scope, "agent-private");
    assert.equal(card.score, undefined);

    await assert.rejects(
      () => engine.memory.show(randomUUID(), principal, agent),
      (err) => err.code === "not-found",
    );

    await engine.close({ budgetMs: 5_000 });
  });

  // (d) is enabled by Task 5 (memory.forget).
  it.todo("(d) show(id) is not-found after engine.memory.forget(id)", { todo: "enabled by Task 5" });

  it("(e) a card captured by agent anna is not-found for principal agent bernd", async () => {
    const host = createStubHost({ stateDir: makeTempDir("e1-read-state-") });
    const engine = createEngine(host, { ...config(makeTempDir("e1-read-db-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    await seed(engine, "anna", "Anna's dog is named Bruno and needs a walk every evening.");

    const annaPrincipal = principalFor("anna");
    const listed = await engine.memory.list({ topic: "dog" }, annaPrincipal, agent);
    assert.ok(listed.items.length >= 1);
    const id = listed.items[0].id;

    const berndPrincipal = principalFor("bernd");
    await assert.rejects(
      () => engine.memory.show(id, berndPrincipal, agent),
      (err) => err.code === "not-found",
    );

    await engine.close({ budgetMs: 5_000 });
  });

  it("(f) list({}) and list({ topic, since }) are invalid-input", async () => {
    const host = createStubHost({ stateDir: makeTempDir("e1-read-state-") });
    const engine = createEngine(host, config(makeTempDir("e1-read-db-")), { internals: { embeddings: flatEmbedder() } });
    const principal = principalFor("agent-f");

    await assert.rejects(
      () => engine.memory.list({}, principal, agent),
      (err) => err.code === "invalid-input",
    );
    await assert.rejects(
      () => engine.memory.list({ topic: "x", since: 1 }, principal, agent),
      (err) => err.code === "invalid-input",
    );

    await engine.close({ budgetMs: 5_000 });
  });
});

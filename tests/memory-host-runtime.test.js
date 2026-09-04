import { strict as assert } from "node:assert";
import test from "node:test";

import {
  createMemoryHostRuntime,
  memoryHostPath,
  parseMemoryHostPath,
  resolveAgentWorkspaceDir,
  toHostSearchResult,
} from "../lib/setup/memory-host-runtime.js";

const CARD = { id: "card-1", text: "Zeile eins\nZeile zwei\nZeile drei", summary: "Kurz gesagt", category: "fact", importance: 0.7 };

function runtimeWith(overrides = {}) {
  const calls = { recall: [], embed: 0, cards: [] };
  const runtime = createMemoryHostRuntime({
    recall: async (params) => { calls.recall.push(params); return [{ entry: CARD, score: 0.83 }, { entry: { ...CARD, id: "dream-1", memoryClass: "dream", summary: "Ich flog." }, score: 0.41 }]; },
    readCard: async ({ cardId }) => { calls.cards.push(cardId); return cardId === "card-1" ? CARD : null; },
    provider: () => ({ provider: "openai", model: "text-embedding-3-large" }),
    embed: async () => { calls.embed += 1; return [0.1, 0.2]; },
    cardCount: async () => 4211,
    hostConfig: () => ({ agents: { defaults: { workspace: "/ws/default" }, entries: { main: { workspace: "/ws/main" } } } }),
    dbPath: () => "/db/lancedb",
    now: () => 1_000_000,
    ...overrides,
  });
  return { runtime, calls };
}

test("card paths round-trip and reject anything foreign", () => {
  const path = memoryHostPath("main", "card-1");
  assert.equal(path, "plur1bus://main/card-1");
  assert.deepEqual(parseMemoryHostPath(path), { agentId: "main", cardId: "card-1" });
  assert.equal(parseMemoryHostPath("/etc/passwd"), null);
  assert.equal(parseMemoryHostPath("plur1bus://main/../x"), null);
  assert.equal(parseMemoryHostPath("plur1bus:///card"), null);
});

test("a recall hit becomes a host search result without leaking the card body", () => {
  const hit = toHostSearchResult("main", { entry: CARD, score: 1.7 });
  assert.equal(hit.path, "plur1bus://main/card-1");
  assert.equal(hit.score, 1, "scores are clamped into the host's range");
  assert.equal(hit.snippet, "Kurz gesagt");
  assert.equal(hit.source, "memory");
  assert.equal(hit.endLine, 3);
  assert.equal(hit.citation, "PLUR1BUS fact");
  assert.equal(toHostSearchResult("main", { entry: { text: "no id" } }), null);
  const dream = toHostSearchResult("main", { entry: { ...CARD, memoryClass: "dream" }, score: 0.4 });
  assert.match(dream.snippet, /^🌙 /);
  assert.match(dream.citation, /\(dream\)$/);
});

test("the workspace is the agent's own, else the default", () => {
  const cfg = { agents: { defaults: { workspace: "/ws/default" }, entries: { main: { workspace: "/ws/main" } } } };
  assert.equal(resolveAgentWorkspaceDir(cfg, "main"), "/ws/main");
  assert.equal(resolveAgentWorkspaceDir(cfg, "other"), "/ws/default");
  assert.equal(resolveAgentWorkspaceDir({}, "main"), null);
});

test("the manager reports PLUR1BUS as the engine and searches the private partition", async () => {
  const { runtime, calls } = runtimeWith();
  assert.deepEqual(runtime.resolveMemoryBackendConfig(), { backend: "builtin" });
  const { manager, debug, error } = await runtime.getMemorySearchManager({ agentId: "main", purpose: "status" });
  assert.equal(error, undefined);
  assert.equal(debug.purpose, "status");
  const status = manager.status();
  assert.equal(status.backend, "builtin");
  assert.equal(status.provider, "openai");
  assert.equal(status.model, "text-embedding-3-large");
  assert.equal(status.workspaceDir, "/ws/main");
  assert.equal(status.dbPath, "/db/lancedb");
  assert.equal(status.chunks, 4211);
  assert.deepEqual(status.sources, ["memory"]);

  const hits = await manager.search("  Stadt  ", { maxResults: 5, minScore: 0.5 });
  assert.equal(calls.recall.length, 1);
  assert.equal(calls.recall[0].query, "Stadt");
  assert.equal(calls.recall[0].limit, 5);
  assert.equal(hits.length, 1, "the dream below minScore is filtered out");
  assert.equal(hits[0].path, "plur1bus://main/card-1");
  assert.deepEqual(await manager.search("", {}), [], "an empty query searches nothing");
  assert.deepEqual(await manager.search("x", { sources: ["sessions"] }), [], "session-only requests get nothing from us");
  assert.equal(calls.recall.length, 1, "neither of those reached the recall pipeline");
});

test("readFile serves the card text by lines and refuses other agents' cards", async () => {
  const { runtime, calls } = runtimeWith();
  const { manager } = await runtime.getMemorySearchManager({ agentId: "main" });
  const whole = await manager.readFile({ relPath: "plur1bus://main/card-1" });
  assert.equal(whole.text, CARD.text);
  assert.equal(whole.from, 1);
  assert.equal(whole.lines, 3);
  assert.equal(whole.truncated, false);
  const part = await manager.readFile({ relPath: "plur1bus://main/card-1", from: 2, lines: 1 });
  assert.equal(part.text, "Zeile zwei");
  assert.equal(part.truncated, true);
  assert.equal(part.nextFrom, 3);
  await assert.rejects(manager.readFile({ relPath: "plur1bus://other/card-1" }), /not a PLUR1BUS card of this agent/);
  await assert.rejects(manager.readFile({ relPath: "/etc/passwd" }), /not a PLUR1BUS card/);
  await assert.rejects(manager.readFile({ relPath: "plur1bus://main/missing" }), /not found/);
  assert.deepEqual(calls.cards, ["card-1", "card-1", "missing"]);
});

test("the embedding probe is cached and never throws", async () => {
  let now = 1_000_000;
  const { runtime, calls } = runtimeWith({ now: () => now });
  const { manager } = await runtime.getMemorySearchManager({ agentId: "main" });
  assert.equal(manager.getCachedEmbeddingAvailability(), null);
  const first = await manager.probeEmbeddingAvailability();
  assert.equal(first.ok, true);
  assert.equal(first.checked, true);
  assert.equal(first.cached, false);
  const second = await manager.probeEmbeddingAvailability();
  assert.equal(second.cached, true);
  assert.equal(calls.embed, 1, "the second probe is served from cache");
  now += 6 * 60_000;
  await manager.probeEmbeddingAvailability();
  assert.equal(calls.embed, 2, "the cache expires");

  const broken = createMemoryHostRuntime({
    recall: async () => [], readCard: async () => null, provider: () => ({}),
    embed: async () => { throw new Error("provider down"); },
  });
  const { manager: m2 } = await broken.getMemorySearchManager({ agentId: "main" });
  const probe = await m2.probeEmbeddingAvailability();
  assert.equal(probe.ok, false);
  assert.match(probe.error, /provider down/);
  assert.equal(m2.status().provider, "plur1bus", "an empty descriptor still names the engine");
  await m2.close();
});

test("bad agent ids and failing dependencies yield a null manager, not an exception", async () => {
  const { runtime } = runtimeWith();
  assert.deepEqual(await runtime.getMemorySearchManager({ agentId: "../x" }), { manager: null, error: "invalid agent id" });
  const failing = runtimeWith({ cardCount: async () => { throw new Error("count broke"); } });
  const { manager } = await failing.runtime.getMemorySearchManager({ agentId: "main" });
  assert.ok(manager, "a failing card count only drops the count");
  assert.equal(manager.status().chunks, undefined);
});

test("session hits never pass the authorization step", async () => {
  const { runtime } = runtimeWith();
  const hits = await runtime.authorizeSearchHits({ hits: [{ source: "memory", path: "a" }, { source: "sessions", path: "b" }] });
  assert.deepEqual(hits, [{ source: "memory", path: "a" }]);
});

test("a host-originated search stays on the agent's private partition", async () => {
  // The runtime's recall closure in index.js builds its context from the
  // agent id alone. Pin both halves of that: the context builder yields no
  // workspace identity and no user principal for such input, and index.js
  // hands exactly that context to withAccessReadDbs, which then leases no
  // shared pool.
  const { resolveMemoryRequestContext } = await import("../lib/memory-request-context.js");
  const context = resolveMemoryRequestContext({ agentId: "main" });
  assert.equal(context.agentId, "main");
  assert.ok(!context.workspaceIdentity, "no workspace identity from an agent id alone");
  assert.ok(!context.userPrincipal, "no user principal from an agent id alone");

  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const start = source.indexOf("const memoryHostRuntime = createMemoryHostRuntime({");
  assert.ok(start > 0, "runtime registration present in index.js");
  const block = source.slice(start, source.indexOf("api.registerMemoryCapability({", start));
  assert.match(block, /resolveMemoryRequestContext\(\{ agentId: forAgentId \}\)/, "context comes from the agent id only");
  assert.match(block, /withAccessReadDbs\(pool, sharedMemoryPool, forAgentId, \{ \.\.\.memoryCtx, logger: api\.logger \}/, "that context is what scopes the read pools");
  assert.doesNotMatch(block, /workspaceIdentity|userPrincipal/, "nothing widens the scope by hand");
  assert.match(source, /runtime: memoryHostRuntime,/, "the runtime is what gets registered");
});

/**
 * tests/engine-contract.test.js — the Engine surface against a stub host
 * (spec success criteria 1, 3; step 9 gates).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { createStubHost } from "../lib/host-services.js";
import { readRuntimeSources } from "./helpers/runtime-sources.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const config = (baseDbPath) => ({
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: false, autoRecall: true,
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  runtime: { recallTimeoutMs: 10_000 },
});

function hangingEmbedder(probe) {
  const hang = (_text, options = {}) => new Promise((_, reject) => {
    probe.calls += 1;
    options.signal?.addEventListener("abort", () => { probe.abortedAt = Date.now(); reject(options.signal.reason); }, { once: true });
  });
  return { embed: hang, embedQuery: hang, embedPassage: hang, embedBatch: async () => [], shutdown: async () => {} };
}

// A fixed 384-dimension vector: the stub-host engine never loads a real model.
function flatEmbedder() {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  const one = async () => vector();
  return { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (texts) => texts.map(vector), shutdown: async () => {} };
}

const principal = { agentId: "agent-a", workspace: "workspace:v1:main", channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "inferred" };
const provedPrincipal = { ...principal, trust: "proved" };
const agent = { origin: "user", background: false };

describe("Engine", () => {
  it("reports contract 1.4.0, 18 jobs, the tools and a status", async () => {
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ec-state-") }), config(makeTempDir("ec-db-")));
    assert.equal(engine.contract, "1.4.0");
    assert.equal(engine.jobs.list().length, 18);
    assert.deepEqual(engine.tools.map((t) => t.name).sort(), ["knowledge_update", "memory_forget", "memory_recall", "memory_search", "memory_store"]);
    assert.equal((await engine.status()).contract, "1.4.0");
    assert.ok(engine.systemSupplement().length >= 1);
    await engine.close({ budgetMs: 5_000 });
  });

  it("recall() aborted at 100 ms cancels the embedder and resolves within 50 ms (criterion 3)", async () => {
    const probe = { calls: 0, abortedAt: null };
    const host = createStubHost({ stateDir: makeTempDir("ec-state-"), workspaceDir: async () => makeTempDir("ec-ws-") });
    const engine = createEngine(host, config(makeTempDir("ec-db-")), { internals: { embeddings: hangingEmbedder(probe) } });
    const signal = AbortSignal.timeout(100);
    const result = await engine.recall({ query: "what happened while I was away", principal, agent, signal });
    const resolvedAt = Date.now();
    assert.deepEqual(result.degraded, { reason: "aborted", capability: "recall" });
    assert.ok(probe.calls >= 1);
    assert.ok(probe.abortedAt !== null);
    assert.ok(resolvedAt - probe.abortedAt <= 50, `resolved ${resolvedAt - probe.abortedAt} ms after the abort`);
    await engine.close({ budgetMs: 5_000 });
  });

  it("recall() never throws: a missing signal and a bad principal come back degraded", async () => {
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ec-state-") }), config(makeTempDir("ec-db-")));
    assert.equal((await engine.recall({ query: "x", principal, agent })).degraded.reason, "invalid-query");
    assert.equal((await engine.recall({ query: "x", principal: { ...principal, agentId: "../etc" }, agent, signal: AbortSignal.timeout(1_000) })).degraded.reason, "invalid-query");
    await engine.close({ budgetMs: 5_000 });
  });

  it("recall() with a proved Principal returns a RecallResult and emits recall.completed", async () => {
    const host = createStubHost({ stateDir: makeTempDir("ec-state-") });
    const engine = createEngine(host, config(makeTempDir("ec-db-")), { internals: { embeddings: flatEmbedder() } });
    const seen = [];
    const subscription = engine.events.on("recall.completed", (payload) => seen.push(payload));
    const result = await engine.recall({ query: "what did we decide about the roadmap", principal: provedPrincipal, agent, signal: AbortSignal.timeout(8_000) });
    assert.ok(Array.isArray(result.blocks));
    assert.equal(result.degraded, null);
    assert.equal(typeof result.capChars, "number");
    assert.equal(typeof result.timing.totalMs, "number");
    assert.ok(Array.isArray(result.deferrals));
    for (const block of result.blocks) assert.equal(block.chars, block.text.length);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].agentId, "agent-a");
    subscription.dispose();
    await engine.recall({ query: "a second question for the store", principal: provedPrincipal, agent, signal: AbortSignal.timeout(8_000) });
    assert.equal(seen.length, 1, "a disposed listener hears nothing");
    await engine.close({ budgetMs: 5_000 });
  });

  it("jobs.run returns a JobRun and checkpoint returns a CheckpointResult", async () => {
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ec-state-"), clock: () => 5 }), config(makeTempDir("ec-db-")));
    const run = await engine.jobs.run("gc-run", "agent-a", { trigger: "harness" });
    assert.equal(run.job, "gc-run");
    assert.equal(run.trigger, "harness");
    assert.ok(["skipped", "completed", "failed"].includes(run.outcome));
    const history = await engine.jobs.history("agent-a", { job: "gc-run" });
    assert.equal(history[0].runId, run.runId);
    const cp = await engine.checkpoint("agent-a", "session-end");
    assert.deepEqual([cp.agentId, cp.reason, cp.written], ["agent-a", "session-end", true]);
    await assert.rejects(() => engine.checkpoint("agent-a", "reboot"), /unknown checkpoint reason/);
    await assert.rejects(() => engine.checkpoint("../etc", "manual"), /Invalid agent ID/);
    await engine.close({ budgetMs: 5_000 });
  });

  it("internal jobs resolve the workspace without an OpenClaw runtime (fix round 1)", async () => {
    const workspace = makeTempDir("ec-ws-");
    const host = createStubHost({ stateDir: makeTempDir("ec-state-"), workspaceDir: async () => workspace });
    const engine = createEngine(host, config(makeTempDir("ec-db-")), { internals: { embeddings: flatEmbedder() } });
    const gc = await engine.jobs.run("gc-run", "agent-a", { trigger: "harness" });
    assert.deepEqual([gc.outcome, gc.reason], ["skipped", "gc_disabled"]);
    for (const spec of engine.jobs.list()) {
      if (spec.name === "light-dream") continue;
      const run = await engine.jobs.run(spec.name, "agent-a", { trigger: "harness" });
      assert.ok(!(run.outcome === "failed" && run.reason === "error:TypeError"), `${spec.name} failed with a TypeError: ${run.error?.message}`);
    }
    await engine.close({ budgetMs: 5_000 });
  });

  it("recall() aborted while the host resolves the workspace comes back aborted (fix round 1)", async () => {
    const host = createStubHost({
      stateDir: makeTempDir("ec-state-"),
      workspaceDir: () => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    });
    const controller = new AbortController();
    const { signal } = controller;
    const engine = createEngine(host, config(makeTempDir("ec-db-")), { internals: { embeddings: flatEmbedder() } });
    const pending = engine.recall({ query: "what happened while I was away", principal, agent, signal });
    setTimeout(() => controller.abort(new Error("caller gave up")), 20);
    const result = await pending;
    assert.equal(result.degraded.reason, "aborted");
    await engine.close({ budgetMs: 5_000 });
  });

  it("one embedder serves the whole engine (fix round 1)", async () => {
    const embedder = flatEmbedder();
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ec-state-") }), config(makeTempDir("ec-db-")), { internals: { embeddings: embedder } });
    const internals = internalsOf(engine);
    assert.equal(internals.embeddings, embedder);
    assert.equal(internals.recallContext.embeddings, embedder);
    assert.equal(internals.captureContext.embeddings, embedder);
    assert.equal(internals.toolContext.embeddings, embedder);
    // Consumers built at construction time hold the same object: the
    // resource closer shuts down the injected embedder, not a real provider.
    let shutdowns = 0;
    embedder.shutdown = async () => { shutdowns += 1; };
    await engine.close({ budgetMs: 5_000 });
    assert.equal(shutdowns, 1);
  });

  it("recall() cache never crosses principals, an aborted recall stays degraded, and cached blocks are copies (final review C1)", async () => {
    // One embedder that answers until `mode.hang` flips, then only settles on abort.
    const mode = { hang: false };
    const flat = flatEmbedder();
    const probe = { calls: 0, abortedAt: null };
    const hanging = hangingEmbedder(probe);
    const switching = {
      embed: (...args) => (mode.hang ? hanging.embed(...args) : flat.embed(...args)),
      embedQuery: (...args) => (mode.hang ? hanging.embedQuery(...args) : flat.embedQuery(...args)),
      embedPassage: (...args) => (mode.hang ? hanging.embedPassage(...args) : flat.embedPassage(...args)),
      embedBatch: async (texts) => flat.embedBatch(texts),
      shutdown: async () => {},
    };
    const host = createStubHost({ stateDir: makeTempDir("ec-state-") });
    const engine = createEngine(host, config(makeTempDir("ec-db-")), { internals: { embeddings: switching } });
    const userA = { ...provedPrincipal, user: `user:v1:${"a".repeat(64)}` };
    const userB = { ...provedPrincipal, user: `user:v1:${"b".repeat(64)}` };
    const query = "what did we decide about the roadmap";
    const first = await engine.recall({ query, principal: userA, agent, signal: AbortSignal.timeout(8_000) });
    assert.equal(first.degraded, null);
    assert.ok(first.blocks.length > 0, "the first recall produced blocks to cache");

    mode.hang = true;
    const other = await engine.recall({ query, principal: userB, agent, signal: AbortSignal.timeout(150) });
    assert.deepEqual(other.degraded, { reason: "aborted", capability: "recall" }, "a timed-out recall is degraded, never served as a clean result");
    assert.deepEqual(other.blocks, [], "user B never receives user A's cached blocks");

    const again = await engine.recall({ query, principal: userA, agent, signal: AbortSignal.timeout(150) });
    assert.deepEqual(again.degraded, { reason: "aborted", capability: "recall" }, "a cached answer after an abort still says aborted");
    assert.deepEqual(again.blocks.map((b) => b.name), first.blocks.map((b) => b.name), "the same principal may reuse its own cache");
    for (let i = 0; i < again.blocks.length; i += 1) assert.notEqual(again.blocks[i], first.blocks[i], "cached blocks are copies");
    again.blocks[0].text = "mutated by the caller";
    const third = await engine.recall({ query, principal: userA, agent, signal: AbortSignal.timeout(150) });
    assert.notEqual(third.blocks[0].text, "mutated by the caller", "a caller's mutation never reaches the cache");
    await engine.close({ budgetMs: 5_000 });
  });

  it("recall() reports an inner store failure as degraded error, not a clean result (final review I6)", async () => {
    const failing = flatEmbedder();
    failing.embedQuery = async () => { throw new Error("vector store unavailable"); };
    failing.embed = failing.embedQuery;
    const host = createStubHost({ stateDir: makeTempDir("ec-state-"), workspaceDir: async () => makeTempDir("ec-ws-") });
    const engine = createEngine(host, config(makeTempDir("ec-db-")), { internals: { embeddings: failing } });
    const result = await engine.recall({ query: "what did we decide about the roadmap", principal, agent, signal: AbortSignal.timeout(8_000) });
    assert.equal(result.degraded?.reason, "error");
    assert.equal(result.degraded?.capability, "recall");
    await engine.close({ budgetMs: 5_000 });
  });

  it("an aborted recall does not mark due reminders presented (final review I7)", async () => {
    const { addPendingReminder, readPendingReminders } = await import("../lib/reminder-pending.js");
    const workspace = makeTempDir("ec-ws-");
    await addPendingReminder(workspace, workspace, "agent-a", { id: "r-1", text: "water the plants", remindAt: 1 });
    const controller = new AbortController();
    // The reaction-capability probe runs after the store search and right
    // before the reminder block: the caller gives up exactly there.
    const detectReactionsCapabilityCached = async () => { controller.abort(new Error("caller gave up")); return false; };
    const host = createStubHost({ stateDir: makeTempDir("ec-state-"), workspaceDir: async () => workspace });
    const engine = createEngine(host, config(makeTempDir("ec-db-")), { internals: { embeddings: flatEmbedder(), detectReactionsCapabilityCached } });
    const result = await engine.recall({ query: "what did we decide about the roadmap", principal, agent, signal: controller.signal });
    assert.equal(result.degraded?.reason, "aborted");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pending = await readPendingReminders(workspace, workspace, "agent-a");
    assert.ok(pending.pending?.["r-1"], "the reminder is still pending after the aborted recall");
    await engine.close({ budgetMs: 5_000 });
  });

  it("recall() reads a proved user's dream echo with the Principal, not a user-less hook context (final review I3)", async () => {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { resolveMemoryRequestContext } = await import("../lib/memory-request-context.js");
    const workspace = makeTempDir("ec-ws-");
    const user = `user:v1:${"c".repeat(64)}`;
    const workspaceIdentity = resolveMemoryRequestContext({ agentId: "agent-a", workspaceDir: workspace }).workspaceIdentity;
    writeFileSync(join(workspace, ".dream-echoes.jsonl"), `${JSON.stringify({
      sentence: "Last night the lighthouse keeper dreamt in teal.",
      createdAt: Date.now() - 60_000,
      aclBindings: { scope: "user", agentId: "agent-a", workspaceIdentity: "", ownerUserId: user },
    })}\n`);
    const host = createStubHost({ stateDir: makeTempDir("ec-state-"), workspaceDir: async () => workspace });
    const engine = createEngine(host, config(makeTempDir("ec-db-")), { internals: { embeddings: flatEmbedder() } });
    const result = await engine.recall({
      query: "what did we decide about the roadmap",
      principal: { ...provedPrincipal, workspace: workspaceIdentity, user },
      agent,
      signal: AbortSignal.timeout(8_000),
    });
    assert.equal(result.degraded, null);
    const memories = result.blocks.find((b) => b.name === "memories")?.text ?? "";
    assert.match(memories, /lighthouse keeper dreamt in teal/, "the user-scoped echo reaches its proved owner");
    await engine.close({ budgetMs: 5_000 });
  });

  it("capture() on a routing-less host stores a host-classified turn and reports the count (final review I2, m5)", async () => {
    const workspace = makeTempDir("ec-ws-");
    const host = createStubHost({ stateDir: makeTempDir("ec-state-"), workspaceDir: async () => workspace });
    const engine = createEngine(host, { ...config(makeTempDir("ec-db-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const messages = [
      { role: "user", content: "Please remember that I always prefer green tea over coffee in the morning." },
      { role: "assistant", content: "Noted: green tea in the morning." },
      { role: "user", content: "Also remember that my sister Mira lives in Lisbon and visits every spring." },
    ];
    const outcome = await engine.capture({ agentId: "agent-a", principal, agent, messages, sessionKey: "agent:agent-a:main", incognito: false, signal: AbortSignal.timeout(8_000) }).done;
    assert.equal(outcome.reason, undefined, `not skipped: ${outcome.reason}`);
    assert.ok(outcome.stored >= 2, `stored reports the actual count (${outcome.stored})`);
    await engine.close({ budgetMs: 5_000 });
  });

  it("capture() returns a handle immediately", async () => {
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ec-state-") }), config(makeTempDir("ec-db-")));
    const started = Date.now();
    const handle = engine.capture({ agentId: "agent-a", principal, agent, messages: [{ role: "user", content: "hi" }], incognito: false, signal: AbortSignal.timeout(5_000) });
    assert.ok(Date.now() - started < 5);
    assert.equal(typeof handle.id, "string");
    assert.ok(handle.done instanceof Promise);
    handle.abort("test over");
    const outcome = await handle.done;
    assert.equal(outcome.stored, 0);
    const incognito = await engine.capture({ agentId: "agent-a", principal, agent, messages: [], incognito: true, signal: AbortSignal.timeout(5_000) }).done;
    assert.deepEqual(incognito, { stored: 0, skipped: 1, reason: "incognito" });
    const unclassified = await engine.capture({ agentId: "agent-a", principal, agent, messages: [], signal: AbortSignal.timeout(5_000) }).done;
    assert.equal(unclassified.reason, "incognito", "an unclassified turn fails closed");
    const mismatch = await engine.capture({ agentId: "agent-b", principal, agent, messages: [], incognito: false, signal: AbortSignal.timeout(5_000) }).done;
    assert.equal(mismatch.reason, "principal-agent-mismatch");
    await engine.close({ budgetMs: 5_000 });
  });

  it("runCommand on a host without a command surface degrades instead of throwing", async () => {
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ec-state-") }), config(makeTempDir("ec-db-")));
    assert.deepEqual(engine.commands.map((c) => c.name), ["plur1bus"]);
    const result = await engine.runCommand("plur1bus", "status", provedPrincipal, agent);
    assert.equal(result.details.reason, "commands-unavailable");
    assert.equal(typeof result.text, "string");
    const unknown = await engine.runCommand("nope", "", provedPrincipal, agent);
    assert.equal(unknown.details.reason, "unknown-command");
    await engine.close({ budgetMs: 5_000 });
  });

  it("open(), channels and the embedding and admin surfaces are present", async () => {
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ec-state-") }), config(makeTempDir("ec-db-")), { internals: { embeddings: flatEmbedder() } });
    const store = await engine.open("agent-a");
    assert.equal(store.agentId, "agent-a");
    assert.equal((await engine.status()).agents, 1);
    await store.close();
    assert.equal((await engine.status()).agents, 0);
    assert.equal(engine.channels.has("telegram"), true);
    assert.ok(engine.channels.list().includes("telegram"));
    const [vector] = await engine.embedding.embed(["hello"], { kind: "query", identity: null, signal: AbortSignal.timeout(1_000) });
    assert.equal(vector.length, 384);
    await assert.rejects(() => engine.admin.share("x", "workspace", provedPrincipal, { nonce: "n" }), /not available in M1b-1/);
    await engine.close({ budgetMs: 5_000 });
  });

  it("close() under a tiny budget still resolves, and stays idempotent", async () => {
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ec-state-") }), config(makeTempDir("ec-db-")));
    const started = Date.now();
    await engine.close({ budgetMs: 1 });
    assert.ok(Date.now() - started < 1_000);
    assert.equal(engine.close({ budgetMs: 1 }), engine.close());
  });

  it("no engine module imports openclaw", () => {
    const { engine } = readRuntimeSources();
    for (const [name, source] of Object.entries(engine)) {
      assert.ok(!/\bfrom\s+["']openclaw|import\(\s*["']openclaw/.test(source), `engine module ${name} imports openclaw`);
    }
  });

  it("re-embedding target reads use the engine's pool class (halfLifeOverrides reach them)", () => {
    const { engine } = readRuntimeSources();
    assert.ok(!/new AgentDbPool\(/.test(engine.createEngine), "createEngine constructs a bare AgentDbPool");
    assert.ok(/const targetPool = new EngineAgentDbPool\(/.test(engine.createEngine), "withTargetGenerationDb uses EngineAgentDbPool");
  });
});

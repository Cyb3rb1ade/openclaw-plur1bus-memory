/**
 * tests/engine-recall-warm-only.test.js — E5 Task 9: `RecallQuery.warmOnly`.
 *
 * A warm-only recall runs the heavy, read-only part of a recall (neo prelude
 * reads, query embedding, a read-only LanceDB open, vector search, rerank)
 * and nothing else: no file or table write, no event, no cache entry, no LLM
 * call, no compaction bookkeeping. The next real recall is left exactly as
 * it would have been without the warm-up.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { createEmbeddingCache } from "../lib/embedding-cache.js";
import { internalsOf } from "../engine/internals.js";
import { stableDirectoryCapabilitiesSupported } from "../lib/directory-capability.js";
import { createStubHost } from "../lib/host-services.js";
import { createNeoStore } from "../lib/neo-arch.js";
import { writeProposal } from "../lib/jobs/skill-miner/proposal-writer.js";
import { addPendingReminder } from "../lib/reminder-pending.js";
import { saveReminder } from "../lib/reminder-store.js";
import { writePlur1busStartNotice } from "../lib/setup/feature-profiles.js";
import { diffSnapshots, snapshotTree } from "./helpers/fs-snapshot.js";
import {
  config as sharedConfig,
  flatEmbedder as sharedFlatEmbedder,
  freshBaseDbPath,
  principal as sharedPrincipal,
  twoWorkspaceHost,
  USER_PRINCIPAL,
} from "./helpers/shared-workspace-engine.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const AGENT = "agent-t9";
const QUERY = "what about the roadmap review";
const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const config = (baseDbPath, overrides = {}) => ({
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: true, autoRecall: true,
  neo: { enabled: true }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  runtime: { recallTimeoutMs: 10_000 },
  // Distinct facts with the flat embedder.
  duplicateThreshold: 1.01,
  ...overrides,
});

// Records every call with its options; a fixed vector, so every stored row
// and every neo candidate matches every query. With `cacheBasePath` it
// embeds through a real persisting embedding cache, as the providers do
// (runtime.embeddingCachePersist: true), honouring the per-call `persist`.
function recordingEmbedder({ cacheBasePath = null, onEmbedQuery = null } = {}) {
  const calls = { embedQuery: [], embed: [] };
  const cache = cacheBasePath
    ? createEmbeddingCache({ persist: true, cacheBasePath, provider: "stub", model: "flat", dimensions: 384 })
    : null;
  const viaCache = async (purpose, text, options) => {
    if (!cache) return vector();
    const [v] = await cache.getMany([text], { model: `flat:${purpose}`, agentId: options?.agentId, persist: options?.persist }, async (texts) => texts.map(vector));
    return v;
  };
  const embedder = {
    calls,
    cache,
    embedQuery: async (text, options) => {
      calls.embedQuery.push({ text: String(text), options });
      if (onEmbedQuery) await onEmbedQuery(text, options);
      return viaCache("query", text, options);
    },
    embed: async (text, options) => { calls.embed.push({ text: String(text), options }); return viaCache("passage", text, options); },
    embedPassage: async (text, options) => viaCache("passage", text, options),
    embedBatch: async (texts) => texts.map(vector),
    shutdown: async () => { cache?.close(); },
  };
  return embedder;
}

const textsOf = (calls) => calls.map((c) => c.text);

function recordingReranker() {
  const calls = [];
  return {
    calls,
    rerank: async (query, docs, limit) => {
      calls.push({ query, count: docs.length });
      return docs.map((_, index) => ({ index, score: 1 - index / 100 })).slice(0, limit);
    },
  };
}

const principal = { agentId: AGENT, workspace: "workspace:v1:main", channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "inferred" };
const agent = { origin: "user", background: false };

const FACTS = [
  "Please remember that the roadmap review happens every second Tuesday in the blue room.",
  "Remember that Lena owns the roadmap review agenda and sends it the evening before.",
  "Remember that the roadmap review always starts with the customer escalations.",
  "Please remember that I prefer the roadmap review slides in dark mode.",
  "Remember that the roadmap review notes go into the shared planning folder.",
  "Remember that Tomas presents the infrastructure part of the roadmap review.",
  "Please remember that the roadmap review was moved to 10:30 for the summer.",
  "Remember that we skip the roadmap review in the first week of August.",
  "Remember that the budget line for the roadmap review offsite is fixed at the start of the quarter.",
  "Please remember that the roadmap review ends with a vote on the next three priorities.",
  "Remember that Ravi keeps the roadmap review decision log.",
  "Remember that the roadmap review invite goes to the whole platform team.",
];

// Two snapshots 400 ms apart that match mean background capture work (neo
// agent_end, the embedding drain, the dynamics queue) has settled (R16).
async function waitForQuiet(roots, { quietMs = 400, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = roots.map(snapshotTree);
  for (;;) {
    await sleep(quietMs);
    const current = roots.map(snapshotTree);
    const settled = current.every((snap, i) => {
      const diff = diffSnapshots(previous[i], snap);
      return diff.added.length + diff.removed.length + diff.changed.length === 0;
    });
    if (settled) return;
    if (Date.now() > deadline) throw new Error("background writes never settled");
    previous = current;
  }
}

function emptyDiff(label, a, b) {
  assert.deepEqual(diffSnapshots(a, b), { added: [], removed: [], changed: [] }, `${label} unchanged`);
}

// The engine of (a)-(c): neo on, 12 stored captures, KNOWLEDGE.md without a
// cache, a due reminder (table row and pending file), a pending skill
// proposal past the weekly gate, a start notice.
//
// Merging (an LLM route through the host runtime), GC and a persisting
// embedding cache (under baseDbPath, so the snapshots cover it) are on, so
// "no LLM call" and "nothing on disk" do not hold merely by configuration.
async function seededEngine() {
  const stateDir = makeTempDir("t9-state-");
  const baseDbPath = join(makeTempDir("t9-root-"), "lancedb-namespaced");
  const workspace = join(stateDir, "workspaces", AGENT);
  mkdirSync(join(workspace, "memory"), { recursive: true });
  const llmCalls = [];
  const hostEvents = [];
  const llm = { complete: async (...args) => { llmCalls.push(args); throw new Error("no llm in this test"); } };
  const host = createStubHost({
    stateDir,
    workspaceDir: async () => workspace,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    llm,
    runtime: { llm },
    events: { emit: (name, payload) => hostEvents.push({ name, payload }) },
  });
  const embeddings = recordingEmbedder({ cacheBasePath: baseDbPath });
  const reranker = recordingReranker();
  const engine = createEngine(host, config(baseDbPath, {
    merging: { enabled: true },
    gc: { enabled: true },
    runtime: { recallTimeoutMs: 10_000, embeddingCachePersist: true },
  }), { internals: { embeddings, reranker } });
  const internals = internalsOf(engine);
  for (const [i, fact] of FACTS.entries()) {
    const outcome = await engine.capture({
      agentId: AGENT,
      principal,
      agent,
      runId: `run-${i}`,
      messages: [{ role: "user", content: fact }, { role: "assistant", content: "Noted, I will keep that in mind." }],
      sessionKey: `agent:${AGENT}:main`,
      incognito: false,
      signal: AbortSignal.timeout(20_000),
    }).done;
    assert.equal(outcome.reason, undefined, `capture ${i} not skipped: ${outcome.reason}`);
  }
  writeFileSync(join(workspace, "memory", "KNOWLEDGE.md"), "# Knowledge\n\n## Roadmap review\n\nThe roadmap review is the fortnightly planning meeting of the platform team.\n\n## Release train\n\nReleases leave every Thursday after the roadmap review has signed them off.\n");
  await internals.pool.withWriteDb(AGENT, async (db) => {
    await db.init();
    await saveReminder(db, { text: "send the roadmap review minutes", remindAt: Date.now() - 60_000, agentId: AGENT, workspaceKey: workspace, embeddings });
  });
  await addPendingReminder(workspace, workspace, AGENT, { id: "r-pending", text: "book the room for the roadmap review", remindAt: 1 });
  const ledgerDir = internals.skillLedgerDirForAgent(AGENT);
  assert.ok(ledgerDir, "the agent has a skill ledger directory");
  writeProposal(ledgerDir, { id: "p-1", skillName: "roadmap-review-prep", status: "pending_review", description: "Prepare the roadmap review agenda.", createdAt: new Date().toISOString() });
  writePlur1busStartNotice(stateDir);
  const neoRoot = internals.neoRoot;
  const roots = { stateDir, baseDbPath, workspace, neoRoot };
  await waitForQuiet(Object.values(roots));
  // Let the compactor finish any check the seeded writes scheduled.
  await internals.fragmentCompactor.check(AGENT);
  assert.ok(existsSync(join(baseDbPath, "embedding-cache-v2")), "the seeding filled the persistent embedding cache");
  return { engine, internals, host, embeddings, reranker, llmCalls, hostEvents, roots, workspace };
}

// Counts the lease calls on the private and shared pools.
function spyLeases(internals) {
  const counts = { withWriteDb: 0, withReadDbs: 0, withReadOnlyReadDbs: 0, withWorkspaceReadDb: 0, withUserReadDb: 0 };
  const restorers = [];
  const wrap = (target, name) => {
    const original = target[name];
    target[name] = function (...args) { counts[name] += 1; return original.apply(this, args); };
    restorers.push(() => { target[name] = original; });
  };
  for (const name of ["withWriteDb", "withReadDbs", "withReadOnlyReadDbs"]) wrap(internals.pool, name);
  for (const name of ["withWorkspaceReadDb", "withUserReadDb"]) wrap(internals.sharedMemoryPool, name);
  return { counts, restore: () => { for (const r of restorers) r(); } };
}

function snapshotAll(roots) {
  return Object.fromEntries(Object.entries(roots).map(([name, root]) => [name, snapshotTree(root)]));
}

// Counts every compaction touch during the warm recall: a noted write, a
// fragment count (the stats connection) and an optimize.
function spyCompaction(internals) {
  const counts = { noteWrite: 0, fragmentCount: 0, optimizeTable: 0 };
  const compactor = internals.fragmentCompactor;
  const adapter = internals.memoryDbAdapter;
  const originals = { noteWrite: compactor.noteWrite, fragmentCount: adapter.fragmentCount, optimizeTable: adapter.optimizeTable };
  compactor.noteWrite = (...args) => { counts.noteWrite += 1; return originals.noteWrite(...args); };
  adapter.fragmentCount = (...args) => { counts.fragmentCount += 1; return originals.fragmentCount.apply(adapter, args); };
  adapter.optimizeTable = (...args) => { counts.optimizeTable += 1; return originals.optimizeTable.apply(adapter, args); };
  return { counts, restore: () => Object.assign(compactor, { noteWrite: originals.noteWrite }) && Object.assign(adapter, { fragmentCount: originals.fragmentCount, optimizeTable: originals.optimizeTable }) };
}

describe("RecallQuery.warmOnly (E5 Task 9)", () => {
  it("a warm-only recall changes nothing on disk", async () => {
    const seeded = await seededEngine();
    const { engine, internals, llmCalls, hostEvents, roots } = seeded;
    try {
      const completed = [];
      const subscription = engine.events.on("recall.completed", (payload) => completed.push(payload));
      const before = snapshotAll(roots);
      const llmBefore = llmCalls.length;
      const eventsBefore = hostEvents.length;
      const spy = spyCompaction(internals);
      const result = await engine.recall({ query: QUERY, principal, agent, signal: new AbortController().signal, warmOnly: true });
      // A query past the pipeline's summarizer limit: the real path would
      // hand it to the query summarizer (an LLM call through merging).
      const long = await engine.recall({ query: `${QUERY} ${"and the planning details ".repeat(900)}`, principal, agent, signal: new AbortController().signal, warmOnly: true });
      spy.restore();
      assert.deepEqual(result.blocks, []);
      assert.equal(result.degraded, null);
      assert.deepEqual(long.blocks, []);
      assert.equal(long.degraded, null);
      // Anything a warm recall scheduled in the background would land here.
      await sleep(300);
      const after = snapshotAll(roots);
      for (const name of Object.keys(roots)) emptyDiff(name, before[name], after[name]);
      assert.equal(llmCalls.length - llmBefore, 0, "no LLM call");
      assert.deepEqual(hostEvents.slice(eventsBefore), [], "no host event");
      assert.equal(completed.length, 0, "no recall.completed");
      assert.deepEqual(spy.counts, { noteWrite: 0, fragmentCount: 0, optimizeTable: 0 }, "no compaction bookkeeping");
      subscription.dispose();
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("a warm-only recall runs the heavy path", async () => {
    const { engine, internals, embeddings, reranker, workspace } = await seededEngine();
    try {
      const queriesBefore = embeddings.calls.embedQuery.length;
      const embedsBefore = embeddings.calls.embed.length;
      const rerankBefore = reranker.calls.length;
      const leases = spyLeases(internals);
      const result = await engine.recall({ query: QUERY, principal, agent, signal: new AbortController().signal, warmOnly: true });
      leases.restore();
      assert.equal(result.degraded, null);
      assert.deepEqual(result.blocks, []);
      // Read-only leases only: a full recall takes withWriteDb + withReadDbs.
      assert.deepEqual(
        [leases.counts.withWriteDb, leases.counts.withReadDbs, leases.counts.withReadOnlyReadDbs, leases.counts.withWorkspaceReadDb],
        [0, 0, 1, 1],
        `leases ${JSON.stringify(leases.counts)}`,
      );
      const queries = embeddings.calls.embedQuery.slice(queriesBefore);
      assert.ok(textsOf(queries).filter((q) => q === QUERY).length >= 2, `embedQuery for the neo prelude and the pipeline: ${JSON.stringify(textsOf(queries))}`);
      // The canonical search embedded both KNOWLEDGE.md sections, and its
      // cache was not written.
      const embeds = textsOf(embeddings.calls.embed.slice(embedsBefore));
      assert.ok(embeds.some((t) => t.includes("fortnightly planning meeting")), `section embeds: ${JSON.stringify(embeds)}`);
      assert.ok(embeds.some((t) => t.includes("Releases leave every Thursday")), `section embeds: ${JSON.stringify(embeds)}`);
      assert.equal(existsSync(join(workspace, ".adaptive-learning", "knowledge-cache.json")), false, "no canonical cache file");
      // E5 R26: every warm embed is memory-only.
      for (const call of [...queries, ...embeddings.calls.embed.slice(embedsBefore)]) {
        assert.equal(call.options?.persist, false, `warm embed of ${JSON.stringify(call.text.slice(0, 40))} is memory-only`);
      }
      // The reranker saw the stored rows, not an empty table.
      const reranks = reranker.calls.slice(rerankBefore);
      assert.equal(reranks.length, 1, "the reranker ran once");
      assert.equal(reranks[0].query, QUERY);
      assert.ok(reranks[0].count > 0, `reranked ${reranks[0].count} rows`);
      const phases = result.timing.phases.completed.map((c) => c.phase);
      for (const phase of ["queue", "prelude", "namespace-recall"]) assert.ok(phases.includes(phase), `phase ${phase} in ${phases.join(",")}`);
      assert.ok(result.timing.totalMs > 0);
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("a warm-only recall leaves the next real recall intact", async () => {
    const { engine, embeddings, llmCalls } = await seededEngine();
    try {
      await engine.recall({ query: QUERY, principal, agent, signal: new AbortController().signal, warmOnly: true });
      const queriesBefore = embeddings.calls.embedQuery.length;
      const embedsBefore = embeddings.calls.embed.length;
      const llmBefore = llmCalls.length;
      const result = await engine.recall({ query: QUERY, principal, agent, signal: new AbortController().signal });
      assert.equal(result.degraded, null);
      const names = result.blocks.filter((b) => b.text).map((b) => b.name);
      for (const name of ["neo", "start", "reminder"]) assert.ok(names.includes(name), `block ${name} in ${names.join(",")}`);
      const realCalls = [...embeddings.calls.embedQuery.slice(queriesBefore), ...embeddings.calls.embed.slice(embedsBefore)];
      assert.ok(embeddings.calls.embedQuery.length > queriesBefore, "the real recall embedded the query again (not served from the recall cache)");
      for (const call of realCalls) assert.notEqual(call.options?.persist, false, "a real recall's embeds may persist");
      // The same LLM spy the warm tests read sees the real path's calls.
      assert.ok(llmCalls.length > llmBefore, "the real recall reaches the LLM spy");
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("warming an agent without a table creates nothing", async () => {
    const stateDir = makeTempDir("t9-d-state-");
    const baseDbPath = join(makeTempDir("t9-d-root-"), "lancedb-namespaced");
    const workspace = makeTempDir("t9-d-ws-");
    const host = createStubHost({ stateDir, workspaceDir: async () => workspace, logger: { info() {}, warn() {}, error() {}, debug() {} } });
    const engine = createEngine(host, config(baseDbPath, { neo: { enabled: false } }), { internals: { embeddings: recordingEmbedder() } });
    try {
      const before = snapshotTree(baseDbPath);
      const result = await engine.recall({ query: QUERY, principal: { ...principal, agentId: "agent-new" }, agent, signal: new AbortController().signal, warmOnly: true });
      assert.equal(result.degraded, null);
      assert.deepEqual(result.blocks, []);
      emptyDiff("baseDbPath", before, snapshotTree(baseDbPath));
      assert.equal(existsSync(join(baseDbPath, "agent-new")), false);
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("warming a workspace and user principal creates nothing (private or shared)", { skip: !stableDirectoryCapabilitiesSupported() }, async () => {
    const stateDir = makeTempDir("t9-e-state-");
    const baseDbPath = freshBaseDbPath("t9-e-");
    const { host } = twoWorkspaceHost(stateDir);
    const engine = createEngine(host, sharedConfig(baseDbPath), { internals: { embeddings: sharedFlatEmbedder() } });
    try {
      const root = dirname(baseDbPath);
      const before = snapshotTree(root);
      const leases = spyLeases(internalsOf(engine));
      const result = await engine.recall({ query: QUERY, principal: sharedPrincipal("anna", { user: USER_PRINCIPAL }), agent, signal: new AbortController().signal, warmOnly: true });
      leases.restore();
      assert.equal(result.degraded, null);
      assert.equal(leases.counts.withWorkspaceReadDb, 1, "the workspace read lease was taken");
      assert.equal(leases.counts.withUserReadDb, 1, "the user read lease was taken");
      // Neither anna's private directory nor a shared root appears.
      emptyDiff("the store root", before, snapshotTree(root));
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("warm-only honours abort and close", async () => {
    const stateDir = makeTempDir("t9-f-state-");
    const workspace = makeTempDir("t9-f-ws-");
    const hostEvents = [];
    const host = createStubHost({
      stateDir,
      workspaceDir: async () => workspace,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      events: { emit: (name, payload) => hostEvents.push({ name, payload }) },
    });
    const engine = createEngine(host, config(join(makeTempDir("t9-f-root-"), "lancedb-namespaced"), { neo: { enabled: false } }), { internals: { embeddings: recordingEmbedder() } });
    const controller = new AbortController();
    controller.abort(new Error("caller gave up"));
    const aborted = await engine.recall({ query: QUERY, principal, agent, signal: controller.signal, warmOnly: true });
    assert.equal(aborted.degraded?.reason, "aborted");
    assert.deepEqual(hostEvents, [], "an aborted warm recall emits nothing");
    await engine.close({ budgetMs: 5_000 });
    const closed = await engine.recall({ query: QUERY, principal, agent, signal: new AbortController().signal, warmOnly: true });
    assert.equal(closed.degraded?.reason, "engine-closed");
  });

  it("a warm-only recall aborted mid-flight answers aborted and emits nothing", async () => {
    const workspace = makeTempDir("t9-g-ws-");
    const hostEvents = [];
    const host = createStubHost({
      stateDir: makeTempDir("t9-g-state-"),
      workspaceDir: async () => workspace,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      events: { emit: (name, payload) => hostEvents.push({ name, payload }) },
    });
    const controller = new AbortController();
    // The caller gives up while the pipeline embeds the query.
    const embeddings = recordingEmbedder({
      onEmbedQuery: (_text, options) => new Promise((_, reject) => {
        const signal = options?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        controller.abort(new Error("caller gave up"));
      }),
    });
    const baseDbPath = join(makeTempDir("t9-g-root-"), "lancedb-namespaced");
    const engine = createEngine(host, config(baseDbPath, { neo: { enabled: false } }), { internals: { embeddings } });
    try {
      // A table to search, so the warm path reaches the pipeline's embed.
      await internalsOf(engine).pool.withWriteDb(AGENT, async (db) => {
        await db.init();
        await db.store({ text: "The roadmap review is on Tuesday.", vector: vector(), category: "fact", createdAt: Date.now(), storedBy: AGENT });
      });
      const completed = [];
      const subscription = engine.events.on("recall.completed", (payload) => completed.push(payload));
      const result = await engine.recall({ query: QUERY, principal, agent, signal: controller.signal, warmOnly: true });
      subscription.dispose();
      assert.ok(embeddings.calls.embedQuery.length >= 1, "the abort landed inside the embed");
      assert.equal(result.degraded?.reason, "aborted");
      assert.deepEqual(result.blocks, []);
      assert.deepEqual(hostEvents, [], "no host event");
      assert.equal(completed.length, 0, "no recall.completed");
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });
});

describe("createNeoStore readOnly (E5 Task 9)", () => {
  it("createNeoStore readOnly skips the stale temp cleanup", () => {
    const root = makeTempDir("t9-h-neo-");
    // Resolve the workspace directory the store uses, then plant a stale
    // `<file>.<pid>.<ts>.tmp` (NEO_STALE_TMP_RE) two days old.
    const { workspaceDir } = createNeoStore(root, "ws-h", { readOnly: true }).paths;
    mkdirSync(workspaceDir, { recursive: true });
    const stale = join(workspaceDir, "memory-candidates.jsonl.4242.1700000000000.tmp");
    writeFileSync(stale, "partial");
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(stale, twoDaysAgo, twoDaysAgo);
    createNeoStore(root, "ws-h", { readOnly: true });
    assert.equal(existsSync(stale), true, "a read-only store leaves the stale temp file");
    createNeoStore(root, "ws-h");
    assert.equal(existsSync(stale), false, "a normal store removes it");
  });
});

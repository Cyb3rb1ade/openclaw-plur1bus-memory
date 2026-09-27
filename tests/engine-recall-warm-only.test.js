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
import { dirname, join, sep } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { stableDirectoryCapabilitiesSupported } from "../lib/directory-capability.js";
import { createStubHost } from "../lib/host-services.js";
import { createNeoStore } from "../lib/neo-arch.js";
import { writeProposal } from "../lib/jobs/skill-miner/proposal-writer.js";
import { addPendingReminder } from "../lib/reminder-pending.js";
import { saveReminder } from "../lib/reminder-store.js";
import { writePlur1busStartNotice } from "../lib/setup/feature-profiles.js";
import { SHARED_ROOT_SEGMENT } from "../lib/shared-memory-pool.js";
import { diffSnapshots, snapshotTree } from "./helpers/fs-snapshot.js";
import {
  config as sharedConfig,
  flatEmbedder as sharedFlatEmbedder,
  freshBaseDbPath,
  principal as sharedPrincipal,
  twoWorkspaceHost,
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

// Records every call; a fixed vector, so every stored row and every neo
// candidate matches every query.
function recordingEmbedder() {
  const calls = { embedQuery: [], embed: [] };
  const embedder = {
    calls,
    embedQuery: async (text) => { calls.embedQuery.push(String(text)); return vector(); },
    embed: async (text) => { calls.embed.push(String(text)); return vector(); },
    embedPassage: async () => vector(),
    embedBatch: async (texts) => texts.map(vector),
    shutdown: async () => {},
  };
  return embedder;
}

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
async function seededEngine() {
  const stateDir = makeTempDir("t9-state-");
  const baseDbPath = join(makeTempDir("t9-root-"), "lancedb-namespaced");
  const workspace = join(stateDir, "workspaces", AGENT);
  mkdirSync(join(workspace, "memory"), { recursive: true });
  const llmCalls = [];
  const hostEvents = [];
  const host = createStubHost({
    stateDir,
    workspaceDir: async () => workspace,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    llm: { complete: async (...args) => { llmCalls.push(args); throw new Error("no llm in this test"); } },
    events: { emit: (name, payload) => hostEvents.push({ name, payload }) },
  });
  const embeddings = recordingEmbedder();
  const reranker = recordingReranker();
  const engine = createEngine(host, config(baseDbPath), { internals: { embeddings, reranker } });
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
  return { engine, internals, host, embeddings, reranker, llmCalls, hostEvents, roots, workspace };
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
      spy.restore();
      assert.deepEqual(result.blocks, []);
      assert.equal(result.degraded, null);
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
    const { engine, embeddings, reranker } = await seededEngine();
    try {
      const queriesBefore = embeddings.calls.embedQuery.length;
      const rerankBefore = reranker.calls.length;
      const result = await engine.recall({ query: QUERY, principal, agent, signal: new AbortController().signal, warmOnly: true });
      assert.equal(result.degraded, null);
      assert.deepEqual(result.blocks, []);
      const queries = embeddings.calls.embedQuery.slice(queriesBefore);
      assert.ok(queries.filter((q) => q === QUERY).length >= 2, `embedQuery for the neo prelude and the pipeline: ${JSON.stringify(queries)}`);
      assert.equal(reranker.calls.length - rerankBefore, 1, "the reranker ran once");
      const phases = result.timing.phases.completed.map((c) => c.phase);
      for (const phase of ["queue", "prelude", "namespace-recall"]) assert.ok(phases.includes(phase), `phase ${phase} in ${phases.join(",")}`);
      assert.ok(result.timing.totalMs > 0);
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("a warm-only recall leaves the next real recall intact", async () => {
    const { engine, embeddings } = await seededEngine();
    try {
      await engine.recall({ query: QUERY, principal, agent, signal: new AbortController().signal, warmOnly: true });
      const queriesBefore = embeddings.calls.embedQuery.length;
      const result = await engine.recall({ query: QUERY, principal, agent, signal: new AbortController().signal });
      assert.equal(result.degraded, null);
      const names = result.blocks.filter((b) => b.text).map((b) => b.name);
      for (const name of ["neo", "start", "reminder"]) assert.ok(names.includes(name), `block ${name} in ${names.join(",")}`);
      assert.ok(embeddings.calls.embedQuery.length > queriesBefore, "the real recall embedded the query again (not served from the recall cache)");
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

  it("warming a workspace principal does not create the shared root", { skip: !stableDirectoryCapabilitiesSupported() }, async () => {
    const stateDir = makeTempDir("t9-e-state-");
    const baseDbPath = freshBaseDbPath("t9-e-");
    const { host } = twoWorkspaceHost(stateDir);
    const engine = createEngine(host, sharedConfig(baseDbPath), { internals: { embeddings: sharedFlatEmbedder() } });
    try {
      const result = await engine.recall({ query: QUERY, principal: sharedPrincipal("anna"), agent, signal: new AbortController().signal, warmOnly: true });
      assert.equal(result.degraded, null);
      const shared = [...snapshotTree(dirname(baseDbPath)).keys()].filter((path) => path.split(sep).includes(SHARED_ROOT_SEGMENT));
      assert.deepEqual(shared, [], "no shared root");
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

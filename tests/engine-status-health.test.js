/**
 * tests/engine-status-health.test.js — E4 Task 4: Engine.status() assembles
 * ledger-derived job health, model readiness, an optional host journal
 * backlog and shared-memory support, and never rejects.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { createStatusReporter, degradedFromModels, normalizeJournalBacklog, JOURNAL_BACKLOG_TIMEOUT_MS } from "../engine/status/status-reporter.js";
import { createStubHost } from "../lib/host-services.js";
import { stableDirectoryCapabilitiesSupported } from "../lib/directory-capability.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const baseConfig = (baseDbPath) => ({
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: true, autoRecall: true,
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  runtime: { recallTimeoutMs: 10_000 },
});

// 384-dim embedder stub used everywhere below; a fixed vector is enough for
// probe() to succeed instantly.
function flatEmbedder() {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  const one = async () => vector();
  return { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (texts) => texts.map(vector), shutdown: async () => {} };
}

function flatReranker() {
  return { rerank: async () => [{ index: 0, score: 0.9 }] };
}

function stubHost(stateDir, { capabilities } = {}) {
  return createStubHost({
    stateDir,
    workspaceDir: async (agentId) => {
      const { mkdirSync } = await import("node:fs");
      const dir = join(stateDir, "workspaces", agentId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    ...(capabilities ? { capabilities } : {}),
  });
}

function setupEngine(prefix, { capabilities, reranker = flatReranker() } = {}) {
  const stateDir = makeTempDir(`${prefix}state-`);
  const baseDbPath = join(makeTempDir(`${prefix}root-`), "lancedb-namespaced");
  const engine = createEngine(stubHost(stateDir, { capabilities }), baseConfig(baseDbPath), {
    internals: { embeddings: flatEmbedder(), reranker },
  });
  return { engine, baseDbPath };
}

describe("Engine.status() (E4 Task 4)", () => {
  it("(a) status carries jobs, models, journal and shared-memory support", async () => {
    const { engine } = setupEngine("e4-status-a-");
    const s = await engine.status();
    for (const key of ["jobs", "models", "journal", "sharedMemory"]) assert.ok(key in s, `missing ${key}`);
    assert.equal(s.journal, null);
    assert.deepEqual(s.degraded, { reason: "models-warming", capability: "embedding" });

    await engine.models.warm();
    const after = await engine.status();
    assert.equal(after.degraded, null);

    const expectedShared = stableDirectoryCapabilitiesSupported()
      ? { supported: true, mode: "fd-capability" }
      : { supported: false, mode: "unavailable", reason: "platform" };
    assert.deepEqual(after.sharedMemory, expectedShared);
    await engine.close();
  });

  it("(b) status reflects a job run", async () => {
    const { engine } = setupEngine("e4-status-b-");
    const run = await engine.jobs.run("gc-run", "agent-a");
    const s = await engine.status();
    const agent = s.jobs.agents.find((a) => a.agentId === "agent-a");
    assert.ok(agent, "agent-a is present in jobs.agents");
    assert.equal(agent.lastRuns["gc-run"].outcome, run.outcome);
    assert.equal(agent.breaker.limit, 3);
    await engine.close();
  });

  it("(c) status reports the host journal backlog", async () => {
    let capability = () => ({ entries: 3, oldestAt: 1_000, extra: "x" });
    const { engine } = setupEngine("e4-status-c-", { capabilities: { journalBacklog: (...args) => capability(...args) } });

    const s1 = await engine.status();
    assert.deepEqual(s1.journal, { entries: 3, oldestAt: 1_000 });

    capability = async () => ({ entries: -1, oldestAt: null });
    const s2 = await engine.status();
    assert.equal(s2.journal, null);

    capability = () => { throw new Error("boom"); };
    const s3 = await engine.status();
    assert.equal(s3.journal, null);

    capability = () => new Promise(() => {}); // never settles
    const t0 = performance.now();
    const s4 = await engine.status();
    assert.equal(s4.journal, null);
    assert.ok(performance.now() - t0 < 100, "status() must resolve well inside its 100 ms budget");

    await engine.close();
  });

  it("a host journalBacklog() returning null is a valid \"no backlog\" answer, not an invalid shape", async () => {
    const debugLines = [];
    const stateDir = makeTempDir("e4-status-c-null-state-");
    const baseDbPath = join(makeTempDir("e4-status-c-null-root-"), "lancedb-namespaced");
    const engine = createEngine(
      createStubHost({
        stateDir,
        workspaceDir: async (agentId) => {
          const { mkdirSync } = await import("node:fs");
          const dir = join(stateDir, "workspaces", agentId);
          mkdirSync(dir, { recursive: true });
          return dir;
        },
        logger: { info() {}, warn() {}, error() {}, debug: (m) => debugLines.push(String(m)) },
        capabilities: { journalBacklog: () => null },
      }),
      baseConfig(baseDbPath),
      { internals: { embeddings: flatEmbedder(), reranker: flatReranker() } },
    );
    const s = await engine.status();
    assert.equal(s.journal, null);
    assert.ok(!debugLines.some((line) => line.includes("invalid shape")), `unexpected log: ${JSON.stringify(debugLines)}`);
    await engine.close();
  });

  it("(d) degraded follows the model states (unit, degradedFromModels)", () => {
    const readiness = (state) => ({ state, warming: false, checkedAt: state === "loading" ? null : 1 });
    assert.deepEqual(
      degradedFromModels({ embedder: { ...readiness("failed"), error: "provider-failed" }, reranker: readiness("loading") }),
      { reason: "model-failed", capability: "embedding" },
    );
    assert.deepEqual(
      degradedFromModels({ embedder: readiness("ready"), reranker: { ...readiness("failed"), error: "invalid-result" } }),
      { reason: "model-failed", capability: "reranker" },
    );
    assert.deepEqual(
      degradedFromModels({ embedder: readiness("ready"), reranker: readiness("loading") }),
      { reason: "models-warming", capability: "reranker" },
    );
    assert.equal(
      degradedFromModels({ embedder: readiness("ready"), reranker: { state: "disabled", warming: false, checkedAt: null } }),
      null,
    );
  });

  it("JOURNAL_BACKLOG_TIMEOUT_MS is the 50 ms cap from the global constraint", () => {
    assert.equal(JOURNAL_BACKLOG_TIMEOUT_MS, 50);
  });

  it("normalizeJournalBacklog validates entries/oldestAt and drops other keys", () => {
    assert.deepEqual(normalizeJournalBacklog({ entries: 3, oldestAt: 1_000, extra: "x" }), { entries: 3, oldestAt: 1_000 });
    assert.deepEqual(normalizeJournalBacklog({ entries: 0, oldestAt: null }), { entries: 0, oldestAt: null });
    assert.equal(normalizeJournalBacklog({ entries: -1, oldestAt: null }), null);
    assert.equal(normalizeJournalBacklog({ entries: 1.5, oldestAt: null }), null);
    assert.equal(normalizeJournalBacklog({ entries: 1, oldestAt: NaN }), null);
    assert.equal(normalizeJournalBacklog(null), null);
    assert.equal(normalizeJournalBacklog("nope"), null);
  });

  it("(e) status never rejects and still answers after close", async () => {
    // Unit level: the registry itself is frozen (never throws in practice),
    // so a throwing `jobs.health()` is exercised directly against the reporter.
    const reporter = createStatusReporter({
      jobs: { health: () => { throw new Error("x"); } },
      models: { status: () => ({ embedder: { state: "ready", warming: false, checkedAt: 1, identity: {} }, reranker: { state: "disabled", warming: false, checkedAt: null, provider: null } }) },
      sharedMemoryPool: { support: () => ({ supported: false, mode: "unavailable", reason: "platform" }) },
      storeMigrator: { current: () => "1" },
      expectedSchema: "1",
      openedAgents: new Set(),
      host: { logger: { debug() {} } },
      contract: "1.8.0",
    });
    const unitStatus = await reporter.status();
    assert.deepEqual(unitStatus.jobs, { ledger: "unavailable", agents: [] });

    const { engine } = setupEngine("e4-status-e-");
    await engine.close();
    const s = await engine.status();
    assert.equal(s.contract, "1.8.0");
  });

  it("(f) status does not create shared or job directories", async () => {
    const { engine, baseDbPath } = setupEngine("e4-status-f-");
    await engine.status();
    await engine.status();
    assert.equal(existsSync(join(baseDbPath, "_jobs")), false);
    assert.equal(existsSync(join(baseDbPath, ".plur1bus-shared")), false);
    await engine.close();
  });
});

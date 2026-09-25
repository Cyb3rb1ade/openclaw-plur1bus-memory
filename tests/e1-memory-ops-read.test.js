/**
 * tests/e1-memory-ops-read.test.js — E1 Task 4: Engine.memory.list / .show.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tombstoneRegistryDir } from "../lib/tombstone.js";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
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

// engine.memory.forget writes an audit line under `<workspaceDir>/.adaptive-learning`
// (lib/sql-safety.js's appendDestructiveOpLog) and fails closed when
// workspaceDir is falsy — createStubHost's default `workspaceDir` resolves to
// `undefined`. A real, writable per-agent path is needed for case (d); a
// claimed `workspace` identity would conflict with the canonical identity
// that real directory resolves to (engine/identity/principal.js), so this
// principal leaves `workspace` unclaimed (same as tests/e1-memory-ops-write.test.js).
function stubHostForDestructiveOps(stateDir) {
  return createStubHost({
    stateDir,
    workspaceDir: async (agentId) => {
      const dir = join(stateDir, "workspaces", agentId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  });
}
function principalForDestructive(agentId) {
  return { agentId, channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" };
}

const agent = { origin: "user", background: false };

async function seed(engine, agentId, text, principalFactory = principalFor) {
  const principal = principalFactory(agentId);
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

// Direct row mutation, the way tests/gc-superseded-scan.test.js seeds
// non-active statuses: through the engine's own write pool, never a second
// capture (a status/createdAt change is not something MemoryOps writes yet).
async function patchRow(engine, agentId, id, patch) {
  await internalsOf(engine).pool.withDb(agentId, (db) => db.update(id, patch));
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

  it("(d) show(id) is not-found after engine.memory.forget(id)", async () => {
    const host = stubHostForDestructiveOps(makeTempDir("e1-read-state-"));
    // A forget test's baseDbPath must nest under its OWN fresh root, not
    // directly under the shared OS tmp dir: the tombstone registry lives
    // beside baseDbPath's PARENT (lib/tombstone.js), keyed only by agentId —
    // see tests/e1-memory-ops-write.test.js's freshBaseDbPath for the full
    // rationale.
    const engine = createEngine(host, { ...config(join(makeTempDir("e1-read-db-root-"), "lancedb-namespaced")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-d";
    await seed(engine, agentId, "The garage door code was changed last week to 4471.", principalForDestructive);

    const principal = principalForDestructive(agentId);
    const listed = await engine.memory.list({ topic: "garage door code" }, principal, agent);
    assert.ok(listed.items.length >= 1);
    const id = listed.items[0].id;

    const forgotten = await engine.memory.forget(id, principal, agent);
    assert.equal(forgotten.archived, true);

    await assert.rejects(
      () => engine.memory.show(id, principal, agent),
      (err) => err.code === "not-found",
    );

    await engine.close({ budgetMs: 5_000 });
  });

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

  it("(g) show(id) is not-found once the card is archived (fix round 1, anti-oracle)", async () => {
    const host = createStubHost({ stateDir: makeTempDir("e1-read-state-") });
    const engine = createEngine(host, { ...config(makeTempDir("e1-read-db-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-g";
    await seed(engine, agentId, "The archived note about the old printer driver is no longer needed.");

    const principal = principalFor(agentId);
    const listed = await engine.memory.list({ topic: "printer driver" }, principal, agent);
    assert.ok(listed.items.length >= 1);
    const id = listed.items[0].id;

    // GC's own archival path (lib/garbage-collector.js) sets exactly this
    // status. The patch goes through the engine's own write pool, a separate
    // LanceDB connection from memoryDbAdapter's cached read table, so show()
    // is not called before the patch (that would cache the pre-patch table).
    await patchRow(engine, agentId, id, { status: "archived" });
    await assert.rejects(
      () => engine.memory.show(id, principal, agent),
      (err) => err.code === "not-found",
    );

    await engine.close({ budgetMs: 5_000 });
  });

  it("(h) show(id) is not-found once the card is superseded (fix round 1, anti-oracle)", async () => {
    const host = createStubHost({ stateDir: makeTempDir("e1-read-state-") });
    const engine = createEngine(host, { ...config(makeTempDir("e1-read-db-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-h";
    await seed(engine, agentId, "The old office address was 12 Baker Street before the move.");

    const principal = principalFor(agentId);
    const listed = await engine.memory.list({ topic: "office address" }, principal, agent);
    assert.ok(listed.items.length >= 1);
    const id = listed.items[0].id;

    // /correct's own supersede path (lib/safe-update.js, lib/db-adapter.js)
    // sets exactly this status. As in (g), show() is not called before the
    // patch — memoryDbAdapter's table cache must not observe the pre-patch row.
    await patchRow(engine, agentId, id, { status: "superseded" });
    await assert.rejects(
      () => engine.memory.show(id, principal, agent),
      (err) => err.code === "not-found",
    );

    await engine.close({ budgetMs: 5_000 });
  });

  it("(i) list({ since }) honours an explicit epoch bound past the legacy 30-day window (fix round 1)", async () => {
    const host = createStubHost({ stateDir: makeTempDir("e1-read-state-") });
    const engine = createEngine(host, { ...config(makeTempDir("e1-read-db-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-i";
    await seed(engine, agentId, "Ninety days ago the team migrated the old ticketing system.");

    const principal = principalFor(agentId);
    const listed = await engine.memory.list({ topic: "ticketing system" }, principal, agent);
    assert.ok(listed.items.length >= 1);
    const id = listed.items[0].id;

    const ninetyDaysAgo = Date.now() - 90 * 86_400_000;
    await patchRow(engine, agentId, id, { createdAt: ninetyDaysAgo });

    const includesIt = await engine.memory.list({ since: Date.now() - 100 * 86_400_000 }, principal, agent);
    assert.ok(includesIt.items.some((c) => c.id === id), "a since 100 days back reaches a 90-day-old fact");

    const excludesIt = await engine.memory.list({ since: Date.now() - 60 * 86_400_000 }, principal, agent);
    assert.ok(!excludesIt.items.some((c) => c.id === id), "a since 60 days back excludes a 90-day-old fact");

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

describe("Engine.memory.state (E1 Task 7)", () => {
  it("counts live agent-private cards, drops a forgotten one, and reports the tombstone", async () => {
    const stateDir = makeTempDir("e1-state-state-");
    const host = stubHostForDestructiveOps(stateDir);
    const engine = createEngine(
      host,
      { ...config(join(makeTempDir("e1-state-db-root-"), "lancedb-namespaced")), autoCapture: true },
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-state";
    await seed(engine, agentId, "The spare key is hidden under the third flowerpot on the porch.", principalForDestructive);
    await seed(engine, agentId, "The Wi-Fi router needs a reboot every couple of weeks.", principalForDestructive);

    const principal = principalForDestructive(agentId);

    const before = await engine.memory.state(principal, agent);
    assert.equal(before.agentId, agentId);
    assert.equal(before.cards.agentPrivate, 2);
    // No workspace/user principal claimed (principalForDestructive), so both
    // shared pools are unreachable for this principal, never counted as 0.
    assert.equal(before.cards.workspace, null);
    assert.equal(before.cards.user, null);
    assert.equal(before.tombstones, 0);
    assert.equal(before.archiveDir, join(stateDir, "memory", "_archive"));

    const listed = await engine.memory.list({ topic: "spare key" }, principal, agent);
    assert.ok(listed.items.length >= 1);
    const id = listed.items[0].id;
    const forgotten = await engine.memory.forget(id, principal, agent);
    assert.equal(forgotten.archived, true);

    const after = await engine.memory.state(principal, agent);
    assert.equal(after.cards.agentPrivate, 1);
    assert.equal(after.tombstones, 1);

    await engine.close({ budgetMs: 5_000 });
  });

  it("(fix round 1, E1-R11) a row with status active and epistemicStatus invalidated is excluded by list AND state", async () => {
    const host = createStubHost({ stateDir: makeTempDir("e1-state-state-") });
    const engine = createEngine(host, { ...config(makeTempDir("e1-state-db-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-state-invalidated";
    await seed(engine, agentId, "The backup generator fuel needs topping up before winter.");
    await seed(engine, agentId, "The recycling pickup moved to Thursdays this month.");

    const principal = principalFor(agentId);
    const listedBefore = await engine.memory.list({ topic: "backup generator" }, principal, agent);
    assert.ok(listedBefore.items.length >= 1);
    const id = listedBefore.items[0].id;

    const beforeState = await engine.memory.state(principal, agent);
    assert.equal(beforeState.cards.agentPrivate, 2);

    // status stays "active" — only epistemicStatus flips to "invalidated".
    // isRecallEntryLive (lib/recall-pipeline.js) excludes this independently
    // of status, and state()'s SQL filter must mirror that NULL-safely.
    await patchRow(engine, agentId, id, { status: "active", epistemicStatus: "invalidated" });

    const listedAfter = await engine.memory.list({ topic: "backup generator" }, principal, agent);
    assert.ok(!listedAfter.items.some((c) => c.id === id), "list excludes the invalidated row");
    await assert.rejects(
      () => engine.memory.show(id, principal, agent),
      (err) => err.code === "not-found",
      "show excludes the invalidated row",
    );

    const afterState = await engine.memory.state(principal, agent);
    assert.equal(afterState.cards.agentPrivate, 1, "state's live count agrees with list/show");

    await engine.close({ budgetMs: 5_000 });
  });

  it("(fix round 1, E1-R11) tombstones is null when the registry is unreadable, not 0", async () => {
    const stateDir = makeTempDir("e1-state-state-");
    const host = stubHostForDestructiveOps(stateDir);
    const dbRoot = makeTempDir("e1-state-db-root-");
    const baseDbPath = join(dbRoot, "lancedb-namespaced");
    const engine = createEngine(host, { ...config(baseDbPath), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-state-badregistry";
    await seed(engine, agentId, "The attic insulation was replaced two summers ago.", principalForDestructive);

    const principal = principalForDestructive(agentId);

    // Puts a DIRECTORY where the registry reader expects this agent's
    // `<agentId>.jsonl` file (lib/tombstone.js's registryFile/
    // tombstoneRegistryDir): existsSync(file) sees it and readFileSync(file)
    // fails with EISDIR — a cheap, deterministic "registry unreadable"
    // without ever writing a corrupt tombstone line.
    mkdirSync(join(tombstoneRegistryDir(baseDbPath), `${agentId}.jsonl`), { recursive: true });

    const state = await engine.memory.state(principal, agent);
    assert.equal(state.tombstones, null);

    await engine.close({ budgetMs: 5_000 });
  });
});

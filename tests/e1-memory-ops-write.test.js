/**
 * tests/e1-memory-ops-write.test.js — E1 Task 5: Engine.memory.forget / .correct.
 * Also covers E1 Task 6: Engine.memory.share.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { readTombstonesFromRegistry } from "../lib/tombstone.js";

// The tombstone registry lives beside baseDbPath's PARENT directory
// (lib/tombstone.js's tombstoneRegistryDir: `dirname(baseDbPath)/_tombstones`,
// deliberately a sibling of the LanceDB root so a snapshot restore doesn't
// delete it). A baseDbPath made directly under the shared OS tmp root would
// put every test's registry in the same `<tmpdir>/_tombstones`, keyed only by
// agentId — cross-test/cross-run pollution for a reused agent id like
// "bernd". Each test therefore makes its own tmp root first and nests
// baseDbPath one level under it (same pattern as tests/tombstone.test.js).
function freshBaseDbPath(prefix) {
  return join(makeTempDir(`${prefix}root-`), "lancedb-namespaced");
}

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

// Same as principalFor, but without the `workspace` claim: a claimed
// workspace identity is checked against the canonical identity derived from
// the host's real `workspaceDir` (engine/identity/principal.js), and
// stubHostForDestructiveOps hands back a REAL directory (needed for the
// destructive-op audit log) — "workspace:v1:main" would conflict with the
// canonical identity that real directory resolves to. Leaving it unclaimed
// lets the canonical directory identity win.
function principalForDestructive(agentId) {
  return { agentId, channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" };
}

// forgetCard/correctCard write an audit line under `<workspaceDir>/.adaptive-learning`
// (lib/sql-safety.js's appendDestructiveOpLog) and fail closed ("audit_failed")
// when workspaceDir is falsy — createStubHost's default `workspaceDir` resolves
// to `undefined`. A per-agent path under stateDir gives every destructive test
// a real, writable directory.
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

// share's "second agent in the same workspace" case needs two agents whose
// canonical workspace identity is the SAME (lib/memory-request-context.js's
// resolveCanonicalWorkspacePrincipal derives it from host.workspaceDir's
// REAL directory when no explicit workspace claim is made). The stub host
// here hands every agent the identical real directory, so two distinct
// agentIds still resolve to one workspace pool key.
function stubHostForSharedWorkspace(stateDir) {
  const dir = join(stateDir, "workspaces", "shared-ws");
  mkdirSync(dir, { recursive: true });
  return createStubHost({ stateDir, workspaceDir: async () => dir });
}

const agent = { origin: "user", background: false };
const cronAgent = { origin: "cron", background: true };

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

async function seedAndGetId(engine, agentId, text, topic, principalFactory = principalFor) {
  await seed(engine, agentId, text, principalFactory);
  const principal = principalFactory(agentId);
  const listed = await engine.memory.list({ topic }, principal, agent);
  assert.ok(listed.items.length >= 1);
  return listed.items[0].id;
}

// Direct row mutation, the way tests/e1-memory-ops-read.test.js's patchRow
// seeds non-active statuses: through the engine's own write pool, never a
// second capture.
async function patchRow(engine, agentId, id, patch) {
  await internalsOf(engine).pool.withDb(agentId, (db) => db.update(id, patch));
}

// A raw, ACL-free read of exactly the row's current text/status, to assert a
// refused forget/correct left the card untouched.
async function rawCard(engine, agentId, id) {
  return internalsOf(engine).pool.withDb(agentId, (db) => db.getById(id));
}

describe("Engine.memory.forget / .correct (E1 Task 5)", () => {
  it("(a),(b),(h) forget archives the card, tombstones it, and is idempotent on a second call", async () => {
    const stateDir = makeTempDir("e1-write-state-");
    const baseDbPath = freshBaseDbPath("e1-write-");
    const host = stubHostForDestructiveOps(stateDir);
    const engine = createEngine(host, { ...config(baseDbPath), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "bernd";
    const id = await seedAndGetId(engine, agentId, "Bernd's spare key is hidden under the third flowerpot.", "spare key", principalForDestructive);

    const principal = principalForDestructive(agentId);

    // (a)
    const forgotten = await engine.memory.forget(id, principal, agent);
    assert.equal(forgotten.id, id);
    assert.equal(forgotten.archived, true);
    assert.equal(typeof forgotten.tombstoneId, "string");
    assert.ok(forgotten.tombstoneId.length > 0);
    assert.equal(forgotten.alreadyForgotten, false);

    const archiveAgentDir = join(stateDir, "memory", "_archive", agentId);
    assert.ok(existsSync(archiveAgentDir), "archive dir exists");
    assert.ok(readdirSync(archiveAgentDir).length >= 1, "an archive file was written");

    const listed = await engine.memory.list({ topic: "spare key" }, principal, agent);
    assert.ok(!listed.items.some((c) => c.id === id), "forgotten card no longer listed");

    // (b) forgetting twice is idempotent, no throw
    const forgottenAgain = await engine.memory.forget(id, principal, agent);
    assert.equal(forgottenAgain.alreadyForgotten, true);
    assert.equal(forgottenAgain.archived, false);

    // (h) exactly one committed tombstone entry after (a) and (b)
    const tombstones = readTombstonesFromRegistry(baseDbPath, agentId).filter((t) => t.status === "committed" && t.memoryId === id);
    assert.equal(tombstones.length, 1);

    await engine.close({ budgetMs: 5_000 });
  });

  it("(c) forget(randomUUID()) is not-found", async () => {
    const host = stubHostForDestructiveOps(makeTempDir("e1-write-state-"));
    const engine = createEngine(host, config(freshBaseDbPath("e1-write-")), { internals: { embeddings: flatEmbedder() } });
    const principal = principalForDestructive("agent-c");

    await assert.rejects(
      () => engine.memory.forget(randomUUID(), principal, agent),
      (err) => err.code === "not-found",
    );

    await engine.close({ budgetMs: 5_000 });
  });

  it("(d) forget of anna's card as bernd is not-found", async () => {
    const host = stubHostForDestructiveOps(makeTempDir("e1-write-state-"));
    const engine = createEngine(host, { ...config(freshBaseDbPath("e1-write-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const id = await seedAndGetId(engine, "anna", "Anna's passport renewal is due in November.", "passport renewal", principalForDestructive);

    const berndPrincipal = principalForDestructive("bernd");
    await assert.rejects(
      () => engine.memory.forget(id, berndPrincipal, agent),
      (err) => err.code === "not-found",
    );

    // The card is still listed for anna.
    const annaListed = await engine.memory.list({ topic: "passport renewal" }, principalForDestructive("anna"), agent);
    assert.ok(annaListed.items.some((c) => c.id === id));

    await engine.close({ budgetMs: 5_000 });
  });

  it("(e) forget with { origin: 'cron', background: true } is denied and the card is still listed", async () => {
    const host = createStubHost({ stateDir: makeTempDir("e1-write-state-") });
    const engine = createEngine(host, { ...config(freshBaseDbPath("e1-write-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-e";
    const id = await seedAndGetId(engine, agentId, "The team retro notes from last sprint are pinned in the channel.", "retro notes");

    const principal = principalFor(agentId);
    await assert.rejects(
      () => engine.memory.forget(id, principal, cronAgent),
      (err) => err.code === "denied",
    );

    const listed = await engine.memory.list({ topic: "retro notes" }, principal, agent);
    assert.ok(listed.items.some((c) => c.id === id), "card still listed after a denied destructive call");

    await engine.close({ budgetMs: 5_000 });
  });

  it("(f) correct changes the text shown by show, and an archive file exists", async () => {
    const stateDir = makeTempDir("e1-write-state-");
    const host = stubHostForDestructiveOps(stateDir);
    const engine = createEngine(host, { ...config(freshBaseDbPath("e1-write-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-f";
    const id = await seedAndGetId(engine, agentId, "The conference room booking system is called RoomHub.", "conference room booking", principalForDestructive);

    const principal = principalForDestructive(agentId);
    const corrected = await engine.memory.correct(id, "The conference room booking system is called SpaceHub now.", principal, agent);
    assert.equal(corrected.archived, true);

    // correctCard's storage layer (lib/db-adapter.js's updateCard) is a
    // version-chain update: the old id is superseded and the corrected text
    // lives at a new id, which `correct` now returns additively as the
    // result's `id` (fix round 1, E1-R8; see the dedicated (E1-R8) test for
    // the old-id/new-id contrast).
    const card = await engine.memory.show(corrected.id, principal, agent);
    assert.match(card.text, /SpaceHub/);

    const archiveAgentDir = join(stateDir, "memory", "_archive", agentId);
    assert.ok(existsSync(archiveAgentDir), "archive dir exists");
    assert.ok(readdirSync(archiveAgentDir).length >= 1, "an archive file was written");

    await engine.close({ budgetMs: 5_000 });
  });

  it("(g) correct(id, '   ') is invalid-input", async () => {
    const host = stubHostForDestructiveOps(makeTempDir("e1-write-state-"));
    const engine = createEngine(host, { ...config(freshBaseDbPath("e1-write-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-g";
    const id = await seedAndGetId(engine, agentId, "The office thermostat is set to 21 degrees in winter.", "office thermostat", principalForDestructive);

    const principal = principalForDestructive(agentId);
    await assert.rejects(
      () => engine.memory.correct(id, "   ", principal, agent),
      (err) => err.code === "invalid-input",
    );

    await engine.close({ budgetMs: 5_000 });
  });

  it("(E1-R7) forget/correct of a superseded card are not-found", async () => {
    const host = stubHostForDestructiveOps(makeTempDir("e1-write-state-"));
    const engine = createEngine(host, { ...config(freshBaseDbPath("e1-write-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-r7";
    const id = await seedAndGetId(engine, agentId, "The old printer driver install notes are in the wiki.", "printer driver install notes", principalForDestructive);

    // /correct's own supersede path (lib/safe-update.js, lib/db-adapter.js)
    // sets exactly this status — same fixture as read-test (h).
    await patchRow(engine, agentId, id, { status: "superseded" });

    const principal = principalForDestructive(agentId);
    await assert.rejects(
      () => engine.memory.forget(id, principal, agent),
      (err) => err.code === "not-found",
    );
    await assert.rejects(
      () => engine.memory.correct(id, "new text for the superseded id", principal, agent),
      (err) => err.code === "not-found",
    );

    await engine.close({ budgetMs: 5_000 });
  });

  it("(E1-R8) correct returns the new version's id: show(result.id) has the new text, show(oldId) is not-found, and forget(result.id) removes it", async () => {
    const host = stubHostForDestructiveOps(makeTempDir("e1-write-state-"));
    const engine = createEngine(host, { ...config(freshBaseDbPath("e1-write-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-r8";
    const oldId = await seedAndGetId(engine, agentId, "The lab freezer temperature log is checked weekly.", "lab freezer temperature log", principalForDestructive);

    const principal = principalForDestructive(agentId);
    const corrected = await engine.memory.correct(oldId, "The lab freezer temperature log is checked daily now.", principal, agent);
    assert.notEqual(corrected.id, oldId, "correct returns the NEW version's id, not the superseded one");
    assert.equal(corrected.archived, true);

    const newCard = await engine.memory.show(corrected.id, principal, agent);
    assert.match(newCard.text, /checked daily now/);

    await assert.rejects(
      () => engine.memory.show(oldId, principal, agent),
      (err) => err.code === "not-found",
    );

    const forgotten = await engine.memory.forget(corrected.id, principal, agent);
    assert.equal(forgotten.archived, true);
    const listed = await engine.memory.list({ topic: "lab freezer temperature log" }, principal, agent);
    assert.ok(!listed.items.some((c) => c.id === corrected.id), "the corrected text is gone after forgetting its new id");

    await engine.close({ budgetMs: 5_000 });
  });

  it("(E1 Task 8) correct writes through safeUpdate: fresh summary, evidence naming the stored text, reinforcement", async () => {
    const host = stubHostForDestructiveOps(makeTempDir("e1-write-state-"));
    const engine = createEngine(host, { ...config(freshBaseDbPath("e1-write-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-t8";
    const oldId = await seedAndGetId(engine, agentId, "The bike shed key hangs by the back door.", "bike shed key", principalForDestructive);
    const before = await rawCard(engine, agentId, oldId);

    const principal = principalForDestructive(agentId);
    const corrected = await engine.memory.correct(oldId, "The bike shed key now hangs in the hallway cabinet.", principal, agent);
    const row = await rawCard(engine, agentId, corrected.id);
    assert.equal(row.summary, "The bike shed key now hangs in the hallway cabinet.", "summary follows the new text (updateCard kept the stale one)");
    assert.equal(row.updateSource, "user_correction");
    assert.equal(row.updateEvidence, `User corrected "${before.text}" to "The bike shed key now hangs in the hallway cabinet."`);
    assert.equal(Number(row.retrievalCount), Number(before.retrievalCount ?? 0) + 1, "the new version is reinforced once");
    assert.equal(row.previousVersion, oldId);

    await engine.close({ budgetMs: 5_000 });
  });

  it("(E1 Task 8) correct to the text of a forgotten memory is conflict and leaves the card live", async () => {
    const host = stubHostForDestructiveOps(makeTempDir("e1-write-state-"));
    const engine = createEngine(host, { ...config(freshBaseDbPath("e1-write-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-t8c";
    const principal = principalForDestructive(agentId);
    await seed(engine, agentId, "The spare router password is taped under the desk.", principalForDestructive);
    await seed(engine, agentId, "The guest network name is Harbour.", principalForDestructive);
    // The flat embedder scores every card alike, so pick each id by its text.
    const { items } = await engine.memory.list({ topic: "router guest network" }, principal, agent);
    const forgottenId = items.find((c) => /spare router/.test(c.text))?.id;
    const liveId = items.find((c) => /Harbour/.test(c.text))?.id;
    assert.ok(forgottenId && liveId && forgottenId !== liveId, "both seeded cards are listed");
    const forgottenRow = await rawCard(engine, agentId, forgottenId);
    await engine.memory.forget(forgottenId, principal, agent);

    await assert.rejects(
      () => engine.memory.correct(liveId, forgottenRow.text, principal, agent),
      (err) => err.code === "conflict",
    );
    const live = await rawCard(engine, agentId, liveId);
    assert.equal(live.status, "active");
    assert.match(live.text, /Harbour/);

    await engine.close({ budgetMs: 5_000 });
  });

  it("(E1-R9) forgetting an already-forgotten card twice returns the SAME tombstoneId", async () => {
    const stateDir = makeTempDir("e1-write-state-");
    const baseDbPath = freshBaseDbPath("e1-write-");
    const host = stubHostForDestructiveOps(stateDir);
    const engine = createEngine(host, { ...config(baseDbPath), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-r9";
    const id = await seedAndGetId(engine, agentId, "The recycling pickup moved to Wednesdays this month.", "recycling pickup", principalForDestructive);

    const principal = principalForDestructive(agentId);
    const first = await engine.memory.forget(id, principal, agent);
    const second = await engine.memory.forget(id, principal, agent);
    assert.equal(second.alreadyForgotten, true);
    assert.equal(second.tombstoneId, first.tombstoneId, "re-forgetting returns the same tombstone, not a new one");

    await engine.close({ budgetMs: 5_000 });
  });

  it("(minor) crash-backfill: a card already status:deleted with no committed registry entry gets one on forget", async () => {
    const stateDir = makeTempDir("e1-write-state-");
    const baseDbPath = freshBaseDbPath("e1-write-");
    const host = stubHostForDestructiveOps(stateDir);
    const engine = createEngine(host, { ...config(baseDbPath), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-backfill";
    const id = await seedAndGetId(engine, agentId, "The backup generator is tested on the first of the month.", "backup generator", principalForDestructive);

    // Simulate a crash between the LanceDB tombstone mutation (db.tombstoneCard,
    // which sets exactly this status/epistemicStatus) and the registry commit:
    // the row is "deleted" but readTombstonesFromRegistry has no entry for it.
    await patchRow(engine, agentId, id, { status: "deleted", epistemicStatus: "invalidated" });
    assert.equal(
      readTombstonesFromRegistry(baseDbPath, agentId).filter((t) => t.memoryId === id).length,
      0,
      "no registry entry exists yet",
    );

    const principal = principalForDestructive(agentId);
    const forgotten = await engine.memory.forget(id, principal, agent);
    assert.equal(forgotten.archived, false, "the LanceDB mutation already happened");
    assert.equal(forgotten.alreadyForgotten, true);
    assert.equal(typeof forgotten.tombstoneId, "string");
    assert.ok(forgotten.tombstoneId.length > 0);

    const committed = readTombstonesFromRegistry(baseDbPath, agentId)
      .filter((t) => t.status === "committed" && t.memoryId === id);
    assert.equal(committed.length, 1, "the backfill committed exactly one registry entry");
    assert.equal(committed[0].tombstoneId, forgotten.tombstoneId);

    await engine.close({ budgetMs: 5_000 });
  });

  it("(minor) ACL: forget/correct of a same-agent, foreign-user-scoped card are not-found and leave it unchanged", async () => {
    const host = stubHostForDestructiveOps(makeTempDir("e1-write-state-"));
    const engine = createEngine(host, { ...config(freshBaseDbPath("e1-write-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-acl";
    const id = await seedAndGetId(engine, agentId, "The shared calendar invite code is posted in the wiki.", "shared calendar invite code", principalForDestructive);

    // Re-scope the card to another user (same agent). checkAccess's "user"
    // branch denies unless ctx.userPrincipal matches ownerUserId exactly
    // (lib/acl-middleware.js); principalForDestructive claims no user at all,
    // so this is denied for "missing_principal" — same not-found either way.
    const foreignOwner = `user:v1:${"a".repeat(64)}`;
    await patchRow(engine, agentId, id, { scope: "user", ownerUserId: foreignOwner });

    const principal = principalForDestructive(agentId);
    await assert.rejects(
      () => engine.memory.forget(id, principal, agent),
      (err) => err.code === "not-found",
    );
    await assert.rejects(
      () => engine.memory.correct(id, "an attempted correction of a foreign-user card", principal, agent),
      (err) => err.code === "not-found",
    );

    const unchanged = await rawCard(engine, agentId, id);
    assert.equal(unchanged.status, "active");
    assert.match(unchanged.text, /shared calendar invite code/);

    await engine.close({ budgetMs: 5_000 });
  });
});

describe("Engine.memory on a workspace-shared card (E1 final review I3)", () => {
  it("anna lists and shows bernd's workspace-shared card; her forget/correct/share are denied; a random id is not-found", async () => {
    const stateDir = makeTempDir("e1-share-state-");
    const host = stubHostForSharedWorkspace(stateDir);
    const baseDbPath = freshBaseDbPath("e1-share-");
    const engine = createEngine(host, { ...config(baseDbPath), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const sourceId = await seedAndGetId(engine, "bernd", "The team's printer toner is ordered from the stationery portal.", "printer toner", principalForDestructive);
    const { sharedId } = await engine.memory.share(sourceId, "workspace", principalForDestructive("bernd"), agent);

    const anna = principalForDestructive("anna");
    const listed = await engine.memory.list({ since: 0 }, anna, agent);
    const listedCard = listed.items.find((c) => c.id === sharedId);
    assert.ok(listedCard, "anna lists the shared card");
    assert.equal(listedCard.scope, "workspace");

    const shown = await engine.memory.show(sharedId, anna, agent);
    assert.equal(shown.id, sharedId);
    assert.equal(shown.scope, "workspace");

    // E2 Task 4 (D31): anna is not the sharer, so each op names its own refusal.
    const deniedShared = (message) => (err) => err.name === "MemoryOpError" && err.code === "denied" && err.message === message;
    await assert.rejects(() => engine.memory.forget(sharedId, anna, agent), deniedShared("only the sharing agent can retract a shared copy"));
    await assert.rejects(() => engine.memory.correct(sharedId, "The toner comes from elsewhere now.", anna, agent), deniedShared("shared copies are changed through a proposal (memory.propose)"));
    await assert.rejects(() => engine.memory.share(sharedId, "workspace", anna, agent), deniedShared("a shared copy cannot be shared again"));

    const unknown = randomUUID();
    await assert.rejects(() => engine.memory.show(unknown, anna, agent), (err) => err.code === "not-found");
    await assert.rejects(() => engine.memory.forget(unknown, anna, agent), (err) => err.code === "not-found");
    await assert.rejects(() => engine.memory.correct(unknown, "text", anna, agent), (err) => err.code === "not-found");
    await assert.rejects(() => engine.memory.share(unknown, "workspace", anna, agent), (err) => err.code === "not-found");

    // The refused calls changed nothing: the shared card is still listed and no tombstone exists for anna.
    const after = await engine.memory.show(sharedId, anna, agent);
    assert.equal(after.text, shown.text);
    assert.equal(readTombstonesFromRegistry(baseDbPath, "anna").length, 0);

    await engine.close({ budgetMs: 5_000 });
  });
});

describe("Engine.memory after close() (E1 final review I2)", () => {
  it("every member rejects with storage \"engine is closed\"; forget writes no archive and no tombstone", async () => {
    const stateDir = makeTempDir("e1-write-state-");
    const baseDbPath = freshBaseDbPath("e1-write-");
    const host = stubHostForDestructiveOps(stateDir);
    const engine = createEngine(host, { ...config(baseDbPath), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-closed";
    const id = await seedAndGetId(engine, agentId, "The spare car key hangs behind the pantry door.", "spare car key", principalForDestructive);
    const principal = principalForDestructive(agentId);

    await engine.close({ budgetMs: 5_000 });

    const closedError = (err) => err.name === "MemoryOpError" && err.code === "storage" && err.message === "engine is closed";
    await assert.rejects(() => engine.memory.forget(id, principal, agent), closedError);
    await assert.rejects(() => engine.memory.correct(id, "The key moved.", principal, agent), closedError);
    await assert.rejects(() => engine.memory.share(id, "workspace", principal, agent), closedError);
    await assert.rejects(() => engine.memory.show(id, principal, agent), closedError);
    await assert.rejects(() => engine.memory.list({ since: 0 }, principal, agent), closedError);
    await assert.rejects(() => engine.memory.state(principal, agent), closedError);

    assert.equal(existsSync(join(stateDir, "memory", "_archive", agentId)), false, "no archive written after close");
    assert.equal(readTombstonesFromRegistry(baseDbPath, agentId).length, 0, "no tombstone registry entry after close");

    // The card is still live for a fresh engine over the same store.
    const reopened = createEngine(host, config(baseDbPath), { internals: { embeddings: flatEmbedder() } });
    const card = await reopened.memory.show(id, principal, agent);
    assert.equal(card.id, id);
    await reopened.close({ budgetMs: 5_000 });
  });
});

describe("Engine.memory.share (E1 Task 6)", () => {
  it("(a) share to workspace returns sharedId, and a second agent in the same workspace lists it with scope 'workspace'", async () => {
    const stateDir = makeTempDir("e1-share-state-");
    const host = stubHostForSharedWorkspace(stateDir);
    const engine = createEngine(host, { ...config(freshBaseDbPath("e1-share-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const ownerId = "share-owner";
    const id = await seedAndGetId(engine, ownerId, "The team's shared VPN config lives in the ops repo.", "shared VPN config", principalForDestructive);

    const ownerPrincipal = principalForDestructive(ownerId);
    const shared = await engine.memory.share(id, "workspace", ownerPrincipal, agent);
    assert.equal(shared.sourceId, id);
    assert.equal(shared.target, "workspace");
    assert.equal(typeof shared.sharedId, "string");
    assert.ok(shared.sharedId.length > 0);

    // A second, different agent whose workspace identity resolves to the
    // SAME workspace (stubHostForSharedWorkspace hands every agent the
    // identical real directory) lists the card through the shared workspace
    // pool, not its own (empty) private one.
    const otherId = "share-other";
    const otherListed = await engine.memory.list({ topic: "shared VPN config" }, principalForDestructive(otherId), agent);
    const sharedCard = otherListed.items.find((c) => c.id === shared.sharedId);
    assert.ok(sharedCard, "the second agent sees the shared card");
    assert.equal(sharedCard.scope, "workspace");

    await engine.close({ budgetMs: 5_000 });
  });

  it("(b) a sensitive card is approval-required, and { allowSensitive: true } succeeds", async () => {
    const stateDir = makeTempDir("e1-share-state-");
    const host = stubHostForSharedWorkspace(stateDir);
    const engine = createEngine(host, { ...config(freshBaseDbPath("e1-share-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const ownerId = "share-sensitive";
    const id = await seedAndGetId(engine, ownerId, "The safe combination is written in the back of the notebook.", "safe combination", principalForDestructive);

    // sensitiveShareReason (lib/telegram-commands/memory-edit.js) flags this
    // category, exactly like the existing b13-share-runtime.test.js fixture.
    await patchRow(engine, ownerId, id, { category: "secret" });

    const principal = principalForDestructive(ownerId);
    await assert.rejects(
      () => engine.memory.share(id, "workspace", principal, agent),
      (err) => err.code === "approval-required",
    );

    const shared = await engine.memory.share(id, "workspace", principal, agent, { allowSensitive: true });
    assert.equal(typeof shared.sharedId, "string");
    assert.ok(shared.sharedId.length > 0);

    await engine.close({ budgetMs: 5_000 });
  });

  it("(c) an inferred principal is denied", async () => {
    const host = stubHostForSharedWorkspace(makeTempDir("e1-share-state-"));
    const engine = createEngine(host, { ...config(freshBaseDbPath("e1-share-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const ownerId = "share-inferred";
    const id = await seedAndGetId(engine, ownerId, "The office wifi password rotates monthly.", "office wifi password", principalForDestructive);

    // No `trust: "proved"` at all: memoryContextFromPrincipal degrades this
    // straight to an "inferred" context (engine/identity/principal.js).
    const inferredPrincipal = { agentId: ownerId };
    await assert.rejects(
      () => engine.memory.share(id, "workspace", inferredPrincipal, agent),
      (err) => err.code === "denied",
    );

    await engine.close({ budgetMs: 5_000 });
  });

  it("(d) target: 'everyone' is invalid-input", async () => {
    const host = stubHostForSharedWorkspace(makeTempDir("e1-share-state-"));
    const engine = createEngine(host, { ...config(freshBaseDbPath("e1-share-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const ownerId = "share-badtarget";
    const id = await seedAndGetId(engine, ownerId, "The printer on the third floor jams on legal-size paper.", "printer jams", principalForDestructive);

    const principal = principalForDestructive(ownerId);
    await assert.rejects(
      () => engine.memory.share(id, "everyone", principal, agent),
      (err) => err.code === "invalid-input",
    );

    await engine.close({ budgetMs: 5_000 });
  });

  it("(e) sharing anna's card as bernd is not-found", async () => {
    const host = stubHostForDestructiveOps(makeTempDir("e1-share-state-"));
    const engine = createEngine(host, { ...config(freshBaseDbPath("e1-share-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const id = await seedAndGetId(engine, "anna", "Anna's storage unit code is taped inside the closet door.", "storage unit code", principalForDestructive);

    const berndPrincipal = principalForDestructive("bernd");
    await assert.rejects(
      () => engine.memory.share(id, "workspace", berndPrincipal, agent),
      (err) => err.code === "not-found",
    );

    // The card is still listed, unshared, for anna.
    const annaListed = await engine.memory.list({ topic: "storage unit code" }, principalForDestructive("anna"), agent);
    assert.ok(annaListed.items.some((c) => c.id === id));

    await engine.close({ budgetMs: 5_000 });
  });

  it("(E1-R7) sharing a superseded card is not-found", async () => {
    const host = stubHostForSharedWorkspace(makeTempDir("e1-share-state-"));
    const engine = createEngine(host, { ...config(freshBaseDbPath("e1-share-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const ownerId = "share-superseded";
    const id = await seedAndGetId(engine, ownerId, "The old build server was decommissioned last quarter.", "old build server", principalForDestructive);

    await patchRow(engine, ownerId, id, { status: "superseded" });

    const principal = principalForDestructive(ownerId);
    await assert.rejects(
      () => engine.memory.share(id, "workspace", principal, agent),
      (err) => err.code === "not-found",
    );

    await engine.close({ budgetMs: 5_000 });
  });
});

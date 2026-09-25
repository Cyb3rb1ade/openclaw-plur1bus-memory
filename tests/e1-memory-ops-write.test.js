/**
 * tests/e1-memory-ops-write.test.js — E1 Task 5: Engine.memory.forget / .correct.
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

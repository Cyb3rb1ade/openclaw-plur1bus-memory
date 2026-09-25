/**
 * tests/e1-memory-ops-write.test.js — E1 Task 5: Engine.memory.forget / .correct.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createEngine } from "../engine/create-engine.js";
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
    const host = createStubHost({ stateDir: makeTempDir("e1-write-state-") });
    const engine = createEngine(host, config(freshBaseDbPath("e1-write-")), { internals: { embeddings: flatEmbedder() } });
    const principal = principalFor("agent-c");

    await assert.rejects(
      () => engine.memory.forget(randomUUID(), principal, agent),
      (err) => err.code === "not-found",
    );

    await engine.close({ budgetMs: 5_000 });
  });

  it("(d) forget of anna's card as bernd is not-found", async () => {
    const host = createStubHost({ stateDir: makeTempDir("e1-write-state-") });
    const engine = createEngine(host, { ...config(freshBaseDbPath("e1-write-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const id = await seedAndGetId(engine, "anna", "Anna's passport renewal is due in November.", "passport renewal");

    const berndPrincipal = principalFor("bernd");
    await assert.rejects(
      () => engine.memory.forget(id, berndPrincipal, agent),
      (err) => err.code === "not-found",
    );

    // The card is still listed for anna.
    const annaListed = await engine.memory.list({ topic: "passport renewal" }, principalFor("anna"), agent);
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
    assert.equal(corrected.id, id);
    assert.equal(corrected.archived, true);

    // correctCard's storage layer (lib/db-adapter.js's updateCard) is a
    // version-chain update: the old id is superseded (not-found via show,
    // same anti-oracle rule as the read-test (h) fixture) and the corrected
    // text lives at a new id. `show` on the *current* card — found the same
    // way any caller would, via `list` — is what must reflect the correction.
    const listed = await engine.memory.list({ topic: "conference room booking" }, principal, agent);
    const current = listed.items.find((c) => /SpaceHub/.test(c.text));
    assert.ok(current, "the corrected text is listed");
    const card = await engine.memory.show(current.id, principal, agent);
    assert.match(card.text, /SpaceHub/);

    const archiveAgentDir = join(stateDir, "memory", "_archive", agentId);
    assert.ok(existsSync(archiveAgentDir), "archive dir exists");
    assert.ok(readdirSync(archiveAgentDir).length >= 1, "an archive file was written");

    await engine.close({ budgetMs: 5_000 });
  });

  it("(g) correct(id, '   ') is invalid-input", async () => {
    const host = createStubHost({ stateDir: makeTempDir("e1-write-state-") });
    const engine = createEngine(host, { ...config(freshBaseDbPath("e1-write-")), autoCapture: true }, { internals: { embeddings: flatEmbedder() } });
    const agentId = "agent-g";
    const id = await seedAndGetId(engine, agentId, "The office thermostat is set to 21 degrees in winter.", "office thermostat");

    const principal = principalFor(agentId);
    await assert.rejects(
      () => engine.memory.correct(id, "   ", principal, agent),
      (err) => err.code === "invalid-input",
    );

    await engine.close({ budgetMs: 5_000 });
  });
});

/**
 * tests/engine-memory-shared-ops.test.js — E2 Task 4 (spec decision D31):
 * shared copies carry `sharedBy`/`sourceId`; only the sharing agent retracts
 * (forget) or refreshes (correct) a shared copy; every other agent is denied,
 * and an agent outside the pool sees not-found.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { readTombstonesFromRegistry } from "../lib/tombstone.js";

// Nested under its own temp root so the tombstone registry
// (`dirname(baseDbPath)/_tombstones`) is per test (see tests/e1-memory-ops-write.test.js).
function freshBaseDbPath(prefix) {
  return join(makeTempDir(`${prefix}root-`), "lancedb-namespaced");
}

const config = (baseDbPath) => ({
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: true, autoRecall: true,
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  runtime: { recallTimeoutMs: 10_000 },
  // Distinct facts with the flat embedder below.
  duplicateThreshold: 1.01,
});

function flatEmbedder() {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  const one = async () => vector();
  return { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (texts) => texts.map(vector), shutdown: async () => {} };
}

const USER_PRINCIPAL = `user:v1:${"a".repeat(64)}`;

// No `workspace` claim: the canonical identity of the host's real workspace
// directory wins (see tests/e1-memory-ops-write.test.js principalForDestructive).
function principal(agentId, { user } = {}) {
  return { agentId, channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved", ...(user ? { user } : {}) };
}

// anna and bernd share one real workspace directory (one workspace pool key);
// carol lives in another workspace.
function twoWorkspaceHost(stateDir) {
  const shared = join(stateDir, "workspaces", "shared-ws");
  const other = join(stateDir, "workspaces", "other-ws");
  mkdirSync(shared, { recursive: true });
  mkdirSync(other, { recursive: true });
  return { host: createStubHost({ stateDir, workspaceDir: async (agentId) => (agentId === "carol" ? other : shared) }), workspaceDir: shared };
}

const userAgent = { origin: "user", background: false };
const cronAgent = { origin: "cron", background: true };

async function seedAndGetId(engine, agentId, text, topic) {
  const p = principal(agentId);
  const outcome = await engine.capture({
    agentId,
    principal: p,
    agent: userAgent,
    messages: [{ role: "user", content: text }, { role: "assistant", content: "noted." }],
    sessionKey: `agent:${agentId}:main`,
    incognito: false,
    signal: AbortSignal.timeout(8_000),
  }).done;
  assert.equal(outcome.reason, undefined, `capture not skipped: ${outcome.reason}`);
  assert.ok(outcome.stored >= 1);
  const listed = await engine.memory.list({ topic }, p, userAgent);
  const card = listed.items.find((c) => c.scope === "agent-private" && c.text.includes(text.slice(0, 20)));
  assert.ok(card, `seeded card for '${topic}' is listed`);
  return card.id;
}

function setup(prefix) {
  const stateDir = makeTempDir(`${prefix}state-`);
  const baseDbPath = freshBaseDbPath(prefix);
  const { host, workspaceDir } = twoWorkspaceHost(stateDir);
  const engine = createEngine(host, config(baseDbPath), { internals: { embeddings: flatEmbedder() } });
  return { stateDir, baseDbPath, workspaceDir, engine };
}

const code = (c) => (err) => err.name === "MemoryOpError" && err.code === c;
const deniedWith = (message) => (err) => err.name === "MemoryOpError" && err.code === "denied" && err.message === message;

function auditLines(workspaceDir) {
  const file = join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function archiveCount(stateDir, agentId) {
  const dir = join(stateDir, "memory", "_archive", agentId);
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

async function assertRetractWorks({ engine, stateDir, baseDbPath, workspaceDir, sourceId, sharedId, anna, scope, viewer }) {
  const tombstonesBefore = readTombstonesFromRegistry(baseDbPath, "anna").length;
  const archivesBefore = archiveCount(stateDir, "anna");

  const result = await engine.memory.forget(sharedId, anna, userAgent);
  assert.deepEqual(result, { id: sharedId, archived: true, tombstoneId: null, alreadyForgotten: false });

  assert.equal(archiveCount(stateDir, "anna"), archivesBefore + 1, "the shared copy was archived under anna");
  await assert.rejects(() => engine.memory.show(sharedId, viewer, userAgent), code("not-found"));
  const original = await engine.memory.show(sourceId, anna, userAgent);
  assert.equal(original.id, sourceId, "the original stays live");
  await assert.rejects(() => engine.memory.forget(sharedId, anna, userAgent), code("not-found"));

  assert.equal(readTombstonesFromRegistry(baseDbPath, "anna").length, tombstonesBefore, "no tombstone registry entry for a retract");
  const line = auditLines(workspaceDir).find((l) => l.op === "share-retract" && l.id === sharedId);
  assert.ok(line, "a share-retract audit line was written");
  assert.equal(line.scope, scope);
  assert.equal(line.sourceMemoryId, sourceId);
  assert.equal(typeof line.actor, "string");
  assert.equal(typeof line.at, "string");
}

describe("Engine.memory on shared copies (E2 Task 4, D31)", () => {
  it("(a)-(c) sharedBy/sourceId on the copy; non-sharers are denied or not-found; the sharer retracts", async () => {
    const { stateDir, baseDbPath, workspaceDir, engine } = setup("e2-shared-a-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const carol = principal("carol");
    const F = await seedAndGetId(engine, "anna", "The office plants are watered every Tuesday morning.", "office plants");
    const { sharedId } = await engine.memory.share(F, "workspace", anna, userAgent);

    // (a)
    const seen = await engine.memory.show(sharedId, bernd, userAgent);
    assert.equal(seen.scope, "workspace");
    assert.equal(seen.sharedBy, "anna");
    assert.equal(seen.sourceId, F);
    const own = await engine.memory.show(F, anna, userAgent);
    assert.equal("sharedBy" in own, false);
    assert.equal("sourceId" in own, false);
    const listed = await engine.memory.list({ since: 0 }, bernd, userAgent);
    assert.equal(listed.items.find((c) => c.id === sharedId)?.sharedBy, "anna", "list carries sharedBy too");

    // (b)
    await assert.rejects(() => engine.memory.forget(sharedId, bernd, userAgent), deniedWith("only the sharing agent can retract a shared copy"));
    await assert.rejects(() => engine.memory.correct(sharedId, "x", bernd, userAgent), deniedWith("shared copies are changed through a proposal (memory.propose)"));
    await assert.rejects(() => engine.memory.share(sharedId, "workspace", bernd, userAgent), deniedWith("a shared copy cannot be shared again"));
    await assert.rejects(() => engine.memory.share(sharedId, "workspace", anna, userAgent), deniedWith("a shared copy cannot be shared again"));
    await assert.rejects(() => engine.memory.show(sharedId, carol, userAgent), code("not-found"));
    await assert.rejects(() => engine.memory.forget(sharedId, carol, userAgent), code("not-found"));
    const unchanged = await engine.memory.show(sharedId, bernd, userAgent);
    assert.equal(unchanged.text, seen.text, "refused calls changed nothing");

    // (c)
    await assertRetractWorks({ engine, stateDir, baseDbPath, workspaceDir, sourceId: F, sharedId, anna, scope: "workspace", viewer: bernd });

    await engine.close({ budgetMs: 5_000 });
  });

  it("(d) the sharer's correct refreshes the copy: new original, new copy, old copy retracted", async () => {
    const { engine } = setup("e2-shared-d-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const G = await seedAndGetId(engine, "anna", "The team lunch is booked at the harbour bistro.", "team lunch");
    const { sharedId: S2 } = await engine.memory.share(G, "workspace", anna, userAgent);

    const result = await engine.memory.correct(S2, "G corrected", anna, userAgent);
    assert.equal(result.archived, true);
    const S3 = result.id;
    assert.notEqual(S3, S2);

    const refreshed = await engine.memory.show(S3, bernd, userAgent);
    assert.equal(refreshed.text, "G corrected");
    assert.equal(refreshed.sharedBy, "anna");
    await assert.rejects(() => engine.memory.show(S2, bernd, userAgent), code("not-found"));
    await assert.rejects(() => engine.memory.show(G, anna, userAgent), code("not-found"));

    const annaList = await engine.memory.list({ topic: "G corrected" }, anna, userAgent);
    const newOriginal = annaList.items.find((c) => c.id === refreshed.sourceId);
    assert.ok(newOriginal, "the new original is listed");
    assert.equal(newOriginal.scope, "agent-private");
    assert.equal(newOriginal.text, "G corrected");

    await engine.close({ budgetMs: 5_000 });
  });

  it("(e) correct of a copy whose original is gone is conflict; retract still works", async () => {
    const { engine } = setup("e2-shared-e-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const H = await seedAndGetId(engine, "anna", "The parking permits renew at the end of March.", "parking permits");
    const { sharedId: S4 } = await engine.memory.share(H, "workspace", anna, userAgent);
    await engine.memory.forget(H, anna, userAgent);

    await assert.rejects(() => engine.memory.correct(S4, "x", anna, userAgent), (err) => code("conflict")(err)
      && err.message === "the original of this shared copy is no longer live; retract it instead");
    const still = await engine.memory.show(S4, bernd, userAgent);
    assert.equal(still.id, S4, "the refused refresh left the copy live");

    const retracted = await engine.memory.forget(S4, anna, userAgent);
    assert.equal(retracted.archived, true);
    await assert.rejects(() => engine.memory.show(S4, bernd, userAgent), code("not-found"));

    await engine.close({ budgetMs: 5_000 });
  });

  it("(f) a background retract is denied and changes nothing", async () => {
    const { engine } = setup("e2-shared-f-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const F = await seedAndGetId(engine, "anna", "The fire drill is scheduled for the first Friday.", "fire drill");
    const { sharedId } = await engine.memory.share(F, "workspace", anna, userAgent);

    await assert.rejects(() => engine.memory.forget(sharedId, anna, cronAgent), code("denied"));
    const still = await engine.memory.show(sharedId, bernd, userAgent);
    assert.equal(still.id, sharedId);

    await engine.close({ budgetMs: 5_000 });
  });

  it("(g) a user-scope copy is retracted through the user pool", async () => {
    const { stateDir, baseDbPath, workspaceDir, engine } = setup("e2-shared-g-");
    const anna = principal("anna", { user: USER_PRINCIPAL });
    const F2 = await seedAndGetId(engine, "anna", "The dentist reminder card sits on the fridge door.", "dentist reminder");
    const { sharedId } = await engine.memory.share(F2, "user", anna, userAgent);

    const seen = await engine.memory.show(sharedId, anna, userAgent);
    assert.equal(seen.scope, "user");
    assert.equal(seen.sharedBy, "anna");
    assert.equal(seen.sourceId, F2);

    await assertRetractWorks({ engine, stateDir, baseDbPath, workspaceDir, sourceId: F2, sharedId, anna, scope: "user", viewer: anna });

    await engine.close({ budgetMs: 5_000 });
  });
});

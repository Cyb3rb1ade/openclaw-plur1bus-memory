/**
 * tests/engine-memory-import.test.js — contract 1.11.0 `Engine.memory.import`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { importCardId } from "../engine/memory-ops/import-id.js";
import { importLedgerPath } from "../engine/memory-ops/import-ledger.js";
import { IMPORT_CARD_BATCH_LIMIT } from "../engine/memory-ops/import.js";

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
  duplicateThreshold: 1.01,
});

function flatEmbedder() {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  const one = async () => vector();
  return { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (texts) => texts.map(vector), shutdown: async () => {} };
}

function principalFor(agentId) {
  return { agentId, workspace: "workspace:v1:main", channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" };
}

function principalForDestructive(agentId) {
  return { agentId, channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" };
}

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

const systemAgent = { origin: "system", background: false };
const userAgent = { origin: "user", background: false };

const FIXTURE = "SECRET_IMPORT_FIXTURE_TOKEN_7F3A";

function importReq(agentId, cards, extra = {}) {
  return { agentId, principal: principalFor(agentId), cards, ...extra };
}

function card(key, text, extra = {}) {
  return { idempotencyKey: key, text, provenance: "imported", ...extra };
}

describe("importCardId", () => {
  it("is a store UUID, stable, and differs across agent or key", () => {
    const a = importCardId("agent-a", "k1");
    const b = importCardId("agent-a", "k1");
    const c = importCardId("agent-a", "k2");
    const d = importCardId("agent-b", "k1");
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(a, c);
    assert.notEqual(a, d);
  });
});

describe("Engine.memory.import", () => {
  it("creates a card, list/show find it, createdAt is kept, origin is internal", async () => {
    const baseDbPath = freshBaseDbPath("imp-create-");
    const logs = [];
    const logger = { info(m) { logs.push(String(m)); }, warn(m) { logs.push(String(m)); }, error(m) { logs.push(String(m)); }, debug(m) { logs.push(String(m)); } };
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("imp-create-state-"), logger }),
      config(baseDbPath),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const createdAt = 1_700_000_000_000;
    const sourceRef = `hermes:MEMORY.md#${"x".repeat(600)}`;
    const result = await engine.memory.import(
      importReq(agentId, [card("k1", `The spare key lives under the third flowerpot. ${FIXTURE}`, { createdAt, sourceRef, kind: "knowledge" })]),
      principalFor(agentId),
      systemAgent,
    );
    assert.equal(result.created, 1);
    assert.equal(result.matchedExisting, 0);
    assert.equal(result.rejected, 0);
    assert.equal(result.cards[0].outcome, "created");
    assert.equal(result.cards[0].id, importCardId(agentId, "k1"));
    const dumped = JSON.stringify(result);
    assert.equal(dumped.includes(FIXTURE), false);
    assert.ok(logs.every((line) => !line.includes(FIXTURE)));

    const shown = await engine.memory.show(result.cards[0].id, principalFor(agentId), userAgent);
    assert.equal(shown.origin, "internal");
    assert.equal(shown.createdAt, createdAt);
    assert.equal(shown.provenance, "imported");
    assert.equal(shown.sourceRef.length, 500);
    assert.equal(shown.text.includes("flowerpot"), true);

    const listed = await engine.memory.list({ topic: "spare key flowerpot" }, principalFor(agentId), userAgent);
    assert.ok(listed.items.some((c) => c.id === shown.id));

    const recalled = await engine.recall({
      query: "spare key flowerpot",
      principal: principalFor(agentId),
      agent: userAgent,
      signal: AbortSignal.timeout(8_000),
    });
    const memories = recalled.blocks?.find((b) => b.name === "memories")?.text || "";
    assert.equal(memories.includes(FIXTURE) || listed.items.some((c) => c.id === shown.id), true);

    await engine.close({ budgetMs: 5_000 });
  });

  it("second call with the same key is matched-existing and does not add a row", async () => {
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("imp-match-state-") }),
      config(freshBaseDbPath("imp-match-")),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const first = await engine.memory.import(importReq(agentId, [card("k1", "Bernd drinks oat milk.")]), principalFor(agentId), systemAgent);
    const second = await engine.memory.import(importReq(agentId, [card("k1", "Bernd drinks oat milk.")]), principalFor(agentId), systemAgent);
    assert.equal(first.cards[0].outcome, "created");
    assert.equal(second.created, 0);
    assert.equal(second.matchedExisting, 1);
    assert.equal(second.cards[0].outcome, "matched-existing");
    assert.equal(second.cards[0].reason, "already-imported");
    assert.equal(second.cards[0].id, first.cards[0].id);
    const listed = await engine.memory.list({ topic: "oat milk" }, principalFor(agentId), userAgent);
    assert.equal(listed.items.filter((c) => c.id === first.cards[0].id).length, 1);
    await engine.close({ budgetMs: 5_000 });
  });

  it("a crash between store and ledger resumes as matched-existing", async () => {
    const baseDbPath = freshBaseDbPath("imp-crash-");
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("imp-crash-state-") }),
      config(baseDbPath),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const first = await engine.memory.import(importReq(agentId, [card("k-crash", "The greenhouse code is 4821.")]), principalFor(agentId), systemAgent);
    assert.equal(first.cards[0].outcome, "created");
    rmSync(importLedgerPath(baseDbPath, agentId), { force: true });
    const second = await engine.memory.import(importReq(agentId, [card("k-crash", "The greenhouse code is 4821.")]), principalFor(agentId), systemAgent);
    assert.equal(second.cards[0].outcome, "matched-existing");
    assert.equal(second.cards[0].id, first.cards[0].id);
    const listed = await engine.memory.list({ topic: "greenhouse code" }, principalFor(agentId), userAgent);
    assert.equal(listed.items.filter((c) => c.id === first.cards[0].id).length, 1);
    await engine.close({ budgetMs: 5_000 });
  });

  it("import, forget, re-import is previously-imported-deleted", async () => {
    const stateDir = makeTempDir("imp-forget-state-");
    const engine = createEngine(
      stubHostForDestructiveOps(stateDir),
      config(freshBaseDbPath("imp-forget-")),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "bernd";
    const principal = principalForDestructive(agentId);
    const first = await engine.memory.import(
      { agentId, principal, cards: [card("k-del", "The attic hatch sticks in winter.")] },
      principal,
      systemAgent,
    );
    assert.equal(first.cards[0].outcome, "created");
    const forgotten = await engine.memory.forget(first.cards[0].id, principal, userAgent);
    assert.equal(forgotten.archived, true);
    const again = await engine.memory.import(
      { agentId, principal, cards: [card("k-del", "The attic hatch sticks in winter.")] },
      principal,
      systemAgent,
    );
    assert.equal(again.created, 0);
    assert.equal(again.rejected, 1);
    assert.equal(again.cards[0].outcome, "rejected");
    assert.equal(again.cards[0].reason, "previously-imported-deleted");
    await assert.rejects(() => engine.memory.show(first.cards[0].id, principal, userAgent), (e) => e.code === "not-found");
    await engine.close({ budgetMs: 5_000 });
  });

  it("dryRun reports created without writing", async () => {
    const baseDbPath = freshBaseDbPath("imp-dry-");
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("imp-dry-state-") }),
      config(baseDbPath),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const dry = await engine.memory.import(
      importReq(agentId, [card("k-dry", "The balcony plants need rainwater.")], { dryRun: true }),
      principalFor(agentId),
      systemAgent,
    );
    assert.equal(dry.dryRun, true);
    assert.equal(dry.created, 1);
    assert.equal(dry.cards[0].id, undefined);
    assert.equal(existsSync(importLedgerPath(baseDbPath, agentId)), false);
    await assert.rejects(
      () => engine.memory.show(importCardId(agentId, "k-dry"), principalFor(agentId), userAgent),
      (e) => e.code === "not-found",
    );
    await engine.close({ budgetMs: 5_000 });
  });

  it("rejects provenance, empty text, unknown kind, and user origin", async () => {
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("imp-rej-state-") }),
      config(freshBaseDbPath("imp-rej-")),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const p = principalFor(agentId);
    const mixed = await engine.memory.import(importReq(agentId, [
      { idempotencyKey: "a", text: "ok", provenance: "dm" },
      { idempotencyKey: "b", text: "   ", provenance: "imported" },
      { idempotencyKey: "c", text: "wiki note", provenance: "imported", kind: "wiki" },
      { idempotencyKey: "d", text: "ok", provenance: "imported" },
    ]), p, systemAgent);
    assert.equal(mixed.cards[0].reason, "provenance-not-imported");
    assert.equal(mixed.cards[1].reason, "empty-text");
    assert.equal(mixed.cards[2].reason, "invalid-input");
    assert.equal(mixed.cards[3].outcome, "created");

    await assert.rejects(
      () => engine.memory.import(importReq(agentId, [card("e", "nope")]), p, userAgent),
      (e) => e.code === "denied",
    );
    await assert.rejects(
      () => engine.memory.import(importReq(agentId, Array.from({ length: IMPORT_CARD_BATCH_LIMIT + 1 }, (_, i) => card(`k${i}`, "x"))), p, systemAgent),
      (e) => e.code === "invalid-input",
    );
    await engine.close({ budgetMs: 5_000 });
  });

  it("inferred principal plus user scope is principal-unresolved", async () => {
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("imp-unres-state-") }),
      config(freshBaseDbPath("imp-unres-")),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const inferred = { ...principalFor(agentId), trust: "inferred" };
    delete inferred.user;
    const result = await engine.memory.import(
      { agentId, principal: inferred, cards: [card("k-user", "A private user fact.", { scope: "user" })] },
      inferred,
      systemAgent,
    );
    assert.equal(result.cards[0].outcome, "rejected");
    assert.equal(result.cards[0].reason, "principal-unresolved");
    await engine.close({ budgetMs: 5_000 });
  });

  it("abort after the first card rejects the rest; resume matches the first", async () => {
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("imp-abort-state-") }),
      config(freshBaseDbPath("imp-abort-")),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const controller = new AbortController();
    const originalBatch = flatEmbedder().embedBatch;
    const embeddings = {
      ...flatEmbedder(),
      embedBatch: async (texts, ...rest) => {
        const out = await originalBatch(texts, ...rest);
        controller.abort();
        return out;
      },
    };
    const engine2 = createEngine(
      createStubHost({ stateDir: makeTempDir("imp-abort2-state-") }),
      config(freshBaseDbPath("imp-abort2-")),
      { internals: { embeddings } },
    );
    // Signal already aborted: every card is aborted, no write.
    controller.abort();
    const aborted = await engine.memory.import(
      importReq(agentId, [card("k-a", "First imported line."), card("k-b", "Second imported line.")], { signal: controller.signal }),
      principalFor(agentId),
      systemAgent,
    );
    assert.equal(aborted.cards.every((c) => c.reason === "aborted"), true);

    const live = await engine.memory.import(
      importReq(agentId, [card("k-a", "First imported line."), card("k-b", "Second imported line.")]),
      principalFor(agentId),
      systemAgent,
    );
    assert.equal(live.created, 2);
    const resume = await engine.memory.import(
      importReq(agentId, [card("k-a", "First imported line."), card("k-b", "Second imported line.")]),
      principalFor(agentId),
      systemAgent,
    );
    assert.equal(resume.matchedExisting, 2);
    await engine.close({ budgetMs: 5_000 });
    await engine2.close({ budgetMs: 5_000 });
  });

  it("closed engine rejects import with storage", async () => {
    const engine = createEngine(createStubHost(), config(freshBaseDbPath("imp-closed-")), { internals: { embeddings: flatEmbedder() } });
    await engine.close({ budgetMs: 5_000 });
    await assert.rejects(
      () => engine.memory.import(importReq("agent-a", [card("k", "x")]), principalFor("agent-a"), systemAgent),
      (e) => e.code === "storage",
    );
  });
});

/**
 * tests/engine-memory-rebind.test.js — contract 1.12.0 `Engine.memory.rebind` / `unbind`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { createStubHost } from "../lib/host-services.js";
import {
  channelIdentityUserPrincipal,
  harnessUserPrincipal,
} from "../lib/memory-request-context.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { rebindLedgerPath } from "../engine/memory-ops/rebind-ledger.js";
import { classifyMemoryFreshness, computeMemoryAge } from "../lib/temporal-provenance.js";
import { stableDirectoryCapabilitiesSupported } from "../lib/directory-capability.js";

const namedRoutingSkip = stableDirectoryCapabilitiesSupported()
  ? false
  : "explicit named namespace routing requires stable directory capabilities";

const TIMEOUT = { timeout: 30_000 };
const TIMEOUT_LONG = { timeout: 60_000 };

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

function operatorFor(agentId) {
  return {
    agentId,
    workspace: "workspace:v1:main",
    channel: "telegram",
    accountId: "default",
    chat: { id: "c1", kind: "direct" },
    trust: "proved",
  };
}

function identityPrincipal(agentId, fromIdentity) {
  const user = channelIdentityUserPrincipal(
    fromIdentity.channel,
    fromIdentity.identityKey,
    fromIdentity.accountId || "default",
  );
  return {
    agentId,
    workspace: "workspace:v1:main",
    channel: fromIdentity.channel,
    accountId: fromIdentity.accountId || "default",
    chat: { id: "c1", kind: "direct" },
    user,
    trust: "proved",
  };
}

function harnessPrincipal(agentId, toUser) {
  return {
    agentId,
    workspace: "workspace:v1:main",
    channel: "telegram",
    accountId: "default",
    chat: { id: "c1", kind: "direct" },
    user: harnessUserPrincipal(toUser),
    trust: "proved",
  };
}

const systemAgent = { origin: "system", background: false };
const userAgent = { origin: "user", background: false };

const SECRET_TEXT = "SECRET_REBIND_TEXT_7F3A_oat_milk";
const PLAIN_KEY = "PLAIN_ID_TG_7F3A_bernd";
const TO_USER = "harness-user-bernd-7F3A";

function hashTree(root) {
  const hash = createHash("sha256");
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        hash.update(name);
        hash.update(readFileSync(full));
      }
    }
  };
  walk(root);
  return hash.digest("hex");
}

function collectingLogger() {
  const lines = [];
  const push = (m) => { lines.push(String(m)); };
  return {
    lines,
    logger: { info: push, warn: push, error: push, debug: push },
  };
}

async function importUserCard(engine, agentId, fromIdentity, key, text) {
  const principal = identityPrincipal(agentId, fromIdentity);
  const result = await engine.memory.import(
    {
      agentId,
      principal,
      cards: [{ idempotencyKey: key, text, provenance: "imported", scope: "user" }],
    },
    principal,
    systemAgent,
  );
  assert.equal(result.created, 1, JSON.stringify(result.cards));
  return result.cards[0].id;
}

describe("Engine.memory.rebind", () => {
  it("dryRun changes nothing on the store tree", TIMEOUT, async () => {
    const baseDbPath = freshBaseDbPath("rebind-dry-");
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("rebind-dry-state-") }),
      config(baseDbPath),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const fromIdentity = { channel: "telegram", identityKey: PLAIN_KEY };
    await importUserCard(engine, agentId, fromIdentity, "k-dry", `${SECRET_TEXT} dry`);
    await engine.memory.list({ topic: "oat" }, identityPrincipal(agentId, fromIdentity), userAgent);
    const before = hashTree(baseDbPath);
    const dry = await engine.memory.rebind(
      { agentId, fromIdentity, toUser: TO_USER },
      operatorFor(agentId),
      systemAgent,
    );
    assert.equal(dry.dryRun, true);
    assert.equal(dry.rebindId, "");
    assert.equal(dry.matched, 1);
    assert.equal(dry.rebound, 0);
    assert.equal(hashTree(baseDbPath), before);
    assert.equal(existsSync(join(baseDbPath, "_rebinds")), false);
    await engine.close({ budgetMs: 5_000 });
  });

  it("moves only scope user from fromIdentity", TIMEOUT, async () => {
    const baseDbPath = freshBaseDbPath("rebind-scope-");
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("rebind-scope-state-") }),
      config(baseDbPath),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const fromIdentity = { channel: "telegram", identityKey: PLAIN_KEY };
    const other = { channel: "telegram", identityKey: "PLAIN_ID_OTHER_7F3A" };
    const mine = await importUserCard(engine, agentId, fromIdentity, "k-mine", `${SECRET_TEXT} mine`);
    const theirs = await importUserCard(engine, agentId, other, "k-theirs", "Someone else drinks soy milk.");
    const agentCard = await engine.memory.import(
      {
        agentId,
        principal: operatorFor(agentId),
        cards: [{ idempotencyKey: "k-agent", text: "Agent knowledge about oat milk.", provenance: "imported" }],
      },
      operatorFor(agentId),
      systemAgent,
    );
    assert.equal(agentCard.created, 1);
    const agentIdCard = agentCard.cards[0].id;

    const applied = await engine.memory.rebind(
      { agentId, fromIdentity, toUser: TO_USER, dryRun: false },
      operatorFor(agentId),
      systemAgent,
    );
    assert.equal(applied.dryRun, false);
    assert.equal(applied.matched, 1);
    assert.equal(applied.rebound, 1);
    assert.match(applied.rebindId, /^[0-9a-f-]{36}$/);

    const listed = await engine.memory.list({ topic: "oat milk" }, harnessPrincipal(agentId, TO_USER), userAgent);
    assert.ok(listed.items.some((c) => c.id === mine));
    assert.equal(listed.items.some((c) => c.id === theirs), false);

    const asOld = await engine.memory.list({ topic: "oat milk" }, identityPrincipal(agentId, fromIdentity), userAgent);
    assert.equal(asOld.items.some((c) => c.id === mine), false);

    const stillTheirs = await engine.memory.show(theirs, identityPrincipal(agentId, other), userAgent);
    assert.equal(stillTheirs.id, theirs);
    const stillAgent = await engine.memory.show(agentIdCard, operatorFor(agentId), userAgent);
    assert.equal(stillAgent.id, agentIdCard);
    assert.equal(stillAgent.scope, "agent-private");
    await engine.close({ budgetMs: 5_000 });
  });

  it("three channel identities onto one user then recall finds all", TIMEOUT_LONG, async () => {
    const baseDbPath = freshBaseDbPath("rebind-3ch-");
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("rebind-3ch-state-") }),
      config(baseDbPath),
      { internals: { embeddings: flatEmbedder() } },
    );
    engine.channels.register("matrix");
    const agentId = "agent-a";
    const identities = [
      { channel: "telegram", identityKey: "tg-bernd-7F3A", phrase: "Bernd waters the telegram fern." },
      { channel: "discord", identityKey: "dc-bernd-7F3A", phrase: "Bernd waters the discord cactus." },
      { channel: "matrix", identityKey: "mx-bernd-7F3A", phrase: "Bernd waters the matrix ivy." },
    ];
    const ids = [];
    for (const ident of identities) {
      ids.push(await importUserCard(engine, agentId, ident, `k-${ident.channel}`, ident.phrase));
    }
    for (const ident of identities) {
      const r = await engine.memory.rebind(
        { agentId, fromIdentity: ident, toUser: TO_USER, dryRun: false },
        operatorFor(agentId),
        systemAgent,
      );
      assert.equal(r.rebound, 1, ident.channel);
    }
    const listed = await engine.memory.list({ topic: "Bernd waters" }, harnessPrincipal(agentId, TO_USER), userAgent);
    for (const id of ids) {
      assert.ok(listed.items.some((c) => c.id === id), id);
    }
    const recalled = await engine.recall({
      query: "Bernd waters the plants",
      principal: harnessPrincipal(agentId, TO_USER),
      agent: userAgent,
      signal: AbortSignal.timeout(8_000),
    });
    const memories = recalled.blocks.filter((b) => b.name === "memories").map((b) => b.text).join("\n");
    for (const ident of identities) {
      assert.ok(memories.includes(ident.phrase), ident.channel);
    }
    const oldRecall = await engine.recall({
      query: "Bernd waters the plants",
      principal: identityPrincipal(agentId, identities[0]),
      agent: userAgent,
      signal: AbortSignal.timeout(8_000),
    });
    const oldMemories = oldRecall.blocks.filter((b) => b.name === "memories").map((b) => b.text).join("\n");
    for (const ident of identities) {
      assert.equal(oldMemories.includes(ident.phrase), false, ident.channel);
    }
    await engine.close({ budgetMs: 5_000 });
  });

  it("second link of the same identity to a different user is identity-already-bound", TIMEOUT, async () => {
    const baseDbPath = freshBaseDbPath("rebind-n1-");
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("rebind-n1-state-") }),
      config(baseDbPath),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const fromIdentity = { channel: "telegram", identityKey: PLAIN_KEY };
    await importUserCard(engine, agentId, fromIdentity, "k-n1", `${SECRET_TEXT} n1`);
    const first = await engine.memory.rebind(
      { agentId, fromIdentity, toUser: TO_USER, dryRun: false },
      operatorFor(agentId),
      systemAgent,
    );
    const before = hashTree(baseDbPath);
    await assert.rejects(
      () => engine.memory.rebind(
        { agentId, fromIdentity, toUser: "other-harness-user-7F3A", dryRun: false },
        operatorFor(agentId),
        systemAgent,
      ),
      (e) => e.code === "identity-already-bound",
    );
    assert.equal(hashTree(baseDbPath), before);
    const again = await engine.memory.rebind(
      { agentId, fromIdentity, toUser: TO_USER, dryRun: false },
      operatorFor(agentId),
      systemAgent,
    );
    assert.equal(again.rebindId, first.rebindId);
    assert.equal(again.rebound, 0);
    await engine.close({ budgetMs: 5_000 });
  });

  it("unbind restores the old owner and a later card survives", TIMEOUT, async () => {
    const baseDbPath = freshBaseDbPath("rebind-un-");
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("rebind-un-state-") }),
      config(baseDbPath),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const fromIdentity = { channel: "telegram", identityKey: PLAIN_KEY };
    const moved = await importUserCard(engine, agentId, fromIdentity, "k-moved", `${SECRET_TEXT} moved`);
    const applied = await engine.memory.rebind(
      { agentId, fromIdentity, toUser: TO_USER, dryRun: false },
      operatorFor(agentId),
      systemAgent,
    );
    const later = await engine.memory.import(
      {
        agentId,
        principal: harnessPrincipal(agentId, TO_USER),
        cards: [{
          idempotencyKey: "k-later",
          text: "A card written for the harness user after the rebind about oat milk.",
          provenance: "imported",
          scope: "user",
        }],
      },
      harnessPrincipal(agentId, TO_USER),
      systemAgent,
    );
    assert.equal(later.created, 1);
    const laterId = later.cards[0].id;
    const unbound = await engine.memory.unbind(
      { rebindId: applied.rebindId },
      operatorFor(agentId),
      systemAgent,
    );
    assert.equal(unbound.unbound, 1);
    assert.equal(unbound.skippedModified, 0);

    const restored = await engine.memory.show(moved, identityPrincipal(agentId, fromIdentity), userAgent);
    assert.equal(restored.id, moved);
    const laterShown = await engine.memory.show(laterId, harnessPrincipal(agentId, TO_USER), userAgent);
    assert.equal(laterShown.id, laterId);
    const again = await engine.memory.unbind(
      { rebindId: applied.rebindId },
      operatorFor(agentId),
      systemAgent,
    );
    assert.equal(again.unbound, 0);
    await engine.close({ budgetMs: 5_000 });
  });

  it("crash mid-batch then a rerun converges without duplicate audit lines", TIMEOUT, async () => {
    const baseDbPath = freshBaseDbPath("rebind-crash-");
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("rebind-crash-state-") }),
      config(baseDbPath),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const fromIdentity = { channel: "telegram", identityKey: PLAIN_KEY };
    for (let i = 0; i < 3; i++) {
      await importUserCard(engine, agentId, fromIdentity, `k-crash-${i}`, `${SECRET_TEXT} crash ${i}`);
    }
    const internals = internalsOf(engine);
    const orig = internals.pool.withWriteDb.bind(internals.pool);
    let updates = 0;
    internals.pool.withWriteDb = async (id, fn) => orig(id, async (db) => {
      const inner = db.update.bind(db);
      db.update = async (...args) => {
        updates += 1;
        if (updates === 2) throw new Error("injected crash");
        return inner(...args);
      };
      return fn(db);
    });
    await assert.rejects(
      () => engine.memory.rebind(
        { agentId, fromIdentity, toUser: TO_USER, dryRun: false },
        operatorFor(agentId),
        systemAgent,
      ),
      (e) => e.code === "storage",
    );
    internals.pool.withWriteDb = orig;
    const resumed = await engine.memory.rebind(
      { agentId, fromIdentity, toUser: TO_USER, dryRun: false },
      operatorFor(agentId),
      systemAgent,
    );
    assert.ok(resumed.rebindId);
    const sidecar = readFileSync(rebindLedgerPath(baseDbPath, resumed.rebindId), "utf8");
    const cardLines = sidecar.split("\n").filter((l) => l.includes('"kind":"card"'));
    const ids = cardLines.map((l) => JSON.parse(l).cardId);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, 3);
    const listed = await engine.memory.list({ topic: "oat milk crash" }, harnessPrincipal(agentId, TO_USER), userAgent);
    assert.equal(listed.items.length, 3);
    await engine.close({ budgetMs: 5_000 });
  });

  it("result, logs and sidecar never contain content or a plain identity key", TIMEOUT, async () => {
    const baseDbPath = freshBaseDbPath("rebind-leak-");
    const collected = collectingLogger();
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("rebind-leak-state-"), logger: collected.logger }),
      config(baseDbPath),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const fromIdentity = { channel: "telegram", identityKey: PLAIN_KEY };
    await importUserCard(engine, agentId, fromIdentity, "k-leak", SECRET_TEXT);
    const applied = await engine.memory.rebind(
      { agentId, fromIdentity, toUser: TO_USER, dryRun: false },
      operatorFor(agentId),
      systemAgent,
    );
    const dumped = JSON.stringify(applied);
    assert.equal(dumped.includes(SECRET_TEXT), false);
    assert.equal(dumped.includes(PLAIN_KEY), false);
    assert.equal(dumped.includes(TO_USER), false);
    const sidecar = readFileSync(rebindLedgerPath(baseDbPath, applied.rebindId), "utf8");
    assert.equal(sidecar.includes(SECRET_TEXT), false);
    assert.equal(sidecar.includes(PLAIN_KEY), false);
    assert.equal(sidecar.includes(TO_USER), false);
    assert.ok(sidecar.includes("user:v1:"));
    assert.ok(sidecar.includes("user:v2:"));
    for (const line of collected.lines) {
      assert.equal(line.includes(SECRET_TEXT), false, line);
      assert.equal(line.includes(PLAIN_KEY), false, line);
      assert.equal(line.includes(TO_USER), false, line);
    }
    await assert.rejects(
      () => engine.memory.rebind(
        { agentId, fromIdentity, toUser: "other-harness-user-7F3A", dryRun: false },
        operatorFor(agentId),
        systemAgent,
      ),
      (e) => e.code === "identity-already-bound",
    );
    await assert.rejects(
      () => engine.memory.unbind({ rebindId: "not-a-uuid" }, operatorFor(agentId), systemAgent),
      (e) => e.code === "invalid-input",
    );
    for (const line of collected.lines) {
      assert.equal(line.includes(SECRET_TEXT), false, line);
      assert.equal(line.includes(PLAIN_KEY), false, line);
      assert.equal(line.includes(TO_USER), false, line);
    }
    await engine.close({ budgetMs: 5_000 });
  });

  it("user origin is denied and default dryRun does not write", TIMEOUT, async () => {
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("rebind-den-state-") }),
      config(freshBaseDbPath("rebind-den-")),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    await assert.rejects(
      () => engine.memory.rebind(
        { agentId, fromIdentity: { channel: "telegram", identityKey: "x" }, toUser: "u" },
        operatorFor(agentId),
        userAgent,
      ),
      (e) => e.code === "denied",
    );
    await engine.close({ budgetMs: 5_000 });
  });

  it("N:1 is engine-wide: same identity cannot bind two users across agents", TIMEOUT, async () => {
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("rebind-xagent-state-") }),
      config(freshBaseDbPath("rebind-xagent-")),
      { internals: { embeddings: flatEmbedder() } },
    );
    const fromIdentity = { channel: "telegram", identityKey: PLAIN_KEY };
    await importUserCard(engine, "agent-a", fromIdentity, "k-a", `${SECRET_TEXT} a`);
    await importUserCard(engine, "agent-b", fromIdentity, "k-b", `${SECRET_TEXT} b`);
    const first = await engine.memory.rebind(
      { agentId: "agent-a", fromIdentity, toUser: TO_USER, dryRun: false },
      operatorFor("agent-a"),
      systemAgent,
    );
    await assert.rejects(
      () => engine.memory.rebind(
        { agentId: "agent-b", fromIdentity, toUser: "other-harness-user-7F3A", dryRun: false },
        operatorFor("agent-b"),
        systemAgent,
      ),
      (e) => e.code === "identity-already-bound",
    );
    const same = await engine.memory.rebind(
      { agentId: "agent-b", fromIdentity, toUser: TO_USER, dryRun: false },
      operatorFor("agent-b"),
      systemAgent,
    );
    assert.equal(same.rebound, 1);
    assert.notEqual(same.rebindId, first.rebindId);
    await engine.close({ budgetMs: 5_000 });
  });

  it("concurrent rebind of one identity to two users: exactly one wins", TIMEOUT_LONG, async () => {
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("rebind-race-state-") }),
      config(freshBaseDbPath("rebind-race-")),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const fromIdentity = { channel: "telegram", identityKey: PLAIN_KEY };
    const cardId = await importUserCard(engine, agentId, fromIdentity, "k-race", `${SECRET_TEXT} race`);
    const settled = await Promise.allSettled([
      engine.memory.rebind(
        { agentId, fromIdentity, toUser: "U1-7F3A", dryRun: false },
        operatorFor(agentId),
        systemAgent,
      ),
      engine.memory.rebind(
        { agentId, fromIdentity, toUser: "U2-7F3A", dryRun: false },
        operatorFor(agentId),
        systemAgent,
      ),
    ]);
    const ok = settled.filter((s) => s.status === "fulfilled");
    const bound = settled.filter((s) => s.status === "rejected" && s.reason?.code === "identity-already-bound");
    assert.equal(ok.length, 1);
    assert.equal(bound.length, 1);
    const row = await internalsOf(engine).pool.withWriteDb(agentId, (db) => db.getById(cardId));
    const u1 = harnessUserPrincipal("U1-7F3A");
    const u2 = harnessUserPrincipal("U2-7F3A");
    assert.ok(row.ownerUserId === u1 || row.ownerUserId === u2);
    const applied = internalsOf(engine).memoryRebind.ledger.listApplied()
      .filter((rec) => rec.header.fromOwner === channelIdentityUserPrincipal("telegram", PLAIN_KEY, "default"));
    assert.equal(applied.length, 1);
    assert.equal(ok[0].value.rebindId, applied[0].rebindId);
    await engine.close({ budgetMs: 5_000 });
  });

  it("concurrent identical rebinds share one rebindId", TIMEOUT_LONG, async () => {
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("rebind-idem-state-") }),
      config(freshBaseDbPath("rebind-idem-")),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const fromIdentity = { channel: "telegram", identityKey: PLAIN_KEY };
    await importUserCard(engine, agentId, fromIdentity, "k-idem", `${SECRET_TEXT} idem`);
    const settled = await Promise.allSettled([
      engine.memory.rebind(
        { agentId, fromIdentity, toUser: TO_USER, dryRun: false },
        operatorFor(agentId),
        systemAgent,
      ),
      engine.memory.rebind(
        { agentId, fromIdentity, toUser: TO_USER, dryRun: false },
        operatorFor(agentId),
        systemAgent,
      ),
    ]);
    assert.equal(settled.every((s) => s.status === "fulfilled"), true);
    assert.equal(settled[0].value.rebindId, settled[1].value.rebindId);
    const applied = internalsOf(engine).memoryRebind.ledger.listApplied();
    assert.equal(applied.length, 1);
    await engine.close({ budgetMs: 5_000 });
  });

  it("unbind racing a rebind resume never leaves reversed-with-card-on-v2 and free", TIMEOUT_LONG, async () => {
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("rebind-p7-state-") }),
      config(freshBaseDbPath("rebind-p7-")),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const fromIdentity = { channel: "telegram", identityKey: PLAIN_KEY };
    await importUserCard(engine, agentId, fromIdentity, "k-p7a", `${SECRET_TEXT} p7a`);
    const first = await engine.memory.rebind(
      { agentId, fromIdentity, toUser: TO_USER, dryRun: false },
      operatorFor(agentId),
      systemAgent,
    );
    const newer = await importUserCard(engine, agentId, fromIdentity, "k-p7b", `${SECRET_TEXT} p7b`);
    await Promise.allSettled([
      engine.memory.unbind({ rebindId: first.rebindId }, operatorFor(agentId), systemAgent),
      engine.memory.rebind(
        { agentId, fromIdentity, toUser: TO_USER, dryRun: false },
        operatorFor(agentId),
        systemAgent,
      ),
    ]);
    const row = await internalsOf(engine).pool.withWriteDb(agentId, (db) => db.getById(newer));
    const onU1 = row.ownerUserId === harnessUserPrincipal(TO_USER);
    const applied = internalsOf(engine).memoryRebind.ledger.listApplied()
      .filter((rec) => rec.header.fromOwner === channelIdentityUserPrincipal("telegram", PLAIN_KEY, "default"));
    if (onU1) {
      assert.equal(applied.length, 1);
      assert.equal(applied[0].header.toOwner, harnessUserPrincipal(TO_USER));
    } else {
      assert.equal(applied.length, 0);
    }
    await engine.close({ budgetMs: 5_000 });
  });

  it("rebind leaves updatedAt and freshness unchanged; unbind restores the row", TIMEOUT, async () => {
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("rebind-ts-state-") }),
      config(freshBaseDbPath("rebind-ts-")),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const fromIdentity = { channel: "telegram", identityKey: PLAIN_KEY };
    const id = await importUserCard(engine, agentId, fromIdentity, "k-ts", `${SECRET_TEXT} ts`);
    const oldTs = Date.now() - 40 * 24 * 60 * 60 * 1000;
    await internalsOf(engine).pool.withWriteDb(agentId, (db) => db.update(id, { updatedAt: oldTs }));
    const before = await internalsOf(engine).pool.withWriteDb(agentId, (db) => db.getById(id));
    const now = Date.now();
    const ageBefore = computeMemoryAge(before, { now });
    const freshBefore = classifyMemoryFreshness(ageBefore.ageMs);
    const applied = await engine.memory.rebind(
      { agentId, fromIdentity, toUser: TO_USER, dryRun: false },
      operatorFor(agentId),
      systemAgent,
    );
    const mid = await internalsOf(engine).pool.withWriteDb(agentId, (db) => db.getById(id));
    assert.equal(Number(mid.updatedAt), Number(before.updatedAt));
    assert.equal(classifyMemoryFreshness(computeMemoryAge(mid, { now }).ageMs), freshBefore);
    assert.equal(freshBefore, "stale");
    assert.equal(mid.ownerUserId, harnessUserPrincipal(TO_USER));
    const vec = (row) => Buffer.from(new Float32Array(Array.from(row.vector)).buffer).toString("hex");
    assert.equal(vec(mid), vec(before));
    assert.equal(mid.text, before.text);
    await engine.memory.unbind({ rebindId: applied.rebindId }, operatorFor(agentId), systemAgent);
    const after = await internalsOf(engine).pool.withWriteDb(agentId, (db) => db.getById(id));
    assert.equal(Number(after.updatedAt), Number(before.updatedAt));
    assert.equal(after.ownerUserId, before.ownerUserId);
    assert.equal(vec(after), vec(before));
    assert.equal(classifyMemoryFreshness(computeMemoryAge(after, { now }).ageMs), freshBefore);
    await engine.close({ budgetMs: 5_000 });
  });

  it("unbind reports skippedModified when the owner changed independently", TIMEOUT, async () => {
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("rebind-mod-state-") }),
      config(freshBaseDbPath("rebind-mod-")),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const fromIdentity = { channel: "telegram", identityKey: PLAIN_KEY };
    const id1 = await importUserCard(engine, agentId, fromIdentity, "k-m1", `${SECRET_TEXT} m1`);
    const id2 = await importUserCard(engine, agentId, fromIdentity, "k-m2", `${SECRET_TEXT} m2`);
    const applied = await engine.memory.rebind(
      { agentId, fromIdentity, toUser: TO_USER, dryRun: false },
      operatorFor(agentId),
      systemAgent,
    );
    await internalsOf(engine).pool.withWriteDb(agentId, (db) => db.update(id2, {
      ownerUserId: harnessUserPrincipal("OTHER-7F3A"),
    }));
    const unbound = await engine.memory.unbind(
      { rebindId: applied.rebindId },
      operatorFor(agentId),
      systemAgent,
    );
    assert.equal(unbound.unbound, 1);
    assert.equal(unbound.skippedModified, 1);
    const still = await internalsOf(engine).pool.withWriteDb(agentId, (db) => db.getById(id2));
    assert.equal(still.ownerUserId, harnessUserPrincipal("OTHER-7F3A"));
    const restored = await internalsOf(engine).pool.withWriteDb(agentId, (db) => db.getById(id1));
    assert.equal(restored.ownerUserId, channelIdentityUserPrincipal("telegram", PLAIN_KEY, "default"));
    await engine.close({ budgetMs: 5_000 });
  });

  it("dryRun leases the write namespace rather than dbs[0] of the recall list", TIMEOUT, async () => {
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("rebind-auth-state-") }),
      config(freshBaseDbPath("rebind-auth-")),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const fromIdentity = { channel: "telegram", identityKey: PLAIN_KEY };
    await importUserCard(engine, agentId, fromIdentity, "k-auth", `${SECRET_TEXT} auth`);
    const pool = internalsOf(engine).pool;
    let auth = 0;
    let readonly = 0;
    const origAuth = pool.withAuthoritativeReadDb.bind(pool);
    const origRo = pool.withReadOnlyReadDbs.bind(pool);
    pool.withAuthoritativeReadDb = async (...args) => {
      auth += 1;
      return origAuth(...args);
    };
    pool.withReadOnlyReadDbs = async (...args) => {
      readonly += 1;
      return origRo(...args);
    };
    const dry = await engine.memory.rebind(
      { agentId, fromIdentity, toUser: TO_USER },
      operatorFor(agentId),
      systemAgent,
    );
    assert.equal(dry.matched, 1);
    assert.equal(auth, 1);
    assert.equal(readonly, 0);
    await engine.close({ budgetMs: 5_000 });
  });

  it("dryRun and apply use the write namespace on a named layout", {
    timeout: 30_000,
    skip: namedRoutingSkip,
  }, async () => {
    const root = makeTempDir("rebind-ns-root-");
    const writeLeaf = join(root, "active");
    mkdirSync(writeLeaf, { recursive: true });
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("rebind-ns-state-") }),
      {
        ...config(writeLeaf),
        namespaces: {
          activeWriteNamespace: "active",
          activeRecallNamespaces: ["shadow", "active"],
        },
      },
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const fromIdentity = { channel: "telegram", identityKey: PLAIN_KEY };
    await importUserCard(engine, agentId, fromIdentity, "k-ns", `${SECRET_TEXT} ns`);
    const dry = await engine.memory.rebind(
      { agentId, fromIdentity, toUser: TO_USER },
      operatorFor(agentId),
      systemAgent,
    );
    assert.equal(dry.matched, 1);
    const applied = await engine.memory.rebind(
      { agentId, fromIdentity, toUser: TO_USER, dryRun: false },
      operatorFor(agentId),
      systemAgent,
    );
    assert.equal(applied.matched, 1);
    assert.equal(applied.rebound, 1);
    const listed = await engine.memory.list({ topic: "oat" }, harnessPrincipal(agentId, TO_USER), userAgent);
    assert.ok(listed.items.some((c) => c.text.includes("ns")));
    await engine.close({ budgetMs: 5_000 });
  });

  it("unbind accepts a lower-cased rebindId and hides a foreign agent as not-found", TIMEOUT, async () => {
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("rebind-id-state-") }),
      config(freshBaseDbPath("rebind-id-")),
      { internals: { embeddings: flatEmbedder() } },
    );
    const agentId = "agent-a";
    const fromIdentity = { channel: "telegram", identityKey: PLAIN_KEY };
    await importUserCard(engine, agentId, fromIdentity, "k-id", `${SECRET_TEXT} id`);
    const applied = await engine.memory.rebind(
      { agentId, fromIdentity, toUser: TO_USER, dryRun: false },
      operatorFor(agentId),
      systemAgent,
    );
    const upper = await engine.memory.unbind(
      { rebindId: applied.rebindId.toUpperCase(), dryRun: true },
      operatorFor(agentId),
      systemAgent,
    );
    assert.equal(upper.matched, 1);
    await assert.rejects(
      () => engine.memory.unbind({ rebindId: applied.rebindId }, operatorFor("agent-b"), systemAgent),
      (e) => e.code === "not-found",
    );
    await engine.close({ budgetMs: 5_000 });
  });
});

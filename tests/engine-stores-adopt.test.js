/**
 * tests/engine-stores-adopt.test.js — contract 1.11.0 `Engine.stores.adopt`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { schemaMarkerPath, writeStoreSchemaMarker } from "../engine/store/schema-version.js";

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

function embedder(axis) {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === axis ? 1 : 0));
  const one = async () => vector();
  return { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (texts) => texts.map(vector), shutdown: async () => {} };
}

function principalFor(agentId) {
  return { agentId, workspace: "workspace:v1:main", channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" };
}

const systemAgent = { origin: "system", background: false };

async function seed(engine, agentId, n = 3) {
  const cards = Array.from({ length: n }, (_, i) => ({
    idempotencyKey: `seed-${i}`,
    text: `Stored probe sentence number ${i} about the greenhouse heater.`,
    provenance: "imported",
  }));
  const result = await engine.memory.import(
    { agentId, principal: principalFor(agentId), cards },
    principalFor(agentId),
    systemAgent,
  );
  assert.equal(result.created, n, `seed created ${result.created} of ${n}: ${JSON.stringify(result.cards)}`);
}

describe("Engine.stores.adopt", () => {
  it("same-model legacy store is ok via probe", async () => {
    const baseDbPath = freshBaseDbPath("adopt-ok-");
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-ok-state-") }),
      config(baseDbPath),
      { internals: { embeddings: embedder(0) } },
    );
    await seed(engine, "agent-a", 3);
    const identity = engine.embedding.identities()[0];
    const result = await engine.stores.adopt({ path: baseDbPath, expectedIdentity: identity });
    assert.equal(result.verdict, "ok");
    assert.equal(result.identitySource, "probe");
    assert.equal(result.reason, undefined);
    assert.deepEqual(result.storeSchema, { current: "1", expected: "1" });
    await engine.close({ budgetMs: 5_000 });
  });

  it("a different model with the same dimension is identity-mismatch", async () => {
    const root = makeTempDir("adopt-mm-root-");
    const baseDbPath = join(root, "lancedb-namespaced");
    const first = createEngine(
      createStubHost({ stateDir: join(root, "state-a") }),
      config(baseDbPath),
      { internals: { embeddings: embedder(0) } },
    );
    await seed(first, "agent-a", 3);
    await first.close({ budgetMs: 5_000 });

    const second = createEngine(
      createStubHost({ stateDir: join(root, "state-b") }),
      config(baseDbPath),
      { internals: { embeddings: embedder(1) } },
    );
    const identity = second.embedding.identities()[0];
    const result = await second.stores.adopt({ path: baseDbPath, expectedIdentity: identity });
    assert.equal(result.verdict, "incompatible");
    assert.equal(result.reason, "identity-mismatch");
    assert.equal(result.identitySource, "probe");
    await second.close({ budgetMs: 5_000 });
  });

  it("an empty store is identity-unverifiable", async () => {
    const baseDbPath = freshBaseDbPath("adopt-empty-");
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-empty-state-") }),
      config(baseDbPath),
      { internals: { embeddings: embedder(0) } },
    );
    const result = await engine.stores.adopt({
      path: baseDbPath,
      expectedIdentity: engine.embedding.identities()[0],
    });
    assert.equal(result.verdict, "incompatible");
    assert.equal(result.reason, "identity-unverifiable");
    assert.equal(result.identitySource, "probe");
    await engine.close({ budgetMs: 5_000 });
  });

  it("a directory without marker or tables is not-a-store", async () => {
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-nas-state-") }),
      config(freshBaseDbPath("adopt-nas-engine-")),
      { internals: { embeddings: embedder(0) } },
    );
    const other = makeTempDir("adopt-nas-dir-");
    const result = await engine.stores.adopt({
      path: other,
      expectedIdentity: engine.embedding.identities()[0],
    });
    assert.equal(result.verdict, "incompatible");
    assert.equal(result.reason, "not-a-store");
    await engine.close({ budgetMs: 5_000 });
  });

  it("schema 0 vs engine 1 is schema-mismatch; unreadable marker is schema-unreadable", async () => {
    const baseDbPath = freshBaseDbPath("adopt-schema-");
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-schema-state-") }),
      config(baseDbPath),
      { internals: { embeddings: embedder(0) } },
    );
    await seed(engine, "agent-a", 2);
    writeStoreSchemaMarker(baseDbPath, "0");
    const mismatch = await engine.stores.adopt({
      path: baseDbPath,
      expectedIdentity: engine.embedding.identities()[0],
    });
    assert.equal(mismatch.verdict, "incompatible");
    assert.equal(mismatch.reason, "schema-mismatch");
    assert.deepEqual(mismatch.storeSchema, { current: "0", expected: "1" });

    writeFileSync(schemaMarkerPath(baseDbPath), "not json");
    const unreadable = await engine.stores.adopt({
      path: baseDbPath,
      expectedIdentity: engine.embedding.identities()[0],
    });
    assert.equal(unreadable.reason, "schema-unreadable");
    await engine.close({ budgetMs: 5_000 });
  });

  it("dryRun does not rewrite the schema marker", async () => {
    const baseDbPath = freshBaseDbPath("adopt-dry-");
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-dry-state-") }),
      config(baseDbPath),
      { internals: { embeddings: embedder(0) } },
    );
    await seed(engine, "agent-a", 2);
    const before = readFileSync(schemaMarkerPath(baseDbPath));
    const result = await engine.stores.adopt({
      path: baseDbPath,
      expectedIdentity: engine.embedding.identities()[0],
      dryRun: true,
    });
    assert.equal(result.verdict, "ok");
    assert.equal(result.dryRun, true);
    assert.deepEqual(readFileSync(schemaMarkerPath(baseDbPath)), before);
    await engine.close({ budgetMs: 5_000 });
  });

  it("relative path is invalid-input; missing path is path-unreadable", async () => {
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-path-state-") }),
      config(freshBaseDbPath("adopt-path-")),
      { internals: { embeddings: embedder(0) } },
    );
    const identity = engine.embedding.identities()[0];
    await assert.rejects(
      () => engine.stores.adopt({ path: "relative/store", expectedIdentity: identity }),
      (e) => e.code === "invalid-input",
    );
    const missing = await engine.stores.adopt({
      path: join(makeTempDir("adopt-missing-"), "no-such-store"),
      expectedIdentity: identity,
    });
    assert.equal(missing.reason, "path-unreadable");
    await engine.close({ budgetMs: 5_000 });
  });

  it("a store at a foreign path is probed through a read-only pool", async () => {
    const seeded = freshBaseDbPath("adopt-copy-src-");
    const first = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-copy-src-state-") }),
      config(seeded),
      { internals: { embeddings: embedder(0) } },
    );
    await seed(first, "agent-a", 3);
    await first.close({ budgetMs: 5_000 });

    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-copy-dst-state-") }),
      config(freshBaseDbPath("adopt-copy-dst-")),
      { internals: { embeddings: embedder(0) } },
    );
    const result = await engine.stores.adopt({
      path: seeded,
      expectedIdentity: engine.embedding.identities()[0],
    });
    assert.equal(result.verdict, "ok");
    assert.equal(result.identitySource, "probe");
    await engine.close({ budgetMs: 5_000 });
  });

  it("matching generation.json plus probe still reports probe when rows exist", async () => {
    const baseDbPath = freshBaseDbPath("adopt-gen-");
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-gen-state-") }),
      config(baseDbPath),
      { internals: { embeddings: embedder(0) } },
    );
    await seed(engine, "agent-a", 2);
    const identity = engine.embedding.identities()[0];
    const genDir = join(baseDbPath, "generations", "g1");
    mkdirSync(genDir, { recursive: true });
    writeFileSync(join(genDir, "generation.json"), JSON.stringify({
      schemaVersion: 1,
      generation: "g1",
      fingerprintId: identity.fingerprintId,
      provider: identity.provider,
      model: identity.model,
      dimensions: identity.dimensions,
      tables: {},
    }));
    const result = await engine.stores.adopt({ path: baseDbPath, expectedIdentity: identity });
    assert.equal(result.verdict, "ok");
    assert.equal(result.identitySource, "probe");
    await engine.close({ budgetMs: 5_000 });
  });
});

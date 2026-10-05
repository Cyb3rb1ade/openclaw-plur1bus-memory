/**
 * tests/engine-stores-adopt.test.js — contract 1.11.0 `Engine.stores.adopt`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";

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
  it("same-model legacy store is ok via probe (3 rows, floor min(8, available))", { timeout: 30_000 }, async () => {
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

  it("same-model legacy store is ok via probe with 20 rows", { timeout: 60_000 }, async () => {
    const baseDbPath = freshBaseDbPath("adopt-ok20-");
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-ok20-state-") }),
      config(baseDbPath),
      { internals: { embeddings: embedder(0) } },
    );
    await seed(engine, "agent-a", 20);
    const identity = engine.embedding.identities()[0];
    const result = await engine.stores.adopt({ path: baseDbPath, expectedIdentity: identity });
    assert.equal(result.verdict, "ok");
    assert.equal(result.identitySource, "probe");
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

  it("zero-norm and NaN stored vectors are never ok", async () => {
    function zeroEmbedder() {
      const vector = () => Array.from({ length: 384 }, () => 0);
      const one = async () => vector();
      return { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (texts) => texts.map(vector), shutdown: async () => {} };
    }
    function nanEmbedder() {
      const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? Number.NaN : 0));
      const one = async () => vector();
      return { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (texts) => texts.map(vector), shutdown: async () => {} };
    }
    const zeroPath = freshBaseDbPath("adopt-zero-");
    const zeroEngine = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-zero-state-") }),
      config(zeroPath),
      { internals: { embeddings: zeroEmbedder() } },
    );
    await seed(zeroEngine, "agent-a", 3);
    const zeroResult = await zeroEngine.stores.adopt({
      path: zeroPath,
      expectedIdentity: zeroEngine.embedding.identities()[0],
    });
    assert.equal(zeroResult.verdict, "incompatible");
    assert.notEqual(zeroResult.reason, undefined);
    assert.notEqual(zeroResult.verdict, "ok");
    await zeroEngine.close({ budgetMs: 5_000 });

    const nanPath = freshBaseDbPath("adopt-nan-");
    const nanEngine = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-nan-state-") }),
      config(nanPath),
      { internals: { embeddings: nanEmbedder() } },
    );
    await seed(nanEngine, "agent-a", 3);
    const nanResult = await nanEngine.stores.adopt({
      path: nanPath,
      expectedIdentity: nanEngine.embedding.identities()[0],
    });
    assert.equal(nanResult.verdict, "incompatible");
    assert.notEqual(nanResult.verdict, "ok");
    await nanEngine.close({ budgetMs: 5_000 });
  });

  it("cosine 0.99 is identity-mismatch", async () => {
    function cosineEmbedder(cosine) {
      const vector = () => {
        const v = Array.from({ length: 384 }, () => 0);
        v[0] = cosine;
        v[1] = Math.sqrt(Math.max(0, 1 - cosine * cosine));
        return v;
      };
      const one = async () => vector();
      return { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (texts) => texts.map(vector), shutdown: async () => {} };
    }
    const root = makeTempDir("adopt-099-root-");
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
      { internals: { embeddings: cosineEmbedder(0.99) } },
    );
    const result = await second.stores.adopt({
      path: baseDbPath,
      expectedIdentity: second.embedding.identities()[0],
    });
    assert.equal(result.verdict, "incompatible");
    assert.equal(result.reason, "identity-mismatch");
    assert.equal(result.identitySource, "probe");
    await second.close({ budgetMs: 5_000 });
  });

  it("probe path mismatches when expectedIdentity fingerprint differs", async () => {
    const baseDbPath = freshBaseDbPath("adopt-fp-");
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-fp-state-") }),
      config(baseDbPath),
      { internals: { embeddings: embedder(0) } },
    );
    await seed(engine, "agent-a", 2);
    const identity = engine.embedding.identities()[0];
    const result = await engine.stores.adopt({
      path: baseDbPath,
      expectedIdentity: { ...identity, fingerprintId: `embedding:v1:sha256:${"0".repeat(64)}` },
    });
    assert.equal(result.verdict, "incompatible");
    assert.equal(result.reason, "identity-mismatch");
    await engine.close({ budgetMs: 5_000 });
  });

  it("symlinked root, symlinked table, and .. segments are invalid-input", async () => {
    const baseDbPath = freshBaseDbPath("adopt-sym-");
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-sym-state-") }),
      config(baseDbPath),
      { internals: { embeddings: embedder(0) } },
    );
    await seed(engine, "agent-a", 2);
    const identity = engine.embedding.identities()[0];
    const link = join(makeTempDir("adopt-sym-link-"), "store-link");
    try {
      symlinkSync(baseDbPath, link);
      await assert.rejects(
        () => engine.stores.adopt({ path: link, expectedIdentity: identity }),
        (e) => e.code === "invalid-input",
      );
    } catch (err) {
      if (err?.code !== "EPERM" && err?.code !== "EACCES") throw err;
    }
    const viaDotDot = `${baseDbPath}${sep}..${sep}${basename(baseDbPath)}`;
    await assert.rejects(
      () => engine.stores.adopt({ path: viaDotDot, expectedIdentity: identity }),
      (e) => e.code === "invalid-input",
    );
    await engine.close({ budgetMs: 5_000 });

    const childRoot = makeTempDir("adopt-sym-child-root-");
    const childStore = join(childRoot, "lancedb-namespaced");
    const childEngine = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-sym-child-state-") }),
      config(childStore),
      { internals: { embeddings: embedder(0) } },
    );
    await seed(childEngine, "agent-a", 2);
    await childEngine.close({ budgetMs: 5_000 });
    const lance = join(childStore, "agent-a", "memories.lance");
    const moved = join(childRoot, "memories.lance");
    renameSync(lance, moved);
    try {
      symlinkSync(moved, lance);
      const childEngine2 = createEngine(
        createStubHost({ stateDir: makeTempDir("adopt-sym-child2-state-") }),
        config(freshBaseDbPath("adopt-sym-child2-eng-")),
        { internals: { embeddings: embedder(0) } },
      );
      const childResult = await childEngine2.stores.adopt({
        path: childStore,
        expectedIdentity: childEngine2.embedding.identities()[0],
      });
      assert.equal(childResult.verdict, "incompatible");
      await childEngine2.close({ budgetMs: 5_000 });
    } catch (err) {
      if (err?.code !== "EPERM" && err?.code !== "EACCES") throw err;
    }
  });

  it("adopt does not change the store tree hash", async () => {
    function treeFingerprint(root) {
      const entries = [];
      const walk = (dir, rel) => {
        let names;
        try {
          names = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        names.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of names) {
          const relPath = rel ? `${rel}/${entry.name}` : entry.name;
          const full = join(dir, entry.name);
          if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full, relPath);
          else if (entry.isFile()) {
            const st = statSync(full);
            entries.push(`${relPath}:${st.size}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
          }
        }
      };
      walk(root, "");
      return entries.join("\n");
    }
    const baseDbPath = freshBaseDbPath("adopt-hash-");
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-hash-state-") }),
      config(baseDbPath),
      { internals: { embeddings: embedder(0) } },
    );
    await seed(engine, "agent-a", 2);
    const before = treeFingerprint(baseDbPath);
    const dry = await engine.stores.adopt({
      path: baseDbPath,
      expectedIdentity: engine.embedding.identities()[0],
      dryRun: true,
    });
    assert.equal(dry.verdict, "ok");
    assert.equal(treeFingerprint(baseDbPath), before);
    const applied = await engine.stores.adopt({
      path: baseDbPath,
      expectedIdentity: engine.embedding.identities()[0],
    });
    assert.equal(applied.verdict, "ok");
    assert.equal(treeFingerprint(baseDbPath), before);
    await engine.close({ budgetMs: 5_000 });
  });

  it("generation layout: mismatch, unreadable, and tables under generations/<id>/", async () => {
    const identityOf = (engine) => engine.embedding.identities()[0];

    const mmPath = freshBaseDbPath("adopt-gen-mm-");
    const mmEngine = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-gen-mm-state-") }),
      config(mmPath),
      { internals: { embeddings: embedder(0) } },
    );
    const mmIdentity = identityOf(mmEngine);
    const mmDir = join(mmPath, "generations", "g1");
    mkdirSync(mmDir, { recursive: true });
    writeFileSync(join(mmDir, "generation.json"), JSON.stringify({
      schemaVersion: 1,
      generation: "g1",
      fingerprintId: `embedding:v1:sha256:${"ab".repeat(32)}`,
      provider: mmIdentity.provider,
      model: mmIdentity.model,
      dimensions: mmIdentity.dimensions,
      tables: {},
    }));
    const mm = await mmEngine.stores.adopt({ path: mmPath, expectedIdentity: mmIdentity });
    assert.equal(mm.verdict, "incompatible");
    assert.equal(mm.reason, "identity-mismatch");
    assert.equal(mm.identitySource, "manifest");

    writeFileSync(join(mmDir, "generation.json"), JSON.stringify({
      schemaVersion: 1,
      generation: "g1",
      fingerprintId: mmIdentity.fingerprintId,
      provider: mmIdentity.provider,
      model: mmIdentity.model,
      dimensions: mmIdentity.dimensions + 1,
      tables: {},
    }));
    const dim = await mmEngine.stores.adopt({ path: mmPath, expectedIdentity: mmIdentity });
    assert.equal(dim.reason, "dimension-mismatch");

    writeFileSync(join(mmDir, "generation.json"), "not json");
    const unread = await mmEngine.stores.adopt({ path: mmPath, expectedIdentity: mmIdentity });
    assert.equal(unread.reason, "identity-unreadable");
    await mmEngine.close({ budgetMs: 5_000 });

    const genPath = freshBaseDbPath("adopt-gen-real-");
    const genEngine = createEngine(
      createStubHost({ stateDir: makeTempDir("adopt-gen-real-state-") }),
      config(genPath),
      { internals: { embeddings: embedder(0) } },
    );
    await seed(genEngine, "agent-a", 3);
    const genIdentity = identityOf(genEngine);
    const genDir = join(genPath, "generations", "g1");
    mkdirSync(genDir, { recursive: true });
    renameSync(join(genPath, "agent-a"), join(genDir, "agent-a"));
    writeFileSync(join(genDir, "generation.json"), JSON.stringify({
      schemaVersion: 1,
      generation: "g1",
      fingerprintId: genIdentity.fingerprintId,
      provider: genIdentity.provider,
      model: genIdentity.model,
      dimensions: genIdentity.dimensions,
      tables: {},
    }));
    const moved = await genEngine.stores.adopt({ path: genPath, expectedIdentity: genIdentity });
    assert.equal(moved.verdict, "ok");
    assert.equal(moved.identitySource, "probe");
    await genEngine.close({ budgetMs: 5_000 });
  });
});

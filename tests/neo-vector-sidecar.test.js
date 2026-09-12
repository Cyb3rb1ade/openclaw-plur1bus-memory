import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNeoStore, transitionRecordStatus, migrateInlineVectorsToSidecar } from "../lib/neo-arch.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// 7.12.26: Vektoren liegen als Float32 im Sidecar, nicht mehr in den JSONL-Zeilen.
// Testwerte sind bewusst float32-exakt (dyadische Brueche), damit deepStrictEqual
// gegen die Eingabe bestehen kann.
const V1 = [0.25, -0.5, 0.125, 1];
const V2 = [0.75, 0.0625, -0.375, -1];

function makeRoot(prefix) {
  const root = makeTempDir(prefix);
  return root;
}

function candidate(id, statement, extra = {}) {
  return {
    id,
    workspaceKey: "ws",
    agentId: "bernhardine",
    statement,
    normalizedStatement: statement.toLowerCase(),
    sourceTurnIds: ["turn-1"],
    status: "candidate",
    embeddingStatus: "pending",
    impact: "low",
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

async function drainWith(store, vector) {
  return store.drainEmbeddingQueue({ impact: "low", maxItems: 50, embedder: () => vector, dimensions: vector.length });
}

describe("neo vector sidecar", () => {
  it("drain writes the vector to the sidecar and keeps the JSONL line free of it", async () => {
    const root = makeRoot("neo-sidecar-drain-");
    try {
      const store = createNeoStore(root, "ws");
      const item = candidate("mem-1", "Eva mag Tee.");
      store.appendCandidates([item]);
      store.appendEmbeddingQueue([item]);
      const result = await drainWith(store, V1);
      assert.equal(result.processed, 1);

      const raw = readFileSync(store.paths.candidates, "utf8");
      assert.doesNotMatch(raw, /"embedding":/, "no inline vector in the JSONL");
      assert.match(raw, /"embeddingStore":"sidecar"/);
      assert.match(raw, /"embeddingDims":4/);
      assert.ok(existsSync(join(store.paths.workspaceDir, "vectors.0.f32")));
      assert.equal(statSync(join(store.paths.workspaceDir, "vectors.0.f32")).size, V1.length * 4);

      const latest = store.readCandidates(10).at(-1);
      assert.equal(latest.embeddingStatus, "fresh");
      assert.deepStrictEqual(latest.embedding, V1, "lazy getter returns the float32-exact vector as a plain array");
      assert.deepStrictEqual(latest.embedding, V1, "getter is memoised and stable");
      assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(latest)), "embedding"), false, "serialisation never carries the vector");
      assert.equal(Object.hasOwn({ ...latest }, "embedding"), false, "spreads never carry the vector");
      assert.deepStrictEqual(store.readVector("mem-1"), V1);
      assert.equal(store.readVector("missing"), undefined);
      assert.deepStrictEqual(store.vectorStats(), { file: "vectors.0.f32", vectors: 1, bytes: 16, generation: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("setter on a sidecar-backed record replaces the getter with a plain value", async () => {
    const root = makeRoot("neo-sidecar-setter-");
    try {
      const store = createNeoStore(root, "ws");
      const item = candidate("mem-2", "Setter probe.");
      store.appendCandidates([item]);
      store.appendEmbeddingQueue([item]);
      await drainWith(store, V1);
      const record = store.readCandidates(10).at(-1);
      record.embedding = V2;
      assert.deepStrictEqual(record.embedding, V2);
      assert.equal(Object.hasOwn({ ...record }, "embedding"), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("migration moves inline vectors to the sidecar losslessly, latest line per id wins", () => {
    const root = makeRoot("neo-sidecar-migrate-");
    try {
      const dir = join(root, "workspaces", "legacy--0000");
      mkdirSync(dir, { recursive: true });
      const lines = [
        { ...candidate("mem-a", "alt"), embedding: V2, embeddingStatus: "fresh" },
        { ...candidate("mem-b", "kein vektor") },
        { ...candidate("mem-a", "alt"), embedding: V1, embeddingStatus: "fresh" },
        { id: "turn-x", role: "user", content: "hallo", createdAt: new Date().toISOString(), embedding: V2, embeddingStatus: "fresh" },
      ];
      writeFileSync(join(dir, "memory-candidates.jsonl"), lines.slice(0, 3).map((l) => JSON.stringify(l)).join("\n") + "\n");
      writeFileSync(join(dir, "turn-journal.jsonl"), JSON.stringify(lines[3]) + "\n");
      const sizeBefore = statSync(join(dir, "memory-candidates.jsonl")).size;

      const dry = migrateInlineVectorsToSidecar(dir, { dryRun: true });
      assert.equal(dry.vectorsWritten, 2);
      assert.equal(statSync(join(dir, "memory-candidates.jsonl")).size, sizeBefore, "dry-run leaves files untouched");
      assert.equal(existsSync(join(dir, "vector-index.json")), false);

      const report = migrateInlineVectorsToSidecar(dir);
      assert.equal(report.vectorsWritten, 2);
      assert.equal(report.verified, 2);
      assert.equal(report.mismatches, 0);
      assert.equal(report.files.candidates.inlineVectors, 2);
      assert.equal(report.files.turns.inlineVectors, 1);
      const raw = readFileSync(join(dir, "memory-candidates.jsonl"), "utf8");
      assert.doesNotMatch(raw, /"embedding":/);
      assert.equal(raw.split("\n").filter(Boolean).length, 3, "line order and count preserved");
      assert.match(raw, /"embeddingStore":"sidecar"/);

      // Direkt ueber Index und Datei pruefen (das Verzeichnis ist kein kanonischer Store-Pfad).
      const index = JSON.parse(readFileSync(join(dir, "vector-index.json"), "utf8"));
      assert.deepStrictEqual(Object.keys(index.entries).sort(), ["mem-a", "turn-x"]);
      assert.equal(index.entries["mem-a"].dims, 4);
      const buf = readFileSync(join(dir, index.file));
      const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
      const memA = Array.from(f32.subarray(index.entries["mem-a"].offset / 4, index.entries["mem-a"].offset / 4 + 4));
      assert.deepStrictEqual(memA, V1, "latest inline vector wins");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrated store scores identically: vectors read back equal the former inline values", async () => {
    const root = makeRoot("neo-sidecar-equiv-");
    try {
      const store = createNeoStore(root, "ws");
      const item = candidate("mem-eq", "Gleichheit.");
      // Altformat simulieren: Inline-Vektor in der Zeile.
      store.appendCandidates([{ ...item, embedding: V2, embeddingStatus: "fresh" }]);
      const before = store.readCandidates(10).at(-1).embedding;
      migrateInlineVectorsToSidecar(store.paths.workspaceDir);
      const fresh = createNeoStore(root, "ws");
      const after = fresh.readCandidates(10).at(-1).embedding;
      assert.deepStrictEqual(after, before);
      assert.deepStrictEqual(after, V2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("compaction drops orphaned slots, rolls the generation and keeps reads correct", async () => {
    const root = makeRoot("neo-sidecar-compact-");
    try {
      const store = createNeoStore(root, "ws");
      const a = candidate("mem-a", "A");
      const b = candidate("mem-b", "B");
      store.appendCandidates([a, b]);
      store.appendEmbeddingQueue([a, b]);
      await drainWith(store, V1);
      // Re-Embedding von A: neuer Slot, alter verwaist.
      store.appendEmbeddingQueue([{ ...a, embeddingStatus: "pending" }]);
      await drainWith(store, V2);
      assert.deepStrictEqual(store.readVector("mem-a"), V2);
      assert.equal(store.vectorStats().bytes, 3 * V1.length * 4, "three slots written, one orphaned");

      const first = store.compactVectors();
      assert.equal(first.rewritten, true);
      assert.equal(first.generation, 1);
      assert.equal(first.after, 2);
      assert.equal(first.bytesAfter, 2 * V1.length * 4);
      assert.deepStrictEqual(store.readVector("mem-a"), V2);
      assert.deepStrictEqual(store.readVector("mem-b"), V1);
      assert.ok(existsSync(join(store.paths.workspaceDir, "vectors.0.f32")), "previous generation kept for readers holding the old index");
      assert.ok(existsSync(join(store.paths.workspaceDir, "vectors.1.f32")));

      // Datensatz B wird verworfen und verschwindet aus der JSONL (z. B. Cap).
      store.appendCandidates([transitionRecordStatus(b, "pruned")]);
      writeFileSync(store.paths.candidates, readFileSync(store.paths.candidates, "utf8").split("\n").filter((l) => l && !l.includes('"id":"mem-b"')).join("\n") + "\n");
      // 7.12.28: Solange der Metadatenindex B noch fuehrt, bleibt der Vektor.
      const held = store.compactVectors();
      assert.equal(held.orphans, 0, "indexed candidate keeps its vector beyond the journal window");
      assert.equal(held.rewritten, false);
      // Die Index-Kompaktierung streicht den verworfenen Eintrag; erst dann raeumt der Sidecar.
      assert.equal(store.compactCandidateIndex().removedStatus, 1);
      const second = store.compactVectors();
      assert.equal(second.orphans, 1);
      assert.equal(second.generation, 2);
      assert.equal(existsSync(join(store.paths.workspaceDir, "vectors.0.f32")), false, "generation 0 removed after two compactions");
      assert.deepStrictEqual(readdirSync(store.paths.workspaceDir).filter((n) => n.endsWith(".f32")).sort(), ["vectors.1.f32", "vectors.2.f32"]);
      assert.equal(store.readVector("mem-b"), undefined);
      assert.deepStrictEqual(store.readVector("mem-a"), V2);

      const idle = store.compactVectors();
      assert.equal(idle.rewritten, false, "nothing to do when there are no orphans");
      assert.ok(Object.hasOwn(store.pruneAll(), "vectors"), "pruneAll reports the sidecar compaction");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

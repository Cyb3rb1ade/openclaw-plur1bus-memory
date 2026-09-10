import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNeoStore, searchNeoCandidatesGlobal, dedupeNeoLanesAgainstTexts, routeNeoRecall } from "../lib/neo-arch.js";

// 7.12.27: Suche ueber alle Kandidaten auf dem Vektor-Sidecar.
const NOW = Date.parse("2026-09-10T00:00:00Z");
const DAY = 86_400_000;
const VECTORS = {
  "mem-tea": [1, 0, 0, 0],
  "mem-tea-old": [1, 0, 0, 0],
  "mem-coffee": [0.75, 0.25, 0, 0],
  "mem-far": [0, 0, 1, 0],
  "mem-pruned": [1, 0, 0, 0],
};

function candidate(id, statement, extra = {}) {
  return {
    id, workspaceKey: "ws", agentId: "bernhardine", statement, normalizedStatement: statement.toLowerCase(),
    sourceTurnIds: ["turn-1"], status: "candidate", embeddingStatus: "pending", impact: "low",
    // Ohne Sichtbarkeits-Stempel faellt die ACL geschlossen aus (isNeoRecordAccessible).
    visibility: { scope: "agent_private" },
    createdAt: new Date(NOW - DAY).toISOString(), ...extra,
  };
}

async function seedStore(root) {
  const store = createNeoStore(root, "ws");
  const items = [
    candidate("mem-tea-old", "Eva trinkt gern Tee.", { createdAt: new Date(NOW - 120 * DAY).toISOString() }),
    candidate("mem-tea", "Eva trinkt gern Tee am Abend."),
    candidate("mem-coffee", "Erik mag Kaffee."),
    candidate("mem-far", "Der Server steht im Keller."),
    candidate("mem-pruned", "Veraltet.", { status: "pruned" }),
  ];
  store.appendCandidates(items);
  store.appendEmbeddingQueue(items);
  const result = await store.drainEmbeddingQueue({ impact: "low", maxItems: 50, embedder: (_text, target) => VECTORS[target.id], dimensions: 4 });
  assert.equal(result.processed, 5);
  return store;
}

describe("searchNeoCandidatesGlobal", () => {
  it("ranks by cosine with a recency discount, honours status, threshold, excludeIds and topK", async () => {
    const root = mkdtempSync(join(tmpdir(), "neo-global-"));
    try {
      const store = await seedStore(root);
      const query = [1, 0, 0, 0];
      const result = searchNeoCandidatesGlobal(store, { queryVector: query, now: NOW, minSimilarity: 0.5, halfLifeDays: 30 });
      // 7.12.28: die Suche laeuft ueber den Metadatenindex (eine Zeile je
      // Append, keine Statuszeilen des Drains) — scanned zaehlt IDs.
      assert.equal(result.scanned, 5, "index holds one entry per id");
      assert.equal(result.unique, 5, "one revision per id");
      assert.equal(result.index, "cached", "append path parsed the index in-process; other threads see tail/full");
      assert.equal(result.eligible, 4, "pruned candidate is filtered before scoring");
      assert.equal(result.withVector, 4);
      // Rezenz: 120 Tage alt bei Halbwertszeit 30 → Faktor 0,85 + 0,15·0,0625 ≈ 0,859,
      // damit rutscht der alte identische Vektor hinter den frischen Kaffee-Treffer (≈0,945).
      assert.deepEqual(result.hits.map((h) => h.item.id), ["mem-tea", "mem-coffee", "mem-tea-old"], "far vector below threshold; old identical vector is discounted");
      assert.ok(result.hits[0].score > result.hits[1].score && result.hits[1].score > result.hits[2].score);
      assert.equal(result.hits[0].similarity, 1);
      assert.equal(result.hits[2].similarity, 1);
      assert.ok(Math.abs(result.hits[1].similarity - 0.75 / Math.sqrt(0.625)) < 1e-6);
      assert.ok(Array.isArray(result.hits[0].item.embedding), "batch-loaded vector is materialised on the record for later scoring");
      assert.ok(result.ms >= 0);

      const topOne = searchNeoCandidatesGlobal(store, { queryVector: query, now: NOW, topK: 1 });
      assert.deepEqual(topOne.hits.map((h) => h.item.id), ["mem-tea"]);
      const excluded = searchNeoCandidatesGlobal(store, { queryVector: query, now: NOW, excludeIds: new Set(["mem-tea"]) });
      assert.equal(excluded.hits[0].item.id, "mem-coffee", "without the fresh tea hit, coffee outranks the discounted old tea");
      assert.deepEqual(searchNeoCandidatesGlobal(store, { queryVector: null }).hits, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("readVectors returns the same values as readVector for a batch of ids", async () => {
    const root = mkdtempSync(join(tmpdir(), "neo-global-batch-"));
    try {
      const store = await seedStore(root);
      const batch = store.readVectors(["mem-far", "mem-tea", "missing"]);
      assert.deepEqual([...batch.keys()].sort(), ["mem-far", "mem-tea"]);
      assert.deepEqual(batch.get("mem-tea"), store.readVector("mem-tea"));
      assert.deepEqual(batch.get("mem-far"), VECTORS["mem-far"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("global hits compete in the recall lanes together with the window", async () => {
    const root = mkdtempSync(join(tmpdir(), "neo-global-lanes-"));
    try {
      const store = await seedStore(root);
      const query = [1, 0, 0, 0];
      const window = store.readCandidates(1); // nur der juengste Datensatz im Fenster
      const global = searchNeoCandidatesGlobal(store, { queryVector: query, now: NOW, excludeIds: new Set(window.map((r) => r.id)) });
      const items = [...window, ...global.hits.map((h) => h.item)];
      // Lane-Routing prueft die ACL: agent-private Datensaetze brauchen den passenden Requester.
      const lanes = routeNeoRecall(items, "Tee", { requesterAgentId: "bernhardine", queryVector: query, maxPerLane: 2, minScore: 0.08 });
      const ids = new Set(Object.values(lanes).flat().map((row) => row.item.id));
      assert.ok(ids.has("mem-tea"), "global hit reaches the lanes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dedupeNeoLanesAgainstTexts", () => {
  const lanes = {
    workspace_facts: [
      { item: { id: "g1", statement: "Eva trinkt gern Tee am Abend." }, score: 0.9 },
      { item: { id: "w1", statement: "Eva trinkt gern Tee am Abend." }, score: 0.8 },
      { item: { id: "g2", statement: "Erik mag Kaffee." }, score: 0.7 },
    ],
  };
  it("drops only the selected ids whose text duplicates an injected memory", () => {
    const result = dedupeNeoLanesAgainstTexts(lanes, ["Eva trinkt gern Tee am Abend"], { onlyIds: new Set(["g1", "g2"]) });
    assert.equal(result.dropped, 1);
    assert.deepEqual(result.lanes.workspace_facts.map((r) => r.item.id), ["w1", "g2"], "window item w1 is never touched");
  });
  it("keeps everything without texts or below the threshold", () => {
    assert.equal(dedupeNeoLanesAgainstTexts(lanes, []).dropped, 0);
    assert.equal(dedupeNeoLanesAgainstTexts(lanes, ["Etwas ganz anderes ueber Autos"]).dropped, 0);
  });
});

/**
 * tests/recall-rerank-order.test.js
 *
 * Recall-Audit (engine-recall), Befunde F1-F3:
 *
 * F1  Die Reranker-Reihenfolge ging im Produktivpfad verloren. Die
 *     Kind-Pipelines des Namespace-Recalls reranken mit `deferFinalCap`, der
 *     Merge (`mergeNamespaceRecallResults`) sortierte aber wieder nach dem
 *     Vor-Rerank-Score, und `applyRecallBudget` stellte die Tier-Reihenfolge
 *     her. Der Reranker kostete nur Latenz.
 * F2  Ein einmaliger Embedding-Fehler eines KNOWLEDGE.md-Abschnitts wurde mit
 *     der mtime gecacht; der Abschnitt fehlte bis zur naechsten Dateiaenderung.
 * F3  `rerankCandidates` begrenzte die Reranker-Eingabe nicht.
 *
 * (F4, Graph-Relevanzpruefung fail-closed, steht in
 * recall-pipeline-graph-hydration-relevance.test.js.)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getKnowledgeChunks, mergeNamespaceRecallResults, runRecallPipeline } from "../lib/recall-pipeline.js";
import { applyRecallBudget } from "../lib/recall-budget.js";
import { runMergedNamespaceRecall } from "../engine/recall/namespace-recall.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const DIM = 4;
const vektor = () => Array(DIM).fill(0.1);
const embeddings = { dim: DIM, async embed() { return vektor(); }, async embedQuery() { return vektor(); } };

const zeile = (id, abstand, extra = {}) => ({
  id, text: `Erinnerung ${id}`, summary: "", category: "fact", origin: "dm", status: "active",
  importance: 0.5, memoryStrength: 1.0, _distance: abstand,
  scope: "agent-private", agentId: "a", storedBy: "a", workspaceId: "", workspaceKey: "", ownerUserId: "",
  ...extra,
});

const tabelle = (rows) => ({
  vectorSearch: () => ({ limit: () => ({ async toArray() { return rows; } }) }),
  query: () => ({ where: () => ({ limit: () => ({ async toArray() { return []; } }) }) }),
});

// Dreht die Eingabe um: der letzte Kandidat ist der beste.
function umdrehenderReranker(seen = []) {
  return {
    async rerank(_query, docs) {
      seen.push(docs.length);
      return docs.map((_, i) => ({ index: docs.length - 1 - i, relevance_score: 1 - i / docs.length }));
    },
  };
}

const basis = {
  query: "frage", embeddings, agentId: "a", topN: 5, budget: 5, candidateTopK: 20, rerankCandidates: 20,
  recallMinScore: 0.01, importanceBoost: 0, canonicalEnabled: false, associativeEnabled: false, dedupEnabled: false,
};

const ids = (result) => result.memories.map((m) => m.entry.id);

describe("F1: Rerank-Reihenfolge ueberlebt Namespace-Merge und Budget", () => {
  it("Namespace-Pfad, ein Namespace: der umkehrende Reranker bestimmt die Ausgabe", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => zeile(`m${i}`, i / 100));
    const result = await runMergedNamespaceRecall(
      [{ namespace: "agent-private", sourceKind: "private", db: { table: tabelle(rows) } }],
      { ...basis, reranker: umdrehenderReranker() },
    );
    assert.deepEqual(ids(result), ["m19", "m18", "m17", "m16", "m15"]);
  });

  it("Namespace-Pfad, zwei Namespaces: Merge ordnet nach Rerank-Score, nicht nach Vor-Rerank-Score", async () => {
    const privat = Array.from({ length: 10 }, (_, i) => zeile(`p${i}`, i / 100));
    const zweiter = Array.from({ length: 10 }, (_, i) => zeile(`w${i}`, i / 100));
    const result = await runMergedNamespaceRecall(
      [
        { namespace: "n0", sourceKind: "private", db: { table: tabelle(privat) } },
        { namespace: "n1", sourceKind: "private", db: { table: tabelle(zweiter) } },
      ],
      { ...basis, reranker: umdrehenderReranker() },
    );
    // Beide Kinder reichen ihr hinterstes Element nach vorn (Score 1.0, 0.9, ...).
    // Gleicher Rerank-Score: Reihenfolge der Namespaces entscheidet.
    assert.deepEqual(ids(result), ["p9", "w9", "p8", "w8", "p7"]);
  });

  it("Merge: Rerank-Score schlaegt Vor-Rerank-Score; ohne Rerank-Score gilt der bisherige Score", () => {
    const item = (id, score, rerankScore) => ({
      entry: { id, text: id }, score, source: "vector", ...(rerankScore === undefined ? {} : { rerankScore }),
    });
    const merged = mergeNamespaceRecallResults([
      { namespace: "agent-private", sourceKind: "private", memories: [item("hoch-vor", 0.9, 0.1), item("niedrig-vor", 0.1, 0.8)], canonical: [] },
      { namespace: "shared-workspace", sourceKind: "workspace", memories: [item("ohne-a", 0.7), item("ohne-b", 0.5)], canonical: [] },
    ], { maxOut: 10, dedupEnabled: false });
    // Reranked zuerst (nach Rerank-Score), danach die nicht-rerankten nach altem Score.
    assert.deepEqual(merged.memories.map((m) => m.entry.id), ["niedrig-vor", "hoch-vor", "ohne-a", "ohne-b"]);
    // Ohne jeden Rerank-Score bleibt es beim bisherigen Verhalten.
    const plain = mergeNamespaceRecallResults([
      { namespace: "agent-private", memories: [item("x", 0.2), item("y", 0.9)], canonical: [] },
    ], { maxOut: 10, dedupEnabled: false });
    assert.deepEqual(plain.memories.map((m) => m.entry.id), ["y", "x"]);
  });

  it("Direktaufruf: Budget-Tiering zerstoert die Rerank-Reihenfolge nicht", async () => {
    const rows = [
      zeile("episodisch", 0.1),
      zeile("kern", 0.3, { coreMemoryScore: 0.8 }),
      zeile("projekt", 0.2, { category: "project" }),
    ];
    // Reranker: episodisch > projekt > kern (Zuordnung ueber den Text, nicht ueber den Index)
    const wunsch = ["episodisch", "projekt", "kern"];
    const reranker = {
      async rerank(_query, docs) {
        return wunsch.map((name, rang) => ({ index: docs.findIndex((d) => d.endsWith(name)), relevance_score: 0.9 - rang * 0.4 }));
      },
    };
    const result = await runRecallPipeline({ ...basis, topN: 4, budget: 4, dbTable: tabelle(rows), reranker });
    assert.deepEqual(ids(result), ["episodisch", "projekt", "kern"]);
  });

  it("Budget ohne Rerank bleibt tier-sortiert (core > project > episodic)", async () => {
    const rows = [
      zeile("episodisch", 0.1),
      zeile("kern", 0.3, { coreMemoryScore: 0.8 }),
      zeile("projekt", 0.2, { category: "project" }),
    ];
    const result = await runRecallPipeline({ ...basis, topN: 4, budget: 4, dbTable: tabelle(rows), reranker: null });
    assert.deepEqual(ids(result), ["kern", "projekt", "episodisch"]);
  });

  it("applyRecallBudget: Auswahl bleibt tier-basiert, preserveOrder erhaelt nur die Eingabereihenfolge", () => {
    const m = (id, extra = {}) => ({ entry: { id, category: "fact", ...extra }, score: 0.5, source: "vector" });
    const input = [m("e1"), m("k1", { coreMemoryScore: 0.9 }), m("e2"), m("e3")];
    const tiered = applyRecallBudget(input, { budget: 2 });
    assert.deepEqual(tiered.selected.map((x) => x.entry.id), ["k1", "e1"]);
    const ordered = applyRecallBudget(input, { budget: 2, preserveOrder: true });
    assert.deepEqual(ordered.selected.map((x) => x.entry.id), ["e1", "k1"]);
    assert.deepEqual(ordered.tierCounts, tiered.tierCounts);
  });
});

describe("F3: rerankCandidates begrenzt die Reranker-Eingabe", () => {
  const rows40 = Array.from({ length: 40 }, (_, i) => zeile(`m${i}`, i / 100));

  it("schickt hoechstens rerankCandidates Dokumente an den Reranker", async () => {
    const seen = [];
    await runRecallPipeline({ ...basis, dbTable: tabelle(rows40), reranker: umdrehenderReranker(seen), candidateTopK: 40, rerankCandidates: 8 });
    assert.deepEqual(seen, [8]);
  });

  it("unterschreitet topN nicht (Untergrenze), auch bei kleinem rerankCandidates", async () => {
    const seen = [];
    const result = await runRecallPipeline({ ...basis, dbTable: tabelle(rows40), reranker: umdrehenderReranker(seen), candidateTopK: 40, rerankCandidates: 2 });
    assert.deepEqual(seen, [5]);
    assert.equal(result.memories.length, 5);
  });

  it("gilt auch im deferFinalCap-Pfad der Namespace-Kinder", async () => {
    const seen = [];
    await runMergedNamespaceRecall(
      [{ namespace: "agent-private", sourceKind: "private", db: { table: tabelle(rows40) } }],
      { ...basis, reranker: umdrehenderReranker(seen), candidateTopK: 40, rerankCandidates: 8 },
    );
    assert.deepEqual(seen, [8]);
  });
});

describe("F2: KNOWLEDGE.md-Cache nach teilweisem Embedding-Fehler", () => {
  const logger = { warn() {}, info() {}, debug() {} };

  function workspace() {
    const ws = makeTempDir("knowledge-partial-");
    mkdirSync(join(ws, "memory"), { recursive: true });
    const file = join(ws, "memory", "KNOWLEDGE.md");
    writeFileSync(file, `# Alpha\n${"a".repeat(60)}\n\n# Beta\n${"b".repeat(60)}\n`);
    const t = new Date("2026-01-01T00:00:00Z");
    utimesSync(file, t, t);
    return ws;
  }

  it("persistiert nichts, wenn ein Abschnitt scheiterte; der naechste Lauf holt ihn nach", async () => {
    const ws = workspace();
    const cacheFile = join(ws, ".adaptive-learning", "knowledge-cache.json");
    const flaky = { async embed(text) { if (text.includes("Beta")) throw new Error("transient"); return vektor(); } };
    const first = await getKnowledgeChunks(ws, flaky, logger, {});
    assert.deepEqual(first.map((c) => c.heading), ["Alpha"], "der Aufruf liefert die erfolgreichen Abschnitte");
    assert.equal(existsSync(cacheFile), false, "unvollstaendige Chunks duerfen nicht gecacht werden");

    let calls = 0;
    const healthy = { async embed() { calls++; return vektor(); } };
    const second = await getKnowledgeChunks(ws, healthy, logger, {});
    assert.deepEqual(second.map((c) => c.heading), ["Alpha", "Beta"]);
    assert.equal(calls, 2, "ohne Cache wird neu embeddet");
    assert.equal(existsSync(cacheFile), true, "vollstaendige Chunks werden gecacht");

    const third = await getKnowledgeChunks(ws, { async embed() { throw new Error("darf nicht aufgerufen werden"); } }, logger, {});
    assert.deepEqual(third.map((c) => c.heading), ["Alpha", "Beta"], "vollstaendiger Cache wird weiter genutzt");
  });
});

/**
 * tests/recall-cap-after-rerank.test.js
 *
 * Die Pipeline kappte auf `topN`, BEVOR der Reranker lief (budget bei Zeile
 * 2012, rerank bei 2039). Der Reranker durfte damit nur umsortieren, was die
 * Kappung uebrig liess — eine Erinnerung auf Platz 16 konnte er nicht mehr
 * hereinholen, obwohl genau das seine Aufgabe ist.
 *
 * Gemessen am 20.09.2026 an 80 Benchmark-Fragen, bei denen der Recall den
 * gesuchten Beleg nicht geliefert hatte, nur Recall ohne LLM:
 *   Kappung NACH dem Rerank:  65 von 80 gefunden (81 %)
 *   Kappung VOR  dem Rerank:  11 von 80 gefunden (14 %)
 *
 * Produktiv lief bereits die bessere Variante, weil index.js:882
 * `deferFinalCap: true` setzt und selbst kappt. Jeder Direktaufruf — Skript,
 * Test, Benchmark — bekam stillschweigend die schwaechere. Deshalb wandert
 * die Kappung hinter das Reranking, statt nur die Vorgabe umzudrehen: so
 * bleibt der Vertrag der Funktion (sie liefert hoechstens topN) unveraendert,
 * und alle Aufrufer profitieren, ohne etwas zu aendern.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { runRecallPipeline } from "../lib/recall-pipeline.js";

const DIM = 4;
const vektor = () => Array(DIM).fill(0.1);
const embeddings = { dim: DIM, async embed() { return vektor(); }, async embedQuery() { return vektor(); } };

const zeile = (id, abstand) => ({
  id, text: `Erinnerung ${id}`, summary: "", category: "fact", origin: "dm", status: "active",
  importance: 0.5, memoryStrength: 1.0, _distance: abstand,
  scope: "agent-private", agentId: "a", storedBy: "a", workspaceId: "", workspaceKey: "", ownerUserId: "",
});

const tabelle = (rows) => ({
  vectorSearch: () => ({ limit: () => ({ async toArray() { return rows; } }) }),
  query: () => ({ where: () => ({ limit: () => ({ async toArray() { return []; } }) }) }),
});

describe("Kappung liegt hinter dem Reranking", () => {
  // 20 Kandidaten, aufsteigender Abstand. Der Reranker dreht die Reihenfolge
  // um: die hintersten sollen vorn landen. Kappt die Pipeline vorher, kann er
  // sie gar nicht mehr sehen.
  const rows = Array.from({ length: 20 }, (_, i) => zeile(`m${i}`, i / 100));
  const umdrehen = {
    async rerank(_query, docs) {
      return docs.map((_, i) => ({ index: docs.length - 1 - i, relevance_score: 1 - i / docs.length }));
    },
  };

  it("holt eine Zeile von hinten nach vorn, die sonst weggekappt waere", async () => {
    const res = await runRecallPipeline({
      query: "frage", dbTable: tabelle(rows), embeddings, reranker: umdrehen,
      agentId: "a", topN: 5, budget: 5, candidateTopK: 20, rerankCandidates: 20,
      recallMinScore: 0.01, importanceBoost: 0, canonicalEnabled: false,
      associativeEnabled: false, dedupEnabled: false,
    });
    const ids = res.memories.map((m) => m.entry.id);
    assert.strictEqual(ids.length, 5, "der Vertrag bleibt: hoechstens topN");
    assert.ok(ids.includes("m19"), `m19 muss durchkommen, geliefert: ${ids.join(",")}`);
    assert.ok(!ids.includes("m0"), `m0 lag vorn, darf aber nicht mehr durchkommen: ${ids.join(",")}`);
  });

  it("liefert ohne Reranker weiterhin die besten topN", async () => {
    const res = await runRecallPipeline({
      query: "frage", dbTable: tabelle(rows), embeddings, reranker: null,
      agentId: "a", topN: 5, budget: 5, candidateTopK: 20, rerankCandidates: 20,
      recallMinScore: 0.01, importanceBoost: 0, canonicalEnabled: false,
      associativeEnabled: false, dedupEnabled: false,
    });
    assert.deepStrictEqual(res.memories.map((m) => m.entry.id), ["m0", "m1", "m2", "m3", "m4"]);
  });
});

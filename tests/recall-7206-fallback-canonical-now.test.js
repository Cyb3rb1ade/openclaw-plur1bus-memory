/**
 * 7.20.6: Rueckfallweg ohne Reranker, kanonische Treffer ausserhalb des
 * Erinnerungsbudgets (nur automatischer Recall), now fuer den Zeitparser.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { mergeNamespaceRecallResults, relevanceFallbackOrder, runRecallPipeline } from "../lib/recall-pipeline.js";

const silent = { warn: () => {}, info: () => {}, debug: () => {} };
const embeddings = { dim: 3, embed: async () => [0.1, 0.2, 0.3], embedQuery: async () => [0.1, 0.2, 0.3] };
const table = (rows) => ({ vectorSearch: () => ({ limit: () => ({ toArray: async () => rows }) }) });
const WORDS = { a: "river stone bridge morning", b: "mountain cloud winter cabin", y: "picnic garden friends lunch", old: "harbor ferry ticket evening" };
const row = (id, distance, extra = {}) => ({ id, text: WORDS[id] || `memory ${id}`, _distance: distance, scope: "agent-private", agentId: "agent-a", storedBy: "agent-a", ...extra });

describe("relevanceFallbackOrder", () => {
  it("ordnet nach Vektorrelevanz, der kombinierte Score entscheidet nur bei Gleichstand", () => {
    const items = [
      { entry: { id: "strong-but-far" }, vectorScore: 0.40, score: 0.40 },
      { entry: { id: "decayed-but-close" }, vectorScore: 0.70, score: 0.10 },
      { entry: { id: "tie-weak" }, vectorScore: 0.50, score: 0.20 },
      { entry: { id: "tie-strong" }, vectorScore: 0.50, score: 0.45 },
    ];
    const out = relevanceFallbackOrder(items);
    assert.deepEqual(out.map((r) => r.entry.id), ["decayed-but-close", "tie-strong", "tie-weak", "strong-but-far"]);
    assert.equal(out[0].score, 0.70, "score traegt danach die Relevanz");
    assert.equal(out[0].boostedScore, 0.10, "der kombinierte Wert bleibt erhalten");
    assert.equal(items[1].score, 0.10, "die Eingabe bleibt unveraendert");
  });
});

describe("runRecallPipeline ohne Reranker-Antwort", () => {
  // b ist naeher an der Anfrage, aber verfallen (memoryStrength 0.4 => -0.6).
  const rows = [
    row("a", 0.3, { memoryStrength: 1.0 }),
    row("b", 0.1, { memoryStrength: 0.4 }),
  ];
  const base = {
    agentId: "agent-a", query: "test", dbTable: table(rows), embeddings, topN: 2, rerankCandidates: 10,
    rerankerTimeoutMs: 5000, rerankerFallbackOnError: true, canonicalEnabled: false, logger: silent,
  };

  it("faellt bei einem Fehler auf die Relevanzreihenfolge zurueck", async () => {
    const { memories } = await runRecallPipeline({ ...base, reranker: { rerank: async () => { throw new Error("402"); } } });
    assert.deepEqual(memories.map((m) => m.entry.id), ["b", "a"]);
  });

  it("faellt bei leerer Reranker-Antwort ebenso zurueck", async () => {
    const { memories } = await runRecallPipeline({ ...base, reranker: { rerank: async () => [] } });
    assert.deepEqual(memories.map((m) => m.entry.id), ["b", "a"]);
  });

  it("die Namensraum-Zusammenfuehrung behaelt die Rueckfallreihenfolge", async () => {
    const { memories } = await runRecallPipeline({ ...base, deferFinalCap: true, candidateHardLimit: 100, reranker: { rerank: async () => { throw new Error("402"); } } });
    const merged = mergeNamespaceRecallResults([{ namespace: "default", canonical: [], memories }], { maxOut: 2 });
    assert.deepEqual(merged.memories.map((m) => m.entry.id), ["b", "a"]);
  });
});

describe("kanonische Treffer und Erinnerungsplaetze", () => {
  const memory = (id, score) => ({ entry: { id, text: `distinct text number ${id} ${"x".repeat(Number(score * 10))}`, scope: "agent-private", agentId: "a", storedBy: "a" }, score });
  const inputs = () => [{
    namespace: "default",
    canonical: [{ heading: "Rules", text: "# Rules\n\nAlways answer politely.", score: 0.9 }],
    memories: [memory("m1", 0.9), memory("m2", 0.8), memory("m3", 0.7)],
  }];

  it("ohne Option bleibt maxOut die Gesamtzahl (Werkzeuge mit limit)", () => {
    const merged = mergeNamespaceRecallResults(inputs(), { maxOut: 3, canonicalMaxItems: 1 });
    assert.equal(merged.canonical.length + merged.memories.length, 3);
  });

  it("mit canonicalOutsideLimit kommen kanonische Treffer zusaetzlich", () => {
    const merged = mergeNamespaceRecallResults(inputs(), { maxOut: 3, canonicalMaxItems: 1, canonicalOutsideLimit: true });
    assert.equal(merged.memories.length, 3);
    assert.equal(merged.canonical.length, 1);
  });

  it("nur der automatische Recall setzt die Option und reicht sie an Merge und Budget weiter", () => {
    // Auf main baut engine/recall/recall-params.js die Parameter des
    // automatischen Recalls (frueher _autoRecallBaseParams in index.js), und
    // engine/recall/namespace-recall.js fuehrt die Namensraeume zusammen.
    const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
    const params = read("../engine/recall/recall-params.js");
    const namespaceRecall = read("../engine/recall/namespace-recall.js");
    const engineSources = [
      params,
      namespaceRecall,
      read("../engine/recall/assemble-prompt-context.js"),
      read("../engine/recall/warm-recall-path.js"),
      read("../engine/tools/memory-tools.js"),
      read("../adapter/openclaw/register-tools.js"),
      read("../index.js"),
    ].join("\n");
    assert.equal((engineSources.match(/canonicalOutsideLimit: true,/g) || []).length, 1);
    assert.match(params, /export function autoRecallParams\([\s\S]*?return \{\s*query,\s*\/\/[^\n]*\n\s*canonicalOutsideLimit: true,/);
    assert.match(namespaceRecall, /canonicalOutsideLimit: baseParams\.canonicalOutsideLimit === true,/);
    assert.match(namespaceRecall, /applyMergedRecallBudget\(merged, baseParams\.budget, \{ canonicalOutsideBudget: baseParams\.canonicalOutsideLimit === true \}\)/);
    // Nur auf main: der Multi-Identity-Rerank kappt danach auf topN und zieht
    // die kanonischen Treffer mit der Option nicht ab.
    assert.match(namespaceRecall, /\(baseParams\.topN \?\? 12\) - \(baseParams\.canonicalOutsideLimit === true \? 0 : merged\.canonical\.length\)/);
  });
});

describe("Zeitparser mit dem now der Pipeline", () => {
  it("die Pipeline gibt now an parseTemporal weiter", () => {
    const source = readFileSync(new URL("../lib/recall-pipeline.js", import.meta.url), "utf8");
    assert.match(source, /parseTemporal\(query, now\)/);
    assert.doesNotMatch(source, /parseTemporal\(query\)/);
  });

  it("'yesterday' greift relativ zum uebergebenen now, nicht zur Systemzeit", async () => {
    const now = Date.parse("2026-03-10T12:00:00Z");
    const rows = [
      row("y", 0.2, { createdAt: Date.parse("2026-03-09T10:00:00Z") }),
      row("old", 0.1, { createdAt: Date.parse("2026-01-01T10:00:00Z") }),
    ];
    const { memories } = await runRecallPipeline({
      agentId: "agent-a", query: "what did we do yesterday", dbTable: table(rows), embeddings, topN: 5,
      canonicalEnabled: false, logger: silent, now,
    });
    assert.ok(memories.some((m) => m.entry.id === "y"), "die Erinnerung von gestern (relativ zu now) bleibt");
    assert.ok(!memories.some((m) => m.entry.id === "old"), "eine Erinnerung ausserhalb des Fensters faellt heraus");
  });
});

describe("7.20.6-Review: Rueckfallweg", () => {
  it("reine Graph-Treffer landen nicht vor der besten Vektorrelevanz", () => {
    const out = relevanceFallbackOrder([
      { entry: { id: "seed" }, vectorScore: 0.6, score: 0.2 },
      { entry: { id: "graph-only" }, score: 0.9, source: "graph" },
    ]);
    assert.deepEqual(out.map((r) => r.entry.id), ["seed", "graph-only"]);
    assert.ok(out[1].score <= 0.85 * 0.6 + 1e-9);
  });

  it("ein einzelner Kandidat traegt mit Reranker die Relevanz als score", async () => {
    const rows = [row("b", 0.1, { memoryStrength: 0.4 })];
    const reranker = { rerank: async () => { throw new Error("nicht aufgerufen"); } };
    const { memories } = await runRecallPipeline({
      agentId: "agent-a", query: "test", dbTable: table(rows), embeddings, topN: 2, reranker,
      rerankCandidates: 10, rerankerFallbackOnError: true, canonicalEnabled: false, logger: silent,
    });
    assert.equal(memories.length, 1);
    assert.ok(Number.isFinite(memories[0].boostedScore), "der kombinierte Wert bleibt erhalten");
    assert.ok(memories[0].score > memories[0].boostedScore, "score ist die Relevanz, nicht der verfallene kombinierte Wert");
  });
});

/**
 * tests/recall-arms.test.js
 *
 * Retrieval arms (lib/recall-arms.js) and their pipeline wiring: config,
 * facet routing, vocabulary matching, hub cap, fusion (RRF and slots), score
 * scale, deadlines, fail-open behaviour, hydration through lifecycle/ACL/
 * freshness gates, the event-time arm and the seed expansion. DB-free.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  armSimilarity,
  finishRetrievalArms,
  fuseRetrievalArms,
  isWhenQuestion,
  matchQueryVocabulary,
  normalizeRetrievalArmsConfig,
  planRetrievalArms,
  routeQueryFacets,
  startRetrievalArms,
} from "../lib/recall-arms.js";
import { runRecallPipeline } from "../lib/recall-pipeline.js";
import { createEnrichmentIndex } from "../lib/enrichment/sidecar.js";
import { enrichmentContentHash } from "../lib/enrichment/enrich-llm.js";
import { distanceToScore } from "../lib/score.js";
import { GOLDEN_NOW, goldenEmbeddings, goldenRow, goldenTable, squaredL2, unitVector } from "./helpers/arms-golden-scenarios.js";

const silent = { info() {}, warn() {}, debug() {}, error() {} };

function entry(id, text, { about = [], entities = [], facets = [], event = null, enrichedAt = 1 } = {}) {
  return {
    id,
    contentHash: enrichmentContentHash(text),
    enrichedAt,
    enrichVersion: 1,
    entities,
    about,
    facets,
    event,
    dateCheck: event ? "agree" : "none",
  };
}

function dayEvent(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return { from: ymd, until: ymd, fromMs: Date.UTC(y, m - 1, d), untilMs: Date.UTC(y, m - 1, d + 1), precision: "day", kind: "past", phrase: "that day", source: "explicit" };
}

/**
 * A small corpus: 20 filler rows (Caroline, axis 1, make both speakers hubs
 * together with the Melanie rows), Melanie's sport rows (axis 0), Oscar rows
 * (axis 2), support-group rows with event dates (axis 3).
 */
function corpus() {
  const rows = [];
  const index = createEnrichmentIndex();
  const add = (id, text, vector, meta, rowOpts = {}) => {
    rows.push(goldenRow({ id, text, vector, ...rowOpts }));
    if (meta) index.offer(entry(id, text, meta));
  };
  for (let i = 0; i < 20; i++) {
    add(`c${String(i).padStart(2, "0")}`, `Caroline: painting session ${i}`, unitVector([0.05 * (i % 3), 1, 0, 0, 0.02 * i]), { about: ["caroline"], facets: ["art"] });
  }
  for (let i = 0; i < 6; i++) {
    add(`s${i}`, `Melanie: went running, lap ${i}`, unitVector([1, 0, 0, 0.1 * i, 0]), { about: ["melanie"], facets: ["sport"] });
  }
  for (let i = 0; i < 4; i++) {
    add(`o${i}`, `Melanie: Oscar the dog, story ${i}`, unitVector([0, 0, 1, 0, 0.1 * i]), { about: ["melanie"], entities: ["oscar"], facets: ["pets"] });
  }
  for (let i = 0; i < 3; i++) {
    add(`e${i}`, `Caroline: support group meeting ${i}`, unitVector([0, 0.1, 0, 1, 0.05 * i]), { about: ["caroline"], entities: ["support group"], facets: ["identity"], event: dayEvent(`2026-11-0${i + 3}`) });
  }
  return { rows, index };
}

function baseParams(extra = {}) {
  return {
    agentId: "agent-a",
    topN: 4,
    budget: 4,
    candidateTopK: 4,
    rerankCandidates: 4,
    recallMinScore: 0.05,
    importanceBoost: 0,
    canonicalEnabled: false,
    associativeEnabled: false,
    dedupEnabled: false,
    logger: silent,
    now: GOLDEN_NOW,
    ...extra,
  };
}

/** goldenTable whose id lookups wait `delayMs` or throw. */
function slowTable(rows, { delayMs = 0, failIds = false } = {}) {
  const table = goldenTable(rows);
  return {
    vectorSearch: (v) => table.vectorSearch(v),
    query() {
      const inner = table.query();
      return {
        where(clause) {
          const q = inner.where(clause);
          if (!/^id\s/i.test(String(clause))) return q;
          return {
            select() { return this; },
            limit(n) {
              return {
                async toArray() {
                  if (failIds) throw new Error("lookup failed");
                  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
                  return q.limit(n).toArray();
                },
              };
            },
          };
        },
      };
    },
  };
}

describe("normalizeRetrievalArmsConfig", () => {
  it("is off by default and active only with a mode and an arm", () => {
    assert.equal(normalizeRetrievalArmsConfig(undefined).active, false);
    assert.equal(normalizeRetrievalArmsConfig({ mode: "on" }).active, false);
    assert.equal(normalizeRetrievalArmsConfig({ entity: true }).active, false);
    assert.equal(normalizeRetrievalArmsConfig({ mode: "maybe", entity: true }).active, false);
    assert.equal(normalizeRetrievalArmsConfig({ mode: "shadow", eventTime: true }).active, true);
    assert.equal(normalizeRetrievalArmsConfig({ mode: "on", entity: true }).active, true);
  });

  it("uses the design defaults and clamps out-of-range values", () => {
    const d = normalizeRetrievalArmsConfig({ mode: "on", entity: true });
    assert.equal(d.fusion, "rrf");
    assert.equal(d.timeoutMs, 150);
    assert.equal(d.rrfK, 60);
    assert.equal(d.slots, 30);
    assert.equal(d.armTopK, 30);
    assert.equal(d.hubRatio, 0.05);
    assert.equal(d.minArmScore, 0.1);
    assert.equal(d.timeZone, "Europe/Berlin");
    const c = normalizeRetrievalArmsConfig({ mode: "on", entity: true, fusion: "x", timeoutMs: 1, armTopK: 10_000, rrfK: -3 });
    assert.equal(c.fusion, "rrf");
    assert.equal(c.timeoutMs, 10);
    assert.equal(c.armTopK, 200);
    assert.equal(c.rrfK, 1);
  });
});

describe("question analysis", () => {
  it("routes facets from English and German question words", () => {
    assert.deepEqual(routeQueryFacets("What activities does Melanie partake in?"), ["hobby", "sport", "art"]);
    assert.deepEqual(routeQueryFacets("What books has Caroline read?"), ["media"]);
    assert.deepEqual(routeQueryFacets("Welche Bücher hat Eva gelesen?"), ["media"]);
    assert.deepEqual(routeQueryFacets("Was hat Christian im Oktober gekauft?"), ["finance"]);
    assert.deepEqual(routeQueryFacets("What kind of pets does Peter have?"), ["pets"], "kind of is not family, Peter is not pet");
    assert.deepEqual(routeQueryFacets("Tell me something"), []);
  });

  it("recognises when-questions in both languages", () => {
    assert.equal(isWhenQuestion("When did Caroline go to the support group?"), true);
    assert.equal(isWhenQuestion("Wann war Eva beim Arzt?"), true);
    assert.equal(isWhenQuestion("In which year did they move?"), true);
    assert.equal(isWhenQuestion("An welchem Tag war das Konzert?"), true);
    assert.equal(isWhenQuestion("What did Caroline paint?"), false);
  });

  it("matches multi-word entities, possessives and the German genitive", () => {
    const index = createEnrichmentIndex();
    index.offer(entry("a", "x", { about: ["melanie", "eva"], entities: ["lgbtq support group", "oscar"] }));
    const en = matchQueryVocabulary("When did Melanie's dog Oscar join the LGBTQ support group?", index);
    assert.deepEqual(en.persons, ["melanie"]);
    assert.deepEqual(en.entities.sort(), ["lgbtq support group", "oscar"]);
    const de = matchQueryVocabulary("Wann war Evas Arzttermin?", index);
    assert.deepEqual(de.persons, ["eva"]);
  });
});

describe("hub cap", () => {
  const { index } = corpus();
  const config = normalizeRetrievalArmsConfig({ mode: "on", entity: true, eventTime: true });

  it("hub persons alone produce no entity candidates", () => {
    const plan = planRetrievalArms({ query: "What does Melanie think about it?", index, now: GOLDEN_NOW, config });
    assert.deepEqual(plan.matched.hubPersons, ["melanie"]);
    assert.equal(plan.entity.candidates.length, 0);
  });

  it("a hub person counts together with a routed facet", () => {
    const plan = planRetrievalArms({ query: "What activities does Melanie partake in?", index, now: GOLDEN_NOW, config });
    assert.deepEqual(plan.entity.candidates.map((c) => c.id).sort(), ["s0", "s1", "s2", "s3", "s4", "s5"]);
  });

  it("non-hub entities match on their own, hub entities do not", () => {
    // "oscar" is on 4 of 33 rows: below a 20 % hub ratio, above the default 5 %.
    const loose = normalizeRetrievalArmsConfig({ mode: "on", entity: true, hubRatio: 0.2 });
    const rare = planRetrievalArms({ query: "Tell me about Oscar", index, now: GOLDEN_NOW, config: loose });
    assert.deepEqual(rare.entity.candidates.map((c) => c.id).sort(), ["o0", "o1", "o2", "o3"]);
    assert.deepEqual(rare.matched.hubPersons, []);
    assert.equal(planRetrievalArms({ query: "Tell me about Oscar", index, now: GOLDEN_NOW, config }).entity.candidates.length, 0);
  });
});

describe("fuseRetrievalArms", () => {
  const item = (id) => ({ entry: { id } });
  const vector = ["v1", "v2", "v3", "v4"].map(item);

  it("rrf: interleaves by reciprocal rank, keeps the vector order on ties, cuts at the limit", () => {
    const out = fuseRetrievalArms({ vectorResults: vector, armLists: [["a1", "v3", "a2"].map(item)], fusion: "rrf", limit: 4, rrfK: 60 });
    assert.deepEqual(out.results.map((r) => r.entry.id), ["v3", "v1", "a1", "v2"]);
    assert.deepEqual(out.added, ["a1"]);
    assert.deepEqual(out.displaced, ["v4"]);
    assert.equal(out.results[0], vector[2], "vector items stay the same objects");
  });

  it("slots: vector top (limit - slots), then arm rows, then the remaining vector rows", () => {
    const out = fuseRetrievalArms({ vectorResults: vector, armLists: [["v1", "a1"].map(item), ["b1"].map(item)], fusion: "slots", limit: 4, slots: 2 });
    assert.deepEqual(out.results.map((r) => r.entry.id), ["v1", "v2", "a1", "b1"]);
    const short = fuseRetrievalArms({ vectorResults: vector, armLists: [["a1"].map(item)], fusion: "slots", limit: 4, slots: 3 });
    assert.deepEqual(short.results.map((r) => r.entry.id), ["v1", "a1", "v2", "v3"], "unused slots are refilled from the vector list");
  });

  it("without arm rows the vector list stays as it is", () => {
    const out = fuseRetrievalArms({ vectorResults: vector, armLists: [[]], fusion: "rrf", limit: 4 });
    assert.deepEqual(out.results, vector);
    assert.deepEqual(out.added, []);
  });
});

describe("score scale", () => {
  it("an arm row gets the score the vector search would have reported for it", async () => {
    const q = unitVector([0.3, 1, 0.2]);
    const row = goldenRow({ id: "x", vector: unitVector([1, 0.2, 0, 0.4]) });
    const [hit] = await goldenTable([row]).vectorSearch(q).limit(1).toArray();
    const sim = armSimilarity(q, row.vector);
    assert.equal(sim.score, distanceToScore(hit._distance));
    assert.equal(sim.score, distanceToScore(squaredL2(q, row.vector)));
    assert.ok(Math.abs(sim.cosine - q.reduce((s, x, i) => s + x * row.vector[i], 0)) < 1e-12);
    assert.equal(armSimilarity(q, [1, 0]), null, "wrong dimension: no score");
    assert.equal(armSimilarity(q, null), null);
  });

  it("reads Arrow vectors (LanceDB rows), where vector[i] is undefined", () => {
    const q = unitVector([0.3, 1, 0.2]);
    const values = Float32Array.from(unitVector([1, 0.2, 0, 0.4]));
    const arrowLike = { length: values.length, get: (i) => values[i], toArray: () => values };
    assert.equal(arrowLike[0], undefined);
    assert.equal(armSimilarity(q, arrowLike).score, armSimilarity(q, Array.from(values)).score);
    const q32 = Float32Array.from(q);
    assert.equal(armSimilarity(q32, values).score, armSimilarity(Array.from(q32), Array.from(values)).score);
  });
});

describe("retrieval arms in the pipeline", () => {
  const caroline = { activities: unitVector([0.1, 1, 0, 0, 0]) };

  it("on: Melanie's sport rows enter the candidates with their real vector score", async () => {
    const { rows, index } = corpus();
    const off = await runRecallPipeline({ ...baseParams(), query: "What activities does Melanie partake in?", dbTable: goldenTable(rows), embeddings: goldenEmbeddings(caroline) });
    assert.ok(off.memories.every((m) => m.entry.id.startsWith("c")), "the vector alone only finds Caroline's rows");
    const on = await runRecallPipeline({
      ...baseParams({ decisionTrace: true }),
      query: "What activities does Melanie partake in?",
      dbTable: goldenTable(rows),
      embeddings: goldenEmbeddings(caroline),
      retrievalArms: { mode: "on", entity: true, timeoutMs: 2_000 },
      enrichmentIndex: () => ({ index, complete: true }),
    });
    const armRows = on.memories.filter((m) => m.retrievalArm === "entity");
    assert.ok(armRows.length > 0, "arm rows reach the result");
    for (const m of armRows) {
      const row = rows.find((r) => r.id === m.entry.id);
      assert.equal(m.vectorScore, distanceToScore(squaredL2(caroline.activities, row.vector)));
      assert.ok(m.entry.id.startsWith("s"));
    }
    assert.ok(on.arms.added.length > 0);
    assert.ok(on.trace.guards.some((g) => g.name === "retrieval-arms"));
  });

  it("slots keep the candidate count at fetchLimit", async () => {
    const { rows, index } = corpus();
    const seen = [];
    const on = await runRecallPipeline({
      ...baseParams({ deferFinalCap: true, candidateHardLimit: 100, candidateTopK: 10, rerankCandidates: 10 }),
      query: "What activities does Melanie partake in?",
      dbTable: goldenTable(rows),
      embeddings: goldenEmbeddings(caroline),
      reranker: { async rerank(_q, docs, limit) { seen.push(docs.length); return docs.map((_, index) => ({ index, relevance_score: 1 - index / 100 })).slice(0, limit); } },
      retrievalArms: { mode: "on", entity: true, fusion: "slots", slots: 3, timeoutMs: 2_000 },
      enrichmentIndex: () => ({ index, complete: true }),
    });
    assert.deepEqual(seen, [10], "the reranker sees as many documents as without arms");
    assert.equal(on.arms.added.length, 3);
    assert.equal(on.arms.displaced.length, 3);
  });

  it("hydration applies lifecycle, ACL and freshness: index membership grants no access", async () => {
    const { rows, index } = corpus();
    // s0: another agent's private row; s1: archived; s2: text changed after enrichment.
    rows.find((r) => r.id === "s0").agentId = "agent-b";
    rows.find((r) => r.id === "s0").storedBy = "agent-b";
    rows.find((r) => r.id === "s1").status = "archived";
    rows.find((r) => r.id === "s2").text = "Melanie: went running, edited later";
    const on = await runRecallPipeline({
      ...baseParams({ deferFinalCap: true, candidateHardLimit: 100, candidateTopK: 8, rerankCandidates: 8 }),
      query: "What activities does Melanie partake in?",
      dbTable: goldenTable(rows),
      embeddings: goldenEmbeddings(caroline),
      retrievalArms: { mode: "on", entity: true, timeoutMs: 2_000, seedExpansion: false },
      enrichmentIndex: () => ({ index, complete: true }),
    });
    const ids = on.memories.map((m) => m.entry.id);
    for (const blocked of ["s0", "s1", "s2"]) assert.ok(!ids.includes(blocked), `${blocked} must not pass`);
    assert.deepEqual(on.arms.entity.list.sort(), ["s3", "s4", "s5"]);
  });

  it("the query embedding is sent before phase A reads the sidecar, also on the keyword-fallback path", async () => {
    const { rows, index } = corpus();
    for (const keywordFallback of [false, true]) {
      const order = [];
      const inner = goldenEmbeddings(caroline);
      const embed = async (text) => { order.push("embed"); return inner.embed(text); };
      await runRecallPipeline({
        ...baseParams(),
        query: "What activities does Melanie partake in?",
        dbTable: goldenTable(rows),
        embeddings: { dim: inner.dim, embed, embedQuery: embed },
        keywordFallback,
        retrievalArms: { mode: "shadow", entity: true, timeoutMs: 2_000 },
        enrichmentIndex: () => { order.push("index"); return { index, complete: true }; },
      });
      assert.deepEqual(order, ["embed", "index"], `keywordFallback=${keywordFallback}`);
    }
  });

  it("warns once per table when a vector index makes vector scores approximate", async () => {
    const { rows, index } = corpus();
    const warnings = [];
    const logger = { ...silent, warn: (msg) => warnings.push(String(msg)) };
    let listed = 0;
    const inner = goldenTable(rows);
    const indexed = {
      vectorSearch: (v) => inner.vectorSearch(v),
      query: () => inner.query(),
      async listIndices() { listed++; return [{ name: "vector_idx", indexType: "IvfHnswPq", columns: ["vector"] }]; },
    };
    const params = {
      ...baseParams({ logger }),
      query: "What activities does Melanie partake in?",
      embeddings: goldenEmbeddings(caroline),
      retrievalArms: { mode: "shadow", entity: true, timeoutMs: 2_000 },
      enrichmentIndex: () => ({ index, complete: true }),
    };
    await runRecallPipeline({ ...params, dbTable: indexed });
    await runRecallPipeline({ ...params, dbTable: indexed });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(listed, 1);
    assert.equal(warnings.filter((w) => w.includes("flat vector scan")).length, 1);
    // Without the arms nothing is checked.
    const plain = { ...indexed, async listIndices() { listed++; return []; } };
    await runRecallPipeline({ ...params, retrievalArms: null, dbTable: plain });
    assert.equal(listed, 1);
  });

  it("a late arm is skipped (fail-open) and the vector result stays unchanged", async () => {
    const { rows, index } = corpus();
    const params = { ...baseParams(), query: "What activities does Melanie partake in?", embeddings: goldenEmbeddings(caroline) };
    const off = await runRecallPipeline({ ...params, dbTable: goldenTable(rows) });
    const late = await runRecallPipeline({
      ...params,
      dbTable: slowTable(rows, { delayMs: 120 }),
      retrievalArms: { mode: "on", entity: true, timeoutMs: 20 },
      enrichmentIndex: () => ({ index, complete: true }),
    });
    assert.equal(late.arms.timedOut, true);
    assert.equal(JSON.stringify(late.memories), JSON.stringify(off.memories));
  });

  it("a failing sidecar or lookup leaves the vector result unchanged", async () => {
    const { rows, index } = corpus();
    const params = { ...baseParams(), query: "What activities does Melanie partake in?", embeddings: goldenEmbeddings(caroline) };
    const off = await runRecallPipeline({ ...params, dbTable: goldenTable(rows) });
    const brokenIndex = await runRecallPipeline({
      ...params,
      dbTable: goldenTable(rows),
      retrievalArms: { mode: "on", entity: true, timeoutMs: 2_000 },
      enrichmentIndex: () => { throw new Error("sidecar unreadable"); },
    });
    assert.match(brokenIndex.arms.error, /sidecar unreadable/);
    assert.equal(JSON.stringify(brokenIndex.memories), JSON.stringify(off.memories));
    const brokenLookup = await runRecallPipeline({
      ...params,
      dbTable: slowTable(rows, { failIds: true }),
      retrievalArms: { mode: "on", entity: true, timeoutMs: 2_000 },
      enrichmentIndex: () => ({ index, complete: true }),
    });
    assert.deepEqual(brokenLookup.arms.added, []);
    assert.equal(JSON.stringify(brokenLookup.memories), JSON.stringify(off.memories));
    const noIndex = await runRecallPipeline({ ...params, dbTable: goldenTable(rows), retrievalArms: { mode: "on", entity: true }, enrichmentIndex: null });
    assert.equal(JSON.stringify(noIndex.memories), JSON.stringify(off.memories));
  });

  it("event arm: a when-question pulls rows with an event date, a date window prefers overlapping rows", async () => {
    const { rows, index } = corpus();
    const params = {
      ...baseParams({ deferFinalCap: true, candidateHardLimit: 100 }),
      embeddings: goldenEmbeddings({ When: unitVector([0.1, 1, 0, 0, 0]), happened: unitVector([0.1, 1, 0, 0, 0]) }),
      // The bench stores wall-clock time as UTC; the question window must use the same zone.
      retrievalArms: { mode: "on", eventTime: true, timeoutMs: 2_000, timeZone: "UTC" },
      enrichmentIndex: () => ({ index, complete: true }),
    };
    const when = await runRecallPipeline({ ...params, query: "When did Caroline go to the support group?", dbTable: goldenTable(rows) });
    assert.equal(when.arms.event.when, true);
    assert.deepEqual(when.arms.event.list.sort(), ["e0", "e1", "e2"]);
    assert.ok(when.memories.some((m) => m.retrievalArm === "event"));
    const window = await runRecallPipeline({ ...params, query: "What happened on 4 November 2026?", dbTable: goldenTable(rows) });
    assert.deepEqual(window.arms.event.window, { from: "2026-11-04", until: "2026-11-04" });
    assert.deepEqual(window.arms.event.list, ["e1"]);
  });

  it("seed expansion adds rows sharing a rare entity with the top vector hits", async () => {
    const { rows, index } = corpus();
    const on = await runRecallPipeline({
      ...baseParams({ topN: 2, budget: 2, candidateTopK: 2, rerankCandidates: 2 }),
      query: "Tell me a story",
      dbTable: goldenTable(rows),
      // Points at o0/o1 only; o2/o3 lie outside the two vector slots.
      embeddings: goldenEmbeddings({ story: unitVector([0, 0, 1, 0, 0]) }),
      retrievalArms: { mode: "shadow", entity: true, timeoutMs: 2_000, fusion: "slots", slots: 1, hubRatio: 0.2 },
      enrichmentIndex: () => ({ index, complete: true }),
    });
    assert.equal(on.arms.expansion.candidates, 2);
    assert.equal(on.arms.added.length, 1);
    assert.ok(["o2", "o3"].includes(on.arms.added[0]));
  });
});

describe("startRetrievalArms / finishRetrievalArms", () => {
  it("never reject, even when hydration throws synchronously", async () => {
    const { index } = corpus();
    const config = normalizeRetrievalArmsConfig({ mode: "on", entity: true, timeoutMs: 1_000 });
    const task = startRetrievalArms({ query: "What activities does Melanie do?", now: GOLDEN_NOW, config, enrichmentIndex: index, hydrate: () => { throw new Error("boom"); } });
    const vectorResults = [{ entry: { id: "v1", text: "x" }, score: 0.5 }];
    const out = await finishRetrievalArms(task, { queryVector: unitVector([1]), vectorResults, limit: 5, config, hydrate: () => { throw new Error("boom"); } });
    assert.equal(out.results, vectorResults);
    assert.match(out.diagnostics.error, /boom/);
  });

  it("a failing seed expansion keeps the direct candidates", async () => {
    const { rows, index } = corpus();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const config = normalizeRetrievalArmsConfig({ mode: "on", entity: true, timeoutMs: 1_000, hubRatio: 0.2 });
    let calls = 0;
    const hydrate = async (ids) => {
      calls++;
      if (calls > 1) throw new Error("expansion lookup failed");
      return ids.map((id) => byId.get(id)).filter(Boolean).map((row) => ({ row, entry: { id: row.id, text: row.text } }));
    };
    const q = unitVector([0, 0, 1, 0, 0]);
    const task = startRetrievalArms({ query: "What activities does Melanie do?", now: GOLDEN_NOW, config, enrichmentIndex: index, hydrate });
    // The top vector hit is an Oscar row: the expansion would look up the other Oscar rows.
    const vectorResults = [{ entry: { id: "o0", text: byId.get("o0").text }, score: 0.9 }];
    const out = await finishRetrievalArms(task, { queryVector: q, vectorResults, limit: 10, config, hydrate });
    assert.match(out.diagnostics.expansion.error, /expansion lookup failed/);
    assert.deepEqual(out.diagnostics.entity.list.sort(), ["s0", "s1", "s2", "s3", "s4", "s5"]);
    assert.equal(out.diagnostics.added.length, 6);
  });

  it("the question window ignores German \"was\" and text beyond the question cap", () => {
    const { index } = corpus();
    const config = normalizeRetrievalArmsConfig({ mode: "on", eventTime: true });
    // Wednesday 2026-11-25 14:00 Europe/Berlin.
    const wed = Date.UTC(2026, 10, 25, 13, 0);
    assert.equal(planRetrievalArms({ query: "Was mache ich am Wochenende?", index, now: wed, config }).event, null);
    const past = planRetrievalArms({ query: "Was war am Wochenende los?", index, now: wed, config });
    assert.deepEqual([past.event.window.from, past.event.window.until], ["2026-11-21", "2026-11-22"]);
    const pasted = `${"lorem ipsum ".repeat(200)} on 4 November 2026`;
    assert.ok(pasted.length > 1_000);
    assert.equal(planRetrievalArms({ query: pasted, index, now: wed, config }).event, null);
    assert.ok(planRetrievalArms({ query: pasted.slice(-30), index, now: wed, config }).event.window);
  });

  it("an invalid time zone disables only the date window", () => {
    const { index } = corpus();
    const config = normalizeRetrievalArmsConfig({ mode: "on", eventTime: true, timeZone: "Mars/Olympus" });
    const plan = planRetrievalArms({ query: "When did it happen on 4 November 2026?", index, now: GOLDEN_NOW, config, logger: silent });
    assert.ok(plan.eventError);
    assert.equal(plan.event.when, true, "the when rule still applies");
  });
});

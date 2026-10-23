import test from "node:test";
import assert from "node:assert/strict";
import { createJevRecallFilter, createFilteredReranker } from "../lib/jev-recall-filter.js";

test("Jev drops only confidently irrelevant complete documents and preserves uncertain or missing answers", async () => {
  let sent;
  const filter = createJevRecallFilter({ apiKey: "SECRET", fetchImpl: async (_url, request) => {
    sent = JSON.parse(request.body);
    return { ok: true, async json() { return { answers: { d0: { choice: "irrelevant", confidence: 0.99 }, d1: { choice: "irrelevant", confidence: 0.8 }, d2: { choice: "relevant", confidence: 1 } } }; } };
  } });
  const result = await filter("question", ["unrelated", "uncertain", "relevant", "no answer"]);
  assert.deepEqual(result.indices, [1, 2, 3]);
  assert.equal(sent.questions.d0.type, "choice");
  assert.ok(JSON.stringify(sent.state).includes("question"));
});

test("invalid confidence, unknown answer and transport failures retain all candidates without exposing secrets", async () => {
  const warnings = [];
  for (const fetchImpl of [async () => { throw new Error("SECRET request body"); }, async () => ({ ok: false, status: 429 }), async () => ({ ok: true, json: async () => ({ answers: { d0: { choice: "irrelevant", confidence: "1" }, d1: { choice: "irrelevant", confidence: 2 } } }) })]) {
    const filter = createJevRecallFilter({ apiKey: "SECRET", fetchImpl, logger: { warn: (m) => warnings.push(m) } });
    assert.deepEqual((await filter("q", ["a", "b"])).indices, [0, 1]);
  }
  assert.doesNotMatch(warnings.join(" "), /SECRET|request body/);
});

test("bounded Jev state keeps oversized documents instead of classifying a truncated copy", async () => {
  const filter = createJevRecallFilter({ apiKey: "key", maxStateChars: 500, fetchImpl: async (_url, req) => {
    const body = JSON.parse(req.body);
    assert.ok(body.state.length <= 500);
    assert.equal(body.questions.d0, undefined);
    return { ok: true, json: async () => ({ answers: { d1: { choice: "irrelevant", confidence: 1 } } }) };
  } });
  assert.deepEqual((await filter("q", ["x".repeat(1000), "short"])).indices, [0]);
});

test("filtered reranker remaps indices, preserves scores and does not refill an explicit empty shortlist", async () => {
  const seen = [];
  const inner = { async rerank(q, docs, topN) { seen.push({ q, docs, topN }); return [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.8 }]; } };
  const reranker = createFilteredReranker(inner, async () => ({ indices: [0, 2] }));
  assert.deepEqual(await reranker.rerank("q", ["a", "b", "c"], 15), [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.8 }]);
  assert.deepEqual(seen[0].docs, ["a", "c"]);
  const empty = createFilteredReranker(inner, async () => ({ indices: [] }));
  assert.deepEqual(await empty.rerank("q", ["a"], 15), []);
  assert.equal(seen.length, 1);
});

test("missing Jev credential returns the unfiltered path without sending any request", async () => {
  assert.equal(createJevRecallFilter({}), null);
});

test("malformed base reranker indices stay errors instead of becoming an intentional empty Jev result", async () => {
  const reranker = createFilteredReranker({ async rerank() { return [{ index: -1 }, { index: 99 }]; } }, async () => ({ indices: [0] }));
  await assert.rejects(reranker.rerank("q", ["a"], 15), /no valid results/);
});

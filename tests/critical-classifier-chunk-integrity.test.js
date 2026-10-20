/**
 * tests/critical-classifier-chunk-integrity.test.js — engine-critical-push audit.
 *
 * (1) A part that is not contained in the whole must reach the model; it used
 *     to be typed "fakt" without classification because its siblings matched.
 * (2) A failed type update on a covered part must not turn into a second push
 *     in the next run (the whole drops out of the candidates once typed).
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { findCoveredChunkIds, runClassifier } from "../lib/jobs/critical-classifier.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const BIRTHDAY = "Christians Geburtstag ist am 1. Mai.";
const CITY = "Er wohnt in Köln.";
const CAT = "Die Katze heißt Mia.";

function card(id, content, extra = {}) {
  return { id, content, title: content, sourceTurnId: "turn-1", chunkGroupId: "", ...extra };
}

describe("part missing from the whole", () => {
  // Whole = "Er wohnt in Köln. Die Katze heißt Mia." — the birthday part is not in it.
  const cards = () => [
    card("whole", `${CITY} ${CAT}`),
    card("p0", BIRTHDAY, { chunkGroupId: "cg" }),
    card("p1", CITY, { chunkGroupId: "cg" }),
    card("p2", CAT, { chunkGroupId: "cg" }),
  ];

  it("findCoveredChunkIds covers only the parts the whole contains", () => {
    assert.deepStrictEqual([...findCoveredChunkIds(cards())].sort(), ["p1", "p2"]);
  });

  it("the uncovered part is classified by the model and pushed when critical", async () => {
    const typed = [];
    const seen = [];
    const db = { findRecentUnclassified: async () => cards(), updateCardType: async (_a, id, type) => { typed.push([id, type]); } };
    const model = { complete: async ({ prompt }) => { seen.push(prompt); return { text: prompt.includes(BIRTHDAY) ? "geburtstag" : "fakt" }; } };
    const res = await runClassifier(db, "agentMissing", { model, maxPerDay: 10, statePath: makeTempDir("crit-state-") });
    assert.ok(seen.some((p) => p.includes(BIRTHDAY)), "the birthday part was shown to the model");
    assert.deepStrictEqual(typed.find(([id]) => id === "p0"), ["p0", "geburtstag"]);
    assert.deepStrictEqual(res.pushMessages.map((m) => m.id), ["p0"]);
    assert.strictEqual(res.skippedChunks, 2);
  });
});

describe("failed type update on a covered part", () => {
  const cards = () => [
    card("whole", `${BIRTHDAY} ${CITY}`),
    card("p0", BIRTHDAY, { chunkGroupId: "cg" }),
    card("p1", CITY, { chunkGroupId: "cg" }),
  ];

  function world({ failPartOnce = true } = {}) {
    const store = new Map(cards().map((c) => [c.id, { ...c, type: "" }]));
    let failures = failPartOnce ? 1 : 0;
    const modelCalls = [];
    return {
      modelCalls,
      store,
      db: {
        findRecentUnclassified: async () => [...store.values()].filter((c) => !c.type),
        updateCardType: async (_a, id, type) => {
          if (id === "p0" && failures > 0) { failures -= 1; throw new Error("timeout"); }
          store.get(id).type = type;
        },
      },
      model: { complete: async ({ prompt }) => { modelCalls.push(prompt); return { text: "geburtstag" }; } },
    };
  }

  it("does not push the birthday twice across two runs", async () => {
    const w = world();
    const statePath = makeTempDir("crit-state-");
    const run1 = await runClassifier(w.db, "agentRetry", { model: w.model, maxPerDay: 10, statePath });
    const run2 = await runClassifier(w.db, "agentRetry", { model: w.model, maxPerDay: 10, statePath });
    const pushedIds = [...run1.pushMessages, ...run2.pushMessages].map((m) => m.id);
    assert.deepStrictEqual(pushedIds, ["whole"], `pushed ${pushedIds.join(",")}`);
    assert.strictEqual(run1.errors, 1, "the failed update is reported");
  });

  it("keeps the whole untyped and unclassified while a covered part could not be typed", async () => {
    const w = world();
    const run1 = await runClassifier(w.db, "agentDefer", { model: w.model, statePath: makeTempDir("crit-state-") });
    assert.strictEqual(w.store.get("whole").type, "", "whole stays a candidate so that the next run sees it with its parts");
    assert.strictEqual(run1.pushed, 0);
    assert.strictEqual(w.modelCalls.length, 0, "no model call is wasted on a deferred whole");
  });

  it("without a failure the whole is pushed once and the parts are typed fakt (unchanged)", async () => {
    const w = world({ failPartOnce: false });
    const res = await runClassifier(w.db, "agentOk", { model: w.model, statePath: makeTempDir("crit-state-") });
    assert.deepStrictEqual(res.pushMessages.map((m) => m.id), ["whole"]);
    assert.strictEqual(w.store.get("p0").type, "fakt");
    assert.strictEqual(w.store.get("p1").type, "fakt");
  });
});

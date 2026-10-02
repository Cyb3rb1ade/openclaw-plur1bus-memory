/**
 * tests/critical-classifier-chunk-dedup.test.js
 *
 * Regression 01.10.2026 (Bernd): die Aufteilung speichert eine lange Nachricht
 * als Ganzes UND als Teile. Der Critical-Cron klassifizierte beide einzeln und
 * pushte dieselbe Aussage zweimal unter zwei Referenzen.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { findCoveredChunkIds, runClassifier } from "../lib/jobs/critical-classifier.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const PARTS = [
  "Die Praxissoftware heißt „CGM MEDICO“ – mit C.",
  "Christian nutzt sie seit 2019 in der Praxis.",
  "Der Support läuft über die Hotline am Vormittag.",
];
const WHOLE = `${PARTS.join(" ")} Mehr gibt es dazu nicht.`;

function cardsFor({ turn = "turn-1", withWhole = true, group = "cg-1" } = {}) {
  const cards = PARTS.map((text, i) => ({
    id: `part-${i}`, content: text, title: text, chunkGroupId: group, sourceTurnId: turn,
  }));
  if (withWhole) cards.unshift({ id: "whole", content: WHOLE, title: WHOLE, chunkGroupId: "", sourceTurnId: turn });
  return cards;
}

function recorder(cards, { failClassify = false } = {}) {
  const typed = [];
  let calls = 0;
  return {
    typed,
    get calls() { return calls; },
    db: {
      findRecentUnclassified: async () => cards,
      updateCardType: async (_agent, id, type) => { typed.push([id, type]); },
    },
    model: {
      complete: async () => {
        calls += 1;
        if (failClassify) throw new Error("provider down");
        return { text: "gesundheit" };
      },
    },
  };
}

describe("findCoveredChunkIds", () => {
  it("deckt Teile ab, deren Ganzes im selben Turn liegt, auch mit abweichenden Satzzeichen", () => {
    const cards = cardsFor();
    cards[1] = { ...cards[1], content: "Die Praxissoftware heißt \"CGM MEDICO\" - mit C" };
    assert.deepStrictEqual([...findCoveredChunkIds(cards)].sort(), ["part-0", "part-1", "part-2"]);
  });

  it("lässt Teile ohne Ganzes (Modus „geteilt“) und ohne sourceTurnId stehen", () => {
    const unrelated = { id: "short", content: "Danke!", chunkGroupId: "", sourceTurnId: "turn-1" };
    assert.strictEqual(findCoveredChunkIds([...cardsFor({ withWhole: false }), unrelated]).size, 0);
    assert.strictEqual(findCoveredChunkIds(cardsFor({ turn: "" })).size, 0);
  });

  it("verbindet keine Teile mit dem Ganzen eines anderen Turns", () => {
    const cards = cardsFor({ withWhole: false });
    cards.push({ id: "whole-other", content: WHOLE, chunkGroupId: "", sourceTurnId: "turn-2" });
    assert.strictEqual(findCoveredChunkIds(cards).size, 0);
  });
});

describe("runClassifier mit Ganzem und Teilen", () => {
  it("pusht nur das Ganze, ruft das Modell einmal und typt die Teile als fakt", async () => {
    const r = recorder(cardsFor());
    const res = await runClassifier(r.db, "agentChunk", { model: r.model, statePath: makeTempDir("crit-state-") });
    assert.strictEqual(r.calls, 1);
    assert.strictEqual(res.pushed, 1);
    assert.deepStrictEqual(res.pushMessages.map((m) => m.id), ["whole"]);
    assert.strictEqual(res.skippedChunks, 3);
    assert.deepStrictEqual(r.typed, [["whole", "gesundheit"], ["part-0", "fakt"], ["part-1", "fakt"], ["part-2", "fakt"]]);
  });

  it("klassifiziert Teile ohne Ganzes wie bisher", async () => {
    const r = recorder(cardsFor({ withWhole: false }));
    const res = await runClassifier(r.db, "agentSplit", { model: r.model, maxPerDay: 10, statePath: makeTempDir("crit-state-") });
    assert.strictEqual(r.calls, 3);
    assert.strictEqual(res.pushed, 3);
    assert.strictEqual(res.skippedChunks, undefined);
  });

  it("typt die Teile auch, wenn die Klassifikation des Ganzen scheitert", async () => {
    const r = recorder(cardsFor(), { failClassify: true });
    const res = await runClassifier(r.db, "agentFail", { model: r.model, statePath: makeTempDir("crit-state-") });
    assert.strictEqual(res.pushed, 0);
    assert.strictEqual(res.skippedChunks, 3);
    assert.deepStrictEqual(r.typed.map(([id]) => id), ["part-0", "part-1", "part-2"]);
  });
});

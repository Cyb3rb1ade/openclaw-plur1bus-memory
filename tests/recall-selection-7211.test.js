/**
 * tests/recall-selection-7211.test.js — 7.21.1, Bernd's recall critique of
 * 24.11.2026: "zu viel von mir selbst" (old assistant replies without new
 * information took the places), "doppelte Einträge" (the same reply in the
 * Neo block and in relevant-memories; one reply split into two records).
 * Nothing is deleted; weak entries move down, parts of one turn are joined
 * for the prompt only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeRecallQualityWeight } from "../lib/recall-quality.js";
import { mergeTurnParts, turnPartKey } from "../lib/recall-turn-merge.js";
import { createAutoRecallPolicy } from "../lib/recall-pipeline.js";
import { filterNeoItemsAgainstTexts } from "../lib/neo-arch.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-24T22:00:00.000Z");
const opts = { staleAssistant: true, now: NOW };

describe("qualityWeighting.staleAssistant", () => {
  const assistant = (text, ageDays) => ({ text, sourceMessageRole: "assistant", createdAt: NOW - ageDays * DAY });

  it("a months-old pleasantry of the assistant ends at the floor", () => {
    const { weight, rules } = computeRecallQualityWeight(assistant("Danke fürs Teilen, Pit! Das freut mich wirklich sehr.", 190), opts);
    assert.ok(rules.includes("assistantSmalltalk") && rules.includes("staleAssistantAncient"), rules.join(","));
    assert.equal(weight, 0.35);
  });

  it("old replies without anchors sink by age; recent ones only by the 7.20.10 assistant rule", () => {
    const text = "Ja, das sehe ich genauso. Wir sollten das in Ruhe weiter beobachten und dann gemeinsam entscheiden, wie es weitergeht.";
    assert.equal(computeRecallQualityWeight(assistant(text, 3), opts).weight, 0.9);
    assert.ok(Math.abs(computeRecallQualityWeight(assistant(text, 30), opts).weight - 0.9 * 0.8) < 1e-12);
    assert.ok(Math.abs(computeRecallQualityWeight(assistant(text, 90), opts).weight - 0.9 * 0.65) < 1e-12);
    assert.ok(Math.abs(computeRecallQualityWeight(assistant(text, 200), opts).weight - 0.9 * 0.55) < 1e-12);
  });

  it("informative assistant replies (anchors, length) are only mildly weighted, and only after 60 days", () => {
    const text = "Der Recall bricht ab, weil das Embedding 17,5 s brauchte; runtime.recallTimeoutMs steht auf 12000 und das Host-Limit liegt bei 15 s. Ich schlage vor, den Neo-Vorlauf auf 3 s zu begrenzen und danach per Schlüsselwort zu suchen.";
    assert.equal(computeRecallQualityWeight(assistant(text, 30), opts).weight, 0.9);
    assert.ok(Math.abs(computeRecallQualityWeight(assistant(text, 90), opts).weight - 0.9 * 0.85) < 1e-12);
  });

  it("user statements are never aged, and staleAssistant off keeps the 7.20.10 weights", () => {
    const user = { text: "Ich will, dass alles gespeichert bleibt und Schwaches nur im Ranking nach unten wandert.", sourceMessageRole: "user", createdAt: NOW - 300 * DAY };
    assert.equal(computeRecallQualityWeight(user, opts).weight, 1);
    const old = assistant("Danke fürs Teilen, Pit!", 190);
    assert.deepEqual(computeRecallQualityWeight(old, { now: NOW }), computeRecallQualityWeight(old, {}));
  });

  it("the auto-recall policy applies it by default and uses its own reference time", () => {
    const policy = createAutoRecallPolicy({ query: "x", qualityWeighting: { enabled: true }, now: NOW });
    const { weight } = policy.weigh(assistant("Gute Nachrichten: Meine Erinnerungen sind noch da!", 190));
    assert.equal(weight, 0.35);
    const off = createAutoRecallPolicy({ query: "x", qualityWeighting: { enabled: true, staleAssistant: false }, now: NOW });
    assert.ok(Math.abs(off.weigh(assistant("Gute Nachrichten: Meine Erinnerungen sind noch da!", 190)).weight - 0.9 * 0.9) < 1e-12, "7.20.10: assistant claim and short");
  });
});

describe("mergeTurnParts", () => {
  const r = (id, turn, role, text, extra = {}) => ({ entry: { id, sourceTurnId: turn, sourceMessageRole: role, text, summary: "", createdAt: NOW, ...extra }, score: 0.5 });

  it("joins the records of one turn and role into the best-ranked one", () => {
    const list = [
      r("a", "t1", "assistant", "Das liegt nicht am Ranking."),
      r("b", "t2", "user", "Komisch. Ist das bei Bernhardine auch so?"),
      r("c", "t1", "assistant", "Doch, in deiner vorletzten Nachricht kam der Block an."),
      r("d", "t1", "user", "Aber auch diesmal kein Recall?"),
    ];
    const { results, merged } = mergeTurnParts(list);
    assert.equal(merged, 1);
    assert.deepEqual(results.map((x) => x.entry.id), ["a", "b", "d"]);
    assert.equal(results[0].entry.text, "Das liegt nicht am Ranking.\n\nDoch, in deiner vorletzten Nachricht kam der Block an.");
    assert.deepEqual(results[0].entry.mergedTurnPartIds, ["a", "c"]);
    assert.equal(list[0].entry.text, "Das liegt nicht am Ranking.", "input untouched");
  });

  it("drops parts another part already contains, and never merges chunk groups, dreams or rows without a turn id", () => {
    const { results } = mergeTurnParts([r("a", "t1", "assistant", "Kurz und gut."), r("b", "t1", "assistant", "Lang: Kurz und gut. Und mehr.")]);
    assert.equal(results.length, 1);
    assert.equal(results[0].entry.text, "Lang: Kurz und gut. Und mehr.");
    assert.equal(turnPartKey({ sourceTurnId: "", text: "x" }), "");
    assert.equal(turnPartKey({ sourceTurnId: "t", chunkGroupId: "g" }), "");
    assert.equal(turnPartKey({ sourceTurnId: "t", memoryClass: "dream" }), "");
    assert.equal(turnPartKey({ sourceTurnId: "t", text: "Assistant: hi" }), "t\u0000assistant");
  });
});

describe("Neo dedupe by containment", () => {
  it("a Neo excerpt of a rendered memory is dropped; short items and unrelated ones stay", () => {
    const memory = "Doch, in deiner vorletzten Nachricht („Ist das bei Bernhardine auch so?“) kam der Block an, aber er war leer, weil der Vorlauf das Budget aufgebraucht hat.";
    const items = [
      { id: "n1", statement: "Doch, in deiner vorletzten Nachricht („Ist das bei Bernhardine auch so?“) kam der Block an" },
      { id: "n2", statement: "Block an" },
      { id: "n3", statement: "Eva plant im Dezember eine Reise nach Lissabon mit ihrer Schwester." },
    ];
    const without = filterNeoItemsAgainstTexts(items, [memory], { threshold: 0.8 });
    assert.equal(without.dropped, 0, "Jaccard alone misses the excerpt (7.20.10 behaviour)");
    const withContainment = filterNeoItemsAgainstTexts(items, [memory], { threshold: 0.8, containment: true });
    assert.deepEqual(withContainment.items.map((i) => i.id), ["n2", "n3"]);
  });
});

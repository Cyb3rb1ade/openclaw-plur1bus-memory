/**
 * 7.20.4: Die Teilstueck-Logik der Recall-Pipeline lief ins Leere, weil
 * projectRecallEntry chunkGroupId und sourceTurnId verwarf. Mit Jev-Aufteilung
 * ("beides") trugen 15 Plaetze im Schnitt nur 10 verschiedene Nachrichten.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dedupResults, expandChunkPartsToWholes, mergeNamespaceRecallResults, projectRecallEntry } from "../lib/recall-pipeline.js";

const WHOLE_TEXT = "Wir fahren im Mai nach Lissabon. Das Hotel liegt in der Alfama. Der Flug geht ab Hamburg. Die Kosten teilen wir uns.";
const row = (id, text, extra = {}) => ({ id, text, summary: "", status: "active", sourceTurnId: "turn-1", chunkGroupId: "", ...extra });
const hit = (entry, score) => ({ entry: projectRecallEntry(entry), score });

const WHOLE = row("whole", WHOLE_TEXT);
const PART_A = row("part-a", "Das Hotel liegt in der Alfama.", { chunkGroupId: "g1" });
const PART_B = row("part-b", "Der Flug geht ab Hamburg.", { chunkGroupId: "g1" });
// Eine andere Nachricht desselben Gespraechszugs (z. B. die Nutzerfrage).
const OTHER = row("other", "Wo wohnen wir in Lissabon eigentlich genau?");

function fakeTable(rows, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    query() {
      return {
        where(filter) {
          calls.push(filter);
          return {
            async toArray() {
              if (fail) throw new Error("no such column: chunkGroupId");
              return rows.filter((r) => filter.includes(`'${r.sourceTurnId}'`) && !r.chunkGroupId);
            },
          };
        },
      };
    },
  };
}

describe("projectRecallEntry", () => {
  it("reicht chunkGroupId und sourceTurnId durch", () => {
    const projected = projectRecallEntry(PART_A);
    assert.equal(projected.chunkGroupId, "g1");
    assert.equal(projected.sourceTurnId, "turn-1");
    assert.equal(projectRecallEntry({ id: "x" }).chunkGroupId, "");
  });
});

describe("dedupResults mit projizierten Zeilen", () => {
  it("das Ganze ersetzt seine Teilstuecke an deren Platz", () => {
    const out = dedupResults([hit(PART_A, 0.9), hit(PART_B, 0.8), hit(WHOLE, 0.7)], 10);
    assert.deepEqual(out.map((r) => r.entry.id), ["whole"]);
  });

  it("eine fremde Nachricht desselben Zugs verdraengt kein Teilstueck", () => {
    const out = dedupResults([hit(OTHER, 0.9), hit(PART_A, 0.8)], 10);
    assert.deepEqual(out.map((r) => r.entry.id), ["other", "part-a"]);
  });

  it("ganze Zeilen desselben Zugs teilen sich keinen Gruppendeckel", () => {
    const rows = ["Erste Nachricht ueber Vulkane", "Zweite Nachricht ueber Tomaten", "Dritte Nachricht ueber Zuege"]
      .map((text, i) => hit(row(`w${i}`, text), 1 - i / 10));
    assert.equal(dedupResults(rows, 10).length, 3);
  });
});

describe("expandChunkPartsToWholes", () => {
  it("ersetzt Teilstuecke durch ihre ganze Nachricht und belegt dafuer einen Platz", async () => {
    const table = fakeTable([WHOLE, OTHER]);
    const out = await expandChunkPartsToWholes([hit(PART_A, 0.9), hit(OTHER, 0.85), hit(PART_B, 0.8)], table);
    assert.deepEqual(out.map((r) => r.entry.id), ["whole", "other"]);
    assert.equal(out[0].score, 0.9, "der Platz behaelt den Score des besten Teilstuecks");
    assert.equal(out[0].chunkExpandedFrom, "part-a");
    assert.equal(table.calls.length, 1, "eine Abfrage je Recall");
  });

  it("laesst Teilstuecke ohne ganze Zeile stehen (Jev: nur Teile)", async () => {
    const out = await expandChunkPartsToWholes([hit(PART_A, 0.9)], fakeTable([OTHER]));
    assert.deepEqual(out.map((r) => r.entry.id), ["part-a"]);
  });

  it("aendert bei einem Abfragefehler nichts", async () => {
    const input = [hit(PART_A, 0.9), hit(PART_B, 0.8)];
    assert.equal(await expandChunkPartsToWholes(input, fakeTable([WHOLE], { fail: true })), input);
  });

  it("ohne Teilstuecke keine Abfrage", async () => {
    const table = fakeTable([WHOLE]);
    await expandChunkPartsToWholes([hit(OTHER, 0.9)], table);
    assert.equal(table.calls.length, 0);
  });

  it("die Zusammenfuehrung der Namensraeume vergibt danach einen Platz je Nachricht", async () => {
    const expanded = await expandChunkPartsToWholes([hit(PART_A, 0.9), hit(PART_B, 0.8), hit(OTHER, 0.7)], fakeTable([WHOLE, OTHER]));
    const merged = mergeNamespaceRecallResults([{ namespace: "default", canonical: [], memories: expanded }], { maxOut: 15 });
    assert.deepEqual(merged.memories.map((r) => r.entry.id), ["whole", "other"]);
  });
});

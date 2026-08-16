/**
 * tests/rem-dream-similarity-scale.test.js
 *
 * `buildSparseNeighborGraph` verglich `distanceToScore(neighbor._distance)`
 * — also `1 / (1 + d)` aus lib/score.js — gegen `minSimilarity = 0.82`. Das ist
 * keine Kosinus-Ähnlichkeit, sondern eine monotone Umformung der Index-Distanz.
 *
 * Live gemessen (16.08.2026, Tabelle `main`): eine Zeile mit **echtem Kosinus
 * 1,0000** liefert `_distance = 0.6715` und damit Score 0,5982. Selbst ein
 * identischer Vektor blieb also weit unter der Schwelle — die Bedingung konnte
 * nie wahr werden, es entstanden null Kanten, null Cluster, null Muster.
 * rem-dream meldete deshalb dauerhaft `patternsFound: 0`, auch nachdem der
 * Partition-Fix (#111) den Job überhaupt erst zum Laufen gebracht hatte.
 *
 * Dass die Skala verschieden ist, zeigt schon dieselbe Datei: `validateClusters`
 * rechnet mit echter Kosinus-Ähnlichkeit (`centroidMinSimilarity = 0.74`).
 * Die Recall-Schwellen des Plugins liegen dagegen bei 0.15/0.2 — sie sind auf
 * die `1/(1+d)`-Skala kalibriert.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSparseNeighborGraph } from "../lib/dreaming/rem-dream.js";

const AGENT = "scale-agent";

function bindung(id, vector) {
  return {
    id,
    vector,
    agentId: AGENT,
    storedBy: AGENT,
    scope: "agent-private",
    workspaceId: "",
    workspaceKey: "",
    ownerUserId: "",
    status: "active",
    text: `Erinnerung ${id}`,
  };
}

const ctx = { agentId: AGENT, workspaceAliases: { paths: [], aliases: [] } };

/**
 * Tischattrappe in der Form, die der echte Index liefert: `_distance` ist eine
 * approximative Distanz, die selbst für identische Vektoren nicht auf 0 geht.
 * Genau das war live der Fall.
 */
function tabelleMitIndexDistanz(rows, distanz) {
  return {
    vectorSearch() {
      return {
        limit() {
          return { async toArray() { return rows.map((r) => ({ ...r, _distance: distanz })); } };
        },
      };
    },
  };
}

describe("buildSparseNeighborGraph misst echte Ähnlichkeit", () => {
  it("verbindet identische Vektoren, auch wenn die Index-Distanz hoch bleibt", async () => {
    const v = [1, 0, 0, 0];
    const memories = [bindung("a", v), bindung("b", [...v])];
    // 0.6715 ist der live gemessene Wert für einen identischen Vektor;
    // distanceToScore ergibt daraus 0.598 und lag damit unter jeder Schwelle.
    const table = tabelleMitIndexDistanz(memories, 0.6715);

    const edges = await buildSparseNeighborGraph(memories, table, { requestContext: ctx });

    assert.ok(edges.length > 0, "identische Vektoren müssen eine Kante ergeben");
    assert.ok(edges[0].strength >= 0.99, `Kantenstärke muss die echte Ähnlichkeit sein — bekam ${edges[0].strength}`);
  });

  it("verwirft unähnliche Vektoren, auch wenn die Index-Distanz niedrig ist", async () => {
    const memories = [bindung("a", [1, 0, 0, 0]), bindung("b", [0, 1, 0, 0])];
    // Niedrige Distanz ⇒ hoher 1/(1+d)-Score, echter Kosinus aber 0.
    const table = tabelleMitIndexDistanz(memories, 0.01);

    const edges = await buildSparseNeighborGraph(memories, table, { requestContext: ctx });

    assert.equal(edges.length, 0, "orthogonale Vektoren dürfen nie verbunden werden");
  });

  it("respektiert minSimilarity auf der Kosinus-Skala", async () => {
    // cos = 0.8 zwischen den beiden Vektoren.
    const memories = [bindung("a", [1, 0]), bindung("b", [0.8, 0.6])];
    const table = tabelleMitIndexDistanz(memories, 0.1);

    const drunter = await buildSparseNeighborGraph(memories, table, { requestContext: ctx, minSimilarity: 0.82 });
    const drueber = await buildSparseNeighborGraph(memories, table, { requestContext: ctx, minSimilarity: 0.75 });

    assert.equal(drunter.length, 0, "0.80 liegt unter der Schwelle 0.82");
    assert.ok(drueber.length > 0, "0.80 liegt über der Schwelle 0.75");
  });

  it("überspringt Nachbarn ohne Vektor, statt sie zu verbinden", async () => {
    const memories = [bindung("a", [1, 0]), { ...bindung("b", [1, 0]), vector: null }];
    const table = tabelleMitIndexDistanz(memories, 0.01);

    const edges = await buildSparseNeighborGraph(memories, table, { requestContext: ctx });

    assert.equal(edges.length, 0, "ohne Vektor lässt sich keine Ähnlichkeit belegen — fail closed");
  });
});

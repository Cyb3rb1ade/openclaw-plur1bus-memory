/**
 * tests/feature-cron-fresh-install-collisions.test.js
 *
 * Auf einer frischen Mehr-Agenten-Installation plante der Installer mehrere
 * Feature-Crons auf dieselbe Minute. Nur persona-evolve (5 Min.) und
 * consolidate-daily (15 Min.) wurden versetzt.
 *
 * Live bestätigt am 16.08.2026: die drei skill-miner-Jobs lagen alle auf
 * `0 3 * * 0` und brachen um 03:05 **alle drei innerhalb einer Sekunde** mit
 * `cron: isolated agent run stalled before execution start` ab — der
 * 60-Sekunden-Watchdog, weil drei isolierte Agent-Läufe gleichzeitig um Lanes
 * konkurrieren. rem-dream und persona-evolve liefen in derselben Nacht sauber
 * durch; rem-dream aber nur, weil sein Versatz hier von Hand nachgetragen
 * worden war — der Installer hätte auch ihn kollidieren lassen.
 *
 * gc-run ist ein Sonderfall: `runGcJob` iteriert selbst über alle
 * Agent-Datenbanken. Ein Job je Agent würde denselben Bestand N-mal
 * durcharbeiten, gleichzeitig, zur selben Minute.
 */

import assert from "node:assert";
import { describe, it } from "node:test";

import { REQUIRED_FEATURE_CRONS, planFeatureCrons } from "../lib/setup/feature-cron-plan.js";

const AGENTS = [
  { id: "main", isDefault: true },
  { id: "bernhardine" },
  { id: "heisenberg" },
];

function planeAlle() {
  return planFeatureCrons([], REQUIRED_FEATURE_CRONS, { agents: AGENTS }).create;
}

/** Alle Zeitpläne eines Features, in Planungsreihenfolge. */
function plaeneVon(create, feature) {
  return create
    .filter((job) => job.command === `/plur1bus internal ${feature}`)
    .map((job) => job.schedule?.expr)
    .filter(Boolean);
}

describe("frische Mehr-Agenten-Installation", () => {
  it("legt keinen per-Agent-Job zweimal auf dieselbe Minute", () => {
    const create = planeAlle();
    const kollisionen = [];
    for (const spec of REQUIRED_FEATURE_CRONS) {
      const plaene = plaeneVon(create, spec.feature);
      if (plaene.length < 2) continue;
      if (new Set(plaene).size !== plaene.length) kollisionen.push(`${spec.feature}: ${plaene.join(" / ")}`);
    }
    assert.deepStrictEqual(kollisionen, [], `gleichzeitige Starts lösen den 60s-Watchdog aus:\n${kollisionen.join("\n")}`);
  });

  it("versetzt skill-miner je Agent", () => {
    const plaene = plaeneVon(planeAlle(), "skill-miner");
    assert.strictEqual(plaene.length, AGENTS.length);
    assert.strictEqual(new Set(plaene).size, AGENTS.length, `bekam: ${plaene.join(" / ")}`);
  });

  it("versetzt rem-dream je Agent", () => {
    const plaene = plaeneVon(planeAlle(), "rem-dream");
    assert.strictEqual(plaene.length, AGENTS.length);
    assert.strictEqual(new Set(plaene).size, AGENTS.length, `bekam: ${plaene.join(" / ")}`);
  });

  it("plant den Garbage Collector genau einmal, unabhängig von der Agentenzahl", () => {
    const create = planeAlle();
    const gc = create.filter((job) => job.command === "/plur1bus internal gc-run");
    assert.strictEqual(gc.length, 1, `runGcJob scannt ohnehin alle Datenbanken — bekam ${gc.length} Jobs`);
  });

  it("plant den Garbage Collector auch bei einem einzigen Agenten", () => {
    const create = planFeatureCrons([], REQUIRED_FEATURE_CRONS, { agents: [{ id: "main", isDefault: true }] }).create;
    const gc = create.filter((job) => job.command === "/plur1bus internal gc-run");
    assert.strictEqual(gc.length, 1);
  });

  it("erkennt einen bereits angelegten GC-Job wieder, statt ihn zu verdoppeln", () => {
    const erst = planFeatureCrons([], REQUIRED_FEATURE_CRONS, { agents: AGENTS }).create;
    const vorhanden = erst
      .filter((job) => job.command === "/plur1bus internal gc-run")
      .map((job) => ({
        id: "gc-1",
        agentId: "main",
        name: job.name,
        enabled: true,
        payload: { message: job.message },
      }));

    const zweit = planFeatureCrons(vorhanden, REQUIRED_FEATURE_CRONS, { agents: AGENTS }).create;
    assert.strictEqual(zweit.filter((job) => job.command === "/plur1bus internal gc-run").length, 0);
  });
});

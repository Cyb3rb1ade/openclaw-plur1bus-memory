import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDreamingStatusProvider, readLightDreamRun, recordLightDreamRun } from "../lib/dreaming/dreaming-status-provider.js";
import { forgetTempDir, makeTempDir } from "./helpers/temp-dir.js";

// Form wie OpenClaws cron.list() sie liefert: Feature-Crons laufen als
// command-Jobs mit `--agent`/`--feature` im argv, je Agent versetzt.
function featureJob({ agentId, feature, expr, enabled = true, nextRunAtMs, lastRunAtMs }) {
  return {
    id: `${feature}-${agentId}`,
    agentId,
    enabled,
    schedule: { kind: "cron", expr, tz: "Europe/Berlin" },
    payload: {
      kind: "command",
      argv: ["/usr/bin/node", "run-feature-cron.mjs", "--agent", agentId, "--feature", feature],
    },
    state: { nextRunAtMs, lastRunAtMs },
  };
}

const JOBS = [
  featureJob({ agentId: "main", feature: "rem-dream", expr: "15 1 * * *", nextRunAtMs: 1_000, lastRunAtMs: 900 }),
  featureJob({ agentId: "main", feature: "consolidate-daily", expr: "0 4 * * *", nextRunAtMs: 2_000 }),
  featureJob({ agentId: "bernhardine", feature: "rem-dream", expr: "30 1 * * *" }),
  featureJob({ agentId: "bernhardine", feature: "consolidate-daily", expr: "15 4 * * *" }),
];

function provider({ jobs = JOBS, cfg = { merging: { enabled: true }, neo: { enabled: true } }, cron } = {}) {
  return createDreamingStatusProvider({
    getPluginConfig: () => cfg,
    getCron: () => cron ?? { list: async () => jobs },
  });
}

describe("PLUR1BUS dreaming-status provider", () => {
  it("meldet je Phase den Job, der für diesen Agenten wirklich eingetragen ist", async () => {
    const status = await provider().getStatus({ cfg: {}, agentId: "main" });

    assert.equal(status.enabled, true);
    assert.equal(status.timezone, "Europe/Berlin");
    assert.deepEqual(status.phases.rem, {
      enabled: true, cron: "15 1 * * *", scheduled: true, nextRunAtMs: 1_000, lastRunAtMs: 900,
    });
    assert.deepEqual(status.phases.deep, {
      enabled: true, cron: "0 4 * * *", scheduled: true, nextRunAtMs: 2_000,
    });
  });

  it("liefert für jeden Agenten dessen eigenen, versetzten Zeitplan", async () => {
    const status = await provider().getStatus({ cfg: {}, agentId: "bernhardine" });
    assert.equal(status.phases.rem.cron, "30 1 * * *");
    assert.equal(status.phases.deep.cron, "15 4 * * *");
  });

  it("meldet den Leichtschlaf als ereignisgesteuert — mit leerem cron statt eines geerbten", async () => {
    // Ein weggelassenes cron behielte den Host-Wert; der Leichtschlaf folgt
    // aber keiner Uhr, sondern läuft nach einem Gespräch.
    const status = await provider().getStatus({ cfg: {}, agentId: "main" });
    assert.deepEqual(status.phases.light, { enabled: true, scheduled: true, cron: "" });
  });

  it("zählt merging und neo als an, solange sie nicht ausdrücklich aus sind — wie index.js", async () => {
    const status = await provider({ cfg: {} }).getStatus({ cfg: {}, agentId: "main" });
    assert.deepEqual(status.phases.light, { enabled: true, scheduled: true, cron: "" });
  });

  it("meldet keinen Leichtschlaf, wenn merging oder neo ihn abschalten", async () => {
    const off = await provider({ cfg: { merging: { enabled: false }, neo: { enabled: true } } })
      .getStatus({ cfg: {}, agentId: "main" });
    assert.equal(off.phases.light, undefined);
  });

  it("übergeht abgeschaltete Jobs und die anderer Agenten", async () => {
    const jobs = [
      featureJob({ agentId: "main", feature: "rem-dream", expr: "15 1 * * *", enabled: false }),
      featureJob({ agentId: "heisenberg", feature: "consolidate-daily", expr: "30 4 * * *" }),
    ];
    const status = await provider({ jobs, cfg: {} }).getStatus({ cfg: {}, agentId: "main" });
    assert.equal(status, null, "ohne einen einzigen eigenen Lauf gibt es nichts zu melden");
  });

  it("schweigt, wenn der Cron-Dienst fehlt oder scheitert, damit der Host seine Werte behält", async () => {
    const none = createDreamingStatusProvider({ getPluginConfig: () => ({}), getCron: () => null });
    assert.equal(await none.getStatus({ cfg: {}, agentId: "main" }), null);

    const broken = provider({ cron: { list: async () => { throw new Error("cron down"); } } });
    assert.equal(await broken.getStatus({ cfg: {}, agentId: "main" }), null);
  });

  it("hält den letzten Leichtschlaf je Agent fest, dateibasiert und neustartfest", async () => {
    const dir = makeTempDir("dreaming-phase-runs-");
    try {
      await recordLightDreamRun({ baseDbPath: dir, agentId: "main", atMs: 1_000 });
      await recordLightDreamRun({ baseDbPath: dir, agentId: "bernhardine", atMs: 2_000 });
      await recordLightDreamRun({ baseDbPath: dir, agentId: "main", atMs: 3_000 });
      assert.equal(await readLightDreamRun({ baseDbPath: dir, agentId: "main" }), 3_000);
      assert.equal(await readLightDreamRun({ baseDbPath: dir, agentId: "bernhardine" }), 2_000);
      assert.equal(await readLightDreamRun({ baseDbPath: dir, agentId: "heisenberg" }), undefined);
      await assert.rejects(() => recordLightDreamRun({ baseDbPath: dir, agentId: "__proto__", atMs: 1 }), /agent/);
    } finally {
      forgetTempDir(dir);
    }
  });

  it("meldet den letzten Leichtschlaf als lastRunAtMs, damit die Szene ihn zeigen kann", async () => {
    const status = await createDreamingStatusProvider({
      getPluginConfig: () => ({}),
      getCron: () => ({ list: async () => JOBS }),
      readLastLightRun: async (agentId) => (agentId === "main" ? 4_000 : undefined),
    }).getStatus({ cfg: {}, agentId: "main" });
    assert.deepEqual(status.phases.light, { enabled: true, scheduled: true, cron: "", lastRunAtMs: 4_000 });

    const none = await createDreamingStatusProvider({
      getPluginConfig: () => ({}),
      getCron: () => ({ list: async () => JOBS }),
      readLastLightRun: async () => { throw new Error("unreadable"); },
    }).getStatus({ cfg: {}, agentId: "main" });
    assert.deepEqual(none.phases.light, { enabled: true, scheduled: true, cron: "" }, "ein Lesefehler kostet nur den Zeitstempel");
  });
});


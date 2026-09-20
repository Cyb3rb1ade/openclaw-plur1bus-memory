import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { projectOperations, readGcReport } from "../lib/dashboard-operations.js";
import { buildControlPlaneProjection } from "../lib/control-plane-projection.js";
import { resolveEffectiveConfig } from "../lib/setup/config-contract.js";
import { createControlUiHttpHandler } from "../lib/setup/control-ui-plugin-runtime.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// makeTempDir tracks and removes the directory itself; no rmSync here.
function workspaceWith(report) {
  const dir = makeTempDir("plur1bus-ops-");
  if (report !== undefined) {
    mkdirSync(join(dir, ".adaptive-learning"), { recursive: true });
    writeFileSync(join(dir, ".adaptive-learning", "gc-report.json"), typeof report === "string" ? report : JSON.stringify(report));
  }
  return dir;
}

const health = {
  status: "ready", namespaces: [], storage: { bytes: 1, complete: true }, lastError: null, observedAt: 1,
  cards: { byAgent: [{ id: "main", cards: 32066 }, { id: "bernhardine", cards: 19871 }], byWorkspace: [], byUser: [], byPrimaryAgent: [] },
};
// Handed straight to projectOperations: one unsafe id must fall out on its own.
const healthWithBadId = { ...health, cards: { ...health.cards, byAgent: [...health.cards.byAgent, { id: "bad id!", cards: 5 }] } };

test("liest den letzten GC-Lauf und übergeht fehlende oder kaputte Reports", () => {
  {
    const good = workspaceWith({ runs: [
      { timestamp: "2026-09-19T02:45:00.000Z", totalArchived: 3, totalSkipped: 0, agents: [] },
      { timestamp: "2026-09-20T02:45:02.809Z", totalArchived: 0, totalSkipped: 2, agents: [
        { agentId: "main", ok: true, archived: 0, skipped: 0, dbSizeMb: 6100, memoryCount: 31990 },
        { agentId: "../evil", memoryCount: 1 },
        { agentId: "_neo", ok: true, archived: 0, skipped: 0, dbSizeMb: 0, memoryCount: 0 },
      ] },
    ] });
    const report = readGcReport(good);
    assert.equal(report.runs, 2);
    assert.equal(report.lastRun.at, Date.parse("2026-09-20T02:45:02.809Z"));
    assert.equal(report.lastRun.totalSkipped, 2);
    assert.deepEqual(report.lastRun.agents.map((a) => a.agentId), ["main", "_neo"], "unsichere Kennungen fallen raus");
    assert.equal(report.lastRun.agents[0].memoryCount, 31990);
    for (const broken of [workspaceWith(undefined), workspaceWith("{not json"), workspaceWith({ runs: [] }), workspaceWith({ runs: [{ nope: 1 }] })]) {
      assert.equal(readGcReport(broken), null);
    }
    assert.equal(readGcReport(null), null);
    assert.equal(readGcReport(""), null);
  }
});

test("rechnet den Spielraum je Agent gegen die Obergrenze und ordnet nach Größe", () => {
  const gcReport = { runs: 30, lastRun: { at: 1, totalArchived: 0, totalSkipped: 0, agents: [{ agentId: "main", memoryCount: 31990, dbSizeMb: 6100, archived: 0, ok: true }] } };
  const ops = projectOperations({ config: resolveEffectiveConfig({ gc: { maxMemoryCount: 40000 } }), health: healthWithBadId, gcReport, pressure: { level: "ok", rssBytes: 1e9, heapUsedBytes: 5e8 } });
  assert.deepEqual(ops.gc.agents.map((a) => a.id), ["main", "bernhardine"], "nur gültige Kennungen, größte zuerst");
  const main = ops.gc.agents[0];
  assert.equal(main.usedPct, 80);
  assert.equal(main.activeAtGc, 31990);
  assert.equal(main.dbSizeMb, 6100);
  assert.equal(ops.gc.agents[1].activeAtGc, null, "kein GC-Eintrag, keine erfundene Zahl");
  assert.equal(ops.gc.maxMemoryCount, 40000);
  assert.equal(ops.gc.lastRun.agentsChecked, 1);
  assert.equal(ops.gc.lastRun.runs, 30);
  assert.equal(ops.gc.moreAgents, 0);
  // Ohne Obergrenze gibt es keinen Prozentwert.
  const uncapped = projectOperations({ config: resolveEffectiveConfig({}), health });
  assert.equal(uncapped.gc.maxMemoryCount, null);
  assert.equal(uncapped.gc.agents[0].usedPct, null);
  assert.equal(uncapped.gc.lastRun, null);
  assert.equal(uncapped.pressure, null);
  // Mehr als acht Speicher: der Rest wird gezählt, nicht gelistet.
  const many = { ...health, cards: { ...health.cards, byAgent: Array.from({ length: 12 }, (_, i) => ({ id: `agent-${i}`, cards: 100 - i })) } };
  assert.equal(projectOperations({ config: resolveEffectiveConfig({}), health: many }).gc.moreAgents, 4);
});

test("Druck und Laufzeitgrenzen kommen aus der wirksamen Konfiguration", () => {
  const ops = projectOperations({ config: resolveEffectiveConfig({ runtime: { recallTimeoutMs: 8000, pressureGateEnabled: false } }), pressure: { level: "warning", rssBytes: 3.3e9, heapUsedBytes: 1e9 } });
  assert.equal(ops.pressure.level, "warning");
  assert.equal(ops.pressure.warningBytes, 3221225472, "Schema-Vorgabe");
  assert.equal(ops.pressure.gateEnabled, false);
  const byKey = Object.fromEntries(ops.runtime.map((row) => [row.key, row.value]));
  assert.equal(byKey.recallTimeoutMs, 8000);
  assert.equal(byKey.captureTimeoutMs, 60000, "Vorgabe, wenn nicht gesetzt");
  assert.equal(byKey.backgroundPriority, "low");
  assert.equal(projectOperations({ config: {}, pressure: { level: "bogus" } }).pressure.level, "unknown");
});

test("das Panel erscheint mit Sprungleisten-Anker, Balken und lesbaren Werten", async () => {
  const projection = buildControlPlaneProjection({
    config: resolveEffectiveConfig({ gc: { maxMemoryCount: 40000 } }), health,
    gcReport: { runs: 3, lastRun: { at: Date.now() - 3600_000, totalArchived: 12, totalSkipped: 0, agents: [{ agentId: "main", memoryCount: 31990, dbSizeMb: 6100, archived: 12, ok: true }] } },
    pressure: { level: "ok", rssBytes: 1_200_000_000, heapUsedBytes: 400_000_000 },
  });
  const handler = createControlUiHttpHandler({ getProjection: async () => projection });
  const response = { statusCode: 0, setHeader() {}, end(body) { this.body = body; } };
  await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control", headers: { host: "localhost" } }, response);
  const html = response.body;
  assert.match(html, /<h2 id="operations-title">Capacity &amp; Runtime<\/h2>/);
  assert.match(html, /<a href="#operations-title">Capacity<\/a>/);
  assert.match(html, /<code>main<\/code><\/th><td>32,066<\/td><td>40,000<\/td><td><span class="headroom is-warning"><progress value="80" max="100"/);
  assert.match(html, /12 archived, 0 skipped across 1 agents \(3 runs on record\)/);
  assert.match(html, /Process pressure<\/h3>.*?<dt>RSS<\/dt><dd><span title="1,200,000,000 B">1\.2 GB<\/span>/s);
  assert.match(html, /<code>recallTimeoutMs<\/code>.*?<strong>45,000 ms<\/strong>/s);
  assert.doesNotMatch(html, /bad id!/);
});

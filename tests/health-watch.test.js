import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  createGatewayLogWatch,
  createLlmFailureRecorder,
  projectHealthWatch,
  resolveGatewayLogFiles,
  scanGatewayLog,
} from "../lib/health-watch.js";
import { buildControlPlaneProjection } from "../lib/control-plane-projection.js";
import { createControlUiHttpHandler } from "../lib/setup/control-ui-plugin-runtime.js";
import { completeFeatureLlm, resolveFeatureLlmRoute } from "../lib/llm-router.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const NOW = Date.parse("2026-10-01T05:00:00.000Z");
const HOUR = 60 * 60 * 1000;

// One JSON line in the shape the OpenClaw gateway writes. The message carries
// a secret-looking sentinel that must never reach the dashboard.
function logLine(isoDate, message) {
  return JSON.stringify({ 0: "{\"subsystem\":\"x\"}", 1: `${message} sentinel-secret-do-not-project`, _meta: { date: isoDate, logLevelName: "WARN" } });
}

test("Fehlerzähler fasst nach Feature/Agent/Ursache zusammen und vergisst nach 24 h", () => {
  let now = NOW - 30 * HOUR;
  const recorder = createLlmFailureRecorder({ now: () => now });
  recorder.record({ feature: "dream-narrative", agentId: "bernhardine", hint: "unavailable", errorClass: "Error" });
  now = NOW - 2 * HOUR;
  recorder.record({ feature: "dream-narrative", agentId: "bernhardine", hint: "unavailable", errorClass: "Error" });
  recorder.record({ feature: "dream-narrative", agentId: "bernhardine", hint: "unavailable", errorClass: "Error" });
  recorder.record({ feature: "episode-extraction", agentId: "main", hint: "timeout", errorClass: "TimeoutError" });
  recorder.record({ feature: "bad feature!", agentId: "../etc", hint: "x".repeat(200), message: "leak" });
  now = NOW;
  const rows = recorder.snapshot();
  const dream = rows.find((row) => row.feature === "dream-narrative");
  assert.equal(dream.count, 2, "the 30 h old failure is outside the window");
  assert.equal(dream.agentId, "bernhardine");
  assert.equal(dream.lastAt, NOW - 2 * HOUR);
  const unsafe = rows.find((row) => row.feature === "unknown");
  assert.deepEqual([unsafe.agentId, unsafe.hint], [null, "unknown"]);
  assert.doesNotMatch(JSON.stringify(rows), /leak|\.\.\/etc/);
});

test("Fehlerzähler bleibt begrenzt", () => {
  const recorder = createLlmFailureRecorder({ maxEntries: 3, now: () => NOW });
  for (let i = 0; i < 10; i += 1) recorder.record({ feature: "merging", hint: "timeout" });
  assert.equal(recorder.snapshot()[0].count, 3);
});

test("Log-Scan zählt die vier Signale im Fenster und ignoriert skipped-Ursachen", async () => {
  const dir = makeTempDir("plur1bus-health-watch-");
  const { files } = resolveGatewayLogFiles({ gatewayLogDir: dir, nowMs: NOW });
  writeFileSync(join(dir, files[1]), [
    logLine("2026-10-01T04:55:00.000Z", "lane task error: error=\"Agent database cleanup failed\""),
    logLine("2026-10-01T00:07:14.000Z", "Channel ingress claim→adoption stalled for event 1 on lane telegram:1:control after 300001ms"),
    logLine("2026-10-01T00:08:17.000Z", "visible channel turn dispatched with no queued reply payloads: channel=telegram messageId=1 cause=completed"),
    logLine("2026-10-01T00:07:16.000Z", "visible channel turn dispatched with no queued reply payloads: channel=telegram messageId=1 cause=skipped:duplicate"),
    logLine("2026-09-29T22:09:01.000Z", "memory pressure: level=critical reason=rss_threshold"),
    logLine("2026-10-01T02:01:36.000Z", "memory pressure: level=critical reason=rss_growth rss=3.33 GiB"),
    "not json at all",
    "",
  ].join("\n"));
  const scan = await scanGatewayLog({ dir, files, nowMs: NOW });
  assert.equal(scan.readable, true);
  const byId = Object.fromEntries(scan.signals.map((entry) => [entry.id, entry]));
  assert.equal(byId["agent-db-cleanup"].count, 1);
  assert.equal(byId["ingress-stall"].count, 1);
  assert.equal(byId["reply-dropped"].count, 1, "cause=skipped:duplicate is not a lost reply");
  assert.equal(byId["memory-critical"].count, 0, "one is older than 24 h, the other is warm-up growth");
  assert.equal(byId["reply-dropped"].lastAt, Date.parse("2026-10-01T00:08:17.000Z"));
});

test("Log-Scan zählt mehrere Zeilen eines Ereignisses einmal", async () => {
  const dir = makeTempDir("plur1bus-health-watch-");
  const { files } = resolveGatewayLogFiles({ gatewayLogDir: dir, nowMs: NOW });
  writeFileSync(join(dir, files[1]), [
    logLine("2026-10-01T04:00:11.865Z", "lane task error: lane=cron-nested error=\"Agent database cleanup failed\""),
    logLine("2026-10-01T04:00:11.870Z", "lane task error: lane=session:agent:main error=\"Agent database cleanup failed\""),
    logLine("2026-10-01T04:00:20.000Z", "lane task error: lane=session:agent:main error=\"Agent database cleanup failed\""),
    logLine("2026-10-01T00:07:14.100Z", "Channel ingress claim\u2192adoption stalled for event 1"),
    logLine("2026-10-01T00:07:14.300Z", "spooled update 1 failed; keeping for retry: Channel ingress claim\u2192adoption stalled for event 1"),
  ].join("\n"));
  const scan = await scanGatewayLog({ dir, files, nowMs: NOW });
  const byId = Object.fromEntries(scan.signals.map((entry) => [entry.id, entry]));
  assert.equal(byId["agent-db-cleanup"].count, 2, "two failures nine seconds apart, three lines");
  assert.equal(byId["ingress-stall"].count, 1);
});

test("Log-Scan liest nur das Ende großer Dateien und meldet fehlende Logs als nicht lesbar", async () => {
  const dir = makeTempDir("plur1bus-health-watch-");
  const { files } = resolveGatewayLogFiles({ gatewayLogDir: dir, nowMs: NOW });
  const filler = "x".repeat(200);
  const lines = [logLine("2026-10-01T01:00:00.000Z", "Agent database cleanup failed")];
  for (let i = 0; i < 200; i += 1) lines.push(filler);
  lines.push(logLine("2026-10-01T04:00:00.000Z", "claim->adoption stalled"));
  writeFileSync(join(dir, files[1]), lines.join("\n"));
  const tail = await scanGatewayLog({ dir, files, nowMs: NOW, maxBytesPerFile: 4096 });
  const byId = Object.fromEntries(tail.signals.map((entry) => [entry.id, entry]));
  assert.equal(byId["agent-db-cleanup"].count, 0, "the head of the file is beyond the tail window");
  assert.equal(byId["ingress-stall"].count, 1);

  const missing = await scanGatewayLog({ dir: join(dir, "does-not-exist"), files, nowMs: NOW });
  assert.equal(missing.readable, false);
});

test("Log-Pfad folgt Override, dann logging.file, dann /tmp/openclaw", () => {
  const today = "openclaw-2026-10-01.log";
  assert.deepEqual(resolveGatewayLogFiles({ gatewayLogDir: "/var/log/oc", nowMs: Date.parse("2026-10-01T12:00:00") }).dir, "/var/log/oc");
  const rolling = resolveGatewayLogFiles({ loggingFile: "/srv/oc/openclaw-2026-09-01.log", nowMs: Date.parse("2026-10-01T12:00:00") });
  assert.equal(rolling.dir, "/srv/oc");
  assert.ok(rolling.files.includes(today));
  assert.deepEqual(resolveGatewayLogFiles({ loggingFile: "/srv/oc/gateway.log", nowMs: NOW }), { dir: "/srv/oc", files: ["gateway.log"] });
  assert.equal(resolveGatewayLogFiles({ nowMs: NOW }).dir, "/tmp/openclaw");
});

test("Log-Watch liest höchstens einmal pro TTL", async () => {
  let now = NOW;
  let scans = 0;
  const watch = createGatewayLogWatch({ ttlMs: 60_000, now: () => now, scan: async () => ({ readable: true, signals: [], n: ++scans }) });
  await Promise.all([watch.snapshot(), watch.snapshot()]);
  await watch.snapshot();
  assert.equal(scans, 1);
  now += 61_000;
  await watch.snapshot();
  assert.equal(scans, 2);
});

test("Projektion: frische Agent-DB-Blockade ist failed, wiederholter Feature-Fehler degraded, Timeouts nicht", () => {
  const signals = [
    { id: "agent-db-cleanup", count: 2, lastAt: NOW - 5 * 60 * 1000 },
    { id: "reply-dropped", count: 1, lastAt: NOW - 4 * HOUR },
  ];
  const failed = projectHealthWatch({ llmFailures: [], logScan: { readable: true, signals }, nowMs: NOW });
  assert.equal(failed.gateway.state, "failed");
  assert.equal(failed.status, "failed");
  assert.equal(failed.gateway.signals.find((row) => row.id === "reply-dropped").state, "degraded");

  const old = projectHealthWatch({ logScan: { readable: true, signals: [{ id: "agent-db-cleanup", count: 1, lastAt: NOW - 3 * HOUR }] }, nowMs: NOW });
  assert.equal(old.gateway.state, "degraded", "an old cleanup failure is history, not an outage");

  const timeouts = projectHealthWatch({ llmFailures: [{ feature: "emotionT3", hint: "timeout", count: 9, lastAt: NOW }], logScan: { readable: true, signals: [] }, nowMs: NOW });
  assert.equal(timeouts.llm.state, "ready");
  const broken = projectHealthWatch({ llmFailures: [{ feature: "dream-narrative", agentId: "bernhardine", hint: "unavailable", count: 3, lastAt: NOW }], logScan: { readable: true, signals: [] }, nowMs: NOW });
  assert.equal(broken.llm.state, "degraded");

  const unreadable = projectHealthWatch({ logScan: null, nowMs: NOW });
  assert.equal(unreadable.gateway.state, "unavailable");
  assert.ok(unreadable.gateway.signals.every((row) => row.state === "unavailable"));
});

test("Dashboard zeigt Zähler, aber keinen Log-Text und keine Pfade", async () => {
  const dir = makeTempDir("plur1bus-health-watch-");
  const { files } = resolveGatewayLogFiles({ gatewayLogDir: dir, nowMs: Date.now() });
  writeFileSync(join(dir, files[1]), logLine(new Date(Date.now() - HOUR).toISOString(),
    "visible channel turn dispatched with no queued reply payloads: messageId=1 cause=completed"));
  const logScan = await scanGatewayLog({ dir, files });
  const recorder = createLlmFailureRecorder();
  recorder.record({ feature: "dream-narrative", agentId: "bernhardine", hint: "unavailable", errorClass: "Error" });
  const projection = buildControlPlaneProjection({ healthWatch: { llmFailures: recorder.snapshot(), logScan } });
  assert.equal(projection.healthWatch.gateway.signals.find((row) => row.id === "reply-dropped").count, 1);
  const serialized = JSON.stringify(projection.healthWatch);
  assert.doesNotMatch(serialized, /sentinel-secret|plur1bus-health-watch-|openclaw-\d{4}/);

  const handler = createControlUiHttpHandler({ getProjection: async () => projection });
  const response = { statusCode: 0, setHeader() {}, end(body) { this.body = body; } };
  await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control", headers: { host: "localhost" } }, response);
  const html = response.body;
  assert.match(html, /<h3 id="health-watch-llm-title">LLM failures \(24 h\)<\/h3>/);
  assert.match(html, /<code>dream-narrative<\/code><\/td><td><code>bernhardine<\/code><\/td><td>model or runtime unavailable<\/td><td>1<\/td>/);
  assert.match(html, /Turn completed without a reply payload<\/td><td>1<\/td>/);
  assert.doesNotMatch(html, /sentinel-secret|plur1bus-health-watch-/);
});

test("Router zählt fehlgeschlagene Aufrufe im Fehlerzähler mit", async () => {
  const recorder = createLlmFailureRecorder();
  const route = resolveFeatureLlmRoute({ model: "openai/gpt-6-luna" }, {
    feature: "dream-narrative",
    runtimeLlm: { complete: async () => { throw new Error("model is not available for this agent"); } },
    logger: { warn() {}, debug() {} },
    failureRecorder: recorder,
  });
  await completeFeatureLlm([{ role: "user", content: "x" }], route, { agentId: "bernhardine", purpose: "dream-narrative" });
  const [row] = recorder.snapshot();
  assert.equal(row.feature, "dream-narrative");
  assert.equal(row.agentId, "bernhardine");
  assert.equal(row.hint, "unavailable");
});

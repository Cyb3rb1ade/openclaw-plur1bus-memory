import { strict as assert } from "node:assert";
import test from "node:test";

import {
  createCompactionRunner,
  isPartitionId,
  summarizeOptimizeStats,
} from "../lib/setup/control-ui-compaction.js";
import {
  CONTROL_UI_ACTION_FIELD,
  CONTROL_UI_FORM_TOKEN_FIELD,
  applyControlUiWriteAction,
  createFormTokenStore,
  writeResultText,
} from "../lib/setup/control-ui-write.js";
import { CONTROL_UI_PATH, createControlUiHttpHandler } from "../lib/setup/control-ui-plugin-runtime.js";
import { buildControlPlaneProjection } from "../lib/control-plane-projection.js";
import { resolveEffectiveConfig } from "../lib/setup/config-contract.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("partition ids follow the public id contract", () => {
  assert.equal(isPartitionId("main"), true);
  assert.equal(isPartitionId("bernhardine-developer-verifier"), true);
  assert.equal(isPartitionId("_neo"), false);
  assert.equal(isPartitionId("../etc"), false);
  assert.equal(isPartitionId(""), false);
  assert.equal(isPartitionId(42), false);
});

test("optimize statistics become one number-safe sentence", () => {
  assert.equal(
    summarizeOptimizeStats({ compaction: { fragmentsRemoved: 120, fragmentsAdded: 3 }, prune: { bytesRemoved: 340 * 1024 * 1024, oldVersionsRemoved: 2 } }),
    "fragments 120 → 3 · 340.0 MB freed · 2 old versions pruned",
  );
  assert.equal(summarizeOptimizeStats(undefined), "compacted");
  assert.equal(summarizeOptimizeStats({ compaction: { fragmentsRemoved: "x" } }), "compacted");
});

test("the runner refuses unknown ids, runs one compaction at a time and records the outcome", async () => {
  let clock = 1_000;
  const gate = deferred();
  const calls = [];
  const finished = [];
  const runner = createCompactionRunner({
    now: () => clock,
    knownPartitions: () => ["main", "bernhardine"],
    optimize: async (id) => { calls.push(id); return gate.promise; },
    onFinished: (entry) => finished.push(entry?.status),
  });

  assert.deepEqual(await runner.start({ id: "heisenberg" }), { ok: false, code: "denied_partition" });
  assert.deepEqual(await runner.start({ id: "../main" }), { ok: false, code: "denied_partition" });
  assert.deepEqual(calls, [], "refused ids never reach the store");

  assert.deepEqual(await runner.start({ id: "main" }), { ok: true, code: "compaction_started" });
  await settle();
  assert.deepEqual(calls, ["main"]);
  assert.deepEqual(await runner.start({ id: "bernhardine" }), { ok: false, code: "denied_busy" });
  assert.deepEqual(await runner.start({ id: "main" }), { ok: false, code: "denied_busy" });
  let status = runner.status();
  assert.equal(status.active, "main");
  assert.equal(status.byPartition.main.status, "running");

  clock = 5_000;
  gate.resolve({ ok: true, stats: { compaction: { fragmentsRemoved: 10, fragmentsAdded: 1 } } });
  await settle();
  await settle();
  status = runner.status();
  assert.equal(status.active, null);
  assert.deepEqual(status.byPartition.main, { id: "main", status: "done", startedAt: 1_000, finishedAt: 5_000, summary: "fragments 10 → 1" });
  assert.deepEqual(finished, ["done"]);

  // A failed optimize (adapter result or thrown error) is recorded, never thrown.
  const failing = createCompactionRunner({
    now: () => clock,
    knownPartitions: async () => ["main"],
    optimize: async () => { throw new Error("disk full"); },
  });
  assert.deepEqual(await failing.start({ id: "main" }), { ok: true, code: "compaction_started" });
  await settle();
  await settle();
  assert.equal(failing.status().byPartition.main.status, "failed");
  assert.equal(failing.status().active, null);

  const refused = createCompactionRunner({
    now: () => clock,
    knownPartitions: async () => ["main"],
    optimize: async () => ({ ok: false, reason: "no-table" }),
  });
  await refused.start({ id: "main" });
  await settle();
  await settle();
  assert.equal(refused.status().byPartition.main.status, "failed");
});

test("finished entries age out of the status after the history window", async () => {
  let clock = 0;
  const runner = createCompactionRunner({
    now: () => clock,
    historyTtlMs: 1_000,
    knownPartitions: () => ["main"],
    optimize: async () => ({ ok: true }),
  });
  await runner.start({ id: "main" });
  await settle();
  await settle();
  assert.equal(runner.status().byPartition.main.status, "done");
  clock = 5_000;
  assert.deepEqual(runner.status().byPartition, {});
});

test("the dashboard action only starts compaction on the full write surface", async () => {
  const started = [];
  const deps = { startCompaction: async (request) => { started.push(request.id); return { ok: true, code: "compaction_started" }; } };
  const form = new URLSearchParams({ partition: "main" });

  assert.deepEqual(await applyControlUiWriteAction({ action: "compaction.start", form, mode: "reranker", deps }), { ok: false, code: "denied_mode" });
  assert.deepEqual(await applyControlUiWriteAction({ action: "compaction.start", form, mode: "off", deps }), { ok: false, code: "denied_mode" });
  assert.deepEqual(
    await applyControlUiWriteAction({ action: "compaction.start", form: new URLSearchParams({ partition: "../x" }), mode: "all", deps }),
    { ok: false, code: "denied_partition" },
  );
  assert.deepEqual(await applyControlUiWriteAction({ action: "compaction.start", form, mode: "all", deps }), { ok: true, code: "compaction_started" });
  assert.deepEqual(started, ["main"]);

  const busy = { startCompaction: async () => ({ ok: false, code: "denied_busy" }) };
  assert.deepEqual(await applyControlUiWriteAction({ action: "compaction.start", form, mode: "all", deps: busy }), { ok: false, code: "denied_busy" });
  assert.deepEqual(await applyControlUiWriteAction({ action: "compaction.start", form, mode: "all", deps: {} }), { ok: false, code: "denied_action" });
  for (const code of ["compaction_started", "denied_busy", "denied_partition"]) assert.equal(typeof writeResultText(code), "string");
});

function collectingResponse() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: "",
    headers,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    end(body = "") { this.body = body; },
  };
}

const projectionWithHealth = () => buildControlPlaneProjection({
  config: resolveEffectiveConfig({}),
  capabilities: { reranker: true },
  providers: { reranker: { provider: "disabled" } },
  health: {
    status: "ready",
    observedAt: 1_000,
    namespaces: [{ id: "lancedb-namespaced", dimensions: 768, rows: 12 }],
    cards: { byAgent: [{ id: "main", cards: 9 }, { id: "bernhardine", cards: 3 }], byWorkspace: [], byUser: [] },
    storage: { bytes: 4_096, complete: true },
    lastError: null,
  },
});

async function renderWith(write) {
  const handler = createControlUiHttpHandler({
    getProjection: async () => projectionWithHealth(),
    now: () => 2_000,
    write,
  });
  const response = collectingResponse();
  await handler({ method: "GET", url: CONTROL_UI_PATH, headers: {} }, response);
  return response;
}

test("each private partition row carries a Compact form on the full write surface only", async () => {
  const tokens = createFormTokenStore();
  const status = { active: null, byPartition: { bernhardine: { id: "bernhardine", status: "done", startedAt: 1, finishedAt: 2, summary: "fragments 4 → 1" } } };
  const full = await renderWith({
    mode: "all",
    tokens,
    applyAction: async () => ({ ok: true, code: "compaction_started" }),
    compactionStatus: () => status,
  });
  assert.equal(full.statusCode, 200);
  assert.match(full.body, new RegExp(`name="${CONTROL_UI_ACTION_FIELD}" value="compaction.start"`));
  assert.match(full.body, /name="partition" value="main"/);
  assert.match(full.body, /name="partition" value="bernhardine"/);
  assert.match(full.body, /<button type="submit">Compact<\/button>/);
  assert.match(full.body, /fragments 4 → 1/);
  assert.match(full.body, new RegExp(`name="${CONTROL_UI_FORM_TOKEN_FIELD}" value="[A-Za-z0-9_-]+"`));

  const running = await renderWith({
    mode: "all",
    tokens,
    applyAction: async () => ({ ok: true, code: "compaction_started" }),
    compactionStatus: () => ({ active: "main", byPartition: { main: { id: "main", status: "running", startedAt: 1, finishedAt: null, summary: null } } }),
  });
  assert.match(running.body, /compacting…/);
  assert.match(running.body, /<button type="submit" disabled>Compact<\/button>/, "other rows wait while one compaction runs");

  const rerankerOnly = await renderWith({
    mode: "reranker",
    tokens,
    applyAction: async () => ({ ok: true, code: "reranker_switched" }),
    compactionStatus: () => status,
  });
  assert.doesNotMatch(rerankerOnly.body, /compaction\.start/);
  assert.match(rerankerOnly.body, /<code>main<\/code><strong>9<\/strong>/);

  const readOnly = await renderWith(null);
  assert.doesNotMatch(readOnly.body, /compaction\.start/);
});

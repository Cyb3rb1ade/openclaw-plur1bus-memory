/**
 * tests/fragment-compaction-benchmark.test.js — E5 Task 7: compaction
 * benchmark, flat latency.
 *
 * Two engines on separate temp LanceDB roots, same deterministic hash
 * embedder: A has `lancedbCompaction: { enabled: false }`, B has
 * `{ fragmentThreshold: 16, checkEveryWrites: 8 }`. Each captures 160
 * distinct texts in four windows of 40. After each window this measures,
 * for both engines, the median of 5 `engine.memory.list({ topic:
 * "benchmark topic" })` durations, the median capture duration of the
 * window just run, and `fragmentCount` (when the adapter can report it).
 *
 * Per R17 (preflight), the "must be able to fail" proof for this test
 * rests on the fragment-count assertions (A ends with >= 160 fragments,
 * B ends with <= 24): at 160 tiny one-row fragments, `list`/`capture`
 * latency growth may not reliably cross 2x + 20ms even without
 * compaction, so the latency assertions are kept but not relied on to
 * prove failure — see task-7-report.md for a local run with B's
 * compaction disabled.
 *
 * Opt-in: this suite runs a real LanceDB with 320 total captures across
 * two engines, which is too slow/flaky to carry in the default `npm
 * test` run on a 2-core machine. It only runs when
 * PLUR1BUS_RUN_COMPACTION_BENCHMARK=1 is set.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const RUN = process.env.PLUR1BUS_RUN_COMPACTION_BENCHMARK === "1";
const testOptions = {
  timeout: 240_000,
  ...(RUN ? {} : { skip: "opt-in benchmark: set PLUR1BUS_RUN_COMPACTION_BENCHMARK=1" }),
};

const AGENT = "agent-a";
const WINDOW_SIZE = 40;
const WINDOW_COUNT = 4;
const TOTAL_CAPTURES = WINDOW_SIZE * WINDOW_COUNT; // 160
const LIST_SAMPLES = 5;
const BENCHMARK_TOPIC = "benchmark topic";

function textHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
function hashVector(text) {
  const h = textHash(String(text));
  const scale = 1 / Math.sqrt(384);
  return Array.from({ length: 384 }, (_, i) => (((h >>> (i % 24)) & 1) ? scale : -scale));
}
const hashEmbedder = () => ({
  embed: async (text) => hashVector(text),
  embedQuery: async (text) => hashVector(text),
  embedPassage: async (text) => hashVector(text),
  embedBatch: async (texts) => texts.map(hashVector),
  shutdown: async () => {},
});

const engineConfig = (baseDbPath, lancedbCompaction) => ({
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: true, autoRecall: true,
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  metaCognition: { enabled: false },
  runtime: { recallTimeoutMs: 10_000, lancedbCompaction },
  duplicateThreshold: 0.95,
});

function setupEngine(prefix, lancedbCompaction) {
  const stateDir = makeTempDir(`${prefix}state-`);
  const baseDbPath = join(makeTempDir(`${prefix}root-`), "lancedb-namespaced");
  const host = createStubHost({
    stateDir,
    workspaceDir: async (agentId) => {
      const dir = join(stateDir, "workspaces", agentId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  return createEngine(host, engineConfig(baseDbPath, lancedbCompaction), { internals: { embeddings: hashEmbedder() } });
}

const principal = { agentId: AGENT, channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" };
const userAgent = { origin: "user", background: false };
const benchmarkText = (i) =>
  `Benchmark topic entry ${i}: fragment compaction latency probe with distinct payload token bch-${i}-${textHash(String(i))}.`;
const turn = (i) => ({
  agentId: AGENT,
  principal,
  agent: userAgent,
  runId: `bench-run-${i}`,
  messages: [{ role: "user", content: benchmarkText(i) }],
  sessionKey: `agent:${AGENT}:main`,
  incognito: false,
  signal: new AbortController().signal,
});

async function captureOne(engine, i) {
  const started = performance.now();
  const result = await engine.capture(turn(i)).done;
  const ms = performance.now() - started;
  assert.equal(result?.stored, 1, `capture ${i} stored one row (${JSON.stringify(result)})`);
  return ms;
}

async function listOnce(engine) {
  const started = performance.now();
  await engine.memory.list({ topic: BENCHMARK_TOPIC }, principal, userAgent);
  return performance.now() - started;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Runs one window of `WINDOW_SIZE` captures against `engine`, waits for
 * any pending compaction check on AGENT (a no-op when compaction is
 * disabled or has nothing to do), then samples `LIST_SAMPLES` list()
 * calls. Returns the window's median capture ms, median list ms, and the
 * post-window fragmentCount (or null when the adapter can't report it).
 */
async function runWindow(engine, startIndex) {
  const captureMs = [];
  for (let i = startIndex; i < startIndex + WINDOW_SIZE; i++) {
    captureMs.push(await captureOne(engine, i));
  }

  // R17 / task-7-brief Step 1: wait for the engine's pending fragment
  // check before measuring, so a compaction that is still running from
  // the write burst doesn't land mid-measurement.
  await internalsOf(engine).fragmentCompactor.check(AGENT);

  const listMs = [];
  for (let s = 0; s < LIST_SAMPLES; s++) {
    listMs.push(await listOnce(engine));
  }

  const fragmentCount = await internalsOf(engine).memoryDbAdapter.fragmentCount(AGENT);

  return { captureMs: median(captureMs), listMs: median(listMs), fragmentCount };
}

describe("fragment compaction benchmark (flat latency)", () => {
  it("B (compaction on) keeps list/capture latency flat across 160 captures; A (compaction off) accumulates fragments", testOptions, async (t) => {
    const engineA = setupEngine("e5-bench-a-", { enabled: false });
    const engineB = setupEngine("e5-bench-b-", { fragmentThreshold: 16, checkEveryWrites: 8 });
    try {
      const windowsA = [];
      const windowsB = [];
      for (let w = 0; w < WINDOW_COUNT; w++) {
        const startIndex = w * WINDOW_SIZE;
        // Windows are sequential by design: each measures cumulative state
        // (fragment count, table size) after the previous window's writes.
        windowsA.push(await runWindow(engineA, startIndex));
        windowsB.push(await runWindow(engineB, startIndex));
      }

      t.diagnostic("window | A list ms | B list ms | A capture ms | B capture ms | A fragments | B fragments");
      for (let w = 0; w < WINDOW_COUNT; w++) {
        const a = windowsA[w];
        const b = windowsB[w];
        t.diagnostic(
          `${w + 1} | ${a.listMs.toFixed(2)} | ${b.listMs.toFixed(2)} | ${a.captureMs.toFixed(2)} | ${b.captureMs.toFixed(2)} | ${a.fragmentCount ?? "n/a"} | ${b.fragmentCount ?? "n/a"}`,
        );
      }

      const firstB = windowsB[0];
      const lastB = windowsB[WINDOW_COUNT - 1];
      const lastA = windowsA[WINDOW_COUNT - 1];

      assert.ok(
        lastB.listMs <= 2 * firstB.listMs + 20,
        `B's last-window list median (${lastB.listMs.toFixed(2)}ms) should stay within 2x + 20ms of its first (${firstB.listMs.toFixed(2)}ms)`,
      );
      assert.ok(
        lastB.captureMs <= 2 * firstB.captureMs + 20,
        `B's last-window capture median (${lastB.captureMs.toFixed(2)}ms) should stay within 2x + 20ms of its first (${firstB.captureMs.toFixed(2)}ms)`,
      );

      if (lastB.fragmentCount === null || lastA.fragmentCount === null) {
        t.diagnostic("table.stats() unavailable: fragment-count assertions skipped");
      } else {
        assert.ok(lastB.fragmentCount <= 24, `B's final fragment count should be bounded by compaction: ${lastB.fragmentCount}`);
        assert.ok(
          lastA.fragmentCount >= TOTAL_CAPTURES,
          `A's final fragment count should show the uncompacted problem (>= ${TOTAL_CAPTURES}): ${lastA.fragmentCount}`,
        );
      }
    } finally {
      await engineA.close();
      await engineB.close();
    }
  });
});

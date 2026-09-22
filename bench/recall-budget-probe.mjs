/**
 * bench/recall-budget-probe.mjs — measure today's recall latency (owner B6).
 *
 * ADR-002 Q2 and decisions-for-owner.md B6 both say the soft/hard recall
 * budget must be set from data, not taste: "Before PR-04, run today's
 * pipeline against your own store using the phase timer already in the code
 * and set the budget from the p50/p95/p99 distribution." This script is that
 * measurement, run against the golden-prefix fixture corpus rather than a
 * real store (see the caveat printed below and in the report).
 *
 * Today's values in code (HEAD e0fcc45a):
 *   - soft budget default: `recallCfg.softBudgetMs ?? 35_000` (index.js:4538).
 *   - hard timeout: `runtimeScheduler.config.recallTimeoutMs`, itself
 *     defaulting to 45_000 (lib/runtime-scheduler.js:7), passed as
 *     `hardTimeoutMs` when the phase timer is built (index.js:4315,
 *     lib/recall-phase-timer.js:26-32). decisions-for-owner.md B6 describes
 *     this pair as "35 s soft / 50 s hard"; the hard side in current code is
 *     45 s, not 50 s — worth a note back to the owner, not silently patched.
 *   - phase timer internals (`lib/recall-phase-timer.js`) use `Date.now()`
 *     throughout (start/end/elapsedMs/isSoftBudgetExceeded), NOT
 *     `performance.now()`. That is exactly why this probe needs
 *     `freezeClock: false`: under the golden test's frozen clock, every
 *     `Date.now()` call inside the pipeline returns the same fixed instant,
 *     so `elapsedMs()` (`lib/recall-phase-timer.js:91-94`) and
 *     `isSoftBudgetExceeded()` (`:96-98`) would always read 0 ms elapsed,
 *     regardless of real work done. This probe's own outer measurement uses
 *     `performance.now()` (imported below), a separate monotonic clock that
 *     `freezeClock()` never touches either way — but the *internal* phase
 *     timer would be blind without the real clock, which is the actual
 *     reason `runScenario` needs the new `{ freezeClock: false }` option.
 *
 * The pipeline's per-phase breakdown (`vector_search`, `query_refinement`,
 * `temporal`, `canonical`, `scoring`, `graph`, `graph_hydration`, `rerank`,
 * `budget`, `dedup`, `acl`, `finalize` — see the `phaseTimer.start/end(...)`
 * calls in `lib/recall-pipeline.js`) is built inside the
 * `assemble-prompt-context.js` hook closure and is not returned by
 * `runScenario` (which only returns `prependContext`). This task's file list
 * only authorizes adding `{ freezeClock }` to the driver, so that internal
 * summary is not plumbed out here. The one phase this probe *can* observe
 * from outside is embedding, by timing calls through the embedding
 * provider's own public methods (`embedQuery`/`embedPassage`,
 * `lib/providers/embedding-local-transformers.js:684-689`). Everything else
 * (LanceDB open/query, scoring, dedup, budget trimming, context formatting)
 * falls out of "total minus embed share".
 *
 * Stub embedder, no reranker, two-card fixture store: this is the pipeline's
 * FLOOR (orchestration only), not a production distribution. The owner must
 * re-run this against a real store and a real embedding provider before
 * PR-04 fixes the budget.
 *
 * Usage:
 *   node bench/recall-budget-probe.mjs                 # 30 iterations
 *   node bench/recall-budget-probe.mjs --iterations 100
 *   node bench/recall-budget-probe.mjs --scale 50      # 50x the fixture cards
 */

import { performance } from "node:perf_hooks";

import { SCENARIOS } from "../tests/fixtures/golden-prefix/scenarios.js";
import { runScenario } from "../tests/helpers/golden-prefix-driver.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const iterations = flag("iterations", 30);
const scale = flag("scale", 1);

/** Same definition bench/report.mjs:20 uses, so the numbers are comparable. */
function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const fmt = (n) => `${n.toFixed(1)} ms`;

/** Grow a scenario's card count without changing what it recalls. */
function scaled(scenario) {
  if (scale <= 1 || scenario.memories.length === 0) return scenario;
  const memories = [];
  for (let copy = 0; copy < scale; copy += 1) {
    for (const [index, memory] of scenario.memories.entries()) {
      memories.push(copy === 0 ? memory : {
        ...memory,
        id: `${copy.toString(16).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`,
        text: `${memory.text} (variant ${copy})`,
        ageDays: (memory.ageDays ?? 1) + copy,
      });
    }
  }
  const topics = { ...scenario.topics };
  for (const memory of memories) topics[memory.text] = topics[memory.text] ?? scenario.topics[memory.text.replace(/ \(variant \d+\)$/, "")];
  return { ...scenario, memories, topics };
}

/** Count time spent inside the embedding provider, across all call sites. */
function instrumentEmbedder() {
  const proto = LocalTransformersEmbeddingProvider.prototype;
  const originals = { embedQuery: proto.embedQuery, embedPassage: proto.embedPassage };
  const totals = { embedMs: 0, calls: 0 };
  for (const name of ["embedQuery", "embedPassage"]) {
    const original = proto[name];
    proto[name] = async function instrumented(...args) {
      const started = performance.now();
      try {
        return await original.apply(this, args);
      } finally {
        totals.embedMs += performance.now() - started;
        totals.calls += 1;
      }
    };
  }
  return {
    totals,
    restore() { proto.embedQuery = originals.embedQuery; proto.embedPassage = originals.embedPassage; },
  };
}

console.log(`recall-budget-probe: ${iterations} iteration(s) per scenario, fixture scale x${scale}`);
console.log("Stub embedder (fixed vectors, no model/network), no reranker, tiny fixture store:");
console.log("these are the pipeline FLOOR, not a production distribution. Embedding and rerank");
console.log("latency of a REAL provider are NOT included. Re-run against a real store and a");
console.log("real embedding provider before fixing the budget.\n");

const rows = [];
for (const raw of SCENARIOS) {
  const scenario = scaled(raw);
  const totals = [];
  const embedShare = [];
  // One warm-up: the first run pays module init and LanceDB's first open.
  await runScenario(scenario, { freezeClock: false });
  for (let i = 0; i < iterations; i += 1) {
    const probe = instrumentEmbedder();
    const started = performance.now();
    await runScenario(scenario, { freezeClock: false });
    const elapsed = performance.now() - started;
    probe.restore();
    totals.push(elapsed);
    embedShare.push(probe.totals.embedMs);
  }
  rows.push({
    name: scenario.name,
    p50: quantile(totals, 0.5),
    p95: quantile(totals, 0.95),
    p99: quantile(totals, 0.99),
    embedP50: quantile(embedShare, 0.5),
  });
}

const width = Math.max(...rows.map((row) => row.name.length), 8);
console.log(`${"scenario".padEnd(width)}  ${"p50".padStart(10)}  ${"p95".padStart(10)}  ${"p99".padStart(10)}  ${"embed p50".padStart(10)}`);
for (const row of rows) {
  console.log(`${row.name.padEnd(width)}  ${fmt(row.p50).padStart(10)}  ${fmt(row.p95).padStart(10)}  ${fmt(row.p99).padStart(10)}  ${fmt(row.embedP50).padStart(10)}`);
}

const allP95 = Math.max(...rows.map((row) => row.p95));
const allP99 = Math.max(...rows.map((row) => row.p99));
console.log(`\nworst p95 ${fmt(allP95)}, worst p99 ${fmt(allP99)}`);
console.log(`owner B6 proposal: soft 400 ms / hard 600 ms`);
console.log(`today in code:     soft 35000 ms (index.js:4538) / hard 45000 ms (lib/runtime-scheduler.js:7)`);
console.log(allP95 <= 400
  ? "floor fits the 400 ms soft budget; the remaining headroom is the provider's."
  : "floor already exceeds the 400 ms soft budget before any provider is involved — report this.");

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
 * Fix round (Task 19, controller ruling): the per-phase breakdown is what
 * makes this measurement actionable for M1b, so it is now in scope. The
 * pipeline's fine-grained phases (`embedding`, `vector_search`,
 * `query_refinement`, `temporal`, `canonical`, `scoring`, `graph`,
 * `graph_hydration`, `rerank`, `budget`, `dedup`, `acl`, `finalize` — see the
 * `phaseTimer.start/end(...)` calls in `lib/recall-pipeline.js`) are recorded
 * on a *child* phase timer created per namespace inside
 * `runMergedNamespaceRecall` (`index.js:683`) — kept separate from the outer
 * timer specifically so concurrent `Promise.allSettled` namespace reads don't
 * interleave start/end calls on a shared timer. That outer timer (created in
 * `engine/recall/assemble-prompt-context.js:140`) previously only ever saw
 * one coarse `"namespace-recall"` block wrapping all of them combined.
 * `index.js`'s `runMergedNamespaceRecall` now folds each finished child's
 * phases back into the outer timer via a new, purely additive
 * `phaseTimer.record(phase, ms)` method (`lib/recall-phase-timer.js`, next to
 * `start`/`end`/`summary`), qualified as `"<namespace>:<phase>"` so multiple
 * namespaces stay distinguishable (the golden fixtures only ever exercise one
 * private namespace, whose `namespace` field is `null` — printed below as
 * `private:<phase>`). `engine/recall/assemble-prompt-context.js` then calls
 * an optional `ctx.recallTimingSink?.({ agentId, phases, totalMs })` right
 * after the scheduled recall settles, with `phases = phaseTimer.summary()`
 * and `totalMs = phaseTimer.elapsedMs()`. This is additive/observational
 * only — it can never change the returned `prependContext`, defaults to
 * `null`, and `index.js` only ever passes a real function through one
 * test-only property (`api.__recallTimingSinkForTests`, read with `?.`) that
 * no real OpenClaw host sets — so production behaviour is unchanged.
 * `tests/helpers/golden-prefix-driver.js`'s `runScenario` forwards its own
 * new `recallTimingSink` option onto that same stub-`api` property.
 *
 * Everything the sink reports (LanceDB vector search, scoring, dedup, budget
 * trimming, context formatting) is still stub-embedder work — see the header
 * this script prints, and the caveat below.
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

/** `null:<phase>` is the private namespace (its `namespace` field is JS `null`
 *  in the golden fixtures); relabel only for display. */
const displayPhase = (phase) => (phase.startsWith("null:") ? `private:${phase.slice(5)}` : phase);

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
console.log("real embedding provider before fixing the budget.");
console.log("Today in code: soft budget 35000 ms (index.js:4538) / hard timeout 45000 ms");
console.log("(lib/runtime-scheduler.js:7's recallTimeoutMs default, passed to the phase timer");
console.log("as hardTimeoutMs at index.js:4315) — corrected here from stale index.js:4711/13351");
console.log("citations found while writing this probe; see the task report for the full note.\n");

const rows = [];
for (const raw of SCENARIOS) {
  const scenario = scaled(raw);
  const totals = [];
  const embedShare = [];
  /** @type {Map<string, number[]>} phase name -> one ms sample per iteration */
  const phaseSamples = new Map();
  let recallAttempts = 0;
  const recordPhases = (entry) => {
    recallAttempts += 1;
    for (const { phase, ms } of entry.phases.completed) {
      if (!phaseSamples.has(phase)) phaseSamples.set(phase, []);
      phaseSamples.get(phase).push(ms);
    }
  };
  // One warm-up: the first run pays module init and LanceDB's first open.
  // Its phase samples are discarded along with its wall-clock time, same as
  // the original probe discarded the warm-up's total.
  await runScenario(scenario, { freezeClock: false });
  for (let i = 0; i < iterations; i += 1) {
    const probe = instrumentEmbedder();
    const started = performance.now();
    await runScenario(scenario, { freezeClock: false, recallTimingSink: recordPhases });
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
    recallAttempts,
    phaseSamples,
  });
}

const width = Math.max(...rows.map((row) => row.name.length), 8);
console.log(`${"scenario".padEnd(width)}  ${"p50".padStart(10)}  ${"p95".padStart(10)}  ${"p99".padStart(10)}  ${"embed p50".padStart(10)}`);
for (const row of rows) {
  console.log(`${row.name.padEnd(width)}  ${fmt(row.p50).padStart(10)}  ${fmt(row.p95).padStart(10)}  ${fmt(row.p99).padStart(10)}  ${fmt(row.embedP50).padStart(10)}`);
}

for (const row of rows) {
  console.log(`\n${row.name} — per-phase breakdown (from the pipeline's own phase timer, ${row.recallAttempts}/${iterations} recall attempt(s) observed):`);
  if (row.phaseSamples.size === 0) {
    console.log("  (no recall attempted for this scenario — workspace-policy declined or the turn was routed to minimal maintenance before the phase timer was created)");
    continue;
  }
  const phaseNames = [...row.phaseSamples.keys()];
  const phaseWidth = Math.max(...phaseNames.map((p) => displayPhase(p).length), 8);
  console.log(`  ${"phase".padEnd(phaseWidth)}  ${"p50".padStart(9)}  ${"p95".padStart(9)}  ${"p99".padStart(9)}  ${"share (p50)".padStart(11)}`);
  for (const phase of phaseNames) {
    const samples = row.phaseSamples.get(phase);
    const p50 = quantile(samples, 0.5);
    const p95 = quantile(samples, 0.95);
    const p99 = quantile(samples, 0.99);
    const share = row.p50 > 0 ? `${((p50 / row.p50) * 100).toFixed(1)}%` : "—";
    console.log(`  ${displayPhase(phase).padEnd(phaseWidth)}  ${fmt(p50).padStart(9)}  ${fmt(p95).padStart(9)}  ${fmt(p99).padStart(9)}  ${share.padStart(11)}`);
  }
}

const allP95 = Math.max(...rows.map((row) => row.p95));
const allP99 = Math.max(...rows.map((row) => row.p99));
console.log(`\nworst p95 ${fmt(allP95)}, worst p99 ${fmt(allP99)}`);
console.log(`\nOwner B6 ("40/60") against this data, all three readings:`);
console.log(`  this task's framing:         soft  400 ms / hard   600 ms`);
console.log(`  decisions-for-owner.md B6:   soft  400 ms / hard 1 200 ms`);
console.log(`  decisions-for-owner.md B6's own fallback recommendation: soft 800 ms / hard 2 500 ms`);
console.log(`today in code:                 soft 35000 ms (index.js:4538) / hard 45000 ms (lib/runtime-scheduler.js:7)`);
console.log(allP95 <= 400
  ? "floor fits the 400 ms soft budget; the remaining headroom is the provider's."
  : "floor already exceeds the 400 ms soft budget before any provider is involved — report this.");
console.log(allP95 <= 800
  ? "floor fits the 800 ms fallback soft budget."
  : "floor already exceeds even the 800 ms fallback soft budget — report this.");

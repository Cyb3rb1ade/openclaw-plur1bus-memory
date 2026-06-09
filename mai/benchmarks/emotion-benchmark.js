/**
 * mai/benchmarks/emotion-benchmark.js — Performance benchmarks for the
 * 3-tier emotion classification pipeline.
 *
 * Run with: node mai/benchmarks/emotion-benchmark.js
 */

import { EmotionEngine } from "../emotion-engine.js";

const WARMUP_RUNS = 10;
const BENCHMARK_RUNS = 100;

const TEST_TEXTS = {
  clear_positive_de: "Das ist fantastisch und wunderbar!",
  clear_negative_de: "Das ist katastrophal und furchtbar!",
  ambiguous_de: "Naja, es geht so.",
  clear_positive_en: "Amazing! I love it! So happy!",
  clear_negative_en: "Terrible. I hate this. Awful.",
  mixed_de: "Ich bin traurig aber auch ein bisschen froh.",
  long_text_de:
    "Heute war ein sehr interessanter Tag. Morgens war ich noch müde und etwas besorgt, " +
    "aber dann ging es bergauf. Die Besprechung lief super, alle waren begeistert. " +
    "Am Nachmittag gab es einen kleinen Rückschlag, aber insgesamt bin ich zufrieden.",
};

async function warmup(engine) {
  for (let i = 0; i < WARMUP_RUNS; i++) {
    await engine.analyze("warmup", "user", 1);
  }
}

async function benchmarkTier(engine, name, text, tier) {
  const times = [];
  for (let i = 0; i < BENCHMARK_RUNS; i++) {
    const t0 = performance.now();
    await engine.analyze(text, "user", tier);
    const t1 = performance.now();
    times.push(t1 - t0);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const p99 = times[Math.floor(times.length * 0.99)];
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  return { name, tier, p50, p95, p99, avg, min: times[0], max: times[BENCHMARK_RUNS - 1] };
}

function printResult(r) {
  console.log(
    `${r.name.padEnd(20)} | Tier ${r.tier} | ` +
    `avg=${r.avg.toFixed(2).padStart(6)}ms | ` +
    `p50=${r.p50.toFixed(2).padStart(6)}ms | ` +
    `p95=${r.p95.toFixed(2).padStart(6)}ms | ` +
    `p99=${r.p99.toFixed(2).padStart(6)}ms | ` +
    `min=${r.min.toFixed(2).padStart(6)}ms | ` +
    `max=${r.max.toFixed(2).padStart(6)}ms`
  );
}

async function main() {
  console.log("═".repeat(100));
  console.log("PLUR1BUS Emotion Engine — Performance Benchmark");
  console.log(`Runs per test: ${BENCHMARK_RUNS} | Warmup: ${WARMUP_RUNS}`);
  console.log("═".repeat(100));

  const engine = new EmotionEngine();
  await warmup(engine);

  console.log("\n--- Tier 1 (Lexicon) ---");
  for (const [key, text] of Object.entries(TEST_TEXTS)) {
    const r = await benchmarkTier(engine, key, text, 1);
    printResult(r);
  }

  console.log("\n--- Tier 2 (Transformer fallback) ---");
  for (const [key, text] of Object.entries(TEST_TEXTS)) {
    const r = await benchmarkTier(engine, key, text, 2);
    printResult(r);
  }

  console.log("\n--- Tier 3 (LLM fallback) ---");
  const r = await benchmarkTier(engine, "no_client_fallback", "Test", 3);
  printResult(r);

  console.log("\n--- Engine Stats ---");
  console.log(engine.stats);

  console.log("\n--- Target vs Actual ---");
  console.log("Tier 1 target: <5ms   | Check p50 values above");
  console.log("Tier 2 target: ~100ms | Check p50 values above (fallback is faster)");
  console.log("Tier 3 target: 1-5s   | Check p50 values above (fallback is instant)");

  console.log("\n✅ Benchmark complete.");
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});

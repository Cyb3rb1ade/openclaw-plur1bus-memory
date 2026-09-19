/**
 * analyze.mjs — wertet results.jsonl aus. Verglichen wird immer die
 * GESPEICHERTE Form: serializeEmotionalValence() wirft Nullen ohnehin weg,
 * also misst die L1-Distanz genau das, was in der Datenbank ankäme.
 */
import { readFileSync } from "node:fs";
const RELEASE = process.env.PLUR1BUS_RELEASE || "/root/.openclaw/plur1bus-release";
const LIB = `${RELEASE}/lib`;
const { EMOTION_DIMENSIONS } = await import(`${LIB}/emotion.js`);

const rows = readFileSync(new URL("./results.jsonl", import.meta.url).pathname, "utf8")
  .trim().split("\n").map((l) => JSON.parse(l));

const byArm = { full: new Map(), short: new Map(), full2: new Map() };
for (const r of rows) byArm[r.arm]?.set(r.id, r);

const vec = (r) => EMOTION_DIMENSIONS.map((d) => r?.parsed?.emotion?.[d] ?? 0);
const nonZero = (r) => vec(r).filter((v) => v > 0).length;
const answerTokens = (r) => {
  const u = r.call.usage || {};
  return (u.completion_tokens || 0) - (u.completion_tokens_details?.reasoning_tokens || 0);
};

function armStats(arm) {
  const rs = [...byArm[arm].values()];
  const okRs = rs.filter((r) => r.parsed?.ok);
  const mean = (f) => okRs.reduce((a, r) => a + f(r), 0) / (okRs.length || 1);
  return {
    n: rs.length,
    parseFail: rs.length - okRs.length,
    truncated: rs.filter((r) => r.call.finishReason && r.call.finishReason !== "stop").length,
    nonZeroDims: mean(nonZero),
    answerTokens: mean(answerTokens),
    completionTokens: mean((r) => r.call.usage?.completion_tokens || 0),
    latencyMs: mean((r) => r.call.latencyMs),
    importance: mean((r) => r.parsed.importance),
    // "wichtige Lektion"-Regel in computeRecallBoost: trust UND fear/anger > 0
    lessonRate: okRs.filter((r) => {
      const e = r.parsed.emotion;
      return (e.trust ?? 0) > 0 && ((e.fear ?? 0) > 0 || (e.anger ?? 0) > 0);
    }).length / (okRs.length || 1),
  };
}

function pairStats(a, b) {
  const ids = [...byArm[a].keys()].filter((id) => byArm[b].has(id));
  const pairs = ids.map((id) => [byArm[a].get(id), byArm[b].get(id)]).filter(([x, y]) => x.parsed?.ok && y.parsed?.ok);
  const mean = (f) => pairs.reduce((s, p) => s + f(p), 0) / (pairs.length || 1);
  return {
    n: pairs.length,
    dImportance: mean(([x, y]) => Math.abs(x.parsed.importance - y.parsed.importance)),
    dImportanceMax: Math.max(...pairs.map(([x, y]) => Math.abs(x.parsed.importance - y.parsed.importance))),
    dominantAgree: pairs.filter(([x, y]) => x.parsed.emotion.emotionalDominant === y.parsed.emotion.emotionalDominant).length / (pairs.length || 1),
    l1: mean(([x, y]) => vec(x).reduce((s, v, i) => s + Math.abs(v - vec(y)[i]), 0)),
    dIntensity: mean(([x, y]) => Math.abs(x.parsed.emotion.emotionalIntensity - y.parsed.emotion.emotionalIntensity)),
  };
}

const f3 = (v) => v.toFixed(3);
console.log("ARME");
console.log("arm    n  parseFail trunc  nonZeroDims  antwortTok  complTok  latenz_ms  importance  lektionsRate");
for (const arm of ["full", "short", "full2"]) {
  const s = armStats(arm);
  console.log(
    `${arm.padEnd(6)} ${String(s.n).padStart(2)}  ${String(s.parseFail).padStart(8)} ${String(s.truncated).padStart(5)}  `
    + `${f3(s.nonZeroDims).padStart(11)}  ${s.answerTokens.toFixed(0).padStart(10)}  ${s.completionTokens.toFixed(0).padStart(8)}  `
    + `${s.latencyMs.toFixed(0).padStart(9)}  ${f3(s.importance).padStart(10)}  ${(100 * s.lessonRate).toFixed(1).padStart(11)}%`,
  );
}

console.log("\nPAARE (full2 vs full = Rauschboden, short vs full = Formateffekt)");
console.log("paar            n  |dImportance|  max    dominantGleich  L1(Vektor)  |dIntensity|");
for (const [a, b, label] of [["full2", "full", "full2 vs full"], ["short", "full", "short vs full"]]) {
  const p = pairStats(a, b);
  console.log(
    `${label.padEnd(15)} ${String(p.n).padStart(2)}  ${f3(p.dImportance).padStart(12)}  ${f3(p.dImportanceMax)}  `
    + `${(100 * p.dominantAgree).toFixed(1).padStart(13)}%  ${f3(p.l1).padStart(10)}  ${f3(p.dIntensity).padStart(12)}`,
  );
}

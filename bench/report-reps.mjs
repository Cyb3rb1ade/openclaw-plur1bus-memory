/**
 * report-reps: wertet Wiederholungslaeufe aus run.mjs (--repeat N) aus und
 * vergleicht Konfigurationen gepaart je Frage.
 *
 * Usage:
 *   node report-reps.mjs <A> [<B> ...] [--excluded excluded.json]
 *                        [--out results/report-reps-<name>.json] [--seed 1] [--boot 10000]
 *
 *   <A>, <B>  Praefix einer Konfiguration, z. B. results/locomo-bl-jev2-full —
 *             gelesen werden alle Dateien <Praefix>-r<k>.jsonl. Alternativ eine
 *             Komma-Liste von Dateien (dann ist der erste Dateiname die
 *             Bezeichnung).
 *
 * Je Konfiguration:
 *   - Quote je Wiederholung (richtig / bewertet), Mittel, Spannweite (min–max)
 *   - je Frage der Mittelwert ueber die Wiederholungen; "Fragenmittel" ist das
 *     Mittel dieser Werte, "wackelnd" zaehlt Fragen mit 0 < Mittel < 1
 *   - Belegtreffer im Recall (identisch ueber Wiederholungen, der Recall wird
 *     in run.mjs je Frage einmal berechnet)
 *   - alles je Kategorie, MIT und OHNE die Fragen aus excluded.json
 * Jede weitere Konfiguration wird gegen die erste gepaart verglichen:
 *   - Differenz der Fragenmittel in Prozentpunkten (B − A)
 *   - besser / schlechter / gleich (je Frage)
 *   - 95-%-Bootstrap-Intervall ueber Fragen (feste Saat)
 *   - exakter Vorzeichentest (zweiseitig, Gleichstaende fallen heraus)
 *
 * Fehlerzeilen (error, leeres Urteil) zaehlen als FEHLEND fuer diese
 * Wiederholung, nicht als falsch.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BENCH = process.env.BENCH_HOME || dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (flag, fallback) => { const i = argv.indexOf(flag); return i > -1 ? argv[i + 1] : fallback; };
const FLAGS_WITH_VALUE = new Set(["--excluded", "--out", "--seed", "--boot"]);
const positional = argv.filter((a, i) => !a.startsWith("--") && !FLAGS_WITH_VALUE.has(argv[i - 1]));
if (positional.length === 0) {
  console.error("Usage: node report-reps.mjs <praefixA> [<praefixB> ...] [--excluded excluded.json] [--out datei.json]");
  process.exit(2);
}
const EXCLUDED_PATH = opt("--excluded", existsSync(join(BENCH, "excluded.json")) ? join(BENCH, "excluded.json") : join(BENCH, "data/excluded.json"));
const SEED = Number(opt("--seed", 1));
const BOOT = Number(opt("--boot", 10000));

const LABELS = {
  "locomo-cat1": "Kat. 1 Multi-Hop",
  "locomo-cat2": "Kat. 2 Temporal",
  "locomo-cat3": "Kat. 3 Open-Domain",
  "locomo-cat4": "Kat. 4 Single-Hop",
  "locomo-cat5": "Kat. 5 Adversarial",
};
const label = (k) => LABELS[k] || k;

const excluded = existsSync(EXCLUDED_PATH)
  ? new Map(JSON.parse(readFileSync(EXCLUDED_PATH, "utf8")).fragen.map((f) => [f.id, f.gruppe]))
  : new Map();
if (!existsSync(EXCLUDED_PATH)) console.error(`Hinweis: ${EXCLUDED_PATH} fehlt — keine Auswertung ohne Ausschluesse.`);

/** Praefix oder Dateiliste → sortierte Dateien je Wiederholung. */
function resolveFiles(spec) {
  if (spec.includes(",") || spec.endsWith(".jsonl")) {
    const files = spec.split(",").map((f) => resolve(f));
    return { name: basename(files[0]).replace(/\.jsonl$/, ""), files };
  }
  const abs = resolve(spec);
  const dir = dirname(abs);
  const stem = basename(abs);
  const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-r(\\d+)\\.jsonl$`);
  const files = readdirSync(dir)
    .map((f) => ({ f, m: re.exec(f) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
    .map((x) => join(dir, x.f));
  if (!files.length) throw new Error(`keine Dateien ${stem}-r<k>.jsonl in ${dir}`);
  return { name: stem, files };
}

function loadConfig(spec) {
  const { name, files } = resolveFiles(spec);
  const reps = files.map((file) => {
    const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { file, rows: new Map(rows.map((r) => [r.id, r])) };
  });
  // Je Frage: Kategorie, Ergebnisse je Wiederholung (true/false/null=fehlend), Belegtreffer.
  const questions = new Map();
  reps.forEach((rep, k) => {
    for (const r of rep.rows.values()) {
      const q = questions.get(r.id) || { id: r.id, category: r.category, results: new Array(reps.length).fill(null), evidenceHit: null };
      q.results[k] = r.error ? null : Boolean(r.correct);
      if (typeof r.evidenceHit === "boolean" && q.evidenceHit === null) q.evidenceHit = r.evidenceHit;
      questions.set(r.id, q);
    }
  });
  for (const q of questions.values()) {
    const scored = q.results.filter((x) => x !== null);
    q.scored = scored.length;
    q.mean = scored.length ? scored.filter(Boolean).length / scored.length : null;
  }
  return { name, files, reps: reps.length, questions };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)} %` : "—");
const pp = (x) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(100 * x).toFixed(1)} pp` : "—");

/** Kennzahlen einer Konfiguration fuer eine Fragenmenge (Filter). */
function stats(cfg, keep) {
  const qs = [...cfg.questions.values()].filter(keep);
  const repAcc = [];
  for (let k = 0; k < cfg.reps; k++) {
    const scored = qs.filter((q) => q.results[k] !== null);
    if (scored.length) repAcc.push(scored.filter((q) => q.results[k]).length / scored.length);
  }
  const withMean = qs.filter((q) => q.mean !== null);
  const ev = qs.filter((q) => typeof q.evidenceHit === "boolean");
  return {
    questions: qs.length,
    scoredQuestions: withMean.length,
    missingCells: qs.reduce((n, q) => n + q.results.filter((x) => x === null).length, 0),
    repAccuracy: repAcc,
    repMean: mean(repAcc),
    repMin: repAcc.length ? Math.min(...repAcc) : NaN,
    repMax: repAcc.length ? Math.max(...repAcc) : NaN,
    questionMean: mean(withMean.map((q) => q.mean)),
    unstable: withMean.filter((q) => q.mean > 0 && q.mean < 1).length,
    evidenceHit: ev.length ? ev.filter((q) => q.evidenceHit).length / ev.length : NaN,
  };
}

// Deterministischer Zufall fuer den Bootstrap (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exakter zweiseitiger Vorzeichentest. */
function signTest(wins, losses) {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let p = 2 ** -n;
  let cum = p;
  for (let i = 0; i < k; i++) { p = p * (n - i) / (i + 1); cum += p; }
  return Math.min(1, 2 * cum);
}

function paired(a, b, keep) {
  const ids = [...a.questions.keys()].filter((id) => {
    const qa = a.questions.get(id);
    const qb = b.questions.get(id);
    return qb && qa.mean !== null && qb.mean !== null && keep(qa);
  });
  const diffs = ids.map((id) => b.questions.get(id).mean - a.questions.get(id).mean);
  const wins = diffs.filter((d) => d > 0).length;
  const losses = diffs.filter((d) => d < 0).length;
  const rand = rng(SEED);
  const boots = [];
  if (diffs.length) {
    for (let i = 0; i < BOOT; i++) {
      let s = 0;
      for (let j = 0; j < diffs.length; j++) s += diffs[Math.floor(rand() * diffs.length)];
      boots.push(s / diffs.length);
    }
    boots.sort((x, y) => x - y);
  }
  return {
    questions: ids.length,
    meanA: mean(ids.map((id) => a.questions.get(id).mean)),
    meanB: mean(ids.map((id) => b.questions.get(id).mean)),
    diff: mean(diffs),
    ci95: boots.length ? [boots[Math.floor(0.025 * boots.length)], boots[Math.min(boots.length - 1, Math.floor(0.975 * boots.length))]] : [NaN, NaN],
    better: wins, worse: losses, equal: diffs.length - wins - losses,
    signTestP: signTest(wins, losses),
  };
}

const configs = positional.map(loadConfig);
const allIds = new Set(configs.flatMap((c) => [...c.questions.keys()]));
const missingExcluded = [...excluded.keys()].filter((id) => !allIds.has(id));
const categories = [...new Set(configs.flatMap((c) => [...c.questions.values()].map((q) => q.category)))].sort();

const VIEWS = [
  { key: "alle", title: "alle Fragen", keep: () => true },
  { key: "ohneAusschluss", title: `ohne ${excluded.size} ausgeschlossene Fragen (excluded.json)`, keep: (q) => !excluded.has(q.id) },
];
const SLICES = [
  { key: "gesamt", title: "Gesamt", keep: () => true },
  { key: "kat1-4", title: "Kat. 1–4", keep: (q) => q.category !== "locomo-cat5" },
  ...categories.map((c) => ({ key: c, title: label(c), keep: (q) => q.category === c })),
];

const json = { when: new Date().toISOString(), excludedFile: EXCLUDED_PATH, excludedCount: excluded.size, missingExcluded, seed: SEED, boot: BOOT, configs: {}, comparisons: {} };
const md = [];
md.push(`# Wiederholungen: ${configs.map((c) => `${c.name} (${c.reps}×)`).join(" vs. ")}`, "");
if (missingExcluded.length) md.push(`Ausschlussliste: ${missingExcluded.length} Kennung(en) kommen in keinem Lauf vor (Teillauf?): ${missingExcluded.slice(0, 8).join(", ")}${missingExcluded.length > 8 ? " …" : ""}`, "");

for (const cfg of configs) {
  json.configs[cfg.name] = { files: cfg.files, reps: cfg.reps };
  for (const view of VIEWS) {
    md.push(`## ${cfg.name} — ${view.title}`, "");
    md.push("| Teil | Fragen | Fragenmittel | Mittel der Läufe | Spannweite | je Lauf | wackelnd | Beleg im Recall | fehlende Zellen |");
    md.push("|---|---:|---:|---:|---:|---|---:|---:|---:|");
    const block = {};
    for (const sl of SLICES) {
      const s = stats(cfg, (q) => view.keep(q) && sl.keep(q));
      if (!s.questions) continue;
      block[sl.key] = s;
      md.push(`| ${sl.title} | ${s.scoredQuestions} | ${pct(s.questionMean)} | ${pct(s.repMean)} | ${pct(s.repMin)}–${pct(s.repMax)} | ${s.repAccuracy.map((x) => (100 * x).toFixed(1)).join(" / ")} | ${s.unstable} | ${pct(s.evidenceHit)} | ${s.missingCells} |`);
    }
    json.configs[cfg.name][view.key] = block;
    md.push("");
  }
}

for (const b of configs.slice(1)) {
  const a = configs[0];
  const key = `${b.name} vs ${a.name}`;
  json.comparisons[key] = {};
  for (const view of VIEWS) {
    md.push(`## Gepaart: ${b.name} − ${a.name} — ${view.title}`, "");
    md.push("| Teil | Fragen | A | B | B − A | 95-%-KI (Bootstrap) | B besser | B schlechter | gleich | Vorzeichentest p |");
    md.push("|---|---:|---:|---:|---:|---|---:|---:|---:|---:|");
    const block = {};
    for (const sl of SLICES) {
      const r = paired(a, b, (q) => view.keep(q) && sl.keep(q));
      if (!r.questions) continue;
      block[sl.key] = r;
      md.push(`| ${sl.title} | ${r.questions} | ${pct(r.meanA)} | ${pct(r.meanB)} | ${pp(r.diff)} | ${pp(r.ci95[0])} … ${pp(r.ci95[1])} | ${r.better} | ${r.worse} | ${r.equal} | ${r.signTestP < 0.001 ? "<0,001" : r.signTestP.toFixed(3)} |`);
    }
    json.comparisons[key][view.key] = block;
    md.push("");
  }
}

md.push("Fragenmittel = Mittel ueber Fragen des Anteils richtiger Wiederholungen; Spannweite = schlechtester bis bester Einzellauf; wackelnd = Fragen, die nicht in allen Wiederholungen gleich bewertet wurden. Fehlerzeilen zaehlen als fehlend, nicht als falsch.");
const OUT = opt("--out", join(BENCH, `results/report-reps-${configs.map((c) => c.name.replace(/^(locomo|lme)-/, "")).join("-vs-")}.json`));
writeFileSync(OUT, JSON.stringify(json, null, 1));
console.log(md.join("\n"));
console.log(`\n→ ${OUT}`);

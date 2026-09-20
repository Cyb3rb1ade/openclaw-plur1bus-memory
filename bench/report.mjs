/**
 * Report: aggregiert eine Ergebnis-JSONL zu Markdown (Gesamt, je Kategorie,
 * Abstention getrennt, Evidenz-Trefferquote und Recall-Latenz).
 *
 * Usage: node report.mjs results/<datei>.jsonl [weitere.jsonl ...]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const LABELS = {
  "locomo-cat1": "1 — Multi-Hop",
  "locomo-cat2": "2 — Temporal",
  "locomo-cat3": "3 — Open-Domain",
  "locomo-cat4": "4 — Single-Hop",
  "locomo-cat5": "5 — Adversarial (Abstention)",
};
const label = (key) => LABELS[key] || key;

const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)} %` : "—");
const quantile = (values, q) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

/** Kreuztabelle Evidenz x Korrektheit: trennt "das Gedaechtnis hat es nicht
 *  gefunden" von "das Antwortmodell hat es nicht genutzt". Nur sinnvoll, wo
 *  evidenceHit nicht konstruktionsbedingt immer wahr ist (also nicht bei
 *  LongMemEval-oracle). */
function evidenceBreakdown(rows) {
  const usable = rows.filter((r) => !r.abstention && typeof r.evidenceHit === "boolean" && !r.error);
  if (!usable.length) return null;
  const hit = usable.filter((r) => r.evidenceHit);
  const miss = usable.filter((r) => !r.evidenceHit);
  const idk = hit.filter((r) => /^i don.?t know/i.test(String(r.response || "").trim())).length;
  return [
    "| Fall | Fragen | Anteil | davon richtig beantwortet |",
    "|---|---:|---:|---:|",
    `| Evidenz im Recall | ${hit.length} | ${pct(hit.length, usable.length)} | ${pct(hit.filter((r) => r.correct).length, hit.length)} |`,
    `| Evidenz nicht im Recall | ${miss.length} | ${pct(miss.length, usable.length)} | ${pct(miss.filter((r) => r.correct).length, miss.length)} |`,
    "",
    `Bei ${idk} der ${hit.length} Fragen mit gefundener Evidenz (${pct(idk, hit.length)}) antwortete das Modell trotzdem „I don't know“.`,
  ].join("\n");
}

function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.category || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const line = (name, list) => {
    const correct = list.filter((r) => r.correct).length;
    const evid = list.filter((r) => r.evidenceHit !== null && r.evidenceHit !== undefined);
    const hits = evid.filter((r) => r.evidenceHit).length;
    const errors = list.filter((r) => r.error).length;
    return `| ${name} | ${list.length} | ${correct} | ${pct(correct, list.length)} | ${evid.length ? pct(hits, evid.length) : "—"} | ${errors} |`;
  };
  const table = [
    "| Kategorie | Fragen | Richtig | Accuracy | Evidenz im Recall | Fehler |",
    "|---|---:|---:|---:|---:|---:|",
    ...[...groups.entries()].sort().map(([k, v]) => line(label(k), v)),
    line("**Gesamt**", rows),
  ];
  const answerable = rows.filter((r) => !r.abstention);
  const abstain = rows.filter((r) => r.abstention);
  if (abstain.length) {
    table.push(line("davon beantwortbar", answerable));
    table.push(line("davon Abstention", abstain));
  }
  const latencies = rows.map((r) => r.recallMs).filter((v) => Number.isFinite(v));
  const reranked = rows.filter((r) => r.rerankApplied === true).length;
  const rerankKnown = rows.filter((r) => typeof r.rerankApplied === "boolean").length;
  return {
    table: table.join("\n"),
    stats: {
      questions: rows.length,
      accuracy: rows.filter((r) => r.correct).length / rows.length,
      recallP50: quantile(latencies, 0.5),
      recallP95: quantile(latencies, 0.95),
      avgRecalled: rows.reduce((s, r) => s + (r.recalled || 0), 0) / rows.length,
      rerankRate: rerankKnown ? reranked / rerankKnown : null,
    },
  };
}

const files = process.argv.slice(2);
const parts = [
  "# PLUR1BUS — LOCOMO und LongMemEval",
  "",
  `Erzeugt am ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.`,
  "",
  "## Aufbau",
  "",
  "- PLUR1BUS 7.12.61 (`/root/.openclaw/plur1bus-release`, Commit 039329d), Recall über `lib/recall-pipeline.js` — dieselbe Pipeline wie im Produktivbetrieb.",
  "- Getrennte LanceDB unter `/root/plur1bus-bench/db`, ein Store pro Gespräch (LOCOMO) bzw. pro Frage-Haystack (LongMemEval). Weder Gateway noch Produktivgedächtnis waren beteiligt.",
  "- Embeddings `text-embedding-3-large` (3072 dim), Reranker Cohere — die Produktivkonfiguration aus `openclaw.json`.",
  "- Recall-Parameter aus der Produktivkonfiguration: topN 12, candidateTopK 40, recallMinScore 0.15, importanceBoost 0.3, Dedup 0.78, Reranker-Timeout 2500 ms. Canonical-First ist aus, weil im Benchmark kein Workspace mit `KNOWLEDGE.md` existiert.",
  "- Ingest je Gesprächsturn als eine Memory-Zeile mit echtem Session-Zeitstempel in `createdAt` und im Text; der LLM-Klassifikationsteil des Capture-Pfads lief nicht mit.",
  "- Antwortmodell und Judge stehen je Lauf im Abschnittskopf; die GPT-5-Familie laeuft ohne `temperature` mit `max_completion_tokens`. Die Judge-Prompts stammen wörtlich aus `LongMemEval/src/evaluation/evaluate_qa.py`.",
  "- In der oracle-Variante von LongMemEval bestehen die Haystacks ausschließlich aus Evidenz-Sessions (`answer_session_ids` = `haystack_session_ids` bei allen 500 Fragen). Die Spalte „Evidenz im Recall“ ist dort deshalb konstruktionsbedingt 100 % und nur bei LOCOMO aussagekräftig.",
  "- Preference-Fragen sind Empfehlungsbitten statt Faktenfragen und bekommen deshalb einen Assistenz-Prompt (drei Sätze, personalisiert) statt der knappen Faktenantwort.",
  "- „Evidenz im Recall“ misst, ob mindestens eine Gold-Evidenzstelle unter den zurückgegebenen Memories war — trennt Abrufqualität von der Antwortqualität des Modells.",
  "- Der Recall-Zeitpunkt ist nicht die Laufzeit, sondern die Fragezeit des Datensatzes: bei LongMemEval `question_date`, bei LOCOMO ein Tag nach der letzten Session. Sonst lägen die Memories drei Jahre zurück und Zeitfragen wie Decay hätten eine falsche Referenz.",
  "",
  "### Drei Einschränkungen der Vergleichbarkeit",
  "",
  "- Das Antwortmodell darf abstinieren („reply exactly: I don't know“). Ohne diese Anweisung könnten die Abstention-Kategorien (LOCOMO 5, LongMemEval `_abs`) nicht bestehen; sie drückt aber die beantwortbaren Kategorien leicht gegenüber publizierten Zahlen ohne diese Anweisung.",
  "- Lauf-zu-Lauf-Rauschen: zwei identisch konfigurierte LongMemEval-Läufe unterschieden sich je Kategorie um ein bis drei Fragen, obwohl beide Modelle mit temperature 0 laufen. Auf Kategorien mit rund 130 Fragen sind Unterschiede unter etwa zwei Punkten deshalb kein Signal.",
  "- Bei LOCOMO-Kategorie 5 liefert der Datensatz statt einer Erklärung die Distraktor-Antwort (`adversarial_answer`). Sie landet im Abstention-Judge-Prompt an der Stelle der Erklärung; der Judge bewertet trotzdem primär, ob das Modell die Frage als unbeantwortbar erkannt hat.",
  "",
];

for (const file of files) {
  const rows = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const { table, stats } = summarize(rows);
  const name = basename(file).startsWith("locomo") ? "LOCOMO (10 Gespräche)" : "LongMemEval (oracle, 500 Fragen)";
  const breakdown = basename(file).startsWith("locomo") ? evidenceBreakdown(rows) : null;
  parts.push(`## ${name}`, "", table, "",
    `Recall-Latenz p50 ${stats.recallP50} ms, p95 ${stats.recallP95} ms; im Schnitt ${stats.avgRecalled.toFixed(1)} Memories je Frage. Cohere-Rerank griff bei ${stats.rerankRate === null ? "—" : (100 * stats.rerankRate).toFixed(1) + " %"} der Fragen; der Rest fiel auf die unrerankten Top-N zurück.`,
    "", ...(breakdown ? ["### Abruf oder Antwort — wo gehen die Punkte verloren?", "", "Nur beantwortbare Fragen (ohne Kategorie 5).", "", breakdown, ""] : []),
    `Rohdaten: \`${file}\``, "");
}

const out = "/root/plur1bus-bench/results/REPORT.md";
writeFileSync(out, parts.join("\n"));
console.log(parts.join("\n"));
console.log(`\n→ ${out}`);

/**
 * Lauf: Recall über die echte PLUR1BUS-Pipeline → Antwortmodell → LLM-Judge.
 *
 * Usage: node run.mjs locomo|lme [--limit N] [--no-rerank] [--tag NAME]
 *          [--db DIR] [--top-n N] [--candidate-top-k K] [--category locomo-catX[,locomo-catY...]]
 *          [--render full|prod|prod2 (Komma-Liste)] [--prod2-release PFAD] [--repeat N] [--keep-date-prefix]
 *          [--every K] [--ids ID,ID,...] [--concurrency <=4] [--prod-config PFAD] [--save-blocks] [--overwrite]
 *          [--rerank-model NAME] [--recall-only] [--no-recall-cache | --recall-cache-only] [--recall-cache-dir PFAD]
 *          [--auto-policy off|base|full] [--cohere-billing] [--temporal-mode intent|legacy|off]
 *          [--provider P] [--judge-provider P] [--answer-model M] [--judge-model M]
 *
 * Schluessel: nur eigene des Messstands (BENCH_OPENAI_API_KEY,
 * BENCH_COHERE_API_KEY, BENCH_DEEPSEEK_API_KEY) aus der Umgebung oder
 * BENCH/.env.bench. loadEnv lehnt jede Datei im Zustandsverzeichnis des
 * Gateways ab (~/.openclaw, $OPENCLAW_HOME, $OPENCLAW_STATE_DIR).
 *
 * Seit 25.11.2026 (PLUR1BUS 7.21.1):
 *  --auto-policy M     Regeln des Auto-Recalls nachtraeglich auf das (gecachte)
 *                      Pipeline-Ergebnis: off (Vorgabe, keine Regeln), base
 *                      (7.20.10: Echo-Ausschluss und Qualitaetsgewicht), full
 *                      (7.21.1: zusaetzlich staleAssistant und mergeTurnParts).
 *                      Alle drei Stufen teilen sich einen Recall-Cache-Eintrag.
 *                      base braucht PLUR1BUS >= 7.20.10, full >= 7.21.1.
 *  --cohere-billing    Zaehlt meta.billed_units aller Cohere-Antworten und
 *                      schreibt die Summe als cohereBilling in die Meta-Datei
 *                      (rerank-v5.0-fast rechnet nach input_tokens ab).
 *
 * Seit 24.11.2026:
 *  --temporal-mode M   temporalFilterMode der Pipeline: intent, legacy oder
 *                      off (PLUR1BUS >= 7.20.8, sonst Abbruch). Ohne Schalter
 *                      gilt der Default des Plugins. Meta: temporalFilterMode.
 *  --judge-provider P  Jury bei einem anderen Anbieter als die Antwort, z. B.
 *                      --provider codex --judge-provider deepseek. Vorgabe ist
 *                      --provider (deepseek). Meta: judgeProvider.
 *
 * Seit 24.11.2026 (Recall-Cache, lib/recall-cache.mjs):
 *  Recall-Cache        Der Recall je Frage kommt aus results/recall-cache/, wenn
 *                      Store, Plugin-Code, Recall-Einstellungen, Modelle, Frage
 *                      und Zeitpunkt gleich sind; ein Treffer ruft weder
 *                      Embedding noch Cohere auf. Rerank-Ausfaelle werden nie
 *                      gespeichert. Treffer/Fehlgriffe und gezaehlte
 *                      API-Aufrufe stehen am Ende in der Meta-Datei
 *                      (recallCache), je Ergebniszeile `recallCache`.
 *  --no-recall-cache   Cache weder lesen noch schreiben.
 *  --recall-cache-only Nur Treffer; ein Fehlgriff ist ein Recall-Fehler statt
 *                      eines API-Aufrufs.
 *  --recall-cache-dir P  Andere Ablage (Tests).
 *  --rerank-model NAME Cohere-Modell. Vorgabe BENCH_DEFAULT_RERANK_MODEL
 *                      (rerank-v5.0-fast, Plugin-Default ab 7.21.1), auch
 *                      gegen aeltere Releases; v3.5 mit --rerank-model
 *                      rerank-v3.5. --rerank-max-doc-chars gibt es nicht, es
 *                      gilt der Default des Plugins wie in der Produktion
 *                      (lib/common.mjs, rerankOpts).
 *  --recall-only       Nur Recall (und Rendern) je Frage, kein Antwortmodell,
 *                      keine Jury. Ausgabe results/<which>-<tag>-recall.jsonl
 *                      mit Treffer-IDs, Belegtreffer und Blockgroesse je
 *                      Darstellung. Fuellt bzw. prueft den Cache.
 *
 * Seit 23.11.2026 abends (Hebel a2):
 *  --render prod2      Wie prod, aber alle Render-Funktionen (resolveEffectiveConfig,
 *                      frameRecallConfidence, text-utils, formatRelevantMemoriesContext)
 *                      kommen aus dem Plugin-Checkout unter --prod2-release statt
 *                      aus PLUR1BUS_RELEASE. Recall und alle uebrigen Bausteine
 *                      bleiben bei PLUR1BUS_RELEASE. Mit --render full,prod,prod2
 *                      laufen alle drei auf byte-gleichem Recall. Weichen die
 *                      effektiven Einstellungen von prod und prod2 voneinander ab,
 *                      bricht der Lauf vor der ersten Anfrage ab.
 *  --prod2-release P   Pflicht bei prod2, sonst verboten.
 *  --ids a,b,c         Nur diese Fragen (z. B. conv-44#0,conv-47#4), fuer Kontrollen.
 *
 * Seit 23.11.2026 (c3/c4/c6):
 *  --render full       Wie bisher: alle Treffer im Volltext als nummerierte
 *                      Liste (Vorgabe).
 *  --render prod       Der <relevant-memories>-Block, gebaut mit den echten
 *                      Funktionen des installierten Plugins und den Werten,
 *                      die resolveEffectiveConfig() aus der Live-Config macht
 *                      (siehe renderProd unten).
 *  --render full,prod  Beide Darstellungen im selben Lauf auf demselben Recall.
 *  --repeat N          Antwort + Jury N-mal je Frage und Darstellung. Der Recall
 *                      laeuft je Frage EINMAL und wird fuer alle Wiederholungen
 *                      und Darstellungen wiederverwendet — gemessen wird also
 *                      die Streuung von Antwortmodell und Jury, und die
 *                      Darstellungen sind gepaart (byte-gleicher Recall).
 *  Ausgabe             results/<which>-<tag>-<render>-r<k>.jsonl je
 *                      Darstellung und Wiederholung, dazu
 *                      results/<which>-<tag>.meta.json. Auswertung mit
 *                      report-reps.mjs.
 *  --keep-date-prefix  Nur prod: "[YYYY-MM-DD HH:MM] " im Text lassen (siehe
 *                      stripDatePrefix).
 *  --every K           Nur jede K-te Frage (feste, gestreute Stichprobe).
 *  --save-blocks      Den gerenderten Block je Ergebniszeile mitschreiben.
 *  --overwrite        Ergebnisdateien mit gleichem Tag ersetzen (sonst Abbruch).
 *  Belege              D30:05 → D30:5; Belege, die es im Gespraech nicht gibt
 *                      (conv-47 D4:36), fallen heraus (evidenceDropped).
 *  Jury                Kein Jury-Cache: jedes Urteil ist ein eigener Aufruf,
 *                      auch ueber Wiederholungen und Darstellungen hinweg.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BENCH, RELEASE, PROVIDERS, chatClient, lancedb, loadEnv, makeEmbeddings, makeReranker, openclawConfigPath, pMap, withRetry, silentLogger, parseLocomoDate, rerankOpts, temporalModeOpts } from "./lib/common.mjs";
import { recallCacheFromArgv } from "./lib/recall-cache.mjs";

// 25.11.2026: nur .env.bench (BENCH_OPENAI_API_KEY, BENCH_COHERE_API_KEY,
// BENCH_DEEPSEEK_API_KEY). Bis dahin las run.mjs credentials/deepseek.env und
// gateway.systemd.env — der DeepSeek-Schluessel dort ist der des Gateways.
// Fehlt .env.bench, gelten die Schluessel aus der Shell; fehlen auch die,
// brechen die Schluessel-Pruefungen in lib/common.mjs ab.
loadEnv(undefined, { optional: true });
const { runRecallPipeline, mergeNamespaceRecallResults, createAutoRecallPolicy, applyAutoRecallPolicy } = await import(`${RELEASE}/lib/recall-pipeline.js`);
// --auto-policy off|base|full (24.11.2026, PLUR1BUS 7.21.1): die Regeln des
// Auto-Recalls nachträglich auf das (gecachte) Pipeline-Ergebnis anwenden.
// Mit deferFinalCap liefert die Pipeline die volle gerankte Liste (bis 100);
// die Regeln laufen in der Produktion genau dort (nach Rerank und
// Small-to-Big, vor der Endkappung). So teilen sich alle drei Stufen denselben
// Recall-Cache-Eintrag und kosten keinen weiteren Cohere-Aufruf.
//   off   wie bisher (keine Regeln)
//   base  7.20.10: Echo-Ausschluss + Qualitätsgewicht, ohne 7.21.1-Regeln
//   full  7.21.1: zusätzlich qualityWeighting.staleAssistant und mergeTurnParts
const AUTO_POLICY = (() => {
  const i = process.argv.indexOf("--auto-policy");
  const v = i > -1 ? process.argv[i + 1] : "off";
  if (!["off", "base", "full"].includes(v)) throw new Error(`--auto-policy ${v}: erlaubt sind off, base, full`);
  return v;
})();
if (AUTO_POLICY !== "off" && typeof createAutoRecallPolicy !== "function") throw new Error("--auto-policy braucht PLUR1BUS >= 7.20.10");
const turnMerge = AUTO_POLICY === "full"
  ? await import(`${RELEASE}/lib/recall-turn-merge.js`).catch((error) => { throw new Error(`--auto-policy full braucht PLUR1BUS >= 7.21.1 (lib/recall-turn-merge.js): ${error?.message || error}`, { cause: error }); })
  : null;
function applyBenchAutoPolicy(memories, query, now) {
  if (AUTO_POLICY === "off") return memories;
  const policy = createAutoRecallPolicy({
    query,
    qualityWeighting: { enabled: true, staleAssistant: AUTO_POLICY === "full" },
    mergeTurnParts: AUTO_POLICY === "full",
    now,
  });
  let out = applyAutoRecallPolicy(memories, policy);
  if (AUTO_POLICY === "full") out = turnMerge.mergeTurnParts(out).results;
  return out;
}

const which = process.argv[2];
const arg = (flag, fallback = null) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const LIMIT = Number(arg("--limit", Infinity));
const USE_RERANK = !process.argv.includes("--no-rerank");
const TAG = arg("--tag", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16));
// Hoechstens 4 parallele API-Aufrufe je Skript (Vorgabe des Messstands).
const CONCURRENCY = Math.max(1, Math.min(4, Number(arg("--concurrency", 4))));
const RENDERS = String(arg("--render", "full")).split(",").map((s) => s.trim()).filter(Boolean);
for (const r of RENDERS) if (!["full", "prod", "prod2"].includes(r)) throw new Error(`--render ${r}: erlaubt sind full, prod, prod2 (Komma-Liste)`);
if (new Set(RENDERS).size !== RENDERS.length) throw new Error("--render: jede Darstellung nur einmal");
// prod2: dieselbe Produktionsdarstellung, Render-Funktionen aus einem zweiten
// Plugin-Checkout (z. B. ein Worktree mit geaenderter Block-Anweisung).
const PROD2_RELEASE = arg("--prod2-release", null);
if (RENDERS.includes("prod2") && !PROD2_RELEASE) throw new Error("--render prod2 braucht --prod2-release PFAD");
if (PROD2_RELEASE && !RENDERS.includes("prod2")) throw new Error("--prod2-release ohne --render ...prod2");
if (PROD2_RELEASE && !existsSync(join(PROD2_RELEASE, "lib/relevant-memory-context.js"))) {
  throw new Error(`--prod2-release ${PROD2_RELEASE}: lib/relevant-memory-context.js fehlt`);
}
const IDS = arg("--ids", null);
const ID_SET = IDS ? new Set(IDS.split(",").map((s) => s.trim()).filter(Boolean)) : null;
const REPEAT = Math.max(1, Math.floor(Number(arg("--repeat", 1))));
const KEEP_DATE_PREFIX = process.argv.includes("--keep-date-prefix");
const EVERY = Math.max(1, Math.floor(Number(arg("--every", 1))));
// Nur --render prod/prod2 liest diese Datei, und nur die Render-Einstellungen
// des Plugins. Vorgabe wie beim Gateway: OPENCLAW_CONFIG_PATH, sonst
// openclaw.json im Zustandsverzeichnis (lib/common.mjs).
const PROD_CONFIG_PATH = arg("--prod-config", openclawConfigPath());
// --save-blocks: den gerenderten Erinnerungsblock je Zeile mitschreiben (Pruefung, Nachanalyse).
const SAVE_BLOCKS = process.argv.includes("--save-blocks");
// --recall-only (24.11.2026): kein Antwortmodell, keine Jury (siehe Kopf).
const RECALL_ONLY = process.argv.includes("--recall-only");

const PROVIDER = arg("--provider", "deepseek");
const PROVIDER_CFG = PROVIDERS[PROVIDER];
if (!PROVIDER_CFG) throw new Error(`Unbekannter Anbieter "${PROVIDER}" — bekannt sind ${Object.keys(PROVIDERS).join(", ")}.`);
const ANSWER_MODEL = arg("--answer-model", PROVIDER_CFG.answerModel);
// --judge-provider (24.11.2026): Jury bei einem anderen Anbieter als die
// Antwort, z. B. Antwort ueber codex (GPT-5.6), Jury weiter deepseek-v4-pro.
const JUDGE_PROVIDER = arg("--judge-provider", PROVIDER);
const JUDGE_CFG = PROVIDERS[JUDGE_PROVIDER];
if (!JUDGE_CFG) throw new Error(`Unbekannter Jury-Anbieter "${JUDGE_PROVIDER}" — bekannt sind ${Object.keys(PROVIDERS).join(", ")}.`);
const JUDGE_MODEL = arg("--judge-model", JUDGE_CFG.judgeModel);
const DB_ROOT = arg("--db", "db");   // "db" = Rohturns, "db-capture" = Capture-Pfad

// Produktionswerte aus openclaw.json → plugins.memory-lancedb-namespaced.config.
// `--top-n` hebt das Abrufbudget ueber den Produktionswert, um zu messen, ob
// der Engpass die Anzahl der ausgelieferten Erinnerungen ist oder die
// Rangfolge: findet ein groesseres Fenster deutlich mehr Belege, hat PLUR1BUS
// die richtigen Zeilen und liefert sie nur nicht alle aus.
// --temporal-mode intent|legacy|off (PLUR1BUS >= 7.20.8), siehe lib/common.mjs.
const TEMPORAL = temporalModeOpts();
const TOP_N = Number(arg("--top-n", 12));
const CANDIDATE_TOP_K = Number(arg("--candidate-top-k", 40));
const RECALL = {
  topN: TOP_N, budget: TOP_N, candidateTopK: CANDIDATE_TOP_K, recallMinScore: 0.15, importanceBoost: 0.3,
  dedupEnabled: true, dedupJaccard: 0.78, canonicalMinScore: 0.30, canonicalMaxItems: 5,
  rerankerTimeoutMs: 2500, rerankerFallbackOnError: true, canonicalEnabled: false,
  // WICHTIG, sonst misst der Benchmark eine andere Pipeline als die
  // Produktion: index.js:882 setzt beim Recall deferFinalCap und
  // candidateHardLimit. Ohne das kappt die Pipeline auf topN, BEVOR der
  // Reranker laeuft — er darf dann nur noch umsortieren, was die Kappung
  // uebrig liess, und kann eine Zeile von Platz 16 nicht mehr hereinholen.
  //
  // Gemessen am 20.09.2026 an 80 zuvor verfehlten Fragen: mit der
  // Produktionsreihenfolge findet der Recall 65 davon (81 %), mit der alten
  // Benchmark-Reihenfolge 11 (14 %). Alle Laeufe vor diesem Datum sind
  // dadurch zu niedrig.
  deferFinalCap: true,
  candidateHardLimit: 100,
};

// Bei --recall-only kein Chat-Client (keine Anmeldung, kein Schluessel noetig).
const client = RECALL_ONLY ? null : chatClient(PROVIDER);
const judgeClient = RECALL_ONLY ? null : JUDGE_PROVIDER === PROVIDER ? client : chatClient(JUDGE_PROVIDER);
const RERANK = rerankOpts();
if (RERANK.model && !USE_RERANK) throw new Error("--rerank-model zusammen mit --no-rerank ergibt keinen Sinn");
const embeddings = await makeEmbeddings();
// --cohere-billing (25.11.2026): zaehlt meta.billed_units aller Cohere-
// Antworten (globales fetch, das Plugin ruft es zur Laufzeit auf) und schreibt
// die Summe in die Meta-Datei. Fuer die Kostenhochrechnung von rerank-v5.0-fast.
const COHERE_BILLING = process.argv.includes("--cohere-billing");
const cohereBilling = { calls: 0, withMeta: 0, parseErrors: 0, units: {} };
if (COHERE_BILLING) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    try {
      const url = String(input?.url ?? input);
      if (/api\.cohere\.(com|ai)\//.test(url) && response.ok) {
        cohereBilling.calls++;
        const meta = (await response.clone().json())?.meta;
        if (meta?.billed_units) {
          cohereBilling.withMeta++;
          for (const [k, v] of Object.entries(meta.billed_units)) if (Number.isFinite(v)) cohereBilling.units[k] = (cohereBilling.units[k] || 0) + v;
        }
      }
    } catch (error) {
      // Zaehlung ist best-effort und darf den Recall nicht stoeren; Fehler
      // werden gezaehlt (Meta und Schlusszeile), der erste wird gemeldet.
      cohereBilling.parseErrors++;
      if (cohereBilling.parseErrors === 1) console.warn(`cohere-billing: Antwort nicht auswertbar, weitere Fehler werden nur gezaehlt: ${error?.message || error}`);
    }
    return response;
  };
}
const reranker = USE_RERANK ? await makeReranker({ timeoutMs: RECALL.rerankerTimeoutMs, ...RERANK }) : null;
const recallCache = recallCacheFromArgv(process.argv, { script: "run.mjs" });
recallCache.instrument(embeddings, reranker);

// ─── Produktionsdarstellung (--render prod) ──────────────────────────────────
//
// Nachbau von index.js 7.20.6, before_prompt_build: Abbildung der Treffer auf
// Prompt-Items (index.js ~13286), frameRecallConfidence (~13649),
// fullTextTopRecords (~13662), semanticCompression (~13680),
// formatRelevantMemoriesContext (~13709). Alle Bausteine sind die exportierten
// Funktionen des installierten Plugins; nur die Verdrahtung steht hier.
//
// Die Werte kommen aus resolveEffectiveConfig() angewandt auf die Live-Config —
// derselbe Aufruf, mit dem index.js:4585 seine cfg baut. Wichtig, weil das
// Schema Vorgaben einsetzt, die der Code allein nicht zeigt: index.js prueft
// `semanticCompression.enabled !== false` (also "an", wenn nichts gesetzt
// ist), aber materializeNode() setzt recall.semanticCompression.enabled aus
// openclaw.plugin.json auf false. Effektiv ist die Kompression in Produktion
// AUS (Stand 23.11.2026), anders als die Diagnose (lv-prod-prompt) annahm.
//
// Nicht nachgebaut, weil im Messstand ohne Wirkung oder ohne Gegenstueck:
// kanonische KNOWLEDGE.md-Treffer, Semantic Lens (kein Index im Workspace),
// Graph/Assoziationen (taste gate wirkt nur auf graphSource "graph"),
// Interpretations-Overlays, Widerspruchserkennung, CRR-Block, Persona/Stil,
// temporalContext-Block, globalInjectMaxChars. Die TRUNCATED-RECALL-Anweisung
// verweist auf memory_recall — dieses Werkzeug hat das Antwortmodell hier nicht.
// PROD dient bei prod2 auch als Referenz fuer die Einstellungspruefung.
const PROD = RENDERS.includes("prod") || RENDERS.includes("prod2") ? await loadProdRender(RELEASE) : null;
const PROD2 = RENDERS.includes("prod2") ? await loadProdRender(PROD2_RELEASE) : null;
if (PROD2) {
  // prod2 soll genau wie prod rendern; nur die geladenen Funktionen duerfen
  // sich unterscheiden. Laeuft die Live-Config durch das zweite
  // resolveEffectiveConfig anders (anderes Schema in openclaw.plugin.json),
  // waere der Vergleich nicht mehr gepaart.
  const comparable = ({ pluginVersion, release, ...rest }) => JSON.stringify(rest);
  if (comparable(PROD.settings) !== comparable(PROD2.settings)) {
    console.error(`abort: prod2-Einstellungen weichen von prod ab\n prod:  ${comparable(PROD.settings)}\n prod2: ${comparable(PROD2.settings)}`);
    process.exit(1);
  }
}

/** index.js:913 (nicht exportiert) — wortgleich uebernommen. */
function normalizeBoundedRecallInteger(value, fallback, minimum, maximum) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

async function loadProdRender(release) {
  const { resolveEffectiveConfig } = await import(`${release}/lib/setup/config-contract.js`);
  const { frameRecallConfidence } = await import(`${release}/lib/recall-confidence-framing.js`);
  const { compressMemorySlotsForPrompt, generateSummary } = await import(`${release}/lib/text-utils.js`);
  const { formatRelevantMemoriesContext, resolveFadedThreshold } = await import(`${release}/lib/relevant-memory-context.js`);
  const raw = JSON.parse(readFileSync(PROD_CONFIG_PATH, "utf8"))?.plugins?.entries?.["memory-lancedb-namespaced"]?.config;
  if (!raw) throw new Error(`${PROD_CONFIG_PATH}: plugins.entries.memory-lancedb-namespaced.config fehlt`);
  const cfg = resolveEffectiveConfig(raw);
  const recallCfg = cfg.recall || {};
  const compressionCfg = recallCfg.semanticCompression || {};
  const version = JSON.parse(readFileSync(join(release, "package.json"), "utf8")).version;
  return {
    fn: { frameRecallConfidence, compressMemorySlotsForPrompt, generateSummary, formatRelevantMemoriesContext },
    settings: {
      release,
      pluginVersion: version,
      configPath: PROD_CONFIG_PATH,
      hedging: (cfg.recallHedging?.enabled ?? true) !== false,
      hedgingOpts: cfg.recallHedging || {},
      fullTextTopRecords: normalizeBoundedRecallInteger(recallCfg.fullTextTopRecords, 3, 0, 15),
      fullTextMaxChars: normalizeBoundedRecallInteger(recallCfg.fullTextMaxChars, 2000, 400, 8000),
      semanticCompression: compressionCfg.enabled !== false,
      tokenBudget: normalizeBoundedRecallInteger(compressionCfg.tokenBudget, 240, 1, 1000),
      memoriesMaxChars: recallCfg.memoriesMaxChars ?? 12_000,
      fadedThreshold: resolveFadedThreshold(recallCfg),
      summaryMaxWords: cfg.summaryMaxWords ?? 150,
      keepDatePrefix: KEEP_DATE_PREFIX,
    },
  };
}

/**
 * Produktive Zeilen tragen kein "[YYYY-MM-DD HH:MM] " im Text — das Datum
 * kommt im Attribut created-at (volles ISO-Datum) an. Der Sprechername bleibt,
 * weil bei LOCOMO zwei Menschen sprechen und sonst unklar waere, wer was sagt.
 * Mit --keep-date-prefix bleibt das Praefix stehen; damit laesst sich ein
 * Unterschied in Kat. 2 der Datumsdarstellung oder dem Rest zuordnen.
 */
const DATE_PREFIX = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s*/;
const stripDatePrefix = (s) => (KEEP_DATE_PREFIX ? s : s.replace(DATE_PREFIX, ""));

/** Messstand-Darstellung bis 23.11.2026: nummerierte Volltexte. */
function renderFull(memories) {
  return { block: memories.map((m, i) => `${i + 1}. ${m.entry.text}`).join("\n"), promptMemories: memories.length, dropped: 0 };
}

function renderProd(memories, now, ctx = PROD) {
  const { fn, settings: s } = ctx;
  // index.js ~13286: Treffer → Prompt-Item.
  const items = memories.map((r) => {
    const text = typeof r.entry.text === "string" ? stripDatePrefix(r.entry.text) : "";
    const summary = r.entry.summary ? stripDatePrefix(String(r.entry.summary)) : "";
    return {
      id: r.entry.id,
      category: r.entry.category,
      source: r.entry.origin || "dm",
      display: summary || fn.generateSummary(text, s.summaryMaxWords),
      fullText: text,
      memoryStrength: r.entry.memoryStrength ?? 1.0,
      graphSource: r.source,
      depth: r.depth,
      relevanceScore: r.score,
      versionNumber: r.entry.versionNumber ?? 1,
      previousVersion: r.entry.previousVersion || "",
      supersededBy: r.entry.supersededBy || "",
      updateSource: r.entry.updateSource || "",
      updateEvidence: r.entry.updateEvidence || "",
      reconsolidationConfidence: r.entry.reconsolidationConfidence ?? 0.0,
      status: r.entry.status || "active",
      versionCreatedAt: r.entry.versionCreatedAt ?? r.entry.createdAt ?? 0,
      createdAt: r.entry.createdAt ?? 0,
      updatedAt: r.entry.updatedAt ?? undefined,
      lastRetrievedAt: r.entry.lastRetrievedAt ?? undefined,
      memoryClass: r.entry.memoryClass || "standard",
      validFrom: r.entry.validFrom ?? 0,
      validUntil: r.entry.validUntil ?? 0,
      epistemicStatus: r.entry.epistemicStatus,
    };
  });
  // ~13649: Hedging der schwaechsten Treffer.
  let framed = items;
  try {
    if (s.hedging) framed = fn.frameRecallConfidence(items, s.hedgingOpts).items;
  } catch { framed = items; }
  // ~13662: Spitzentreffer mit gespeichertem Volltext.
  const fullTextIds = new Set();
  for (const item of framed) {
    if (fullTextIds.size >= s.fullTextTopRecords) break;
    if (item?.fullText && item.memoryClass !== "dream" && item.category !== "canonical") fullTextIds.add(item.id);
  }
  for (const item of framed) {
    if (!fullTextIds.has(item.id)) continue;
    item.display = item.fullText;
    item.displayMaxChars = s.fullTextMaxChars;
    item.keepFullText = true;
  }
  // ~13680: semantische Kompression der uebrigen Treffer.
  let promptItems = framed;
  let dropped = 0;
  if (s.semanticCompression) {
    const compressible = framed.filter((item) => !item.keepFullText);
    const slots = fn.compressMemorySlotsForPrompt(compressible.map((item) => ({
      entry: { id: item.id, text: item.display || "", summary: item.display || "", category: item.category, memoryClass: item.memoryClass },
    })), s.tokenBudget);
    let k = 0;
    promptItems = framed.flatMap((item) => {
      if (item.keepFullText) return [item];
      const slot = slots[k++];
      if (!slot) { dropped++; return []; }
      return [{ ...item, display: slot }];
    });
  }
  // ~13709: der eigentliche Block. now = Fragezeitpunkt, sonst stimmen die
  // age-Angaben nicht.
  const block = fn.formatRelevantMemoriesContext(promptItems, {
    fadedThreshold: s.fadedThreshold,
    maxTotalChars: s.memoriesMaxChars,
    now,
  });
  const promptMemories = (block.match(/<memory-record /g) || []).length;
  return { block, promptMemories, dropped };
}

function renderBlock(render, memories, now) {
  if (render === "prod") return renderProd(memories, now, PROD);
  if (render === "prod2") return renderProd(memories, now, PROD2);
  return renderFull(memories);
}

// Die GPT-5-Familie lehnt max_tokens und temperature ab und will
// max_completion_tokens; GPT-4o umgekehrt. Deshalb pro Familie getrennt.
const isGpt5 = (model) => /^(gpt-5|o[134])/.test(model);
const isDeepseek = (model) => /^deepseek/.test(model);
/**
 * Untergrenze fuer Modelle, die Denk-Tokens gegen das Antwortbudget
 * verrechnen. Gemessen am 19.09.2026: der Jury-Aufruf laeuft mit maxTokens=5
 * (es soll ja nur "yes" oder "no" kommen) — bei deepseek-flash UND
 * deepseek-v4-pro kam der Inhalt damit LEER zurueck, finish_reason "length",
 * HTTP 200. Jedes Urteil waere stillschweigend als "nein" gewertet worden und
 * der ganze Lauf wertlos, ohne dass irgendetwas nach Fehler ausgesehen haette.
 */
const THINK_FLOOR = 4000;

/**
 * Ein Aufruf, der bei abgeschnittener Antwort EINMAL mit doppeltem Budget
 * wiederholt wird.
 *
 * Anlass (19.09.2026, Lauf `nach-umbau-7.12.66`): Die Jury lief mit einem
 * Budget von 5 Tokens, weil nur "yes" oder "no" kommen soll. Denk-Tokens
 * verrechnen sich dagegen — 165 von 1986 Urteilen (8,3 %) kamen LEER zurueck,
 * HTTP 200, `finish_reason: "length"`, und wurden als "falsch" gezaehlt. Das
 * Ergebnis lag dadurch bei 45,9 % statt 50,0 %, ohne dass irgendetwas nach
 * einem Fehler aussah. Ein durchgehender Ausfall waere aufgefallen; eine
 * Teilmenge tarnt sich als schlechteres Ergebnis.
 *
 * Deshalb zwei Vorkehrungen: ein hoeheres Grundbudget, und ein
 * Wiederholungsversuch, wenn die Antwort dennoch abbricht. Bleibt sie leer,
 * meldet das der Aufrufer als Fehler — nicht als falsche Antwort.
 */
let truncationRetries = 0;

/**
 * Der Codex-Endpunkt spricht die Responses-API (`input` statt `messages`) und
 * verlangt `stream: true` — ohne das antwortet er mit
 * 400 "Stream must be set to true". Die Bruchstuecke werden hier wieder
 * zusammengesetzt; der Rest des Harness sieht davon nichts.
 *
 * Abbruch meldet diese API als `status: "incomplete"`, nicht als
 * `finish_reason: "length"` — deshalb steht die Erkennung im Aufrufer und
 * nicht hier.
 *
 * `max_output_tokens` lehnt dieser Endpunkt mit 400 (ohne Rumpf) ab, anders
 * als die Responses-API auf api.openai.com. Ein Tokenbudget laesst sich hier
 * also nicht setzen; der Server begrenzt selbst. Die Abbrucherkennung bleibt
 * trotzdem scharf — eine leere Antwort zaehlt dann als Fehler, nicht als
 * falsche Antwort.
 */
async function responsesCall(model, messages, cl = client) {
  return withRetry(async () => {
    const stream = await cl.responses.create({
      model,
      input: messages.map((m) => ({ role: m.role, content: m.content })),
      store: false,
      stream: true,
    });
    let text = "";
    let truncated = false;
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") text += event.delta || "";
      else if (event.type === "response.incomplete") truncated = true;
      else if (event.type === "response.completed" && event.response?.status === "incomplete") truncated = true;
      else if (event.type === "error") throw new Error(event.message || "responses stream error");
    }
    return { content: text.trim(), truncated };
  }, { label: model });
}

async function chatRaw(model, messages, maxTokens, attempt = 0, role = "answer") {
  const cfg = role === "judge" ? JUDGE_CFG : PROVIDER_CFG;
  const cl = role === "judge" ? judgeClient : client;
  const budget = Math.max(maxTokens, THINK_FLOOR) * (attempt + 1);
  let content;
  let truncated;
  if (cfg.api === "responses") {
    ({ content, truncated } = await responsesCall(model, messages, cl));
  } else {
    const r = await withRetry(
      () => cl.chat.completions.create({
        model,
        messages,
        ...(isGpt5(model)
          ? { max_completion_tokens: budget }
          : isDeepseek(model)
            ? { temperature: 0, max_tokens: budget }
            : { temperature: 0, max_tokens: maxTokens }),
      }),
      { label: model },
    );
    const choice = r.choices?.[0];
    content = choice?.message?.content?.trim() || "";
    truncated = choice?.finish_reason === "length";
  }
  if (!content && truncated && attempt === 0) {
    truncationRetries += 1;
    return chatRaw(model, messages, maxTokens, 1, role);
  }
  return content;
}
const chat = (model, messages, maxTokens = 300, role = "answer") => chatRaw(model, messages, maxTokens, 0, role);

// ─── Judge-Prompts: wörtlich aus LongMemEval src/evaluation/evaluate_qa.py ───
function judgePrompt(task, question, answer, response, abstention) {
  if (abstention) {
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  }
  if (task === "temporal-reasoning") {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (task === "knowledge-update") {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (task === "single-session-preference") {
    return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
}

/**
 * Antwortprompt ("alle Punkte", Stand 23.11.2026) — wortgleich zu vorher. Seit
 * c4 bekommt er den fertigen Erinnerungsblock (renderFull oder renderProd)
 * statt der Trefferliste; bei full ist der Block byte-gleich zu frueher.
 */
function answerMessages(question, renderedBlock, nowIso, judgeTask) {
  const block = renderedBlock || "(no memories retrieved)";
  // Preference-Fragen sind Empfehlungsbitten, keine Faktenfragen. Die knappe
  // Antwortanweisung laesst sie auf "I don't know" kollabieren, obwohl der
  // Recall die noetigen Vorlieben geliefert hat — bewertet wird hier, ob die
  // Antwort die persoenlichen Vorlieben des Nutzers aufgreift.
  if (judgeTask === "single-session-preference") {
    return [
      {
        role: "system",
        content: `You are the user's long-term assistant. The current date and time is ${nowIso}. Use the retrieved memories below — each prefixed with the date it was said — to give a personalized, concrete answer that reflects what you know about this user's preferences. Answer in at most three sentences.`,
      },
      { role: "user", content: `Retrieved memories:\n${block}\n\nQuestion: ${question}` },
    ];
  }
  return [
    {
      role: "system",
      content: `You answer questions about a long-running conversation, using ONLY the retrieved memories below. Each memory is prefixed with the date and time it was said. The current date and time is ${nowIso}. Answer briefly — a short phrase, a name, a date, or a number — with no explanation. If the question asks for several things (what, which, where, who — in plural, or 'all'), list every item the memories support, not only the first. If it asks how many, count across all memories before answering. If the memories do not contain the information needed, reply exactly: I don't know.`,
    },
    { role: "user", content: `Retrieved memories:\n${block}\n\nQuestion: ${question}\nShort answer:` },
  ];
}

const tableCache = new Map();
async function openTable(dir) {
  if (!tableCache.has(dir)) {
    tableCache.set(dir, (async () => (await (await lancedb.connect(dir)).openTable("memories")))());
  }
  return tableCache.get(dir);
}

async function recall(storeDir, query, now, agentId) {
  const started = Date.now();
  const table = await openTable(storeDir);
  // Der Reranker faellt bei Fehler oder Timeout still auf die unreranked Top-N
  // zurueck (recall-pipeline.js:2019). Ohne diesen Logger wuerde der Lauf ohne
  // Rerank weiterlaufen und der Report trotzdem "Reranker Cohere" behaupten.
  let rerankFallback = false;
  const logger = {
    ...silentLogger,
    warn: (message) => { if (/rerank/i.test(String(message))) rerankFallback = true; },
  };
  // Recall-Cache: ein Treffer liefert dasselbe Ergebnis ohne Embedding und
  // Cohere; die Logzeilen der Pipeline kommen mit, rerankFallback bleibt also
  // richtig. Rerank-Ausfaelle speichert der Cache nie.
  const { result, cache } = await recallCache.run({
    runRecallPipeline, storeDir,
    params: {
      ...RECALL, query, dbTable: table, embeddings, reranker,
      rerankCandidates: RECALL.candidateTopK, agentId, logger, now, ...TEMPORAL,
    },
  });
  // Mit deferFinalCap liefert die Pipeline bis zu candidateHardLimit Zeilen
  // zurueck — die endgueltige Kappung macht der AUFRUFER. index.js tut das
  // ueber maxOut: topN beim Zusammenfuehren der Namensraeume; ohne diesen
  // Schritt landen hier bis zu 100 Erinnerungen im Prompt statt topN, und der
  // Lauf misst wieder etwas anderes als die Produktion.
  // Wie in der Produktion (index.js: runMergedNamespaceRecall): die Kappung
  // auf topN macht mergeNamespaceRecallResults, mit Entdopplung und
  // Gruppendeckel. Bis 23.11.2026 kappte der Messstand hier nur per slice.
  const memories = mergeNamespaceRecallResults([{ namespace: "default", canonical: [], memories: applyBenchAutoPolicy(result.memories || [], query, now) }], {
    maxOut: RECALL.topN, canonicalMaxItems: RECALL.canonicalMaxItems, dedupEnabled: RECALL.dedupEnabled, dedupJaccard: RECALL.dedupJaccard,
  }).memories;
  return { memories, ms: Date.now() - started, rerankApplied: reranker ? !rerankFallback : false, recallCache: cache.status, recallCacheKey: cache.key };
}

/**
 * Seit c3 wird der Recall je Frage EINMAL berechnet und fuer alle
 * Wiederholungen und Darstellungen verwendet. Fiele der Reranker dabei aus,
 * truege jede Wiederholung denselben Ausfall — darum bis zu zwei weitere
 * Versuche, bevor der Lauf mit rerankApplied=false weitergeht.
 */
const RECALL_RERANK_RETRIES = 2;
async function recallWithRetry(storeDir, query, now, agentId) {
  let res;
  for (let attempt = 0; attempt <= RECALL_RERANK_RETRIES; attempt++) {
    res = await recall(storeDir, query, now, agentId);
    res.attempts = attempt + 1;
    if (!reranker || res.rerankApplied) return res;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  return res;
}

/** "D30:05" → "D30:5" (wie lv-prod-lib.mjs). */
const normEvidence = (raw) => {
  const m = /^D(\d+):(\d+)$/.exec(String(raw).trim());
  return m ? `D${Number(m[1])}:${Number(m[2])}` : String(raw).trim();
};

function buildTasks() {
  if (which === "locomo") {
    const data = JSON.parse(readFileSync(join(BENCH, "data/locomo10.json"), "utf8"));
    const ingest = JSON.parse(readFileSync(join(BENCH, `results/ingest${DB_ROOT.startsWith("db-capture") ? `-capture${DB_ROOT.slice("db-capture".length)}` : ""}-locomo.json`), "utf8"));
    const tasks = [];
    for (const sample of data) {
      if (!ingest.manifest.some((m) => m.store === sample.sample_id)) continue;
      // Recall-Zeitpunkt = einen Tag nach der letzten Session. Mit Date.now()
      // laegen die Memories drei Jahre in der Vergangenheit: relative
      // Zeitfragen ("wie lange her") haetten eine falsche Referenz und der
      // Decay in memory-dynamics wuerde die Rangfolge verzerren.
      const lastSession = Math.max(...Object.keys(sample.conversation)
        .filter((k) => /^session_\d+_date_time$/.test(k))
        .map((k) => parseLocomoDate(sample.conversation[k])));
      const askedAt = lastSession + 86400000;
      const diaIds = new Set();
      for (const k of Object.keys(sample.conversation).filter((x) => /^session_\d+$/.test(x))) {
        for (const t of sample.conversation[k]) diaIds.add(t.dia_id);
      }
      for (const [index, qa] of sample.qa.entries()) {
        const adversarial = qa.category === 5;
        // c6: Belege einheitlich normalisieren; nicht existierende fallen heraus.
        const ev = [...new Set((qa.evidence || []).map(normEvidence))];
        const evidenceDropped = ev.filter((e) => !diaIds.has(e)).map((e) => `${sample.sample_id}:${e}`);
        tasks.push({
          evidenceDropped,
          id: `${sample.sample_id}#${index}`,
          store: join(BENCH, DB_ROOT, "locomo", sample.sample_id),
          agentId: "bench-locomo",
          question: qa.question,
          gold: String(qa.answer ?? qa.adversarial_answer ?? ""),
          category: `locomo-cat${qa.category}`,
          judgeTask: "multi-session",
          abstention: adversarial,
          evidence: ev.filter((e) => diaIds.has(e)).map((e) => `${sample.sample_id}:${e}`),
          now: askedAt,
        });
      }
    }
    return tasks;
  }
  const data = JSON.parse(readFileSync(join(BENCH, "data/longmemeval_oracle.json"), "utf8"));
  const parseList = (v) => (Array.isArray(v) ? v : JSON.parse(String(v).replace(/'/g, '"')));
  return data.map((item) => {
    const sessionIds = parseList(item.haystack_session_ids);
    const answerIds = parseList(item.answer_session_ids);
    const m = /^(\d{4})\/(\d{2})\/(\d{2})[^\d]*(\d{2}):(\d{2})$/.exec(item.question_date);
    const now = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : Date.now();
    return {
      id: item.question_id,
      store: join(BENCH, DB_ROOT, "lme", item.question_id),
      agentId: "bench-lme",
      question: item.question,
      gold: String(item.answer ?? ""),
      category: item.question_type,
      judgeTask: item.question_type,
      abstention: item.question_id.endsWith("_abs"),
      evidence: answerIds.map((sid) => `${item.question_id}:s${sessionIds.indexOf(sid)}:`),
      now,
    };
  });
}

const allTasks = buildTasks();
// --category locomo-cat1 beschraenkt den Lauf auf eine Kategorie, eine
// Komma-Liste (locomo-cat1,locomo-cat2,...) auf mehrere (seit 23.11.2026).
const CATEGORY = arg("--category", null);
const CATEGORIES = CATEGORY ? new Set(CATEGORY.split(",").map((s) => s.trim()).filter(Boolean)) : null;
const tasks = allTasks
  .filter((t) => existsSync(t.store) && (!CATEGORIES || CATEGORIES.has(t.category)))
  .filter((t) => !ID_SET || ID_SET.has(t.id))
  .filter((_, i) => i % EVERY === 0)
  .slice(0, LIMIT);
if (ID_SET) {
  const missing = [...ID_SET].filter((id) => !tasks.some((t) => t.id === id));
  if (missing.length) {
    console.error(`abort: --ids ohne passende Frage (Store fehlt oder Kategorie gefiltert): ${missing.join(", ")}`);
    process.exit(1);
  }
}
// Vollstaendigkeitspruefung: erwartet werden alle Fragen der Datendatei. Bis
// 23.11.2026 stand hier fest 1986 (alle zehn LOCOMO-Gespraeche) — mit den drei
// verschobenen Gespraechen brach jeder Lauf ohne --limit ab.
const EXPECTED = which === "locomo"
  ? JSON.parse(readFileSync(join(BENCH, "data/locomo10.json"), "utf8")).reduce((n, s) => n + s.qa.length, 0)
  : JSON.parse(readFileSync(join(BENCH, "data/longmemeval_oracle.json"), "utf8")).length;
const FILTERED = Number.isFinite(LIMIT) || CATEGORY || EVERY > 1 || ID_SET;
if (!FILTERED && tasks.length !== EXPECTED) {
  console.error(`abort: ${tasks.length} questions with an existing store, expected ${EXPECTED} — ingest incomplete`);
  process.exit(1);
}
console.log(`${which}: ${tasks.length} questions, db=${DB_ROOT}, rerank=${USE_RERANK}${reranker ? ` (${reranker.model})` : ""}, topN=${TOP_N}, candidateTopK=${CANDIDATE_TOP_K}, provider=${PROVIDER}, answer=${ANSWER_MODEL}, judge=${JUDGE_MODEL}, render=${RENDERS.join("+")}, autoPolicy=${AUTO_POLICY}, repeat=${REPEAT}, concurrency=${CONCURRENCY}${RECALL_ONLY ? ", NUR RECALL" : ""}`);
console.log(`recall-cache: ${recallCache.enabled ? `an${recallCache.requireHit ? " (nur Treffer)" : ""}, ${recallCache.dir}` : "aus (--no-recall-cache)"}`);
if (PROD) console.log(`prod-render (resolveEffectiveConfig, Plugin ${PROD.settings.pluginVersion}): ${JSON.stringify(PROD.settings)}`);
if (PROD2) console.log(`prod2-render (Render-Funktionen aus ${PROD2.settings.release}, Plugin ${PROD2.settings.pluginVersion}; Einstellungen gleich prod)`);

// Je Darstellung und Wiederholung eine eigene Datei. Vorhandene Ergebnisse
// werden nicht ueberschrieben.
const outPaths = new Map();
if (RECALL_ONLY) outPaths.set("recall", join(BENCH, `results/${which}-${TAG}-recall.jsonl`));
else {
  for (let rep = 1; rep <= REPEAT; rep++) {
    for (const render of RENDERS) outPaths.set(`${render}#${rep}`, join(BENCH, `results/${which}-${TAG}-${render}-r${rep}.jsonl`));
  }
}
const metaPath = join(BENCH, `results/${which}-${TAG}.meta.json`);
const clash = [...outPaths.values(), metaPath].filter((p) => existsSync(p));
if (clash.length && !process.argv.includes("--overwrite")) {
  console.error(`abort: ${clash.length} Ergebnisdatei(en) mit Tag "${TAG}" existieren schon (${clash[0]} …) — anderen --tag waehlen oder --overwrite.`);
  process.exit(1);
}
for (const p of outPaths.values()) writeFileSync(p, "");
// Die Meta-Datei wird am Ende mit den Cache-Zahlen neu geschrieben.
const meta = {
  when: new Date().toISOString(), which, tag: TAG, argv: process.argv.slice(2), questions: tasks.length,
  db: DB_ROOT, rerank: USE_RERANK, rerankModel: reranker?.model ?? null, recall: RECALL, autoPolicy: AUTO_POLICY,
  ...(COHERE_BILLING ? { get cohereBilling() { return cohereBilling; } } : {}), temporalFilterMode: TEMPORAL.temporalFilterMode ?? "plugin-default", renders: RENDERS, repeat: REPEAT, keepDatePrefix: KEEP_DATE_PREFIX,
  every: EVERY, category: CATEGORY, provider: PROVIDER, judgeProvider: JUDGE_PROVIDER, answerModel: ANSWER_MODEL, judgeModel: JUDGE_MODEL,
  ids: IDS, release: RELEASE, prodRender: PROD?.settings ?? null, prod2Render: PROD2?.settings ?? null, files: Object.fromEntries(outPaths),
  recallOnly: RECALL_ONLY, recallCache: recallCache.summary(),
};
writeFileSync(metaPath, JSON.stringify(meta, null, 1));

// Ein aufgeteilter Store fuehrt Teilstuecke als "<original>#0", "#1" usw.
// Der Beleg gilt als gefunden, sobald IRGENDEIN Teilstueck der
// Originalzeile im Kontext liegt — sonst zaehlte die Aufteilung als
// Verschlechterung, obwohl sie dieselbe Stelle liefert.
const trifft = (e, id) => (e.endsWith(":") ? id.startsWith(e) : id === e || id.startsWith(`${e}#`));

let done = 0;
const results = await pMap(tasks, CONCURRENCY, async (task) => {
  const base = { id: task.id, category: task.category, abstention: task.abstention };
  const out = [];
  let rec;
  try {
    rec = await recallWithRetry(task.store, task.question, task.now, task.agentId);
  } catch (error) {
    // Ohne Recall keine Antwort: in JEDER Datei eine Fehlerzeile, damit die
    // Dateien deckungsgleich bleiben.
    for (const [key, path] of outPaths) {
      const [render, rep] = key.split("#");
      const record = RECALL_ONLY
        ? { ...base, error: `recall: ${String(error?.message || error)}`, evidenceHit: null }
        : { ...base, render, rep: Number(rep), error: `recall: ${String(error?.message || error)}`, correct: false, evidenceHit: null };
      appendFileSync(path, `${JSON.stringify(record)}\n`);
      out.push(record);
    }
    if (++done % 50 === 0) console.log(`${done}/${tasks.length}`);
    return out;
  }
  const { memories, ms, rerankApplied, attempts, recallCache: recallCacheStatus } = rec;
  const ids = memories.map((m) => m.entry.id);
  const evidenceHit = task.evidence.length
    ? task.evidence.some((e) => ids.some((id) => trifft(e, id)))
    : null;
  const nowIso = new Date(task.now).toISOString().slice(0, 16).replace("T", " ");
  const blocks = new Map(RENDERS.map((render) => [render, renderBlock(render, memories, task.now)]));
  if (RECALL_ONLY) {
    const record = {
      ...base, question: task.question, recalled: ids.length, recalledIds: ids,
      evidenceHit, evidence: task.evidence, ...(task.evidenceDropped?.length ? { evidenceDropped: task.evidenceDropped } : {}),
      blocks: Object.fromEntries([...blocks].map(([render, b]) => [render, {
        promptMemories: b.promptMemories, droppedFromPrompt: b.dropped, blockChars: b.block.length, ...(SAVE_BLOCKS ? { block: b.block } : {}),
      }])),
      recallMs: ms, recallAttempts: attempts, rerankApplied, recallCache: recallCacheStatus, recallCacheKey: rec.recallCacheKey, topN: TOP_N, db: DB_ROOT,
    };
    appendFileSync(outPaths.get("recall"), `${JSON.stringify(record)}\n`);
    out.push(record);
    if (++done % 50 === 0) console.log(`${done}/${tasks.length}`);
    return out;
  }
  // Wiederholungen aussen, Darstellungen innen: beide Darstellungen einer
  // Wiederholung laufen zeitlich direkt nacheinander.
  for (let rep = 1; rep <= REPEAT; rep++) {
    for (const render of RENDERS) {
      const { block, promptMemories, dropped } = blocks.get(render);
      let record;
      try {
        const response = await chat(ANSWER_MODEL, answerMessages(task.question, memories.length ? block : "", nowIso, task.judgeTask));
        const verdict = await chat(JUDGE_MODEL, [{ role: "user", content: judgePrompt(task.judgeTask, task.question, task.gold, response, task.abstention) }], 5, "judge");
        // Ein leeres Urteil ist KEIN "nein". Es bedeutet, dass die Jury nicht
        // geantwortet hat, und gehoert damit unter die Fehler — sonst sinkt die
        // Quote, ohne dass jemand eine Frage falsch beantwortet haette.
        const judgeFailed = verdict.trim() === "";
        record = {
          ...base, render, rep,
          question: task.question, gold: task.gold, response,
          correct: !judgeFailed && /^yes/i.test(verdict.trim()), verdict, recalled: ids.length,
          ...(judgeFailed ? { error: "judge returned empty verdict", judgeFailed: true } : {}),
          evidenceHit, evidence: task.evidence, ...(task.evidenceDropped?.length ? { evidenceDropped: task.evidenceDropped } : {}),
          recalledIds: ids, promptMemories, droppedFromPrompt: dropped, blockChars: block.length,
          ...(SAVE_BLOCKS ? { block } : {}),
          recallMs: ms, recallAttempts: attempts, rerankApplied, recallCache: recallCacheStatus, topN: TOP_N, provider: PROVIDER, answerModel: ANSWER_MODEL, judgeModel: JUDGE_MODEL, db: DB_ROOT,
        };
      } catch (error) {
        record = { ...base, render, rep, error: String(error?.message || error), correct: false, evidenceHit };
      }
      appendFileSync(outPaths.get(`${render}#${rep}`), `${JSON.stringify(record)}\n`);
      out.push(record);
    }
  }
  if (++done % 50 === 0) console.log(`${done}/${tasks.length}`);
  return out;
});

// Bewertet wird nur, was auch beurteilt wurde. Fehler stehen daneben, damit
// ein stiller Ausfall nicht als schlechtes Ergebnis durchgeht.
const flat = results.flat();
console.log("");
const rcSummary = recallCache.summary();
meta.finished = new Date().toISOString();
meta.recallCache = rcSummary;
writeFileSync(metaPath, JSON.stringify(meta, null, 1));
console.log(`recall-cache: ${rcSummary.hit} Treffer, ${rcSummary.miss} Fehlgriffe, ${rcSummary.written} geschrieben, ${rcSummary.skippedRerankFallback} Rerank-Ausfaelle nicht gespeichert; API-Aufrufe embed ${rcSummary.apiCalls.embed} / rerank ${rcSummary.apiCalls.rerank}`);
if (COHERE_BILLING) console.log(`cohere-billing: ${cohereBilling.calls} Antworten, ${cohereBilling.withMeta} mit billed_units, ${cohereBilling.parseErrors} nicht auswertbar: ${JSON.stringify(cohereBilling.units)}`);
if (RECALL_ONLY) {
  const rows = flat.filter((r) => !r.error);
  const withEv = rows.filter((r) => r.evidenceHit !== null);
  console.log(`${which} recall-only: ${rows.length}/${flat.length} Fragen ohne Fehler, Belegtreffer ${withEv.filter((r) => r.evidenceHit).length}/${withEv.length} → ${outPaths.get("recall")}`);
  console.log(`→ meta ${metaPath}`);
  await embeddings.shutdown?.();
  process.exit(0);
}
for (const [key, path] of outPaths) {
  const [render, rep] = key.split("#");
  const rows = flat.filter((r) => r.render === render && r.rep === Number(rep));
  const ok = rows.filter((r) => r.correct).length;
  const errors = rows.filter((r) => r.error).length;
  const judgeFailed = rows.filter((r) => r.judgeFailed).length;
  const scored = rows.length - errors;
  console.log(`${which} ${render} r${rep}: ${ok}/${scored} = ${(100 * ok / Math.max(scored, 1)).toFixed(1)} % (errors: ${errors}, davon leere Urteile: ${judgeFailed}) → ${path}`);
  if (errors > rows.length * 0.02) {
    console.log(`WARNUNG: ${(100 * errors / Math.max(rows.length, 1)).toFixed(1)} % der Fragen in ${render} r${rep} wurden nicht bewertet — nur eingeschraenkt vergleichbar.`);
  }
}
const noRerank = flat.filter((r) => r.rep === 1 && r.render === RENDERS[0] && r.rerankApplied === false).length;
console.log(`Wiederholungen nach Abbruch: ${truncationRetries}; Fragen ohne Rerank trotz Wiederholung: ${noRerank}`);
console.log(`→ meta ${metaPath}`);
await embeddings.shutdown?.();

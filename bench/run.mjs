/**
 * Lauf: Recall über die echte PLUR1BUS-Pipeline → Antwortmodell → LLM-Judge.
 *
 * Usage: node run.mjs locomo|lme [--limit N] [--no-rerank] [--tag NAME]
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BENCH, RELEASE, PROVIDERS, chatClient, lancedb, loadEnv, makeEmbeddings, makeReranker, pMap, withRetry, silentLogger, parseLocomoDate } from "./lib/common.mjs";

loadEnv();
const { runRecallPipeline } = await import(`${RELEASE}/lib/recall-pipeline.js`);

const which = process.argv[2];
const arg = (flag, fallback = null) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const LIMIT = Number(arg("--limit", Infinity));
const USE_RERANK = !process.argv.includes("--no-rerank");
const TAG = arg("--tag", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16));
const CONCURRENCY = Number(arg("--concurrency", 6));

const PROVIDER = arg("--provider", "deepseek");
const PROVIDER_CFG = PROVIDERS[PROVIDER];
if (!PROVIDER_CFG) throw new Error(`Unbekannter Anbieter "${PROVIDER}" — bekannt sind ${Object.keys(PROVIDERS).join(", ")}.`);
const ANSWER_MODEL = arg("--answer-model", PROVIDER_CFG.answerModel);
const JUDGE_MODEL = arg("--judge-model", PROVIDER_CFG.judgeModel);
const DB_ROOT = arg("--db", "db");   // "db" = Rohturns, "db-capture" = Capture-Pfad

// Produktionswerte aus openclaw.json → plugins.memory-lancedb-namespaced.config.
// `--top-n` hebt das Abrufbudget ueber den Produktionswert, um zu messen, ob
// der Engpass die Anzahl der ausgelieferten Erinnerungen ist oder die
// Rangfolge: findet ein groesseres Fenster deutlich mehr Belege, hat PLUR1BUS
// die richtigen Zeilen und liefert sie nur nicht alle aus.
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

const client = chatClient(PROVIDER);
const embeddings = await makeEmbeddings();
const reranker = USE_RERANK ? await makeReranker({ timeoutMs: RECALL.rerankerTimeoutMs }) : null;

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
async function responsesCall(model, messages) {
  return withRetry(async () => {
    const stream = await client.responses.create({
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

async function chatRaw(model, messages, maxTokens, attempt = 0) {
  const budget = Math.max(maxTokens, THINK_FLOOR) * (attempt + 1);
  let content;
  let truncated;
  if (PROVIDER_CFG.api === "responses") {
    ({ content, truncated } = await responsesCall(model, messages));
  } else {
    const r = await withRetry(
      () => client.chat.completions.create({
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
    return chatRaw(model, messages, maxTokens, 1);
  }
  return content;
}
const chat = (model, messages, maxTokens = 300) => chatRaw(model, messages, maxTokens);

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

function answerMessages(question, memories, nowIso, judgeTask) {
  const block = memories.length
    ? memories.map((m, i) => `${i + 1}. ${m.entry.text}`).join("\n")
    : "(no memories retrieved)";
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
      content: `You answer questions about a long-running conversation, using ONLY the retrieved memories below. Each memory is prefixed with the date and time it was said. The current date and time is ${nowIso}. Answer as briefly as possible — a short phrase, a name, a date, or a number — with no explanation. If the memories do not contain the information needed, reply exactly: I don't know.`,
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
  const result = await runRecallPipeline({
    ...RECALL, query, dbTable: table, embeddings, reranker,
    rerankCandidates: RECALL.candidateTopK, agentId, logger, now,
  });
  // Mit deferFinalCap liefert die Pipeline bis zu candidateHardLimit Zeilen
  // zurueck — die endgueltige Kappung macht der AUFRUFER. index.js tut das
  // ueber maxOut: topN beim Zusammenfuehren der Namensraeume; ohne diesen
  // Schritt landen hier bis zu 100 Erinnerungen im Prompt statt topN, und der
  // Lauf misst wieder etwas anderes als die Produktion.
  const memories = (result.memories || []).slice(0, RECALL.topN);
  return { memories, ms: Date.now() - started, rerankApplied: reranker ? !rerankFallback : false };
}

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
      for (const [index, qa] of sample.qa.entries()) {
        const adversarial = qa.category === 5;
        tasks.push({
          id: `${sample.sample_id}#${index}`,
          store: join(BENCH, DB_ROOT, "locomo", sample.sample_id),
          agentId: "bench-locomo",
          question: qa.question,
          gold: String(qa.answer ?? qa.adversarial_answer ?? ""),
          category: `locomo-cat${qa.category}`,
          judgeTask: "multi-session",
          abstention: adversarial,
          evidence: (qa.evidence || []).map((e) => `${sample.sample_id}:${e}`),
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
const tasks = allTasks.filter((t) => existsSync(t.store)).slice(0, LIMIT);
const EXPECTED = { locomo: 1986, lme: 500 }[which];
if (!Number.isFinite(LIMIT) && tasks.length !== EXPECTED) {
  console.error(`abort: ${tasks.length} questions with an existing store, expected ${EXPECTED} — ingest incomplete`);
  process.exit(1);
}
console.log(`${which}: ${tasks.length} questions, db=${DB_ROOT}, rerank=${USE_RERANK}, topN=${TOP_N}, candidateTopK=${CANDIDATE_TOP_K}, provider=${PROVIDER}, answer=${ANSWER_MODEL}, judge=${JUDGE_MODEL}`);

const outPath = join(BENCH, `results/${which}-${TAG}.jsonl`);
writeFileSync(outPath, "");
let done = 0;
const results = await pMap(tasks, CONCURRENCY, async (task) => {
  let record;
  try {
    const { memories, ms, rerankApplied } = await recall(task.store, task.question, task.now, task.agentId);
    const ids = memories.map((m) => m.entry.id);
    // Ein aufgeteilter Store fuehrt Teilstuecke als "<original>#0", "#1" usw.
    // Der Beleg gilt als gefunden, sobald IRGENDEIN Teilstueck der
    // Originalzeile im Kontext liegt — sonst zaehlte die Aufteilung als
    // Verschlechterung, obwohl sie dieselbe Stelle liefert.
    const trifft = (e, id) => (e.endsWith(":") ? id.startsWith(e) : id === e || id.startsWith(`${e}#`));
    const evidenceHit = task.evidence.length
      ? task.evidence.some((e) => ids.some((id) => trifft(e, id)))
      : null;
    const nowIso = new Date(task.now).toISOString().slice(0, 16).replace("T", " ");
    const response = await chat(ANSWER_MODEL, answerMessages(task.question, memories, nowIso, task.judgeTask));
    const verdict = await chat(JUDGE_MODEL, [{ role: "user", content: judgePrompt(task.judgeTask, task.question, task.gold, response, task.abstention) }], 5);
    // Ein leeres Urteil ist KEIN "nein". Es bedeutet, dass die Jury nicht
    // geantwortet hat, und gehoert damit unter die Fehler — sonst sinkt die
    // Quote, ohne dass jemand eine Frage falsch beantwortet haette.
    const judgeFailed = verdict.trim() === "";
    record = {
      id: task.id, category: task.category, abstention: task.abstention,
      question: task.question, gold: task.gold, response,
      correct: !judgeFailed && /^yes/i.test(verdict.trim()), verdict, recalled: ids.length,
      ...(judgeFailed ? { error: "judge returned empty verdict", judgeFailed: true } : {}),
      evidenceHit, recallMs: ms, rerankApplied, topN: TOP_N, provider: PROVIDER, answerModel: ANSWER_MODEL, judgeModel: JUDGE_MODEL, db: DB_ROOT,
    };
  } catch (error) {
    record = { id: task.id, category: task.category, abstention: task.abstention, error: String(error?.message || error), correct: false, evidenceHit: null };
  }
  appendFileSync(outPath, `${JSON.stringify(record)}\n`);
  if (++done % 50 === 0) console.log(`${done}/${tasks.length}`);
  return record;
});

const ok = results.filter((r) => r.correct).length;
const errors = results.filter((r) => r.error).length;
const judgeFailed = results.filter((r) => r.judgeFailed).length;
// Bewertet wird nur, was auch beurteilt wurde. Fehler stehen daneben, damit
// ein stiller Ausfall nicht als schlechtes Ergebnis durchgeht.
const scored = results.length - errors;
console.log(`\n${which}: ${ok}/${scored} = ${(100 * ok / Math.max(scored, 1)).toFixed(1)} % (errors: ${errors}, davon leere Urteile: ${judgeFailed}, Wiederholungen nach Abbruch: ${truncationRetries})`);
if (errors > results.length * 0.02) {
  console.log(`WARNUNG: ${(100 * errors / results.length).toFixed(1)} % der Fragen wurden nicht bewertet — das Ergebnis ist nur eingeschraenkt vergleichbar.`);
}
console.log(`→ ${outPath}`);
await embeddings.shutdown?.();

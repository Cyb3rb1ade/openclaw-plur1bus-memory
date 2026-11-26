/**
 * Gemeinsame Bausteine für die PLUR1BUS-Benchmarkläufe (LOCOMO / LongMemEval).
 *
 * Alles läuft gegen eigene LanceDB-Stores unter BENCH (db/, db-capture-<name>/) —
 * niemals gegen ~/.openclaw/memory/lancedb-namespaced und niemals über den
 * Gateway, damit weder Produktivgedächtnis noch laufende Chats betroffen sind.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Zustandsverzeichnis des Gateways, in derselben Reihenfolge wie das Plugin
 * (lib/dashboard-settings.js, lib/host-services.js): OPENCLAW_STATE_DIR, dann
 * OPENCLAW_HOME, sonst ~/.openclaw. Bewusst hier nachgebaut und nicht aus dem
 * Release importiert, damit der Messstand auch gegen aeltere Checkouts laeuft.
 * @param {object} [env]
 * @returns {string} Pfad des Zustandsverzeichnisses
 */
export function openclawStateDir(env = process.env) {
  const stateDir = typeof env.OPENCLAW_STATE_DIR === "string" ? env.OPENCLAW_STATE_DIR.trim() : "";
  if (stateDir) return stateDir;
  const home = typeof env.OPENCLAW_HOME === "string" ? env.OPENCLAW_HOME.trim() : "";
  return home || join(homedir(), ".openclaw");
}

/**
 * Konfigurationsdatei des Gateways (nur fuer --render prod, gelesen werden
 * nur die Render-Einstellungen des Plugins): OPENCLAW_CONFIG_PATH, sonst
 * openclaw.json im Zustandsverzeichnis.
 * @param {object} [env]
 * @returns {string} Pfad von openclaw.json
 */
export function openclawConfigPath(env = process.env) {
  const explicit = typeof env.OPENCLAW_CONFIG_PATH === "string" ? env.OPENCLAW_CONFIG_PATH.trim() : "";
  return explicit || join(openclawStateDir(env), "openclaw.json");
}

/**
 * Wo die zu vermessende Bibliothek liegt und wo Daten und Stores stehen.
 *
 * Beides ist ueber die Umgebung ueberschreibbar, damit der Messstand nicht an
 * einen Pfad gebunden ist: PLUR1BUS_RELEASE zeigt auf den Checkout, dessen
 * lib/ gemessen wird (Vorgabe: der Release-Checkout plur1bus-release im
 * Zustandsverzeichnis des Gateways, also genau der Code, der laeuft),
 * BENCH_HOME auf das Arbeitsverzeichnis mit data/ und den LanceDB-Stores.
 */
export const RELEASE = process.env.PLUR1BUS_RELEASE || join(openclawStateDir(), "plur1bus-release");
// 25.11.2026: Ohne BENCH_HOME ist BENCH das Verzeichnis dieses Messstands
// (eine Ebene ueber lib/); dort liegt auch .env.bench.
export const BENCH = process.env.BENCH_HOME || dirname(dirname(fileURLToPath(import.meta.url)));
const require_ = createRequire(`${RELEASE}/package.json`);

export const lancedb = require_("@lancedb/lancedb");
const OpenAI = require_("openai").default ?? require_("openai");

/**
 * Absoluter Pfad mit aufgeloesten Symlinks. Existiert das Ziel nicht, wird
 * der naechste vorhandene Vorfahre aufgeloest und der Rest angehaengt; so
 * faellt auch ein noch nicht vorhandenes Ziel hinter einem Symlink auf.
 * @param {string} path
 * @returns {string}
 */
function canonicalPath(path) {
  let head = resolve(String(path));
  const rest = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    rest.unshift(basename(head));
    head = parent;
  }
  return join(existsSync(head) ? realpathSync(head) : head, ...rest);
}

/**
 * Verzeichnisse des Gateways, aus denen der Messstand nie Schluessel liest:
 * ~/.openclaw sowie OPENCLAW_HOME und OPENCLAW_STATE_DIR, wenn gesetzt.
 * @param {object} [env]
 * @returns {string[]} kanonische Pfade
 */
function forbiddenEnvRoots(env = process.env) {
  const roots = [join(homedir(), ".openclaw")];
  for (const name of ["OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]) {
    const value = typeof env[name] === "string" ? env[name].trim() : "";
    if (value) roots.push(value);
  }
  return [...new Set(roots.map(canonicalPath))];
}

/**
 * Laedt KEY=VALUE-Zeilen in process.env; schon gesetzte Variablen bleiben.
 *
 * 25.11.2026: Der Messstand liest nie Schluessel des Gateways. Jeder Pfad,
 * der nach resolve() und Aufloesen der Symlinks in ~/.openclaw,
 * $OPENCLAW_HOME oder $OPENCLAW_STATE_DIR liegt (gateway.systemd.env,
 * credentials/*.env), wird abgelehnt, bevor die Datei gelesen wird. Standard
 * ist BENCH/.env.bench.
 * @param {string} [path] Datei, Vorgabe BENCH/.env.bench
 * @param {object} [opts]
 * @param {boolean} [opts.optional=false] fehlende Datei ist kein Fehler
 *   (Schluessel koennen auch aus der Shell kommen); jeder andere Fehler
 *   und die Ablehnung eines Gateway-Pfads werfen trotzdem
 * @returns {boolean} true, wenn die Datei gelesen wurde
 */
export function loadEnv(path = join(BENCH, ".env.bench"), { optional = false } = {}) {
  const target = canonicalPath(path);
  const root = forbiddenEnvRoots().find((r) => target === r || target.startsWith(`${r}${sep}`));
  if (root) {
    throw new Error(`loadEnv(${path}): liegt in ${root} — Schluessel des Gateways sind im Messstand verboten, eigene BENCH_*-Schluessel in .env.bench eintragen.`);
  }
  if (optional && !existsSync(target)) return false;
  for (const line of readFileSync(target, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = m[2];
    if (/^".*"$/.test(value)) value = value.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
  return true;
}

export const EMBED_MODEL = "text-embedding-3-large";
export const EMBED_DIM = 3072;

/**
 * Eigener Schluessel des Messstands aus der Umgebung oder BENCH/.env.bench;
 * nie der des Gateways (23.11.2026: Messlaeufe haben das Cohere-Limit der
 * Produktion aufgebraucht). Fehlt er, bricht der Aufruf ab.
 * @param {string} name Variablenname, immer mit Praefix BENCH_
 * @returns {void}
 */
export function requireBenchKey(name) {
  if (!process.env[name]) loadEnv(join(BENCH, ".env.bench"), { optional: true });
  if (!process.env[name]) {
    throw new Error(`${name} fehlt — der Messstand nutzt keine Schluessel des Gateways (.env.bench).`);
  }
}

export async function makeEmbeddings() {
  requireBenchKey("BENCH_OPENAI_API_KEY");
  const { OpenAIEmbeddingProvider } = await import(`${RELEASE}/lib/providers/embedding-openai.js`);
  return new OpenAIEmbeddingProvider({
    provider: "openai",
    model: EMBED_MODEL,
    dimensions: EMBED_DIM,
    apiKeyEnv: "BENCH_OPENAI_API_KEY",
    embeddingCacheEnabled: false,
  });
}

/**
 * Reranker-Modell des Messstands (25.11.2026). rerank-v5.0-fast ist ab
 * PLUR1BUS 7.21.1 der Plugin-Default (die Live-Config setzt kein
 * reranker.model). Der Messstand nennt das Modell ausdruecklich, damit auch
 * Laeufe gegen aeltere Releases (Default rerank-v3.5) dasselbe Modell nutzen;
 * fuer v3.5: --rerank-model rerank-v3.5. Das Modell steht im
 * Recall-Cache-Schluessel, v3.5-Eintraege bleiben ueber den Schalter erreichbar.
 * @type {string}
 */
export const BENCH_DEFAULT_RERANK_MODEL = "rerank-v5.0-fast";

/**
 * Cohere-Reranker des Plugins mit dem Bench-Schluessel.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=2500]
 * @param {string} [opts.model] Cohere-Modell; ohne Angabe BENCH_DEFAULT_RERANK_MODEL.
 * @returns {Promise<object>} CohereRerankerProvider
 */
export async function makeReranker({ timeoutMs = 2500, model } = {}) {
  requireBenchKey("BENCH_COHERE_API_KEY");
  const { CohereRerankerProvider } = await import(`${RELEASE}/lib/providers/reranker-cohere.js`);
  return new CohereRerankerProvider({ apiKeyEnv: "BENCH_COHERE_API_KEY", timeoutMs, model: model || BENCH_DEFAULT_RERANK_MODEL });
}

/**
 * Reranker-Schalter (24.11.2026), fuer makeReranker:
 *   --rerank-model NAME   Cohere-Modell, z. B. rerank-v3.5. Ohne Schalter
 *                         BENCH_DEFAULT_RERANK_MODEL (rerank-v5.0-fast).
 *   --rerank-max-doc-chars N  gibt es bewusst NICHT. Der Messstand uebergibt
 *                         kein maxDocChars, es gilt also der Default des
 *                         Plugins, wie in der Produktion (die Live-Config setzt
 *                         kein reranker.maxDocChars): bis 7.20.9 keine Grenze,
 *                         ab 7.20.10 kuerzt CohereRerankerProvider jedes
 *                         Dokument auf reranker.maxDocChars (Vorgabe 1400
 *                         Zeichen). Rerank-Dokument ist je Kandidat `summary`
 *                         bzw. generateSummary(text, summaryMaxWords). Ein
 *                         eigener Wert nur im Messstand mass etwas, das
 *                         Produktion nicht tut; deshalb bricht der Schalter ab,
 *                         statt still ignoriert zu werden. Der wirksame Wert
 *                         steht im Recall-Cache-Schluessel (reranker.maxDocChars).
 * @param {string[]} [argv]
 * @returns {{model?: string}}
 */
export function rerankOpts(argv = process.argv) {
  if (argv.includes("--rerank-max-doc-chars")) {
    throw new Error("--rerank-max-doc-chars: gibt es im Messstand nicht; es gilt der Default des Plugins wie in der Produktion (ab 7.20.10 reranker.maxDocChars = 1400 Zeichen, davor keine Grenze); siehe README.md");
  }
  const i = argv.indexOf("--rerank-model");
  if (i < 0) return {};
  const model = argv[i + 1];
  if (!model || model.startsWith("--")) throw new Error("--rerank-model NAME");
  return { model };
}

/**
 * Anbieter für Antwort- und Jury-Modell. Die EINBETTUNGEN bleiben davon
 * unberührt (OpenAI, text-embedding-3-large, 3072 Dimensionen) — sie stecken
 * in der Benchmark-Datenbank, ein Wechsel würde jede frühere Zahl entwerten.
 *
 * DeepSeek spricht das OpenAI-Format, braucht also nur eine andere baseURL.
 * Gemessen am 19.09.2026: `temperature: 0` wird akzeptiert (deterministisch),
 * aber beide Modelle verbrauchen Denk-Tokens gegen `max_tokens` — bei einem
 * Budget von 5 kommt der Inhalt LEER zurück (`finish_reason: length`). Siehe
 * THINK_FLOOR in run.mjs.
 */
export const PROVIDERS = {
  openai: {
    baseURL: undefined,
    keyEnv: "BENCH_OPENAI_API_KEY",
    answerModel: "gpt-5.6-luna",
    judgeModel: "gpt-5.6-terra",
  },
  deepseek: {
    baseURL: "https://api.deepseek.com",
    keyEnv: "BENCH_DEEPSEEK_API_KEY",
    answerModel: "deepseek-flash",
    judgeModel: "deepseek-v4-pro",
  },
  /**
   * Der Codex-Endpunkt laeuft ueber die ChatGPT-Anmeldung aus
   * ~/.codex/auth.json (auth_mode "chatgpt"), nicht ueber einen API-Key — es
   * wird also das Abonnement belastet und kein Guthaben. Zwei Unterschiede
   * zu den anderen Anbietern:
   *
   *  - Die Adresse ist `https://chatgpt.com/backend-api/codex`, NICHT
   *    `api.openai.com/v1`. Gegen den falschen Host antwortet dieselbe
   *    Anmeldung mit 401 "Missing scopes: api.responses.write" — das sieht
   *    nach abgelaufenem Token aus, ist aber der falsche Endpunkt.
   *    OpenClaw waehlt die Adresse in extensions/openai/base-url.ts.
   *  - Er spricht die Responses-API (`input` statt `messages`,
   *    `max_output_tokens` statt `max_tokens`) und verlangt `stream: true`
   *    ("Stream must be set to true").
   */
  codex: {
    baseURL: "https://chatgpt.com/backend-api/codex",
    api: "responses",
    authFile: join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"),
    answerModel: "gpt-5.6-terra",
    judgeModel: "gpt-5.6-sol",
  },
};

function codexAuth(authFile) {
  let data;
  try {
    data = JSON.parse(readFileSync(authFile, "utf8"));
  } catch (err) {
    throw new Error(`Codex-Anmeldung nicht lesbar (${authFile}): ${err?.message || err}`);
  }
  const token = data?.tokens?.access_token;
  const account = data?.tokens?.account_id;
  if (!token) throw new Error(`Kein Zugriffstoken in ${authFile} — zuerst "codex login" ausfuehren.`);
  return { token, account, lastRefresh: data?.last_refresh };
}

export function chatClient(provider = "openai") {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unbekannter Anbieter "${provider}" — bekannt sind ${Object.keys(PROVIDERS).join(", ")}.`);
  if (cfg.authFile) {
    const { token, account, lastRefresh } = codexAuth(cfg.authFile);
    void lastRefresh;
    return new OpenAI({
      apiKey: token,
      baseURL: cfg.baseURL,
      defaultHeaders: { ...(account ? { "chatgpt-account-id": account } : {}), originator: "codex_cli_rs" },
      timeout: 120000,
      maxRetries: 5,
    });
  }
  // 25.11.2026: nur eigene Schluessel des Messstands (BENCH_*), wie bei
  // Cohere und den Embeddings; fehlt er, bricht der Lauf ab.
  requireBenchKey(cfg.keyEnv);
  const apiKey = process.env[cfg.keyEnv];
  return new OpenAI({ apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}), timeout: 120000, maxRetries: 5 });
}

export const openaiClient = () => chatClient("openai");

/** Produktionsschema aus index.js — Feldnamen und Typen müssen exakt passen,
 *  weil projectRecallEntry() beim Recall genau diese Spalten liest. */
export function memoryRow({ id, text, summary = "", vector, createdAt, agentId, category = "other", importance = 0.5 }) {
  return {
    id, type: "memory", confirmed: false, text, summary, origin: "dm", vector,
    importance, category, createdAt, mergedFrom: "[]", expiresAt: 0,
    agentId, storedBy: agentId, sourceTurnId: "", sourceMessageRole: "", sourceTimestamp: createdAt,
    sourceUrl: "", evidenceQuote: "", scope: "agent-private", ownerUserId: "",
    emotionalValence: "", emotionalIntensity: 0, emotionalDominant: "neutral",
    moodContextAtCapture: "", emotionStatus: "final", replayCount: 0, lastReplayed: 0,
    retrievalCount: 0, lastRetrievedAt: 0, memoryStrength: 1.0, halfLifeDays: 180,
    lastStrengthenedAt: 0, lastDynamicsAt: 0, memoryClass: "standard", neverForget: 0,
    coreMemoryScore: 0.0, coreMemoryReason: "", versionNumber: 1, previousVersion: "",
    supersededBy: "", updateSource: "", updateEvidence: "", reconsolidationConfidence: 0.0,
    status: "active", versionCreatedAt: createdAt, updatedAt: createdAt,
    workspaceId: "", workspaceKey: "", memoryKind: "memory",
    reminderStatus: "", remindAt: 0, remindedAt: 0, dispatchedAt: 0, acknowledgedAt: 0,
    cancelledAt: 0, reminderKey: "", dispatchCount: 0, lastDispatchAttemptAt: 0,
    nextDispatchAttemptAt: 0, epistemicStatus: "", epistemicStatusUpdatedAt: 0,
    epistemicStatusActor: "", epistemicStatusReason: "", previousEpistemicStatus: "",
    validFrom: 0, validUntil: 0,
  };
}

/** Begrenzte Parallelität — schützt API-Limits und den Rechner. */
export async function pMap(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

export async function withRetry(fn, { tries = 5, baseMs = 1000, label = "call" } = {}) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt++) {
    try { return await fn(); } catch (error) {
      lastError = error;
      const status = error?.status ?? error?.response?.status;
      if (status && status < 500 && status !== 429) throw error;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt + Math.random() * 500));
    }
  }
  throw new Error(`${label} failed after ${tries} tries: ${lastError?.message || lastError}`);
}

const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };

/** "1:56 pm on 8 May, 2023" -> epoch ms (UTC) */
export function parseLocomoDate(raw) {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),\s*(\d{4})$/.exec(String(raw).trim());
  if (!m) throw new Error(`unparsable LOCOMO date: ${raw}`);
  let hour = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "pm") hour += 12;
  return Date.UTC(Number(m[6]), MONTHS[m[5].toLowerCase()], Number(m[4]), hour, Number(m[2]));
}

/** "2023/04/10 (Mon) 17:50" -> epoch ms (UTC) */
export function parseLmeDate(raw) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})[^\d]*(\d{2}):(\d{2})$/.exec(String(raw).trim());
  if (!m) throw new Error(`unparsable LongMemEval date: ${raw}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

export const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * Zeitfilter der Recall-Pipeline (PLUR1BUS >= 7.20.8): `--temporal-mode
 * intent|legacy|off` setzt `temporalFilterMode` von runRecallPipeline.
 * Ohne Schalter gilt der Default des Plugins (7.20.8: "intent"). "legacy" ist
 * das Verhalten von 7.20.7 (harter createdAt-Filter, Anker), "off" parst keine
 * Zeitangaben. Anders als der alte Umweg ueber `validAt` bleibt fetchLimit
 * dabei unveraendert (validAt setzt es auf candidateHardLimit).
 * Gegen ein Plugin < 7.20.8 ist der Schalter wirkungslos — dann bricht er ab.
 * @param {string[]} [argv]
 * @returns {{temporalFilterMode?: "intent"|"legacy"|"off"}}
 */
export function temporalModeOpts(argv = process.argv) {
  const i = argv.indexOf("--temporal-mode");
  if (i < 0) return {};
  const mode = argv[i + 1];
  if (!["intent", "legacy", "off"].includes(mode)) throw new Error("--temporal-mode intent|legacy|off");
  const version = JSON.parse(readFileSync(`${RELEASE}/package.json`, "utf8")).version;
  const [a, b, c] = version.split(".").map(Number);
  if (a < 7 || (a === 7 && (b < 20 || (b === 20 && c < 8)))) {
    throw new Error(`--temporal-mode braucht PLUR1BUS >= 7.20.8 (PLUR1BUS_RELEASE ist ${version})`);
  }
  return { temporalFilterMode: mode };
}

/**
 * Gemeinsame Bausteine für die PLUR1BUS-Benchmarkläufe (LOCOMO / LongMemEval).
 *
 * Alles läuft gegen eine separate LanceDB unter /root/plur1bus-bench/db —
 * niemals gegen ~/.openclaw/memory/lancedb-namespaced und niemals über den
 * Gateway, damit weder Produktivgedächtnis noch laufende Chats betroffen sind.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

/**
 * Wo die zu vermessende Bibliothek liegt und wo Daten und Stores stehen.
 *
 * Beides ist ueber die Umgebung ueberschreibbar, damit der Messstand nicht an
 * einen Pfad gebunden ist: PLUR1BUS_RELEASE zeigt auf den Checkout, dessen
 * lib/ gemessen wird (Vorgabe: der Live-Deploy-Worktree, also genau der Code,
 * der laeuft), BENCH_HOME auf das Arbeitsverzeichnis mit data/ und den
 * LanceDB-Stores.
 */
export const RELEASE = process.env.PLUR1BUS_RELEASE || "/root/.openclaw/plur1bus-release";
export const BENCH = process.env.BENCH_HOME || "/root/plur1bus-bench";
const require_ = createRequire(`${RELEASE}/package.json`);

export const lancedb = require_("@lancedb/lancedb");
const OpenAI = require_("openai").default ?? require_("openai");

export function loadEnv(path = "/root/.openclaw/gateway.systemd.env") {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = m[2];
    if (/^".*"$/.test(value)) value = value.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}

export const EMBED_MODEL = "text-embedding-3-large";
export const EMBED_DIM = 3072;

export async function makeEmbeddings() {
  const { OpenAIEmbeddingProvider } = await import(`${RELEASE}/lib/providers/embedding-openai.js`);
  return new OpenAIEmbeddingProvider({
    provider: "openai",
    model: EMBED_MODEL,
    dimensions: EMBED_DIM,
    apiKeyEnv: "OPENAI_API_KEY",
    embeddingCacheEnabled: false,
  });
}

export async function makeReranker({ timeoutMs = 2500 } = {}) {
  const { CohereRerankerProvider } = await import(`${RELEASE}/lib/providers/reranker-cohere.js`);
  return new CohereRerankerProvider({ apiKeyEnv: "COHERE_API_KEY", timeoutMs });
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
    keyEnv: "OPENAI_API_KEY",
    answerModel: "gpt-5.6-luna",
    judgeModel: "gpt-5.6-terra",
  },
  deepseek: {
    baseURL: "https://api.deepseek.com",
    keyEnv: "DEEPSEEK_API_KEY",
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
    authFile: "/root/.codex/auth.json",
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
  const apiKey = process.env[cfg.keyEnv];
  if (!apiKey) throw new Error(`${cfg.keyEnv} ist nicht gesetzt.`);
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

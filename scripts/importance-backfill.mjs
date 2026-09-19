#!/usr/bin/env node
/**
 * scripts/importance-backfill.mjs — Phase 2 der Importance-Migration:
 * arbeitet den Bestand auf, den Phase 1 auf `pending_backfill` gestellt hat.
 *
 * Läuft als eigener Prozess, NICHT im Gateway. Zwei Gründe:
 *
 * 1. `MemoryDB.update` erzeugt je Zeile eine LanceDB-Version. 22.000
 *    Einzelversionen sind genau die Fragmentierung, die am 13.09.2026 zu
 *    Gateway-Blockaden von bis zu 143 Sekunden geführt hat. Hier wird je
 *    Stapel EIN `mergeInsert` geschrieben — aus 22.000 Versionen werden rund
 *    45. Danach `scripts/lancedb-compact-once.mjs` aufrufen.
 * 2. Der stündliche Cron bedient die Warteschlange `pending`. `pending_backfill`
 *    ist bewusst eine zweite, die nur dieses Skript leert.
 *
 * Dry-Run ist Standard. `--apply` muss ausdrücklich gesetzt werden.
 *
 * Wiederaufnahme ist eingebaut: jede fertige Zeile wird `final`, die Abfrage
 * holt nur `pending_backfill`. Ein abgebrochener Lauf wird durch einen
 * erneuten Start fortgesetzt, ohne doppelt zu bezahlen.
 *
 * Rückweg: jede geänderte Zeile trägt ihren vorherigen Zustand in
 * `updateEvidence`, die Quelle in `updateSource` ("importance-v2").
 */
import { join } from "node:path";
import { homedir } from "node:os";

import { buildRefinePatch, classifyEncoding } from "../lib/encoding-llm.js";
import { STORE_SCAN_LIMIT } from "../lib/store-limits.js";
import { IMPORTANCE_STATUS } from "../lib/importance-status.js";
// Gleiche Gefahr wie in Phase 1: whenMatchedUpdateAll() ersetzt bei doppelten
// ids BEIDE Zielzeilen durch die eine Quellzeile — ein Tombstone wird damit
// wieder aktiv, lautlos. Phase 1 laeuft vorher und wuerde selbst abbrechen,
// aber der Backfill darf sich darauf nicht verlassen.
import { findDuplicateActiveIds } from "./importance-phase1-reset.mjs";

export const BATCH_SIZE = 500;
export const CONCURRENCY = 8;
export const DEFAULT_MAX_TOKENS = 1500;
export const UPDATE_SOURCE = "importance-v2";

/**
 * Beide Anbieter sprechen dasselbe OpenAI-Format; sie unterscheiden sich nur
 * in Endpunkt, Modellnamen, Schlüsselvariable und einem Pflicht-Header.
 *
 * DeepSeek ist der Standard. Vergleich am 19.09.2026 über 20 echte Zeilen
 * gegen die gespeicherten Kimi-Urteile (/root/plur1bus-bench/deepseek-compare):
 * |dImportance| 0,064 und dominante Emotion gleich in 95,0 % — beides besser
 * als Kimis eigener Rauschboden aus zwei identischen Läufen (0,079 und
 * 76,8 %). Die beiden Modelle sind für diese Aufgabe austauschbar, ohne
 * systematischen Versatz (mittlere Importance 0,319 gegen 0,297).
 */
export const PROVIDERS = {
  deepseek: {
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-flash",
    keyEnv: "DEEPSEEK_API_KEY",
    headers: {},
  },
  kimi: {
    endpoint: "https://api.kimi.com/coding/v1/chat/completions",
    model: "kimi-for-coding-highspeed",
    keyEnv: "KIMI_CODING_API_KEY",
    // Ohne diesen Header antwortet die Route "Invalid Authentication" trotz
    // gültigem Schlüssel. DeepSeek braucht ihn nicht.
    headers: { "User-Agent": "gsd/2.77.0" },
  },
};
export const DEFAULT_PROVIDER = "deepseek";

/** Löst Anbieter und Modell auf; ein unbekannter Name wirft, statt zu raten. */
export function resolveProvider(name = DEFAULT_PROVIDER, model = null) {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unbekannter Anbieter "${name}" — bekannt sind ${Object.keys(PROVIDERS).join(", ")}.`);
  }
  return { ...provider, model: model || provider.model };
}

export function chunk(rows = [], size = BATCH_SIZE) {
  const out = [];
  const step = Number.isFinite(size) && size > 0 ? Math.floor(size) : BATCH_SIZE;
  for (let i = 0; i < rows.length; i += step) out.push(rows.slice(i, i + step));
  return out;
}

/**
 * LanceDB liefert die Vektorspalte aus `toArray()` als iterierbares
 * Arrow-Objekt, nicht als Array — `mergeInsert` lehnt das beim Zurückschreiben
 * ab ("Found field not in schema"). Gleiche Entpackung wie `toPlainRow` in
 * scripts/importance-phase1-reset.mjs.
 */
export function toPlainRow(row) {
  const plain = { ...row };
  if (plain.vector && !Array.isArray(plain.vector) && typeof plain.vector[Symbol.iterator] === "function") {
    plain.vector = Array.from(plain.vector);
  }
  return plain;
}

/**
 * Die vollständige Zeile für `mergeInsert`: bestehende Felder plus Patch.
 *
 * `mergeInsert(...).whenMatchedUpdateAll()` ersetzt die GANZE Zielzeile durch
 * die Quellzeile — ein hier fehlendes Feld ist in der Datenbank weg. Deshalb
 * wird die gelesene Zeile als Basis genommen und nur überschrieben, nie neu
 * aufgebaut.
 *
 * @returns {object|null} null, wenn das Modell kein brauchbares Urteil lieferte
 */
export function buildBackfillRow(row, encoding, now = Date.now()) {
  const patch = buildRefinePatch(row, encoding, now, { flashbulbEncodingEnabled: false });
  if (!patch) return null;
  const base = toPlainRow(row);
  return {
    ...base,
    ...patch,
    importanceStatus: IMPORTANCE_STATUS.FINAL,
    // Der Rückweg. buildRefinePatch fasst diese beiden Felder bewusst nicht an
    // (der stündliche Cron würde sonst die Provenienz des Backfills
    // überschreiben) — hier, im Backfill selbst, gehören sie hin.
    updateSource: UPDATE_SOURCE,
    updateEvidence: JSON.stringify({
      previousImportance: typeof row?.importance === "number" ? row.importance : null,
      previousHalfLifeDays: typeof row?.halfLifeDays === "number" ? row.halfLifeDays : null,
      previousEmotionalValence: row?.emotionalValence ?? null,
      previousEmotionalDominant: row?.emotionalDominant ?? null,
      at: now,
    }),
  };
}

/**
 * Baut die `callLlm`-Funktion, die `classifyEncoding` injiziert bekommt.
 *
 * Zwei Eigenheiten, beide am 19.09.2026 gemessen:
 *
 * - `temperature` wird gar nicht mitgeschickt: Kimi lehnt jede Angabe außer 1
 *   mit "invalid temperature: only 1 is allowed for this model" ab, und für
 *   DeepSeek gibt es keinen Grund, davon abzuweichen.
 * - Thinking ist auf diesem Pfad standardmäßig AN und zählt gegen `max_tokens`.
 *   Der Cron schaltet es ab (`disableThinking: true`), hier geht das nicht —
 *   deshalb der eine Wiederholungsversuch mit doppeltem Budget, wenn die
 *   Antwort abgeschnitten wurde. Der Fehler wäre sonst stumm: HTTP 200,
 *   plausibel aussehendes JSON, keine schließende Klammer.
 *
 * Ein Fehlschlag liefert "" — `classifyEncoding` macht daraus `callFailed`,
 * die Zeile bleibt `pending_backfill` und wird beim nächsten Lauf erneut
 * versucht.
 */
export function createEncodingCall({
  apiKey,
  provider = DEFAULT_PROVIDER,
  model = null,
  maxTokens = DEFAULT_MAX_TOKENS,
  fetchImpl = globalThis.fetch,
  onTruncation = () => {},
  onHttpError = () => {},
} = {}) {
  const route = resolveProvider(provider, model);
  return async function callLlm(messages, { signal } = {}) {
    const attempt = async (budget) => {
      const res = await fetchImpl(route.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...route.headers,
        },
        body: JSON.stringify({ model: route.model, max_tokens: budget, messages }),
        ...(signal ? { signal } : {}),
      });
      if (!res?.ok) {
        onHttpError(res?.status ?? 0);
        return { content: "", finishReason: "http_error" };
      }
      const body = await res.json();
      const choice = body?.choices?.[0];
      return { content: choice?.message?.content || "", finishReason: choice?.finish_reason || null };
    };

    try {
      const first = await attempt(maxTokens);
      if (first.finishReason !== "length") return first.content;
      onTruncation();
      const second = await attempt(maxTokens * 2);
      return second.content;
    } catch {
      return "";
    }
  };
}

export function parseArgs(argv = []) {
  const args = {
    agents: [],
    apply: false,
    limit: Infinity,
    provider: DEFAULT_PROVIDER,
    model: null,
    batchSize: BATCH_SIZE,
    concurrency: CONCURRENCY,
    baseDbPath: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--provider") args.provider = String(argv[++i]);
    else if (arg === "--model") args.model = String(argv[++i]);
    else if (arg === "--batch-size") args.batchSize = Number(argv[++i]);
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (arg === "--base-db-path") args.baseDbPath = String(argv[++i]);
    else if (!arg.startsWith("--")) args.agents.push(arg);
  }
  return args;
}

/** Arbeitet eine Liste mit fester Breite ab, ohne alle Versprechen auf einmal zu erzeugen. */
async function mapWithConcurrency(items, width, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, width) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function openclawHome() {
  return process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
}

function readApiKey(route) {
  const key = process.env[route.keyEnv];
  if (!key) {
    throw new Error(`${route.keyEnv} ist nicht gesetzt — das Skript fragt keinen Schlüssel aus Dateien ab.`);
  }
  return key;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.agents.length === 0) {
    console.log("Nutzung: node scripts/importance-backfill.mjs <agentId> [...] [--apply]");
    console.log("         [--limit N] [--provider deepseek|kimi] [--model <id>] [--batch-size N] [--concurrency N] [--base-db-path <pfad>]");
    console.log(`Standard: Dry-Run, Anbieter ${DEFAULT_PROVIDER} (${PROVIDERS[DEFAULT_PROVIDER].model}), Stapel ${BATCH_SIZE}, Breite ${CONCURRENCY}.`);
    console.log("ACHTUNG: ein Dry-Run bezahlt jedes Urteil und schreibt keines — nur mit --limit sinnvoll.");
    console.log(`Schlüssel über die Umgebungsvariable je Anbieter: ${Object.values(PROVIDERS).map((p) => p.keyEnv).join(", ")}.`);
    return 1;
  }

  const route = resolveProvider(args.provider, args.model);
  const apiKey = readApiKey(route);
  console.log(`Anbieter ${args.provider} (${route.model})`);
  const baseDbPath = args.baseDbPath || join(openclawHome(), "memory", "lancedb-namespaced");
  const lancedb = await import("@lancedb/lancedb");
  let failed = 0;

  for (const agentId of args.agents) {
    let table;
    try {
      const db = await lancedb.connect(join(baseDbPath, agentId));
      table = await db.openTable("memories");
    } catch (err) {
      console.log(`${agentId}: kein memories-Table (${err?.message || err})`);
      failed += 1;
      continue;
    }

    const all = await table.query().limit(STORE_SCAN_LIMIT).toArray();
    const queue = all
      .filter((row) => row.importanceStatus === IMPORTANCE_STATUS.PENDING_BACKFILL)
      .slice(0, Number.isFinite(args.limit) ? args.limit : undefined);

    console.log(`${agentId}: ${queue.length} Zeilen in der Warteschlange (von ${all.length} insgesamt)`);
    if (queue.length === 0) continue;

    const duplicates = findDuplicateActiveIds(all);
    if (duplicates.length > 0) {
      console.log(
        `   ABBRUCH: ${duplicates.length} doppelte aktive ids — mergeInsert("id") wuerde Tombstones reaktivieren.`
        + " Zuerst scripts/dedupe-memory-ids.mjs --apply laufen lassen.",
      );
      failed += 1;
      continue;
    }

    let truncated = 0;
    const httpErrors = new Map();
    const callLlm = createEncodingCall({
      apiKey,
      provider: args.provider,
      model: args.model,
      maxTokens: DEFAULT_MAX_TOKENS,
      onTruncation: () => { truncated += 1; },
      onHttpError: (status) => { httpErrors.set(status, (httpErrors.get(status) || 0) + 1); },
    });

    let judged = 0;
    let unresolved = 0;
    const batches = chunk(queue, args.batchSize);
    for (const [index, batch] of batches.entries()) {
      const encodings = await mapWithConcurrency(batch, args.concurrency, (row) =>
        classifyEncoding(String(row.text || ""), { agentId, callLlm }));
      const now = Date.now();
      const patched = [];
      for (const [i, encoding] of encodings.entries()) {
        const built = buildBackfillRow(batch[i], encoding, now);
        if (built) patched.push(built);
        else unresolved += 1;
      }
      judged += patched.length;

      if (!args.apply) {
        console.log(`   Stapel ${index + 1}/${batches.length}: ${patched.length} bewertet, ${encodings.length - patched.length} ohne Urteil — Dry-Run, nichts geschrieben`);
        continue;
      }
      if (patched.length === 0) {
        console.log(`   Stapel ${index + 1}/${batches.length}: kein brauchbares Urteil, nichts zu schreiben`);
        continue;
      }
      try {
        await table.mergeInsert("id").whenMatchedUpdateAll().execute(patched);
        console.log(`   Stapel ${index + 1}/${batches.length}: ${patched.length} geschrieben`);
      } catch (err) {
        console.log(`   Stapel ${index + 1}/${batches.length}: FEHLER beim Schreiben (${err?.message || err}) — Zeilen bleiben pending_backfill`);
        failed += 1;
      }
    }

    const httpSummary = httpErrors.size > 0
      ? ` | HTTP-Fehler: ${[...httpErrors.entries()].map(([s, n]) => `${s}x${n}`).join(", ")}`
      : "";
    console.log(`${agentId}: ${judged} bewertet, ${unresolved} ohne Urteil (bleiben pending_backfill), ${truncated} Antworten nachgefordert${httpSummary}`);
    if (!args.apply) console.log(`${agentId}: Dry-Run — mit --apply ausführen`);
  }

  if (args.apply) console.log("\nDanach: node scripts/lancedb-compact-once.mjs");
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("importance-backfill.mjs")) {
  process.exitCode = await main();
}

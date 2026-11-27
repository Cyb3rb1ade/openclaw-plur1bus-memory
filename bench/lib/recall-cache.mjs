/**
 * Recall-Cache des Messstands (24.11.2026).
 *
 * Ein Recall kostet je Frage einen Embedding- und einen Cohere-Aufruf. Bei
 * Wiederholungen derselben Konfiguration (A/B mit gleichem Recall, Nachanalyse,
 * anderer Antwortprompt) liefert der Cache die Trefferliste aus einer Datei,
 * OHNE Embedding und OHNE Reranker. runRecallPipeline wird bei einem Treffer
 * gar nicht aufgerufen.
 *
 * Schluessel = sha256 ueber (kanonisches JSON, Schluessel sortiert,
 * undefined-Felder weggelassen):
 *   store       realpath des Store-Verzeichnisses, Tabellenname,
 *               table.version() und das neueste _versions/*.manifest
 *               (Name, Groesse, mtime) — jede Schreibaktion am Store
 *               invalidiert.
 *   plugin      Version aus package.json, realpath von PLUR1BUS_RELEASE,
 *               sha256 ueber alle Dateien unter <release>/lib (Inhalt + Pfad)
 *               und die @lancedb/lancedb-Version des Releases. Damit trifft
 *               ein Dev-Worktree mit gleicher Version, aber geaendertem Code
 *               nicht den alten Eintrag.
 *   settings    alle Parameter an runRecallPipeline ausser dbTable,
 *               embeddings, reranker, logger, query, now (topN, budget,
 *               candidateTopK, rerankCandidates, candidateHardLimit,
 *               temporalFilterMode, validAt, agentId, ...).
 *   reranker    null (--no-rerank) oder Klasse, id, model, timeoutMs,
 *               maxDocChars (bis Plugin 7.20.9 null, ab 7.20.10 der
 *               normalisierte reranker.maxDocChars, Vorgabe 1400).
 *   embeddings  Klasse, id, model, dim, baseUrl.
 *   embedTextMode  Bereinigungsmodus des Anfragetexts vor dem Embedding. Der
 *               Messstand bereinigt nichts und uebergibt kein embeddingQuery
 *               (Plugin ab 7.20.10, nur Auto-Recall); der Wert ist fest
 *               "raw". Ein uebergebenes embeddingQuery landet ueber settings
 *               im Schluessel; wer einen eigenen Modus einfuehrt, setzt ihn hier.
 *   extra       frei fuer die Skripte (heute leer).
 *   query, now  die Anfrage und der Recall-Zeitpunkt. Ohne now wird nicht
 *               gecacht (das Ergebnis hinge an der Uhr).
 *
 * Wert: das ganze Ergebnis von runRecallPipeline (memories mit allen Feldern,
 * queryVector, canonical, temporalFilter, ...) typgetreu (BigInt, -0, NaN,
 * undefined, TypedArrays werden markiert), dazu alle Logger-Aufrufe der
 * Pipeline. Bei einem Treffer werden sie in den Logger des Aufrufers
 * wiedergegeben, damit Rerank-Ausfall- und Zeitfilter-Erkennung der Skripte
 * gleich bleiben.
 *
 * Nie gecacht: Ergebnisse mit Rerank-Ausfall (eine warn/error-Zeile mit
 * "rerank"; run.mjs wiederholt dann den Recall), Fehler, Parameter, die sich
 * nicht serialisieren lassen (Funktionen), Aufrufe ohne now.
 *
 * Ablage: <dir>/<ctx16>/<keyhash>.jsonl, ctx16 = die ersten 16 Zeichen des
 * sha256 ueber alles ausser query/now (also eine Konfiguration). Zeile 1 ist
 * der Kopf (Schluessel im Klartext, Logs, Rest des Ergebnisses), danach eine
 * Zeile je Treffer. Daneben <ctx16>/context.json zum Nachlesen. Geschrieben
 * wird ueber eine Temp-Datei und rename, also nie halb.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH, RELEASE } from "./common.mjs";

export const RECALL_CACHE_FORMAT = 1;
export const DEFAULT_RECALL_CACHE_DIR = join(BENCH, "results/recall-cache");

/** Parameter, die nicht in den Schluessel gehen (Objekte bzw. eigene Felder). */
const NON_SETTING_PARAMS = new Set(["dbTable", "embeddings", "reranker", "logger", "query", "now"]);
const LOG_LEVELS = ["info", "warn", "error", "debug"];

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// ─── typgetreue Kodierung ────────────────────────────────────────────────────

/**
 * Wert -> JSON-faehige Form. Alles, was JSON.stringify still veraendern wuerde
 * (BigInt, -0, NaN/Infinity, undefined, TypedArrays), bekommt eine Markierung
 * {$t: ...}; Objekte mit eigenem "$t"-Feld werden eingepackt. Fremde Klassen
 * (Arrow-Vektoren, Date, Map ...) und Funktionen werfen, damit nichts
 * unbemerkt verfaelscht im Cache landet.
 * @param {*} value
 * @param {string} [path] Pfad fuer die Fehlermeldung
 * @returns {*} JSON-faehige Darstellung
 */
export function encodeCacheValue(value, path = "$") {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (Object.is(value, -0)) return { $t: "num", v: "-0" };
      return Number.isFinite(value) ? value : { $t: "num", v: String(value) };
    case "bigint":
      return { $t: "bigint", v: value.toString() };
    case "undefined":
      return { $t: "undef" };
    case "object":
      break;
    default:
      throw new Error(`${path}: Typ ${typeof value} laesst sich nicht cachen`);
  }
  if (Array.isArray(value)) return value.map((x, i) => encodeCacheValue(x, `${path}[${i}]`));
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return { $t: "typed", c: value.constructor.name, v: Array.from(value, (x) => (typeof x === "bigint" ? x.toString() : encodeCacheValue(x))) };
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${path}: ${proto?.constructor?.name || "Objekt"} laesst sich nicht cachen`);
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = encodeCacheValue(v, `${path}.${k}`);
  return Object.hasOwn(value, "$t") ? { $t: "obj", v: out } : out;
}

const TYPED = { Float32Array, Float64Array, Int8Array, Int16Array, Int32Array, Uint8Array, Uint16Array, Uint32Array, Uint8ClampedArray, BigInt64Array, BigUint64Array };

/**
 * Umkehrung von encodeCacheValue.
 * @param {*} value JSON-Form
 * @returns {*} urspruenglicher Wert
 */
export function decodeCacheValue(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeCacheValue);
  if (Object.hasOwn(value, "$t")) {
    switch (value.$t) {
      case "num": return value.v === "-0" ? -0 : Number(value.v);
      case "bigint": return BigInt(value.v);
      case "undef": return undefined;
      case "typed": {
        const Ctor = TYPED[value.c];
        if (!Ctor) throw new Error(`unbekannter TypedArray-Typ ${value.c}`);
        return Ctor === BigInt64Array || Ctor === BigUint64Array
          ? Ctor.from(value.v, (x) => BigInt(x))
          : Ctor.from(value.v, (x) => decodeCacheValue(x));
      }
      case "obj": return decodeObject(value.v);
      default: throw new Error(`unbekannte Markierung $t=${value.$t}`);
    }
  }
  return decodeObject(value);
}

function decodeObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = decodeCacheValue(v);
  return out;
}

function dropUndefined(value) {
  if (Array.isArray(value)) return value.map(dropUndefined);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = dropUndefined(v);
    return out;
  }
  return value;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

/**
 * Kanonisches JSON fuer den Schluessel: Objektfelder sortiert, undefined-Felder
 * weggelassen (fuer die Pipeline gleichbedeutend mit "nicht gesetzt").
 * @param {*} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(encodeCacheValue(dropUndefined(value))));
}

// ─── Schluesselbestandteile ──────────────────────────────────────────────────

const pluginInfoMemo = new Map();

/** sha256 ueber alle Dateien unter root (relativer Pfad + Inhalt), sortiert. */
function hashTree(root) {
  const h = createHash("sha256");
  let files = 0;
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules") continue;
      const abs = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, relPath);
      else if (st.isFile()) {
        h.update(relPath).update("\0").update(readFileSync(abs)).update("\0");
        files++;
      }
    }
  };
  walk(root, "");
  return { sha256: h.digest("hex"), files };
}

/**
 * Plugin-Teil des Schluessels, je Release einmal je Prozess berechnet.
 * @param {string} release Pfad des Plugin-Checkouts (PLUR1BUS_RELEASE)
 * @returns {{version: string, release: string, libSha256: string, libFiles: number, lancedb: string|null}}
 */
export function pluginCacheInfo(release = RELEASE) {
  if (!pluginInfoMemo.has(release)) {
    const real = realpathSync(release);
    const version = JSON.parse(readFileSync(join(real, "package.json"), "utf8")).version;
    const lib = hashTree(join(real, "lib"));
    let lancedbVersion = null;
    const lancedbPkg = join(real, "node_modules/@lancedb/lancedb/package.json");
    if (existsSync(lancedbPkg)) lancedbVersion = JSON.parse(readFileSync(lancedbPkg, "utf8")).version;
    pluginInfoMemo.set(release, { version, release: real, libSha256: lib.sha256, libFiles: lib.files, lancedb: lancedbVersion });
  }
  return pluginInfoMemo.get(release);
}

const storeMemo = new Map();

/**
 * Fingerabdruck des Stores: Tabellenversion und neuestes Manifest. Je
 * Verzeichnis einmal je Prozess (die Stores des Messstands aendern sich
 * waehrend eines Laufs nicht; der Recall schreibt nichts).
 * @param {string} storeDir Verzeichnis, das lancedb.connect bekommt
 * @param {object} table geoeffnete LanceDB-Tabelle
 * @returns {Promise<object>}
 */
export function storeFingerprint(storeDir, table) {
  const dir = realpathSync(storeDir);
  const name = table?.name || "memories";
  const memoKey = `${dir}\0${name}`;
  if (!storeMemo.has(memoKey)) {
    storeMemo.set(memoKey, (async () => {
      const version = await table.version();
      const vdir = join(dir, `${name}.lance`, "_versions");
      const manifests = readdirSync(vdir).filter((f) => f.endsWith(".manifest")).map((f) => {
        const st = statSync(join(vdir, f));
        return { name: f, size: st.size, mtimeMs: st.mtimeMs };
      });
      if (!manifests.length) throw new Error(`${vdir}: kein Manifest`);
      manifests.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1));
      return { dir, table: name, version, manifests: manifests.length, newestManifest: manifests[0] };
    })());
  }
  return storeMemo.get(memoKey);
}

const describe = (obj, fields) => {
  if (!obj) return null;
  const out = { class: obj.constructor?.name || null };
  for (const f of fields) out[f] = obj[f] ?? null;
  return out;
};

// ─── Cache ───────────────────────────────────────────────────────────────────

/**
 * Datei-Cache fuer runRecallPipeline. Ein Objekt je Skriptlauf; summary()
 * gehoert in die Meta-Datei des Laufs.
 */
export class RecallCache {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.enabled=true] false = weder lesen noch schreiben
   * @param {boolean} [opts.requireHit=false] Fehlgriff = Fehler, nie ein API-Aufruf
   * @param {string} [opts.dir] Ablage (Vorgabe results/recall-cache)
   * @param {string} [opts.release] Plugin-Checkout (Vorgabe PLUR1BUS_RELEASE)
   * @param {string} [opts.script] Name des Skripts (nur Kopfzeile)
   * @param {object} [opts.extra] zusaetzliche Schluesselfelder
   * @param {string} [opts.embedTextMode="raw"] Bereinigungsmodus vor dem Embedding
   */
  constructor({ enabled = true, requireHit = false, dir = DEFAULT_RECALL_CACHE_DIR, release = RELEASE, script = "", extra = {}, embedTextMode = "raw" } = {}) {
    this.enabled = enabled;
    this.requireHit = requireHit;
    this.dir = dir;
    this.release = release;
    this.script = script;
    this.extra = extra;
    this.embedTextMode = embedTextMode;
    this.counts = { hit: 0, miss: 0, written: 0, off: 0, corrupt: 0, skippedRerankFallback: 0, skippedNoNow: 0, skippedUncacheable: 0 };
    this.apiCalls = { embed: 0, rerank: 0 };
    this.contexts = new Set();
  }

  /**
   * Zaehlt die echten Anbieter-Aufrufe (embedBatch bzw. embedQuery/embed,
   * rerank) direkt an den Instanzen; die Schnittstelle bleibt gleich. Die
   * Zahlen stehen in summary().apiCalls — Beleg, dass ein Treffer nichts
   * aufruft.
   * @param {object} embeddings
   * @param {object|null} reranker
   * @returns {void}
   */
  instrument(embeddings, reranker) {
    const wrap = (obj, method, counter) => {
      const orig = obj[method];
      if (typeof orig !== "function" || orig.__recallCacheCounted) return;
      const counted = (...args) => { this.apiCalls[counter]++; return orig.apply(obj, args); };
      counted.__recallCacheCounted = true;
      obj[method] = counted;
    };
    if (embeddings) {
      if (typeof embeddings.embedBatch === "function") wrap(embeddings, "embedBatch", "embed");
      else { wrap(embeddings, "embedQuery", "embed"); wrap(embeddings, "embed", "embed"); }
    }
    if (reranker) wrap(reranker, "rerank", "rerank");
  }

  /**
   * Schluessel fuer einen Aufruf.
   * @param {string} storeDir
   * @param {object} params Parameter fuer runRecallPipeline
   * @returns {Promise<{ctx: object, ctxHash: string, keyJson: string, keyHash: string}>}
   */
  async key(storeDir, params) {
    const settings = {};
    for (const [k, v] of Object.entries(params)) if (!NON_SETTING_PARAMS.has(k)) settings[k] = v;
    const ctx = {
      format: RECALL_CACHE_FORMAT,
      store: await storeFingerprint(storeDir, params.dbTable),
      plugin: pluginCacheInfo(this.release),
      settings,
      reranker: describe(params.reranker, ["id", "model", "timeoutMs", "maxDocChars"]),
      embeddings: describe(params.embeddings, ["id", "model", "dim", "baseUrl"]),
      embedTextMode: this.embedTextMode,
      extra: this.extra,
    };
    const ctxHash = sha256(canonicalJson(ctx));
    const keyJson = canonicalJson({ ...ctx, query: params.query, now: params.now });
    return { ctx, ctxHash, keyJson, keyHash: sha256(keyJson) };
  }

  _paths(ctxHash, keyHash) {
    const ctxDir = join(this.dir, ctxHash.slice(0, 16));
    return { ctxDir, file: join(ctxDir, `${keyHash}.jsonl`), contextFile: join(ctxDir, "context.json") };
  }

  _read(file, keyJson, keyHash) {
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.length);
    const head = JSON.parse(lines[0]);
    if (head.format !== RECALL_CACHE_FORMAT) throw new Error(`Format ${head.format} statt ${RECALL_CACHE_FORMAT}`);
    if (head.keyHash !== keyHash || head.keyJson !== keyJson) throw new Error("Schluessel im Kopf passt nicht");
    const memories = lines.slice(1).map((l) => decodeCacheValue(JSON.parse(l)));
    if (memories.length !== head.nMemories) throw new Error(`${memories.length} Treffer statt ${head.nMemories}`);
    return { result: { ...decodeCacheValue(head.rest), memories }, logs: head.logs };
  }

  _write(paths, ctx, keyJson, keyHash, params, result, logs) {
    mkdirSync(paths.ctxDir, { recursive: true });
    const tmpName = (p) => `${p}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    if (!existsSync(paths.contextFile)) {
      const tmp = tmpName(paths.contextFile);
      writeFileSync(tmp, `${JSON.stringify(sortKeys(encodeCacheValue(dropUndefined(ctx))), null, 1)}\n`);
      renameSync(tmp, paths.contextFile);
    }
    const { memories = [], ...rest } = result || {};
    const head = {
      format: RECALL_CACHE_FORMAT, keyHash, keyJson, script: this.script, writtenAt: new Date().toISOString(),
      query: params.query, now: params.now, nMemories: memories.length, logs, rest: encodeCacheValue(rest, "$.rest"),
    };
    const body = [JSON.stringify(head), ...memories.map((m, i) => JSON.stringify(encodeCacheValue(m, `$.memories[${i}]`)))].join("\n");
    const tmp = tmpName(paths.file);
    writeFileSync(tmp, `${body}\n`);
    renameSync(tmp, paths.file);
  }

  /**
   * Recall mit Cache. Bei einem Treffer wird runRecallPipeline nicht
   * aufgerufen; die gespeicherten Logger-Aufrufe gehen an params.logger.
   * @param {object} args
   * @param {Function} args.runRecallPipeline die Pipeline-Funktion des Releases
   * @param {string} args.storeDir Verzeichnis des Stores (fuer den Fingerabdruck)
   * @param {object} args.params Parameter wie fuer runRecallPipeline
   * @returns {Promise<{result: object, cache: {status: string, key: string|null, ctx: string|null}}>}
   */
  async run({ runRecallPipeline, storeDir, params }) {
    if (!this.enabled) {
      this.counts.off++;
      return { result: await runRecallPipeline(params), cache: { status: "off", key: null, ctx: null } };
    }
    if (params.now == null) {
      this.counts.skippedNoNow++;
      if (this.requireHit) throw new Error("recall-cache: Aufruf ohne now ist nicht cachebar (--recall-cache-only)");
      console.warn("recall-cache: Aufruf ohne now wird nicht gecacht");
      return { result: await runRecallPipeline(params), cache: { status: "skipped-no-now", key: null, ctx: null } };
    }
    let k;
    try {
      k = await this.key(storeDir, params);
    } catch (error) {
      this.counts.skippedUncacheable++;
      if (this.requireHit) throw new Error(`recall-cache: kein Schluessel (${error?.message || error}) und --recall-cache-only`);
      console.warn(`recall-cache: kein Schluessel, Recall ungecacht: ${error?.message || error}`);
      return { result: await runRecallPipeline(params), cache: { status: "skipped-uncacheable", key: null, ctx: null } };
    }
    const paths = this._paths(k.ctxHash, k.keyHash);
    this.contexts.add(k.ctxHash.slice(0, 16));
    const meta = { key: k.keyHash, ctx: k.ctxHash.slice(0, 16) };
    if (existsSync(paths.file)) {
      try {
        const { result, logs } = this._read(paths.file, k.keyJson, k.keyHash);
        for (const [level, args] of logs) params.logger?.[level]?.(...args);
        this.counts.hit++;
        return { result, cache: { status: "hit", ...meta } };
      } catch (error) {
        this.counts.corrupt++;
        console.warn(`recall-cache: ${paths.file} unbrauchbar (${error?.message || error}), wird neu berechnet`);
      }
    }
    if (this.requireHit) throw new Error(`recall-cache: kein Eintrag ${meta.ctx}/${meta.key} (--recall-cache-only verbietet API-Aufrufe)`);
    // Fehlgriff: Pipeline mit mitschreibendem Logger.
    const logs = [];
    let rerankFallback = false;
    const orig = params.logger;
    const logger = {};
    for (const level of LOG_LEVELS) {
      logger[level] = (...args) => {
        const text = args.map((a) => (typeof a === "string" ? a : String(a)));
        logs.push([level, text]);
        if ((level === "warn" || level === "error") && text.some((t) => /rerank/i.test(t))) rerankFallback = true;
        return orig?.[level]?.(...args);
      };
    }
    const result = await runRecallPipeline({ ...params, logger });
    this.counts.miss++;
    if (rerankFallback) {
      this.counts.skippedRerankFallback++;
      return { result, cache: { status: "miss-rerank-fallback-not-stored", ...meta } };
    }
    try {
      this._write(paths, k.ctx, k.keyJson, k.keyHash, params, result, logs);
      this.counts.written++;
    } catch (error) {
      this.counts.skippedUncacheable++;
      console.warn(`recall-cache: Ergebnis nicht gespeichert: ${error?.message || error}`);
      return { result, cache: { status: "miss-not-stored", ...meta } };
    }
    return { result, cache: { status: "miss", ...meta } };
  }

  /**
   * Zusammenfassung fuer Meta-Dateien und Log.
   * @returns {object}
   */
  summary() {
    return {
      enabled: this.enabled,
      requireHit: this.requireHit,
      dir: this.dir,
      contexts: [...this.contexts],
      ...this.counts,
      apiCalls: { ...this.apiCalls },
    };
  }
}

/**
 * RecallCache aus den Schaltern eines Skripts:
 *   --no-recall-cache        Cache weder lesen noch schreiben
 *   --recall-cache-dir PFAD  andere Ablage (Tests, Wegwerf-Caches)
 *   --recall-cache-only      nur Treffer; ein Fehlgriff bricht ab, statt
 *                            Embedding/Cohere aufzurufen
 * @param {string[]} [argv]
 * @param {object} [opts] weitere Optionen fuer RecallCache (script, extra)
 * @returns {RecallCache}
 */
export function recallCacheFromArgv(argv = process.argv, opts = {}) {
  const i = argv.indexOf("--recall-cache-dir");
  const dir = i > -1 ? argv[i + 1] : undefined;
  if (i > -1 && (!dir || dir.startsWith("--"))) throw new Error("--recall-cache-dir PFAD");
  const enabled = !argv.includes("--no-recall-cache");
  const requireHit = argv.includes("--recall-cache-only");
  if (!enabled && requireHit) throw new Error("--no-recall-cache und --recall-cache-only schliessen sich aus");
  return new RecallCache({ ...opts, enabled, requireHit, ...(dir ? { dir } : {}) });
}

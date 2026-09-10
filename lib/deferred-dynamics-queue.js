/**
 * lib/deferred-dynamics-queue.js (7.12.30)
 *
 * Verschiebt Memory-Dynamik-Updates (LanceDB getById + update je Erinnerung)
 * aus dem Prompt-Hook in eine serielle Warteschlange je Agent.
 *
 * Hintergrund: Der Host fuehrt die before_prompt_build-Handler eines Plugins
 * nacheinander aus, jeder mit eigenem Timeout (15 s). Das Reply-Outcome-
 * Tracking lief als erster Handler und wartete auf bis zu zwoelf sequenzielle
 * LanceDB-Updates (je ~1,2 s auf fragmentierten Tabellen). Der Recall-Handler
 * startete erst nach dessen Timeout — der Agent bekam die Antwort 15 s spaeter
 * (09./10.09.2026, jeder DM-Turn mit positivem/negativem Feedback).
 *
 * Die Klassifikation und die Log-Dateien bleiben im Hook (billig, synchron);
 * nur der DB-Teil landet hier. Gestartet wird die Kette, wenn der Recall des
 * Turns fertig ist (kick), spaetestens nach fallbackDelayMs.
 */
import { safeWarn } from "./safe-logging.js";

const DEFAULT_MAX_BACKLOG = 20;
const DEFAULT_FALLBACK_DELAY_MS = 10_000;
const DEFAULT_SLOW_LOG_MS = 2_000;

/**
 * @param {{logger?: object|null, maxBacklog?: number, fallbackDelayMs?: number, slowLogMs?: number, now?: () => number, setTimer?: Function, clearTimer?: Function}} [options]
 */
export function createDeferredDynamicsQueue(options = {}) {
  const logger = options.logger || null;
  const maxBacklog = Math.max(1, Number(options.maxBacklog) || DEFAULT_MAX_BACKLOG);
  const fallbackDelayMs = Math.max(0, Number(options.fallbackDelayMs ?? DEFAULT_FALLBACK_DELAY_MS));
  const slowLogMs = Math.max(0, Number(options.slowLogMs ?? DEFAULT_SLOW_LOG_MS));
  const now = typeof options.now === "function" ? options.now : Date.now;
  const setTimer = typeof options.setTimer === "function" ? options.setTimer : (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };
  const clearTimer = typeof options.clearTimer === "function" ? options.clearTimer : clearTimeout;
  /** @type {Map<string, {jobs: Array<{run: Function, meta: object, enqueuedAt: number}>, running: Promise<void>|null, timer: any, dropped: number}>} */
  const lanes = new Map();
  let closed = false;

  function lane(agentId) {
    const key = String(agentId || "default");
    let entry = lanes.get(key);
    if (!entry) {
      entry = { jobs: [], running: null, timer: null, dropped: 0 };
      lanes.set(key, entry);
    }
    return entry;
  }

  async function runLane(key, entry) {
    while (entry.jobs.length > 0) {
      const job = entry.jobs.shift();
      const startedAt = now();
      try {
        await job.run();
        const ms = now() - startedAt;
        const line = `reply-outcome: dynamics applied entries=${job.meta?.entries ?? "?"} waitMs=${startedAt - job.enqueuedAt} ms=${ms} agent=${key}`;
        if (ms >= slowLogMs) logger?.info?.(line); else logger?.debug?.(line);
      } catch (error) {
        safeWarn(logger, "reply-outcome.dynamics", error, { agentId: key, entries: job.meta?.entries ?? 0 });
      }
    }
  }

  function start(key, entry) {
    if (entry.timer) { clearTimer(entry.timer); entry.timer = null; }
    if (entry.running || entry.jobs.length === 0) return entry.running || Promise.resolve();
    entry.running = runLane(key, entry).finally(() => { entry.running = null; });
    return entry.running;
  }

  return {
    /**
     * Stellt einen Dynamik-Lauf ein. Laeuft an, sobald kick() kommt oder die
     * Rueckfallfrist ablaeuft. Bei vollem Rueckstau faellt der aelteste
     * wartende Lauf weg (Dynamik ist eine Verstaerkung, kein Fakt).
     * @param {string} agentId
     * @param {() => Promise<void>} run
     * @param {{entries?: number}} [meta]
     * @returns {boolean} false, wenn die Queue geschlossen ist
     */
    enqueue(agentId, run, meta = {}) {
      if (closed || typeof run !== "function") return false;
      const key = String(agentId || "default");
      const entry = lane(key);
      entry.jobs.push({ run, meta, enqueuedAt: now() });
      while (entry.jobs.length > maxBacklog) {
        entry.jobs.shift();
        entry.dropped++;
        logger?.warn?.(`reply-outcome: dynamics backlog full for agent=${key}, dropped oldest run (dropped=${entry.dropped})`);
      }
      if (!entry.running && !entry.timer && fallbackDelayMs > 0) {
        entry.timer = setTimer(() => { entry.timer = null; start(key, entry); }, fallbackDelayMs);
      } else if (!entry.running && fallbackDelayMs === 0) {
        start(key, entry);
      }
      return true;
    },
    /** Startet die wartenden Laeufe eines Agenten (nach dem Recall des Turns). */
    kick(agentId) {
      const key = String(agentId || "default");
      const entry = lanes.get(key);
      if (!entry) return Promise.resolve();
      return start(key, entry);
    },
    /** Wartet auf alles, was fuer den Agenten laeuft oder wartet (Tests, Shutdown). */
    async drain(agentId) {
      const keys = agentId ? [String(agentId)] : [...lanes.keys()];
      for (const key of keys) {
        const entry = lanes.get(key);
        if (!entry) continue;
        await start(key, entry);
        while (entry.running) await entry.running;
      }
    },
    pending(agentId) {
      const entry = lanes.get(String(agentId || "default"));
      return entry ? entry.jobs.length + (entry.running ? 1 : 0) : 0;
    },
    stats() {
      const out = {};
      for (const [key, entry] of lanes) out[key] = { waiting: entry.jobs.length, running: Boolean(entry.running), dropped: entry.dropped };
      return out;
    },
    close() {
      closed = true;
      for (const entry of lanes.values()) {
        if (entry.timer) { clearTimer(entry.timer); entry.timer = null; }
      }
    },
  };
}

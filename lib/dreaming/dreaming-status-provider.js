// Meldet OpenClaws Gedaechtnisseite, wie PLUR1BUS tatsaechlich traeumt.
//
// Der Host kennt fuer den Schlafplan nur EIN Cron-Feld fuer alle drei Phasen
// und liest Zaehler aus memory-cores eigenem Zustand. PLUR1BUS faehrt REM und
// Tiefschlaf aber als eigene Feature-Crons je Agent, versetzt, und den
// Leichtschlaf nach einem Gespraech. Dieser Provider bedient die optionale
// Naht `dreaming` an der Memory-Capability (openclaw/openclaw#155860). Ein Host
// ohne diese Naht ignoriert das Feld; nichts aendert sich dann.
//
// Quelle sind die tatsaechlich eingetragenen Jobs aus dem Cron-Dienst des
// Gateways, nicht der Plan: wer einen Job von Hand verschiebt, soll auf der
// Seite genau das sehen, was laeuft.

const LIST_TIMEOUT_MS = 5_000;

// Feature-Cron -> Phase auf der Gedaechtnisseite.
const PHASE_BY_FEATURE = Object.freeze({
  "rem-dream": "rem",
  "consolidate-daily": "deep",
});

function argValue(argv, flag) {
  if (!Array.isArray(argv)) return undefined;
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

// Aeltere Jobs tragen das Feature noch als Chat-Kommando in der Nachricht.
function featureOf(job) {
  const payload = job?.payload ?? {};
  const fromArgv = argValue(payload.argv, "--feature");
  if (fromArgv) return fromArgv;
  const message = typeof payload.message === "string" ? payload.message : payload.text;
  const match = typeof message === "string" ? /^\/plur1bus internal ([a-z-]+)/.exec(message.trim()) : null;
  return match?.[1];
}

function agentOf(job) {
  return job?.agentId ?? argValue(job?.payload?.argv, "--agent");
}

function phaseStatus(job) {
  const state = job?.state ?? {};
  return {
    enabled: true,
    cron: job.schedule.expr,
    scheduled: true,
    ...(Number.isFinite(state.nextRunAtMs) ? { nextRunAtMs: state.nextRunAtMs } : {}),
    ...(Number.isFinite(state.lastRunAtMs) ? { lastRunAtMs: state.lastRunAtMs } : {}),
  };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`cron list timed out after ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Baut den dreaming-Provider fuer `registerMemoryCapability`.
 *
 * @param {object} deps
 * @param {() => object} deps.getPluginConfig Aktuelle PLUR1BUS-Konfiguration.
 * @param {() => ({list: Function}|null|undefined)} deps.getCron Cron-Dienst des Gateways, sobald bekannt.
 * @param {object} [deps.logger]
 * @returns {{getStatus: (params: {cfg: object, agentId: string}) => Promise<object|null>}}
 */
export function createDreamingStatusProvider({ getPluginConfig, getCron, logger = null } = {}) {
  return {
    async getStatus({ agentId } = {}) {
      // null heisst: der Host behaelt seine eigene Aufloesung. Jeder Fehler
      // endet dort, damit die Seite nie schlechter wird als ohne Provider.
      if (typeof agentId !== "string" || !agentId) return null;
      let cron;
      try {
        cron = getCron?.();
      } catch (error) {
        logger?.debug?.(`dreaming-status: cron service lookup failed: ${error?.message || error}`);
        return null;
      }
      if (!cron || typeof cron.list !== "function") return null;

      let jobs;
      try {
        jobs = await withTimeout(Promise.resolve(cron.list({ includeDisabled: false })), LIST_TIMEOUT_MS);
      } catch (error) {
        logger?.debug?.(`dreaming-status: cron list failed: ${error?.message || error}`);
        return null;
      }
      if (!Array.isArray(jobs)) return null;

      const phases = {};
      let timezone;
      for (const job of jobs) {
        if (job?.enabled === false || agentOf(job) !== agentId) continue;
        const phase = PHASE_BY_FEATURE[featureOf(job)];
        if (!phase || phases[phase] || job?.schedule?.kind !== "cron" || typeof job.schedule.expr !== "string") continue;
        phases[phase] = phaseStatus(job);
        timezone ??= typeof job.schedule.tz === "string" ? job.schedule.tz : undefined;
      }

      const pluginCfg = getPluginConfig?.() ?? {};
      // Dieselbe Bedingung, unter der index.js lightDream im Nachgang eines
      // Gespraechs anstoesst. Kein Zeitplan: leerer cron, sonst erbte die
      // Phase den Host-Ausdruck, dem sie gar nicht folgt.
      // Beide gelten als an, solange sie nicht ausdruecklich abgeschaltet sind.
      if (pluginCfg.merging?.enabled !== false && pluginCfg.neo?.enabled !== false) {
        phases.light = { enabled: true, scheduled: true, cron: "" };
      }

      if (!phases.rem && !phases.deep) return null;
      return {
        enabled: true,
        ...(timezone ? { timezone } : {}),
        phases,
      };
    },
  };
}

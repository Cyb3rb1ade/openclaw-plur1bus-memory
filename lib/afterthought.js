/**
 * lib/afterthought.js — Nachgedanken: seltene, verzögerte Follow-ups.
 *
 * Trigger: das letzte Gespräch endete vor 30–120 Minuten mit einem offenen
 * Outcome. Harte Grenzen zusätzlich zum Governor: max. 1/Tag, nie zu einem
 * Thema, das heute schon als offener Faden injiziert wurde.
 *
 * Der interne Job liefert nur JSON ({text} oder {skipped}); die Zustellung
 * übernimmt ein Cron-Agent (siehe README-Abschnitt aus Step 5).
 */

import { join } from "node:path";
import { readReplyOutcomeLog } from "./reply-outcome-tracking.js";
import {
  loadGovernorState, saveGovernorState, applyOutcomeAdjustments, evaluateGovernor, recordProactiveSend,
  acquireGovernorLock, releaseGovernorLock,
} from "./proactive-governor.js";
import { normalizeTopic, OPEN_THREADS_SHOWN_FILE } from "./open-threads.js";
import { hourInTimeZone, isQuietHour } from "./time-window.js";
import { readJsonSafe, writeJsonAtomic } from "./atomic-file.js";

const OPEN_OUTCOMES = new Set(["asked_details", "ignored_or_topic_shifted"]);
const STATE_FILE = ".afterthought-state.json";
const MAX_TEXT_CHARS = 600;

export function findAfterthoughtCandidate(outcomes, { now = Date.now(), minAgeMin = 30, maxAgeMin = 120 } = {}) {
  try {
    if (!Array.isArray(outcomes) || outcomes.length === 0) return null;
    const valid = outcomes.filter((o) => Number.isFinite(o?.timestamp));
    if (valid.length === 0) return null;
    const newest = valid.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b));
    const ageMin = (now - newest.timestamp) / 60000;
    if (ageMin < minAgeMin || ageMin > maxAgeMin) return null;
    if (!OPEN_OUTCOMES.has(newest.outcome)) return null;
    const userPrompt = typeof newest.userPrompt === "string" ? newest.userPrompt : "";
    if (!userPrompt.trim()) return null;
    return {
      topic: userPrompt.replace(/[\r\n]+/g, " ").trim().slice(0, 120),
      userPrompt,
      timestamp: newest.timestamp,
    };
  } catch (_) {
    return null;
  }
}

export async function composeAfterthought(candidate, { llmCfg = null, callLlm = null } = {}) {
  try {
    if (!candidate?.topic || !llmCfg || typeof callLlm !== "function") return null;
    const raw = await callLlm([
      {
        role: "system",
        content:
          "Du bist ein Chat-Agent, dem nach einem Gespräch noch etwas eingefallen ist. Schreibe eine kurze deutsche Follow-up-Nachricht (2-3 Sätze), die beiläufig an das Thema anknüpft — sinngemäß \"Mir ist zu … noch eingefallen: …\". Kein Gruß, keine Signatur, keine Emojis-Pflicht. Antworte NUR mit der Nachricht.",
      },
      { role: "user", content: `Letzte Nutzer-Nachricht des Gesprächs:\n${candidate.userPrompt.slice(0, 1000)}` },
    ], llmCfg);
    const text = String(raw || "").trim();
    if (!text) return null;
    return text.slice(0, MAX_TEXT_CHARS);
  } catch (_) {
    return null;
  }
}

export async function runAfterthoughtJob({ workspaceDir, agentId = "default", llmCfg = null, callLlm = null, now = Date.now(), hour = null, timeZone = null, quietHours = { start: 22, end: 8 }, logger = { info: () => {}, warn: () => {} } } = {}) {
  try {
    if (!workspaceDir) return { skipped: true, reason: "missing_workspace" };

    // Ruhezeiten, wrap-aware (22–8 überspannt Mitternacht; 8–22 nicht).
    // Explizite hour hat Vorrang (Tests/Aufrufer); sonst timezone-bewusst.
    const effectiveHour = Number.isInteger(hour) ? hour : hourInTimeZone(now, timeZone);
    if (isQuietHour(effectiveHour, quietHours)) return { skipped: true, reason: "quiet_hours" };

    const today = new Date(now).toISOString().slice(0, 10);

    const statePath = join(workspaceDir, STATE_FILE);
    const state = readJsonSafe(statePath, {});
    if (state.lastSentDate === today) return { skipped: true, reason: "daily_cap" };

    const outcomes = readReplyOutcomeLog(workspaceDir, 50);
    const candidate = findAfterthoughtCandidate(outcomes, { now });
    if (!candidate) return { skipped: true, reason: "no_candidate" };

    const shown = readJsonSafe(join(workspaceDir, OPEN_THREADS_SHOWN_FILE), {});
    if (shown.date === today && Array.isArray(shown.topics)
      && shown.topics.some((t) => normalizeTopic(t) === normalizeTopic(candidate.topic))) {
      return { skipped: true, reason: "open_thread_overlap" };
    }

    // Advisory cross-process lock: closes the lost-update window between this
    // job (possibly a separate OS process, e.g. cron) and index.js's
    // dream-echo block, both of which read-modify-write the governor state.
    // Spans the whole read-modify-write below, including the LLM await —
    // staleMs 30s covers a hung LLM call. Skip-on-contention: the proactive
    // feature simply doesn't fire this time.
    if (!acquireGovernorLock(workspaceDir, { now })) {
      return { skipped: true, reason: "governor_locked" };
    }
    try {
      let gov = loadGovernorState(workspaceDir);
      gov = applyOutcomeAdjustments(gov, outcomes, { now });
      if (!evaluateGovernor(gov, now).allowed) {
        saveGovernorState(workspaceDir, gov);
        return { skipped: true, reason: "governor_budget" };
      }

      const text = await composeAfterthought(candidate, { llmCfg, callLlm });
      if (!text) {
        // Auch dieser Pfad liegt hinter dem await: nicht die stale
        // Vor-Await-Kopie zurückschreiben (gleiche lost-update race).
        let noTextGov = loadGovernorState(workspaceDir);
        noTextGov = applyOutcomeAdjustments(noTextGov, outcomes, { now });
        saveGovernorState(workspaceDir, noTextGov);
        return { skipped: true, reason: "no_llm_text" };
      }

      // Der obige await kann Sekunden dauern; ein konkurrierender proaktiver
      // Send (z.B. dream-echo-Injektion) kann währenddessen Governor-State
      // gespeichert haben. Frisch laden statt die stale Vor-Await-Kopie zu
      // überschreiben (lost-update race).
      let freshGov = loadGovernorState(workspaceDir);
      freshGov = applyOutcomeAdjustments(freshGov, outcomes, { now });
      if (!evaluateGovernor(freshGov, now).allowed) {
        saveGovernorState(workspaceDir, freshGov);
        return { skipped: true, reason: "governor_budget" };
      }

      freshGov = recordProactiveSend(freshGov, "afterthought", now);
      saveGovernorState(workspaceDir, freshGov);
      writeJsonAtomic(statePath, { lastSentDate: today, lastTopic: candidate.topic });
      logger.info?.(`afterthought[${agentId}]: composed follow-up for "${candidate.topic.slice(0, 40)}"`);
      return { text, topic: candidate.topic };
    } finally {
      releaseGovernorLock(workspaceDir);
    }
  } catch (err) {
    logger.warn?.(`afterthought[${agentId}]: ${String(err)}`);
    return { skipped: true, reason: "error" };
  }
}

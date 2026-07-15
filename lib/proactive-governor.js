/**
 * lib/proactive-governor.js — adaptiver Frequenzregler für proaktive
 * Lebenszeichen (Traum-Echos, Nachgedanken, …).
 *
 * Budget-Modell: Start 2 Sends/Woche über alle Governor-Features gemeinsam.
 * Reply-Outcomes innerhalb von 6h nach einem proaktiven Send gelten als
 * Reaktion darauf: positiv (+0.25, Cap 4), ignoriert (−0.25, Floor 1).
 * Träge Anpassung — ein schlechter Tag kippt nichts.
 *
 * Pure Kernfunktionen + fail-open Datei-Helpers (.proactive-governor.json).
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-file.js";

const WEEK_MS = 7 * 86400000;
const ATTRIBUTION_MS = 6 * 3600000;
const STEP = 0.25;
const MIN_BUDGET = 1;
const MAX_BUDGET = 4;
const START_BUDGET = 2;
const STATE_FILE = ".proactive-governor.json";
const LOCK_FILE = ".proactive-governor.lock";

const POSITIVE = new Set(["confirmed_or_continued", "continued_topic"]);
const NEGATIVE = new Set(["ignored_or_topic_shifted"]);

export function createGovernorState(now = Date.now()) {
  return { schema: 1, budgetPerWeek: START_BUDGET, sends: [], adjustedAt: 0, createdAt: now };
}

function normalizeState(state) {
  const s = state && typeof state === "object" ? state : {};
  return {
    schema: 1,
    budgetPerWeek: Number.isFinite(s.budgetPerWeek) ? s.budgetPerWeek : START_BUDGET,
    sends: Array.isArray(s.sends) ? s.sends.filter((x) => Number.isFinite(x?.ts)) : [],
    adjustedAt: Number.isFinite(s.adjustedAt) ? s.adjustedAt : 0,
    createdAt: Number.isFinite(s.createdAt) ? s.createdAt : Date.now(),
  };
}

export function applyOutcomeAdjustments(state, outcomes, { now = Date.now() } = {}) {
  const s = normalizeState(state);
  if (!Array.isArray(outcomes) || outcomes.length === 0) return s;

  let budget = s.budgetPerWeek;
  let adjustedAt = s.adjustedAt;
  const sorted = outcomes
    .filter((o) => Number.isFinite(o?.timestamp) && o.timestamp <= now)
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const o of sorted) {
    if (o.timestamp <= adjustedAt) continue;
    adjustedAt = o.timestamp;
    const attributed = s.sends.some(
      (send) => o.timestamp > send.ts && o.timestamp - send.ts <= ATTRIBUTION_MS,
    );
    if (!attributed) continue;
    if (POSITIVE.has(o.outcome)) budget += STEP;
    else if (NEGATIVE.has(o.outcome)) budget -= STEP;
    budget = Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, budget));
  }
  return { ...s, budgetPerWeek: budget, adjustedAt };
}

export function evaluateGovernor(state, now = Date.now()) {
  const s = normalizeState(state);
  const recentSends = s.sends.filter((x) => now - x.ts >= 0 && now - x.ts < WEEK_MS);
  const cap = Math.round(s.budgetPerWeek);
  if (recentSends.length < cap) {
    return { allowed: true, budgetPerWeek: s.budgetPerWeek, reason: "within_budget" };
  }
  return { allowed: false, budgetPerWeek: s.budgetPerWeek, reason: "budget_exhausted" };
}

export function recordProactiveSend(state, featureId, now = Date.now()) {
  const s = normalizeState(state);
  const sends = [...s.sends, { featureId: String(featureId || "unknown"), ts: now }]
    .filter((x) => now - x.ts < 2 * WEEK_MS);
  return { ...s, sends };
}

export function loadGovernorState(workspaceDir) {
  try {
    const path = join(workspaceDir, STATE_FILE);
    if (!existsSync(path)) return createGovernorState();
    return normalizeState(readJsonSafe(path, createGovernorState()));
  } catch (_) {
    return createGovernorState();
  }
}

export function saveGovernorState(workspaceDir, state) {
  try {
    const path = join(workspaceDir, STATE_FILE);
    writeJsonAtomic(path, normalizeState(state), { pretty: true });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Advisory cross-process lock for the governor state file. Closes the
 * lost-update window between two OS processes (afterthought cron vs.
 * index.js's dream-echo block) that both read-modify-write
 * .proactive-governor.json without any shared in-process mutex.
 *
 * Skip-on-contention semantics: callers that fail to acquire simply skip
 * their proactive-feature turn this time — never block the user response.
 */
function lockPath(workspaceDir) {
  return join(workspaceDir, LOCK_FILE);
}

function tryCreateLock(path, now) {
  try {
    writeFileSync(path, String(now), { flag: "wx" });
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw err;
  }
}

export function acquireGovernorLock(workspaceDir, { now = Date.now(), staleMs = 30000 } = {}) {
  try {
    const path = lockPath(workspaceDir);
    if (tryCreateLock(path, now)) return true;

    // Lock file exists — check staleness, reclaim + retry ONCE.
    let ts = NaN;
    try {
      ts = Number(readFileSync(path, "utf8"));
    } catch (_) {
      ts = NaN;
    }
    const stale = !Number.isFinite(ts) || now - ts > staleMs;
    if (!stale) return false;

    try { unlinkSync(path); } catch (_) { /* best-effort */ }
    return tryCreateLock(path, now);
  } catch (_) {
    return false;
  }
}

export function releaseGovernorLock(workspaceDir) {
  try {
    unlinkSync(lockPath(workspaceDir));
  } catch (_) { /* best-effort */ }
}

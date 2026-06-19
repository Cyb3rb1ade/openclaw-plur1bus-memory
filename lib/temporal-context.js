/**
 * lib/temporal-context.js
 * Temporal continuity context for prompts.
 */

import { getLastActivity } from "./session-time.js";

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const THRESHOLD_IMMEDIATE = 5 * MS_PER_MINUTE;
const THRESHOLD_RECENT = 1 * MS_PER_HOUR;
const THRESHOLD_SAME_DAY = 12 * MS_PER_HOUR;
const THRESHOLD_OVERNIGHT = 36 * MS_PER_HOUR;
const THRESHOLD_MULTI_DAY = 7 * MS_PER_DAY;

const CONTINUITY_HINTS = {
  new_session: "This appears to be the first user-visible turn in this session.",
  immediate: "Continue naturally; the conversation is ongoing.",
  recent: "Continue naturally; only a short pause has occurred.",
  same_day: "The user may expect continuation without a full recap.",
  overnight: "Briefly re-anchor the task before proceeding.",
  multi_day: "A longer gap has passed; a brief recap may help.",
  stale: "Treat old assumptions as potentially stale; verify context before proceeding.",
};

const RULES_TEXT = [
  "- Use this as context, not as dialogue filler.",
  "- Mention the time gap only if it improves the answer.",
  "- For short gaps, continue naturally.",
  "- For long gaps, briefly re-anchor the task before proceeding.",
  "- For stale gaps, treat old assumptions as potentially stale.",
  "- Never pretend to have experienced waiting.",
  "- Never say you were thinking, watching, or remembering during the gap unless there was an actual logged process.",
].join("\n");

function formatLocalTime(value, timezone) {
  return new Date(value)
    .toLocaleString("sv-SE", { timeZone: timezone, hour12: false })
    .slice(0, 16);
}

function parsePreviousUserTurnAt(previousUserTurnAt) {
  if (previousUserTurnAt === null || previousUserTurnAt === undefined) {
    return null;
  }
  if (typeof previousUserTurnAt === "number") {
    return previousUserTurnAt;
  }
  const parsed = Date.parse(previousUserTurnAt);
  return Number.isNaN(parsed) ? null : parsed;
}

export function resolveGapBucket(elapsedMs) {
  if (elapsedMs === null || elapsedMs === undefined) return "new_session";
  const ms = Number(elapsedMs);
  if (ms < THRESHOLD_IMMEDIATE) return "immediate";
  if (ms < THRESHOLD_RECENT) return "recent";
  if (ms < THRESHOLD_SAME_DAY) return "same_day";
  if (ms < THRESHOLD_OVERNIGHT) return "overnight";
  if (ms < THRESHOLD_MULTI_DAY) return "multi_day";
  return "stale";
}

export function formatElapsedHuman(elapsedMs) {
  if (elapsedMs === null || elapsedMs === undefined) return null;

  const totalMinutes = Math.floor(elapsedMs / MS_PER_MINUTE);
  const totalHours = Math.floor(elapsedMs / MS_PER_HOUR);
  const totalDays = Math.floor(elapsedMs / MS_PER_DAY);

  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  }

  if (totalHours < 24) {
    const remainderMinutes = totalMinutes % 60;
    if (remainderMinutes === 0) {
      return `${totalHours} hour${totalHours === 1 ? "" : "s"}`;
    }
    return `${totalHours} hour${totalHours === 1 ? "" : "s"} ${remainderMinutes} minute${remainderMinutes === 1 ? "" : "s"}`;
  }

  const remainderHours = totalHours % 24;
  if (remainderHours === 0) {
    return `${totalDays} day${totalDays === 1 ? "" : "s"}`;
  }
  return `${totalDays} day${totalDays === 1 ? "" : "s"} ${remainderHours} hour${remainderHours === 1 ? "" : "s"}`;
}

export function computeTemporalContinuityContext({
  previousUserTurnAt,
  now = Date.now(),
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
}) {
  const parsedPrevious = parsePreviousUserTurnAt(previousUserTurnAt);
  const elapsedMs = parsedPrevious === null ? null : Math.max(0, now - parsedPrevious);
  const gapBucket = resolveGapBucket(elapsedMs);

  return {
    now: formatLocalTime(now, timezone),
    timezone,
    previousUserTurnAt: parsedPrevious === null ? null : formatLocalTime(parsedPrevious, timezone),
    elapsedSincePreviousUserTurnMs: elapsedMs,
    elapsedHuman: formatElapsedHuman(elapsedMs),
    gapBucket,
    continuityHint: CONTINUITY_HINTS[gapBucket],
  };
}

export function renderTemporalContext(context, { lang = "en" } = {}) {
  const lines = [
    "<temporal-context>",
    `Current local time: ${context.now} (${context.timezone})`,
  ];

  if (context.gapBucket === "new_session") {
    lines.push("Previous user-visible turn: none");
  } else {
    lines.push(`Previous user-visible turn: ${context.previousUserTurnAt}`);
    lines.push(`Elapsed since previous user-visible turn: ${context.elapsedHuman}`);
  }

  lines.push(`Gap bucket: ${context.gapBucket}`);
  lines.push(`Continuity hint: ${context.continuityHint}`);

  lines.push("");
  lines.push("Rules:");
  lines.push(RULES_TEXT);

  lines.push("</temporal-context>");
  return lines.join("\n");
}

export async function formatTemporalContinuityContext(
  agentId,
  workspaceKey,
  workspaceDir,
  options = {}
) {
  const { enabled = false, lang = "en" } = options;
  if (!enabled) return "";

  let previousUserTurnAt = options.previousUserTurnAt;
  if (previousUserTurnAt === undefined || previousUserTurnAt === null) {
    previousUserTurnAt = await getLastActivity(agentId, workspaceKey, workspaceDir);
  }

  const context = computeTemporalContinuityContext({
    previousUserTurnAt,
    now: options.now,
    timezone: options.timezone,
  });

  return renderTemporalContext(context, { lang });
}

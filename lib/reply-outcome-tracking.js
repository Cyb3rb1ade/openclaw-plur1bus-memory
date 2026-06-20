/**
 * lib/reply-outcome-tracking.js — automatic reply-based outcome signals.
 *
 * Purpose: infer whether the user's next reply confirms, continues, corrects,
 * rejects, or ignores memories that were injected into the previous answer.
 * Facts remain append-only; this only emits outcome signals for feedback-log and
 * memory-dynamics reinforcement/weakening.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readJsonl } from "./jsonl-utils.js";
import { recordFeedback } from "./feedback-log.js";

export const REPLY_OUTCOME_PENDING_FILE = "reply-outcome-pending.json";
export const REPLY_OUTCOME_LOG_FILE = "reply-outcomes.jsonl";

const POSITIVE_RE = /\b(ja|yes|genau|richtig|stimmt|passt|perfekt|super|great|good|danke|thanks|weiter|mach weiter|go on|continue|implementiere|umsetzen|merge|ship)\b/i;
const CORRECTION_RE = /\b(nein|no|falsch|wrong|incorrect|stimmt nicht|nicht korrekt|eigentlich|actually|korrig|correction|sondern|rather|not that|nicht das)\b/i;
const REJECTION_RE = /(darum ging es nicht|nicht darum|not what i meant|irrelevant|hast du nicht verstanden|you misunderstood|ignore that|vergiss das)/i;
const DETAIL_RE = /(\?|warum|wieso|wie genau|details?|genauer|mehr dazu|was fehlt|explain|why|how exactly|tell me more)/i;
const STOP_RE = /\b(ok|okay|alles klar|noted|got it|verstanden)\b[.!\s]*$/i;

function adaptiveDir(workspaceDir) {
  const dir = join(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function pendingPath(workspaceDir) {
  return join(adaptiveDir(workspaceDir), REPLY_OUTCOME_PENDING_FILE);
}

function logPath(workspaceDir) {
  return join(adaptiveDir(workspaceDir), REPLY_OUTCOME_LOG_FILE);
}

function atomicJson(path, value) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, path);
}

function appendJsonl(path, entry) {
  const existing = readJsonl(path);
  const idx = existing.findIndex((e) => e.id === entry.id);
  if (idx >= 0) existing[idx] = entry;
  else existing.push(entry);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, existing.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  renameSync(tmp, path);
}

export function textFromMessage(msg = {}) {
  const c = msg?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        if (typeof block.text === "string") return block.text;
        if (typeof block.content === "string") return block.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function lastMessageText(messages = [], roles = []) {
  const wanted = new Set(roles);
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!wanted.has(msg?.role)) continue;
    const text = textFromMessage(msg).trim();
    if (text) return text;
  }
  return "";
}

export function sessionKeyFrom(event = {}, ctx = {}) {
  return String(
    ctx.sessionKey || ctx.sessionId || event.sessionKey || event.sessionId || event.runId || "default"
  );
}

export function normalizeMemoryIds(memoryIds = [], limit = 12) {
  const out = [];
  const seen = new Set();
  for (const raw of memoryIds || []) {
    const id = String(raw || "").trim();
    if (!id || id.startsWith("canonical:")) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

export function classifyReplyOutcome(replyText = "", previousPrompt = "", assistantText = "") {
  const reply = String(replyText || "").trim();
  if (!reply) return { outcome: "no_reply", feedback: "neutral", confidence: 0, reasons: ["empty_reply"] };

  const reasons = [];
  let outcome = "neutral";
  let feedback = "neutral";
  let confidence = 0.35;

  if (REJECTION_RE.test(reply)) {
    outcome = "rejected";
    feedback = "negative";
    confidence = 0.9;
    reasons.push("explicit_rejection");
  } else if (CORRECTION_RE.test(reply)) {
    outcome = "corrected";
    feedback = "negative";
    confidence = 0.82;
    reasons.push("correction_language");
  } else if (DETAIL_RE.test(reply)) {
    outcome = "asked_details";
    feedback = "positive";
    confidence = 0.68;
    reasons.push("followup_detail_request");
  } else if (POSITIVE_RE.test(reply)) {
    outcome = "confirmed_or_continued";
    feedback = "positive";
    confidence = 0.72;
    reasons.push("positive_or_continuation_language");
  } else if (STOP_RE.test(reply)) {
    outcome = "acknowledged";
    feedback = "neutral";
    confidence = 0.45;
    reasons.push("ack_only");
  }

  const overlap = lexicalOverlap(previousPrompt, reply);
  if (overlap >= 0.22 && feedback === "neutral") {
    outcome = "continued_topic";
    feedback = "positive";
    confidence = Math.max(confidence, 0.58);
    reasons.push("topic_continuation");
  } else if (overlap < 0.05 && previousPrompt && reply.length > 80 && !/[?]/.test(reply)) {
    if (outcome === "neutral") {
      outcome = "ignored_or_topic_shifted";
      feedback = "neutral";
      confidence = 0.5;
      reasons.push("low_topic_overlap");
    }
  }

  if (assistantText && assistantText.length > 20 && /\b(das|this|that|it)\b/i.test(reply) && feedback === "neutral") {
    outcome = "continued_topic";
    feedback = "positive";
    confidence = Math.max(confidence, 0.52);
    reasons.push("deictic_followup_after_assistant_reply");
  }

  return { outcome, feedback, confidence, reasons };
}

export function lexicalOverlap(a = "", b = "") {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let hits = 0;
  for (const t of A) if (B.has(t)) hits++;
  return hits / Math.min(A.size, B.size);
}

function tokenSet(text) {
  const stop = new Set(["der", "die", "das", "und", "oder", "ich", "du", "wir", "the", "and", "or", "you", "me", "it", "to", "a", "of", "in", "for", "is", "ist"]);
  return new Set(
    String(text || "")
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !stop.has(t))
  );
}

function readPending(workspaceDir) {
  const p = pendingPath(workspaceDir);
  if (!existsSync(p)) return { schema: 1, pending: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return { schema: 1, pending: Array.isArray(parsed?.pending) ? parsed.pending : [] };
  } catch (_) {
    return { schema: 1, pending: [] };
  }
}

function writePending(workspaceDir, pending) {
  atomicJson(pendingPath(workspaceDir), { schema: 1, pending: pending.slice(-100) });
}

export function recordPendingReplyOutcome(workspaceDir, params = {}) {
  if (!workspaceDir) return null;
  const memoryIds = normalizeMemoryIds(params.memoryIds, params.maxMemoryIds ?? 12);
  if (memoryIds.length === 0) return null;
  const sessionKey = params.sessionKey || "default";
  const agentId = params.agentId || "default";
  const userPrompt = String(params.userPrompt || "").trim();
  if (!userPrompt) return null;

  const state = readPending(workspaceDir);
  const key = `${agentId}:${sessionKey}`;
  const now = params.now ?? Date.now();
  const promptHash = createHash("sha256").update(userPrompt).digest("hex").slice(0, 16);
  const entry = {
    id: params.id || `${key}:${promptHash}:${now}`,
    key,
    agentId,
    sessionKey,
    workspaceKey: params.workspaceKey || null,
    userPrompt,
    promptHash,
    memoryIds,
    createdAt: now,
    assistantText: params.assistantText || "",
    source: "auto-recall",
  };
  const pending = state.pending.filter((e) => e.key !== key);
  pending.push(entry);
  writePending(workspaceDir, pending);
  return entry;
}

export function recordAgentReplyForOutcome(workspaceDir, params = {}) {
  if (!workspaceDir) return null;
  const state = readPending(workspaceDir);
  const key = `${params.agentId || "default"}:${params.sessionKey || "default"}`;
  const assistantText = String(params.assistantText || "").trim();
  if (!assistantText) return null;
  const pending = state.pending.map((e) => {
    if (e.key !== key) return e;
    return { ...e, assistantText: assistantText.slice(0, params.maxAssistantChars ?? 4000), assistantAt: params.now ?? Date.now() };
  });
  writePending(workspaceDir, pending);
  return pending.find((e) => e.key === key) || null;
}

export async function completePendingReplyOutcomes(workspaceDir, params = {}) {
  if (!workspaceDir) return [];
  const state = readPending(workspaceDir);
  const agentId = params.agentId || "default";
  const sessionKey = params.sessionKey || "default";
  const key = `${agentId}:${sessionKey}`;
  const replyText = String(params.replyText || "").trim();
  if (!replyText) return [];

  const now = params.now ?? Date.now();
  const maxAgeMs = params.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const matched = [];
  const keep = [];

  for (const pending of state.pending) {
    if (pending.key !== key) {
      keep.push(pending);
      continue;
    }
    if (now - Number(pending.createdAt || 0) > maxAgeMs) {
      continue;
    }
    if (pending.promptHash && pending.promptHash === createHash("sha256").update(replyText).digest("hex").slice(0, 16)) {
      keep.push(pending);
      continue;
    }
    matched.push(pending);
  }

  if (matched.length === 0) return [];
  writePending(workspaceDir, keep);

  const completed = [];
  for (const pending of matched) {
    const classification = classifyReplyOutcome(replyText, pending.userPrompt, pending.assistantText || "");
    const entry = {
      id: `${pending.id}:reply:${now}`,
      schema: 1,
      timestamp: now,
      agentId,
      sessionKey,
      workspaceKey: pending.workspaceKey || params.workspaceKey || null,
      source: "reply-based-outcome-tracking",
      userPrompt: pending.userPrompt,
      replyText: replyText.slice(0, params.maxReplyChars ?? 4000),
      assistantText: (pending.assistantText || "").slice(0, params.maxAssistantChars ?? 4000),
      memoryIds: pending.memoryIds || [],
      ...classification,
    };
    appendJsonl(logPath(workspaceDir), entry);

    for (const memoryId of pending.memoryIds || []) {
      const dynamics = params.applyDynamics === true
        ? { applyDynamics: true, dbPool: params.dbPool, agentId }
        : {};
      const maybePromise = recordFeedback(
        workspaceDir,
        pending.userPrompt,
        memoryId,
        classification.feedback,
        {
          source: "reply-outcome",
          outcome: classification.outcome,
          confidence: classification.confidence,
          reasons: classification.reasons,
        },
        dynamics,
      );
      if (maybePromise && typeof maybePromise.then === "function") await maybePromise;
    }
    completed.push(entry);
  }
  return completed;
}

export function readReplyOutcomeLog(workspaceDir, limit = 0) {
  const entries = readJsonl(logPath(workspaceDir));
  const newest = entries.slice().reverse();
  return limit > 0 ? newest.slice(0, limit) : newest;
}

/**
 * lib/i18n.js — Global i18n + SOUL.MD tone for PLUR1BUS.
 *
 * Every user-facing string in PLUR1BUS rendered in the user's language
 * and the agent's tone. Security, setup, error, and approval texts remain
 * deterministic and precise.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dictionary } from "./i18n-dictionary.js";

// ─── Logger (best-effort, swallows if absent) ──────────────────────────────

function warn(logger, msg) {
  if (logger?.warn) logger.warn(msg);
  else if (typeof console !== "undefined" && console.warn) console.warn(msg);
}

// ─── Locale Resolution ─────────────────────────────────────────────────────

/**
 * Resolve language from config > ctx > messages > fallback.
 *
 * @param {object} options
 * @param {string} [options.config]   — explicit config language (e.g. "de")
 * @param {object} [options.ctx]      — context object with .lang
 * @param {Array}  [options.messages] — OpenClaw message array
 * @param {string} [options.fallback="en"]
 * @returns {string} language code
 */
export function resolveLocale({ config, ctx, messages, fallback = "en" } = {}) {
  if (config && typeof config === "string") return config;
  if (ctx?.lang && typeof ctx.lang === "string") return ctx.lang;
  if (messages && Array.isArray(messages) && messages.length > 0) {
    const detected = detectLanguage(messages);
    if (detected) return detected;
  }
  return fallback;
}

// ─── Language Detection ────────────────────────────────────────────────────

const GERMAN_WORDS = new Set([
  "der", "die", "das", "und", "ist", "zu", "den", "mit", "ich", "auf",
  "für", "sich", "dem", "nicht", "ein", "eine", "als", "auch", "es", "an",
  "werden", "aus", "er", "hat", "dass", "sie", "nach", "wird", "bei",
  "einer", "der", "um", "am", "sind", "noch", "wie", "einen", "so",
  "zur", "aber", "über", "dich", "dein", "deine", "dir", "mir", "mich",
  "mein", "meine", "wir", "uns", "unser", "euch", "euer", "ihr", "ihnen",
  "ja", "nein", "bitte", "danke", "gern", "hallo", "hi", "hej", "moin",
]);

export function detectLanguage(messages = []) {
  const userTexts = messages
    .filter(m => m.role === "user" && typeof m.content === "string")
    .map(m => m.content)
    .slice(-3);
  if (userTexts.length === 0) return "en";
  const sample = userTexts.join(" ").toLowerCase();
  const germanHits = GERMAN_WORDS.size === 0
    ? 0
    : sample.split(/\s+/).filter(w => GERMAN_WORDS.has(w)).length;
  return germanHits >= 2 ? "de" : "en";
}

// ─── SOUL.MD Tone Reading ──────────────────────────────────────────────────

const SOUL_CANDIDATES = [
  "SOUL.MD", "SOUL.md", "soul.md",
  "IDENTITY.MD", "IDENTITY.md", "identity.md",
];

export function readSoulTone(workspaceDir) {
  if (!workspaceDir) return null;
  for (const name of SOUL_CANDIDATES) {
    const path = join(workspaceDir, name);
    if (existsSync(path)) {
      try {
        const text = readFileSync(path, "utf8");
        const toneMatch = text.match(/(?:Tone|Voice|Duktus|Stil|Personality| persona)[:\s]*([^\n]+)/i);
        if (toneMatch) return toneMatch[1].trim();
        const firstLine = text.split("\n").find(l => l.trim() && !l.startsWith("#") && !l.startsWith("<!--"));
        if (firstLine) return firstLine.trim();
      } catch (_) { /* ignore read errors */ }
    }
  }
  return null;
}

const _soulToneCache = new Map(); // workspaceDir → { tone, ts }
const _soulToneCacheMax = 100;

export function readSoulToneCached(workspaceDir, opts = {}) {
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = Date.now();
  const cached = _soulToneCache.get(workspaceDir);
  if (cached && now - cached.ts < ttlMs) return cached.tone;
  const tone = readSoulTone(workspaceDir);
  if (_soulToneCache.size >= _soulToneCacheMax) {
    const firstKey = _soulToneCache.keys().next().value;
    _soulToneCache.delete(firstKey);
  }
  _soulToneCache.set(workspaceDir, { tone, ts: now });
  return tone;
}

export function pickTone(toneHint) {
  if (!toneHint) return "default";
  const t = toneHint.toLowerCase();
  if (t.includes("casual") || t.includes("friendly") || t.includes("warm") || t.includes("relaxed") || t.includes("locker")) return "casual";
  if (t.includes("formal") || t.includes("professional") || t.includes("strict") || t.includes("business") || t.includes("förmlich")) return "formal";
  return "default";
}

// ─── Escaping ──────────────────────────────────────────────────────────────

function escapeTelegramMarkdown(value) {
  const s = String(value ?? "");
  // Escape characters that have special meaning in Telegram MarkdownV2
  return s.replace(/([_\*\[\]\(\)~`>#+\-=|{}\.!])/g, "\\$1");
}

function escapeHtml(value) {
  const s = String(value ?? "");
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeVar(value, format) {
  if (format === "telegramMarkdown") return escapeTelegramMarkdown(value);
  if (format === "html") return escapeHtml(value);
  return String(value ?? "");
}

// ─── Translation ───────────────────────────────────────────────────────────

/**
 * Translate a key with fallback chain and safe interpolation.
 *
 * Fallback chain:
 *   1. dictionary[key]?.[lang]?.[tone]
 *   2. dictionary[key]?.[lang]?.default
 *   3. dictionary[key]?.en?.default
 *   4. key + warning log
 *
 * @param {string} key   — dot-separated dictionary key
 * @param {object} opts
 * @param {string} opts.lang   — "de" | "en" | ...
 * @param {string} opts.tone   — "casual" | "formal" | "default"
 * @param {object} [opts.vars={}]   — interpolation variables { name: "..." }
 * @param {string} [opts.format="plain"] — "plain" | "telegramMarkdown" | "html"
 * @param {object} [opts.logger] — optional logger for missing-key warnings
 * @returns {string}
 */
export function t(key, opts = {}) {
  const { lang = "en", tone = "default", vars = {}, format = "plain", logger } = opts;

  const entry = dictionary[key];
  if (!entry) {
    warn(logger, `i18n missing key: ${key}`);
    return key;
  }

  let text;
  if (entry[lang]?.[tone]) {
    text = entry[lang][tone];
  } else if (entry[lang]?.default) {
    text = entry[lang].default;
  } else if (entry.en?.default) {
    text = entry.en.default;
  } else {
    warn(logger, `i18n missing fallback for key: ${key}`);
    return key;
  }

  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => escapeVar(vars[k], format));
}

/**
 * lib/jobs/proactive-check.js — Hintergrund-Job für proaktive Nudges.
 *
 * Läuft täglich, liest Turn-Journal, erkennt Patterns und speichert Nudges.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectPatterns } from "../pattern-detector.js";
import { generateProactiveNudge, shouldShowNudge } from "../proactive-nudge.js";

const NUDGE_FILE = "proactive-nudges.json";
const COOLDOWN_FILE = "proactive-nudge-cooldowns.json";
const PATTERNS_FILE = "patterns.jsonl";
const DEFAULT_MAX_PATTERN_LOG_ENTRIES = 5000;
const DEFAULT_MAX_COOLDOWN_ENTRIES = 5000;

function normalizeMaxEntries(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(path, data) {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  // Atomic publish: rename never leaves `path` half-written if the process dies
  // mid-write (the previous read-tmp-then-write-path was non-atomic).
  renameSync(tmp, path);
}

function writeTextAtomic(path, data) {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}

function appendJsonl(path, lines, options = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return;
  const maxEntries = normalizeMaxEntries(options.maxEntries, DEFAULT_MAX_PATTERN_LOG_ENTRIES);
  const serialized = lines.map((l) => JSON.stringify(l));
  const existing = existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean)
    : [];
  const bounded = existing.concat(serialized).slice(-maxEntries);
  writeTextAtomic(path, `${bounded.join("\n")}\n`);
}

function cooldownTime(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pruneCooldowns(cooldowns, maxEntries) {
  const limit = normalizeMaxEntries(maxEntries, DEFAULT_MAX_COOLDOWN_ENTRIES);
  return Object.fromEntries(
    Object.entries(cooldowns || {})
      .sort(([, left], [, right]) => cooldownTime(right) - cooldownTime(left))
      .slice(0, limit),
  );
}

function utcDateString(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function countSameUtcDayNudges(entries, now) {
  const targetDay = utcDateString(now);
  if (!targetDay || !Array.isArray(entries)) return 0;
  let count = 0;
  for (const entry of entries) {
    if (utcDateString(entry?.generatedAt) === targetDay) {
      count++;
    }
  }
  return count;
}

/**
 * Führt den täglichen proaktiven Check aus.
 *
 * @param {Object} store — Neo-Arch Store mit readTurns()
 * @param {string} agentId
 * @param {Object} opts
 * @param {string} opts.workspaceDir
 * @param {string} opts.workspaceKey
 * @param {number} [opts.now=Date.now()]
 * @param {Object} [opts.logger]
 * @param {(text:string) => Promise<number[]>|number[]} [opts.embedFn] — Text → Embedding
 * @param {number} [opts.threshold=0.6] — Nudge-Score-Threshold
 * @param {number} [opts.maxPatternLogEntries=5000] — Max retained pattern JSONL rows
 * @param {number} [opts.maxCooldownEntries=5000] — Max retained cooldown keys
 * @returns {Promise<{ok:boolean, nudgesGenerated:number, patternsFound:number}>}
 */
export async function runProactiveCheck(store, agentId, opts = {}) {
  const {
    workspaceDir,
    workspaceKey,
    now = Date.now(),
    logger = { info: () => {}, warn: () => {} },
    embedFn = null,
    threshold = 0.6,
    maxPatternLogEntries = DEFAULT_MAX_PATTERN_LOG_ENTRIES,
    maxCooldownEntries = DEFAULT_MAX_COOLDOWN_ENTRIES,
  } = opts;

  if (!workspaceDir || !workspaceKey) {
    return { ok: false, nudgesGenerated: 0, patternsFound: 0, reason: "missing_workspace" };
  }

  const adaptiveDir = join(workspaceDir, ".adaptive-learning");
  mkdirSync(adaptiveDir, { recursive: true });

  const turns = store?.readTurns ? store.readTurns(500) : [];
  if (!Array.isArray(turns) || turns.length === 0) {
    return { ok: true, nudgesGenerated: 0, patternsFound: 0, reason: "no_turns" };
  }

  const detectOpts = { now };
  if (embedFn) {
    detectOpts.embedFn = embedFn;
    detectOpts.embeddingThreshold = 0.82;
  }
  const patterns = await detectPatterns(turns, detectOpts);
  if (patterns.length === 0) {
    return { ok: true, nudgesGenerated: 0, patternsFound: 0, reason: "no_patterns" };
  }

  // Persistiere Cluster als JSONL
  const patternsPath = join(adaptiveDir, PATTERNS_FILE);
  appendJsonl(
    patternsPath,
    patterns.map((p) => ({
      clusterId: p.clusterId || `pattern-${p.keyword?.slice(0, 20).replace(/\s+/g, "-")}-${now}`,
      turnIds: p.turnIds || [],
      representative: p.keyword,
      score: p.score,
      occurrences: p.occurrences,
      createdAt: new Date(now).toISOString(),
    })),
    { maxEntries: maxPatternLogEntries },
  );

  const cooldownPath = join(adaptiveDir, COOLDOWN_FILE);
  const cooldowns = readJson(cooldownPath, {});
  const nudgePath = join(adaptiveDir, NUDGE_FILE);
  const existing = readJson(nudgePath, { nudges: [] });

  const nudges = [];
  let generated = 0;
  let shownToday = countSameUtcDayNudges(existing?.nudges, now);

  for (const pattern of patterns) {
    const cooldownKey = pattern.clusterId || pattern.keyword;
    const lastShown = cooldowns[cooldownKey] || null;
    if (!shouldShowNudge(pattern, lastShown, now, { shownToday })) continue;

    const nudge = generateProactiveNudge({ now }, [pattern], { threshold });
    if (!nudge) continue;

    nudges.push({
      id: `nudge-${agentId}-${cooldownKey}-${now}`,
      agentId,
      workspaceKey,
      keyword: pattern.keyword,
      text: nudge.text,
      score: nudge.score,
      generatedAt: new Date(now).toISOString(),
    });

    cooldowns[cooldownKey] = now;
    generated++;
    shownToday++;
  }

  if (generated > 0 || Object.keys(cooldowns).length > 0) {
    existing.nudges = (existing.nudges || []).concat(nudges).slice(-100); // bounded
    const boundedCooldowns = pruneCooldowns(cooldowns, maxCooldownEntries);
    writeJsonAtomic(nudgePath, existing);
    writeJsonAtomic(cooldownPath, boundedCooldowns);
  }

  logger.info?.(`proactive-check[${agentId}]: ${generated} nudge(s) generated from ${patterns.length} pattern(s)`);

  return {
    ok: true,
    nudgesGenerated: generated,
    patternsFound: patterns.length,
  };
}

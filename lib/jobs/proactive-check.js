/**
 * lib/jobs/proactive-check.js — Hintergrund-Job für proaktive Nudges.
 *
 * Läuft täglich, liest Turn-Journal, erkennt Patterns und speichert Nudges.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectPatterns } from "../pattern-detector.js";
import { generateProactiveNudge, shouldShowNudge } from "../proactive-nudge.js";

const NUDGE_FILE = "proactive-nudges.json";
const COOLDOWN_FILE = "proactive-nudge-cooldowns.json";
const PATTERNS_FILE = "patterns.jsonl";

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
  writeFileSync(path, readFileSync(tmp, "utf8"), "utf8");
  try { unlinkSync(tmp); } catch (_) { /* tmp may already be cleaned up */ }
}

function appendJsonl(path, lines) {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  const data = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(path, data, { flag: "a" });
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
  );

  const cooldownPath = join(adaptiveDir, COOLDOWN_FILE);
  const cooldowns = readJson(cooldownPath, {});

  const nudges = [];
  let generated = 0;

  for (const pattern of patterns) {
    const cooldownKey = pattern.clusterId || pattern.keyword;
    const lastShown = cooldowns[cooldownKey] || null;
    if (!shouldShowNudge(pattern, lastShown, now)) continue;

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
  }

  if (generated > 0 || Object.keys(cooldowns).length > 0) {
    const nudgePath = join(adaptiveDir, NUDGE_FILE);
    const existing = readJson(nudgePath, { nudges: [] });
    existing.nudges = (existing.nudges || []).concat(nudges).slice(-100); // bounded
    writeJsonAtomic(nudgePath, existing);
    writeJsonAtomic(cooldownPath, cooldowns);
  }

  logger.info?.(`proactive-check[${agentId}]: ${generated} nudge(s) generated from ${patterns.length} pattern(s)`);

  return {
    ok: true,
    nudgesGenerated: generated,
    patternsFound: patterns.length,
  };
}

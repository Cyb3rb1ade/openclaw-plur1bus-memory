/**
 * MoodTracker — sliding-window mood aggregator using Russell's Circumplex Model.
 *
 * Maintains a rolling buffer of recent EmotionScores, computes aggregate mood,
 * detects trends, and persists history to a JSONL file.
 */

import { EmotionScore } from "./emotion-score.js";
import fs from "node:fs";
import path from "node:path";

export class MoodTracker {
  /**
   * @param {Object} [options]
   * @param {number} [options.windowSize=50]      — max number of recent scores to keep
   * @param {string} [options.storagePath="data/mood_log.jsonl"] — JSONL persistence path
   */
  constructor({ windowSize = 50, storagePath = "data/mood_log.jsonl" } = {}) {
    this.windowSize = windowSize;
    this.storagePath = storagePath;
    /** @type {EmotionScore[]} */
    this._window = [];
    this._loadHistory();
  }

  /**
   * Add a new EmotionScore to the sliding window and persist it.
   * @param {EmotionScore} score
   */
  add(score) {
    if (!(score instanceof EmotionScore)) {
      throw new TypeError("MoodTracker.add() expects an EmotionScore instance");
    }
    this._window.push(score);
    if (this._window.length > this.windowSize) {
      this._window.shift();
    }
    this._persist(score);
  }

  /**
   * Current aggregate mood: average VAD, mood label, and top emotions.
   * @returns {{valence:number, arousal:number, dominance:number, intensity:number, label:string, topEmotions:string[]}|null}
   */
  get currentMood() {
    if (this._window.length === 0) return null;

    const n = this._window.length;
    const avg = (key) => this._window.reduce((s, e) => s + e[key], 0) / n;

    const v = avg("valence");
    const a = avg("arousal");
    const d = avg("dominance");
    const i = avg("intensity");

    return {
      valence: v,
      arousal: a,
      dominance: d,
      intensity: i,
      label: this._moodLabel(v, a),
      topEmotions: this._topEmotions(3),
    };
  }

  /**
   * Trend direction based on recent valence trajectory and volatility.
   * @returns {"improving" | "declining" | "stable" | "volatile" | "insufficient_data"}
   */
  get moodTrend() {
    const len = this._window.length;
    if (len < 3) return "insufficient_data";

    const vals = this._window.map((e) => e.valence);
    const first = vals.slice(0, Math.ceil(len / 2));
    const second = vals.slice(Math.floor(len / 2));

    const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const meanFirst = avg(first);
    const meanSecond = avg(second);

    const std = (arr) => {
      const m = avg(arr);
      return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
    };
    const volatility = std(vals);

    if (volatility > 0.5) return "volatile";
    if (meanSecond - meanFirst > 0.15) return "improving";
    if (meanSecond - meanFirst < -0.15) return "declining";
    return "stable";
  }

  /**
   * Map average valence/arousal to a mood label using Russell's Circumplex Model.
   * @param {number} v — valence
   * @param {number} a — arousal
   * @returns {string}
   */
  _moodLabel(v, a) {
    const absV = Math.abs(v);
    const absA = Math.abs(a);

    if (absV < 0.2 && absA < 0.2) return "neutral";
    if (v > 0.2 && a > 0.2) return "excited";
    if (v > 0.2 && a < -0.2) return "relaxed";
    if (v < -0.2 && a > 0.2) return "distressed";
    if (v < -0.2 && a < -0.2) return "depressed";
    if (v > 0.2 && absA <= 0.2) return "content";
    if (v < -0.2 && absA <= 0.2) return "sad";
    if (absV <= 0.2 && a > 0.2) return "aroused";
    if (absV <= 0.2 && a < -0.2) return "lethargic";
    return "mixed";
  }

  /**
   * Most common primary emotions in the current window.
   * @param {number} [n=3]
   * @returns {string[]}
   */
  _topEmotions(n = 3) {
    const counts = new Map();
    for (const e of this._window) {
      const key = e.primary_emotion;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([emotion]) => emotion);
  }

  /**
   * Append a single score to the JSONL log.
   * @param {EmotionScore} score
   */
  _persist(score) {
    const line = JSON.stringify(score.toDict()) + "\n";
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(this.storagePath, line, "utf8");
  }

  /**
   * Load historical scores from JSONL into the sliding window (up to windowSize).
   */
  _loadHistory() {
    if (!fs.existsSync(this.storagePath)) return;
    const raw = fs.readFileSync(this.storagePath, "utf8");
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const recent = lines.slice(-this.windowSize);
    for (const line of recent) {
      try {
        const data = JSON.parse(line);
        this._window.push(new EmotionScore(data));
      } catch {
        // skip malformed lines
      }
    }
  }
}

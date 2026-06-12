import { randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolveInside } from "./sql-safety.js";
import { safeWarn } from "./safe-logging.js";

const MEANING = "meaning";

/**
 * Detects contradictions between meaning overlays for the same memory.
 *
 * Uses an injected LLM to decide whether two interpretations are mutually
 * incompatible, persists discovered contradictions to a JSONL file, and can
 * load prior contradictions for a given set of memory ids.
 */
export class ContradictionDetector {
  /**
   * @param {object} options
   * @param {(messages: Array<{role:string,content:string}>) => Promise<string>} options.llm
   *   Async LLM caller. Should return a string starting with "yes" when the
   *   two interpretations contradict each other.
   * @param {string|null} [options.workspaceDir=null] Directory where
   *   `contradictions.jsonl` may be written and read. If null, persistence is
   *   disabled.
   * @param {object} [options.logger=console] Logger compatible with
   *   `logger.warn(message, extra)`. Defaults to `console`.
   */
  constructor({ llm, workspaceDir = null, logger = console } = {}) {
    this.llm = llm;
    this.logger = logger;
    this.workspaceDir = workspaceDir || null;
    try {
      this.filePath = this.workspaceDir ? resolveInside(this.workspaceDir, "contradictions.jsonl") : null;
    } catch (err) {
      safeWarn(this.logger, "ContradictionDetector:constructor", err, { workspaceDir });
      this.filePath = null;
    }
    this._writeQueue = Promise.resolve();
  }

  /**
   * Find contradictions among an array of interpretation overlays.
   *
   * Only overlays whose `shiftType` is `"meaning"` and whose
   * `shiftDescription` is truthy are considered. Pairwise checks are limited
   * to overlays sharing the same `targetMemoryId`.
   *
   * @param {Array<object>} overlays Interpretation overlays to inspect.
   * @returns {Promise<Array<object>>} Detected contradiction records.
   */
  async findContradictions(overlays) {
    if (!this.llm || !Array.isArray(overlays) || overlays.length < 2) return [];

    const meaningOverlays = overlays.filter((o) => o && o.shiftType === MEANING && o.shiftDescription);
    const contradictions = [];

    for (let i = 0; i < meaningOverlays.length; i++) {
      for (let j = i + 1; j < meaningOverlays.length; j++) {
        const a = meaningOverlays[i];
        const b = meaningOverlays[j];
        if (a.targetMemoryId !== b.targetMemoryId) continue;
        const conflict = await this._askLLM(a, b);
        if (conflict) {
          contradictions.push({
            id: randomUUID(),
            targetMemoryId: a.targetMemoryId,
            overlayA: a.id,
            overlayB: b.id,
            descriptionA: a.shiftDescription,
            descriptionB: b.shiftDescription,
            detectedAt: new Date().toISOString(),
          });
        }
      }
    }

    return contradictions;
  }

  /**
   * Find contradictions and append each record to the JSONL store.
   *
   * Appends are serialized through an internal queue so concurrent calls do
   * not interleave lines.
   *
   * @param {Array<object>} overlays Interpretation overlays to inspect.
   * @returns {Promise<Array<object>>} Detected contradiction records.
   */
  async findAndPersistContradictions(overlays) {
    const contradictions = await this.findContradictions(overlays);
    for (const c of contradictions) {
      await this._append(c);
    }
    return contradictions;
  }

  /**
   * Load persisted contradiction records for the given memory ids.
   *
   * @param {Array<string>} memoryIds Memory ids to filter by.
   * @returns {Promise<Array<object>>} Matching contradiction records.
   */
  async loadFor(memoryIds) {
    if (!this.filePath || !existsSync(this.filePath) || !Array.isArray(memoryIds)) return [];
    const idSet = new Set(memoryIds);
    const content = await readFile(this.filePath, "utf8");
    const results = [];
    for (const line of content.split("\n").filter(Boolean)) {
      try {
        const rec = JSON.parse(line);
        if (rec.recordType === "contradiction" && idSet.has(rec.targetMemoryId)) {
          results.push(rec);
        }
      } catch (err) {
        safeWarn(this.logger, "ContradictionDetector:loadFor", err, { lineIndex: results.length });
      }
    }
    return results;
  }

  async _askLLM(a, b) {
    const prompt = [
      {
        role: "system",
        content: `You decide whether two interpretations of the same memory contradict each other. Reply with exactly one word: "yes" if they are mutually incompatible, otherwise "no".`,
      },
      {
        role: "user",
        content: `Interpretation 1: "${a.shiftDescription}"
Interpretation 2: "${b.shiftDescription}"
Do these contradict each other?`,
      },
    ];
    try {
      const response = await this.llm(prompt);
      return typeof response === "string" && response.trim().toLowerCase().startsWith("yes");
    } catch (err) {
      safeWarn(this.logger, "ContradictionDetector:_askLLM", err, {
        overlayA: a.id,
        overlayB: b.id,
        targetMemoryId: a.targetMemoryId,
      });
      return false;
    }
  }

  _append(record) {
    if (!this.filePath) return Promise.resolve();
    const line = JSON.stringify({ ...record, recordType: "contradiction" }) + "\n";
    this._writeQueue = this._writeQueue
      .then(() => appendFile(this.filePath, line))
      .catch((err) => {
        safeWarn(this.logger, "ContradictionDetector:_append", err, { recordId: record.id });
      });
    return this._writeQueue;
  }

}

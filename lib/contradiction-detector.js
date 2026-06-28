import { randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolveInside } from "./sql-safety.js";
import { safeWarn } from "./safe-logging.js";

const MEANING = "meaning";
const DEFAULT_MAX_CONTRADICTION_PAIRS = 20;

function normalizeMaxPairs(value, fallback = DEFAULT_MAX_CONTRADICTION_PAIRS) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

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
   * @param {(messages: Array<{role:string,content:string}>) => Promise<string>} [options.llm]
   *   Async LLM caller. Should return a string starting with "yes" when the
   *   two interpretations contradict each other.
   * @param {string|null} [options.workspaceDir=null] Directory where
   *   `contradictions.jsonl` may be written and read. If null, persistence is
   *   disabled.
   * @param {object} [options.logger=console] Logger compatible with
   *   `logger.warn(message, extra)`. Defaults to `console`.
   * @param {number} [options.maxPairs=20] Maximum LLM pair checks per scan.
   */
  constructor({ llm, workspaceDir = null, logger = console, maxPairs = DEFAULT_MAX_CONTRADICTION_PAIRS } = {}) {
    this.llm = llm;
    this.logger = logger;
    this.workspaceDir = workspaceDir || null;
    this.maxPairs = normalizeMaxPairs(maxPairs);
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
   * @param {{maxPairs?: number}} [opts]
   * @returns {Promise<Array<object>>} Detected contradiction records.
   */
  async findContradictions(overlays, opts = {}) {
    if (!this.llm || !Array.isArray(overlays) || overlays.length < 2) return [];

    const meaningOverlays = overlays.filter((o) => o && o.shiftType === MEANING && o.shiftDescription);
    const contradictions = [];
    const maxPairs = normalizeMaxPairs(opts.maxPairs, this.maxPairs);
    let pairsChecked = 0;

    for (let i = 0; i < meaningOverlays.length; i++) {
      for (let j = i + 1; j < meaningOverlays.length; j++) {
        if (pairsChecked >= maxPairs) return contradictions;
        const a = meaningOverlays[i];
        const b = meaningOverlays[j];
        if (a.targetMemoryId !== b.targetMemoryId) continue;
        pairsChecked++;
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
   * @param {{maxPairs?: number}} [opts]
   * @returns {Promise<Array<object>>} Detected contradiction records.
   */
  async findAndPersistContradictions(overlays, opts = {}) {
    const contradictions = await this.findContradictions(overlays, opts);
    for (const c of contradictions) {
      await this._append(c);
    }
    return contradictions;
  }

  /**
   * Decide whether a single pair of meaning overlays contradict each other.
   *
   * Validates that both overlays are meaning shifts for the same memory and
   * that each has a truthy description, then asks the injected LLM.
   *
   * @param {object} a First meaning overlay.
   * @param {object} b Second meaning overlay.
   * @returns {Promise<boolean>} True when the pair is mutually incompatible.
   */
  async detectContradiction(a, b) {
    if (!a || !b) return false;
    if (a.shiftType !== MEANING || b.shiftType !== MEANING) return false;
    if (!a.shiftDescription || !b.shiftDescription) return false;
    if (a.targetMemoryId !== b.targetMemoryId) return false;
    return this._askLLM(a, b);
  }

  /**
   * Find contradictions between a new overlay and a list of existing overlays.
   *
   * Only meaning overlays sharing the same `targetMemoryId` as `newOverlay`
   * are considered.
   *
   * @param {object} newOverlay The overlay to check.
   * @param {Array<object>} existingOverlays Existing overlays to compare against.
   * @param {{maxPairs?: number}} [opts]
   * @returns {Promise<Array<object>>} Detected contradiction records.
   */
  async findContradictionsForNewOverlay(newOverlay, existingOverlays, opts = {}) {
    if (!newOverlay || newOverlay.shiftType !== MEANING || !newOverlay.shiftDescription) return [];
    if (!Array.isArray(existingOverlays) || existingOverlays.length === 0) return [];

    const contradictions = [];
    const maxPairs = normalizeMaxPairs(opts.maxPairs, this.maxPairs);
    let pairsChecked = 0;
    for (const other of existingOverlays) {
      if (pairsChecked >= maxPairs) return contradictions;
      if (!other || other.shiftType !== MEANING || !other.shiftDescription) continue;
      if (other.targetMemoryId !== newOverlay.targetMemoryId) continue;
      pairsChecked++;
      const conflict = await this.detectContradiction(newOverlay, other);
      if (conflict) {
        contradictions.push({
          id: randomUUID(),
          targetMemoryId: newOverlay.targetMemoryId,
          overlayA: newOverlay.id,
          overlayB: other.id,
          descriptionA: newOverlay.shiftDescription,
          descriptionB: other.shiftDescription,
          detectedAt: new Date().toISOString(),
        });
      }
    }
    return contradictions;
  }

  /**
   * Persist a single contradiction record to the JSONL store.
   *
   * The supplied record is augmented with `id`, `recordType`, and
   * `detectedAt` before being appended.
   *
   * @param {object} record
   * @param {string} record.targetMemoryId
   * @param {string} record.overlayA
   * @param {string} record.overlayB
   * @returns {Promise<void>}
   */
  async persistContradiction(record) {
    if (!this.filePath || !record) return;
    if (!record.targetMemoryId || !record.overlayA || !record.overlayB) {
      safeWarn(this.logger, "ContradictionDetector.persistContradiction", new Error("missing required fields"), { record });
      return;
    }
    await this._append({
      id: randomUUID(),
      recordType: "contradiction",
      targetMemoryId: record.targetMemoryId,
      overlayA: record.overlayA,
      overlayB: record.overlayB,
      descriptionA: record.descriptionA,
      descriptionB: record.descriptionB,
      detectedAt: new Date().toISOString(),
    });
  }

  /**
   * Load persisted contradiction records for the given memory ids.
   *
   * @param {Array<string>} memoryIds Memory ids to filter by.
   * @returns {Promise<Array<object>>} Matching contradiction records.
   */
  async loadFor(memoryIds) {
    if (!Array.isArray(memoryIds)) return [];
    const idSet = new Set(memoryIds);
    return this._loadRecords((rec) => idSet.has(rec.targetMemoryId));
  }

  /**
   * Load every persisted contradiction record in the workspace.
   *
   * @returns {Promise<Array<object>>} All contradiction records.
   */
  async loadAll() {
    return this._loadRecords(() => true);
  }

  /**
   * Shared JSONL read/parse/filter loop used by `loadFor` and `loadAll`.
   *
   * @param {(record: object) => boolean} predicate Additional filter applied
   *   after the `recordType === "contradiction"` guard.
   * @returns {Promise<Array<object>>} Matching contradiction records.
   * @private
   */
  async _loadRecords(predicate) {
    if (!this.filePath || !existsSync(this.filePath)) return [];
    const content = await readFile(this.filePath, "utf8");
    const results = [];
    const lines = content.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.recordType === "contradiction" && predicate(rec)) {
          results.push(rec);
        }
      } catch (err) {
        safeWarn(this.logger, "ContradictionDetector:_loadRecords", err, { lineIndex });
      }
    }
    return results;
  }

  /**
   * Mark `contradiction: true` on each overlay whose id appears in a persisted
   * contradiction record **and** whose contradiction partner is also present in
   * the supplied overlay list. Mutates the input array in place.
   *
   * @param {Array<object>} overlays
   * @param {Set<string>|Array<string>} [activeIds] Optional set or array of ids
   *   representing all active overlays for the relevant memories. When omitted,
   *   the ids of the supplied `overlays` are used, which only flags overlays
   *   when both contradiction partners are present in the input array.
   * @returns {Promise<void>}
   */
  async flagContradictoryOverlays(overlays, activeIds) {
    if (!Array.isArray(overlays) || overlays.length === 0) return;
    if (!this.filePath) return;

    const targetMemoryIds = new Set();
    const byId = new Map();
    for (const ov of overlays) {
      if (!ov?.id || !ov?.targetMemoryId) continue;
      targetMemoryIds.add(ov.targetMemoryId);
      byId.set(ov.id, ov);
    }

    const activeIdSet = activeIds instanceof Set
      ? activeIds
      : new Set((Array.isArray(activeIds) ? activeIds : overlays.map((o) => o?.id).filter(Boolean)));

    const contradictions = await this.loadFor(Array.from(targetMemoryIds));
    const flaggedIds = new Set();
    for (const rec of contradictions) {
      const aActive = rec.overlayA && activeIdSet.has(rec.overlayA);
      const bActive = rec.overlayB && activeIdSet.has(rec.overlayB);
      if (aActive && bActive) {
        if (rec.overlayA) flaggedIds.add(rec.overlayA);
        if (rec.overlayB) flaggedIds.add(rec.overlayB);
      }
    }

    for (const id of flaggedIds) {
      const ov = byId.get(id);
      if (ov) ov.contradiction = true;
    }
  }

  /**
   * Decide whether two factual memory texts contradict each other.
   *
   * @param {object} a Memory record with `.text` or `.summary`.
   * @param {object} b Memory record with `.text` or `.summary`.
   * @returns {Promise<boolean>}
   */
  async detectMemoryTextContradiction(a, b) {
    if (!a || !b) return false;
    if (!a.id || !b.id || typeof a.id !== "string" || typeof b.id !== "string") return false;
    if (a.id === b.id) return false;
    const textA = (a.summary || a.text || "").trim();
    const textB = (b.summary || b.text || "").trim();
    if (!textA || !textB) return false;
    return this._askLLM(
      { id: a.id, shiftDescription: textA, targetMemoryId: a.id },
      { id: b.id, shiftDescription: textB, targetMemoryId: b.id },
    );
  }

  /**
   * Find contradictions among a list of recalled memory records.
   *
   * Only the first `maxPairs` pairs (in input order) are checked to bound
   * LLM cost. Returns records shaped for memory-text contradictions.
   *
   * @param {Array<object>} memories
   * @param {{maxPairs?: number}} [opts]
   * @returns {Promise<Array<object>>}
   */
  async findMemoryTextContradictions(memories, opts = {}) {
    if (!this.llm || !Array.isArray(memories) || memories.length < 2) return [];
    const maxPairs = Number.isFinite(opts?.maxPairs) && opts?.maxPairs >= 0 ? opts?.maxPairs : 20;
    const contradictions = [];
    let pairsChecked = 0;
    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        if (pairsChecked >= maxPairs) return contradictions;
        const a = memories[i];
        const b = memories[j];
        if (!a?.id || !b?.id || typeof a.id !== "string" || typeof b.id !== "string") continue;
        pairsChecked++;
        const conflict = await this.detectMemoryTextContradiction(a, b);
        if (conflict) {
          contradictions.push({
            id: randomUUID(),
            memoryA: a.id,
            memoryB: b.id,
            descriptionA: a.summary || a.text || "",
            descriptionB: b.summary || b.text || "",
            detectedAt: new Date().toISOString(),
            recordType: "memory-text-contradiction",
          });
        }
      }
    }
    return contradictions;
  }

  /**
   * Ask the LLM whether two meaning overlays contradict each other.
   *
   * @param {object} a First meaning overlay.
   * @param {object} b Second meaning overlay.
   * @returns {Promise<boolean>} True when the LLM decides the descriptions
   *   are mutually incompatible.
   * @private
   */
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

  /**
   * Append a single contradiction record to the JSONL store.
   *
   * Writes are serialized through the internal queue so concurrent calls do
   * not interleave lines. Errors are logged and swallowed so that a failed
   * append does not break the caller.
   *
   * @param {object} record Contradiction record to persist.
   * @returns {Promise<void>}
   * @private
   */
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

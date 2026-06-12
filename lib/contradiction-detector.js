/**
 * lib/contradiction-detector.js — Detect and surface contradictions between
 * interpretation overlays.
 *
 * Storage: JSONL file {workspaceDir}/contradictions.jsonl
 * Schema per record:
 *   {
 *     targetMemoryId: "abc123",
 *     overlayA: "ov-1",
 *     overlayB: "ov-2",
 *     detectedAt: "2026-06-12T10:00:00.000Z"
 *   }
 */

import { resolveInside } from "./sql-safety.js";
import { readJsonl } from "./jsonl-utils.js";

export class ContradictionDetector {
  /**
   * @param {{ workspaceDir?: string }} options
   */
  constructor({ workspaceDir } = {}) {
    this.filePath = workspaceDir
      ? resolveInside(workspaceDir, "contradictions.jsonl")
      : null;
  }

  /**
   * Load contradiction records for the given target memory ids.
   *
   * @param {string[]} memoryIds
   * @returns {Promise<Array<object>>}
   */
  async loadFor(memoryIds) {
    if (!this.filePath) return [];

    const memoryIdSet = new Set(memoryIds);
    const all = readJsonl(this.filePath, { maxBytes: 1024 * 1024 });
    return all.filter((rec) => memoryIdSet.has(rec.targetMemoryId));
  }

  /**
   * Mark `contradiction: true` on each overlay whose id appears in a persisted
   * contradiction record **and** whose contradiction partner is also present in
   * the supplied overlay list. Mutates the input array in place.
   *
   * @param {Array<object>} overlays
   * @returns {Promise<void>}
   */
  async flagContradictoryOverlays(overlays) {
    if (!Array.isArray(overlays) || overlays.length === 0) return;
    if (!this.filePath) return;

    const targetMemoryIds = new Set();
    const byId = new Map();
    const activeIds = new Set();
    for (const ov of overlays) {
      if (!ov?.id || !ov?.targetMemoryId) continue;
      targetMemoryIds.add(ov.targetMemoryId);
      byId.set(ov.id, ov);
      activeIds.add(ov.id);
    }

    const contradictions = await this.loadFor(Array.from(targetMemoryIds));
    const flaggedIds = new Set();
    for (const rec of contradictions) {
      const aActive = rec.overlayA && activeIds.has(rec.overlayA);
      const bActive = rec.overlayB && activeIds.has(rec.overlayB);
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
}

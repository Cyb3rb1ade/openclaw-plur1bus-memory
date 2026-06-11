/**
 * lib/interpretation-overlay.js — Interpretation overlays (append-only, idempotent).
 *
 * When a memory is recalled in a new emotional/contextual frame, we record
 * a "meaning shift" annotation without ever mutating the original record.
 *
 * Storage: JSONL file {workspaceDir}/interpretation-overlays.jsonl
 * Schema per overlay:
 *   {
 *     id: "uuid-v4",
 *     targetMemoryId: "abc123",
 *     createdAt: "2026-06-11T10:00:00.000Z",
 *     shiftType: "meaning" | "confidence" | "context" | "unresolved-thread",
 *     shiftDescription: "text",
 *     confidenceDelta: -0.1,
 *     triggerContext: "conversation about...",
 *     dedupeKey: "abc123:meaning:a1b2c3d4e5f60000",
 *     provenance: {
 *       triggerMemoryIds: ["abc123", "def456"],
 *       patternId: "pat-789",
 *       llmModel: "kimi-for-coding"
 *     }
 *   }
 *
 * Critical safety invariant: NEVER mutates LanceDB or calls safeUpdate().
 * Only appends to the JSONL file.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class InterpretationOverlayStore {
  /**
   * @param {string} workspaceDir — workspace root directory
   */
  constructor(workspaceDir) {
    this.workspaceDir = workspaceDir;
    this.filePath = join(workspaceDir, "interpretation-overlays.jsonl");
  }

  /**
   * Compute a stable dedupe key from targetMemoryId + shiftType + context summary.
   * Hashing ensures consistent dedupe even across restarts.
   *
   * @param {string} targetMemoryId
   * @param {string} shiftType
   * @param {string} [triggerContextSummary]
   * @returns {string} — 16-char hex hash
   */
  computeDedupeKey(targetMemoryId, shiftType, triggerContextSummary) {
    const input = `${targetMemoryId}:${shiftType}:${String(triggerContextSummary ?? "").slice(0, 200)}`;
    return createHash("sha256").update(input).digest("hex").slice(0, 16);
  }

  /**
   * Load overlays for given memoryIds, filtering by maxAgeDays.
   * Returns [] if file doesn't exist. Skips malformed JSON lines.
   *
   * @param {string[]} memoryIds
   * @param {number} [maxAgeDays=30]
   * @returns {Array<object>}
   */
  loadFor(memoryIds, maxAgeDays = 30) {
    if (!existsSync(this.filePath)) return [];

    const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
    const lines = readFileSync(this.filePath, "utf8").split("\n").filter(Boolean);
    const results = [];
    const memoryIdSet = new Set(memoryIds);

    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        const createdTime = rec.createdAt ? new Date(rec.createdAt).getTime() : Date.now();
        if (memoryIdSet.has(rec.targetMemoryId) && createdTime >= cutoff) {
          results.push(rec);
        }
      } catch {
        /* skip malformed lines */
      }
    }

    return results;
  }

  /**
   * Append overlay record — idempotent: skip if dedupeKey already exists within cooldownDays.
   * Auto-generates id and createdAt if not provided.
   *
   * @param {object} overlay
   * @param {string} [overlay.id] — optional UUID; auto-generated if missing
   * @param {string} overlay.targetMemoryId
   * @param {string} [overlay.createdAt] — optional ISO timestamp; auto-generated if missing
   * @param {string} overlay.shiftType — "meaning" | "confidence" | "context" | "unresolved-thread"
   * @param {string} overlay.shiftDescription
   * @param {number} [overlay.confidenceDelta]
   * @param {string} overlay.triggerContext
   * @param {string} [overlay.dedupeKey] — optional; computed if missing
   * @param {object} [overlay.provenance]
   * @param {number} [cooldownDays=7]
   * @returns {Promise<boolean>} — true if written, false if duplicate within cooldown
   */
  async append(overlay, cooldownDays = 7) {
    const dedupeKey = overlay.dedupeKey ?? this.computeDedupeKey(
      overlay.targetMemoryId,
      overlay.shiftType,
      overlay.triggerContext
    );

    // Check for existing duplicate within cooldown window
    const existing = this.loadFor([overlay.targetMemoryId], cooldownDays);
    if (existing.some((r) => r.dedupeKey === dedupeKey)) {
      return false; // duplicate, skip
    }

    // Finalize record with auto-generated fields
    const record = {
      ...overlay,
      dedupeKey,
      id: overlay.id ?? randomUUID(),
      createdAt: overlay.createdAt ?? new Date().toISOString(),
    };

    // Append atomically
    appendFileSync(this.filePath, JSON.stringify(record) + "\n");
    return true;
  }

  /**
   * Static helper to determine if an LLM response should be skipped (e.g., "no shift" responses).
   * Callers are responsible for filtering LLM output; the store just appends what it receives.
   * This helper assists callers in that decision.
   *
   * @param {string} [response]
   * @returns {boolean} — true if response indicates no shift
   */
  static shouldSkipLlmResponse(response) {
    return !response || response.trim().toLowerCase() === "no shift";
  }
}

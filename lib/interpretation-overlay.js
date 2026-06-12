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
import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { safeWarn } from "./safe-logging.js";

export class InterpretationOverlayStore {
  /**
   * @param {string} workspaceDir — workspace root directory
   */
  constructor(workspaceDir) {
    this.workspaceDir = workspaceDir;
    this.filePath = join(workspaceDir, "interpretation-overlays.jsonl");
    this._writeQueue = Promise.resolve(); // serializes writes to prevent races
  }

  /**
   * Compute a stable dedupe key for a target + shift type + trigger context.
   */
  computeDedupeKey(targetMemoryId, shiftType, triggerContext) {
    const keyPayload = JSON.stringify([targetMemoryId, shiftType, String(triggerContext)]);
    return createHash("sha256").update(keyPayload).digest("hex").slice(0, 32);
  }

  /**
   * Compute the legacy dedupe key produced by the previous `::`-join algorithm.
   * Kept for backward compatibility so existing records do not block re-appends.
   *
   * @private
   */
  _computeLegacyDedupeKey(targetMemoryId, shiftType, triggerContext) {
    const keyParts = [targetMemoryId, shiftType, triggerContext].map(String).join("::");
    return createHash("sha256").update(keyParts).digest("hex").slice(0, 32);
  }

  /**
   * Load overlays for given memoryIds, filtering by maxAgeDays.
   * Returns [] if file doesn't exist. Skips malformed JSON lines.
   *
   * @param {string[]} memoryIds
   * @param {number} [maxAgeDays=30]
   * @returns {Promise<Array<object>>}
   */
  async loadFor(memoryIds, maxAgeDays = 30) {
    if (!existsSync(this.filePath)) return [];

    const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
    const content = await readFile(this.filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const results = [];
    const memoryIdSet = new Set(memoryIds);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      try {
        const rec = JSON.parse(line);
        if (rec.status === "forgotten") continue;
        const createdTime = rec.createdAt ? new Date(rec.createdAt).getTime() : Date.now();
        // Invalid/unparseable createdAt yields NaN, so the record is ignored below.
        if (memoryIdSet.has(rec.targetMemoryId) && createdTime >= cutoff) {
          results.push(rec);
        }
      } catch (err) {
        safeWarn(console, "InterpretationOverlayStore.loadFor", err, { lineIndex: i });
      }
    }

    return results;
  }

  /**
   * Loads overlays for the Inner Continuity Engine render path.
   *
   * Returns only the latest, non-superseded, non-provisional overlay per target
   * memory by default, so stale or unreviewed interpretations cannot become live
   * evidence. Pass `{ includeProvisional: true }` for diagnostics/review and
   * `{ includeDisabled: true }` to surface disabled overlays.
   *
   * @param {string[]} memoryIds
   * @param {number} [maxAgeDays=30]
   * @param {{includeProvisional?: boolean, includeDisabled?: boolean}} [options={}]
   * @returns {Promise<Array<object>>}
   */
  async loadForTargets(memoryIds, maxAgeDays = 30, { includeProvisional = false, includeDisabled = false } = {}) {
    const all = await this.loadAllOverlays(memoryIds, {
      includeProvisional,
      includeSuperseded: false,
      includeDisabled,
      maxAgeDays,
    });

    // loadAllOverlays already excluded superseded, provisional (unless requested),
    // and disabled records (unless requested). Tombstones themselves must never
    // be rendered, even when includeDisabled surfaces the disabled originals.
    const visible = all.filter((rec) => rec.status !== "forgotten");

    const latestByTarget = new Map();
    for (const rec of visible) {
      const createdTime = rec.createdAt ? new Date(rec.createdAt).getTime() : Date.now();
      const existing = latestByTarget.get(rec.targetMemoryId);
      const existingTime = existing?.createdAt ? new Date(existing.createdAt).getTime() : 0;
      if (!existing || createdTime > existingTime) {
        latestByTarget.set(rec.targetMemoryId, rec);
      }
    }

    return Array.from(latestByTarget.values());
  }

  /**
   * Load every overlay for the given memory ids, optionally including
   * superseded, provisional, and disabled/tombstone records.
   *
   * Passing an empty `memoryIds` array loads the entire JSONL file (subject to
   * `maxAgeDays`), which is the audit path used by `plur1bus memory overlays`.
   *
   * @param {string[]} memoryIds
   * @param {{includeProvisional?: boolean, includeSuperseded?: boolean, includeDisabled?: boolean, maxAgeDays?: number}} [options={}]
   * @returns {Promise<Array<object>>}
   */
  async loadAllOverlays(memoryIds, { includeProvisional = false, includeSuperseded = false, includeDisabled = false, maxAgeDays = 30 } = {}) {
    const all = await this._loadRaw(maxAgeDays);
    const idSet = memoryIds?.length ? new Set(memoryIds) : null;
    const scoped = idSet ? all.filter((rec) => idSet.has(rec.targetMemoryId)) : all;

    // Collect disabled overlay ids from forgotten tombstones and superseded ids
    // from the canonical `supersedes` relationship on newer records.
    const disabledIds = new Set();
    const supersededIds = new Set();
    for (const rec of scoped) {
      if (rec.status === "forgotten" && rec.disabledOverlayId) {
        disabledIds.add(rec.disabledOverlayId);
      }
      if (rec.supersedes) {
        supersededIds.add(rec.supersedes);
      }
    }

    return scoped.filter((rec) => {
      if (rec.status === "forgotten") return includeDisabled;
      if (disabledIds.has(rec.id)) return includeDisabled;
      if (!includeProvisional && rec.status === "provisional") return false;
      if (!includeSuperseded && (rec.supersededBy || supersededIds.has(rec.id))) return false;
      return true;
    });
  }

  /**
   * Load every record in the overlay JSONL file, filtered only by maxAgeDays.
   * Skips malformed JSON lines after logging a warning.
   * @private
   * @param {number} maxAgeDays
   * @returns {Promise<Array<object>>}
   */
  async _loadRaw(maxAgeDays = 30) {
    if (!existsSync(this.filePath)) return [];
    const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
    const content = await readFile(this.filePath, "utf8");
    const results = [];
    const lines = content.split("\n").filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      try {
        const rec = JSON.parse(line);
        const createdTime = rec.createdAt ? new Date(rec.createdAt).getTime() : Date.now();
        if (createdTime >= cutoff) results.push(rec);
      } catch (err) {
        safeWarn(console, "InterpretationOverlayStore._loadRaw", err, { lineIndex: i });
      }
    }
    return results;
  }

  /**
   * Return the supersession lineage for a single overlay id.
   *
   * @param {string} overlayId
   * @param {number} [maxAgeDays=30]
   * @returns {Promise<{current: object|null, predecessors: Array<object>, successors: Array<object>}>}
   */
  async getLineage(overlayId, maxAgeDays = 30) {
    if (!existsSync(this.filePath)) {
      return { current: null, predecessors: [], successors: [] };
    }
    const content = await readFile(this.filePath, "utf8");
    const byId = new Map();
    const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
    const lines = content.split("\n").filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      try {
        const rec = JSON.parse(line);
        const createdTime = rec.createdAt ? new Date(rec.createdAt).getTime() : Date.now();
        if (createdTime >= cutoff) byId.set(rec.id, rec);
      } catch (err) {
        safeWarn(console, "InterpretationOverlayStore.getLineage", err, { lineIndex: i });
      }
    }

    const current = byId.get(overlayId) || null;
    const predecessors = [];
    const successors = [];

    if (current) {
      let walk = current;
      const visited = new Set([overlayId]);
      while (walk?.supersedes && byId.has(walk.supersedes) && !visited.has(walk.supersedes)) {
        const nextId = walk.supersedes;
        visited.add(nextId);
        walk = byId.get(nextId);
        predecessors.unshift(walk);
      }
      for (const rec of byId.values()) {
        if (rec.supersedes === overlayId) successors.push(rec);
      }
    }

    return { current, predecessors, successors };
  }

  /**
   * Disable (tombstone) a single overlay without mutating it.
   *
   * @param {string} overlayId
   * @param {string} [reason]
   * @returns {Promise<boolean>}
   */
  async disableOverlay(overlayId, reason = "operator disabled") {
    if (!overlayId) throw new TypeError("overlayId is required");
    const lineage = await this.getLineage(overlayId, 365 * 100);
    const targetMemoryId = lineage.current?.targetMemoryId;
    if (!targetMemoryId) return false;

    return this.append({
      targetMemoryId,
      shiftType: "meaning",
      shiftDescription: `Disabled overlay ${overlayId}`,
      triggerContext: reason,
      reason,
      status: "forgotten",
      disabledOverlayId: overlayId,
      dedupeKey: `disable:${overlayId}`,
    });
  }

  /**
   * Append overlay record — idempotent: skip if dedupeKey already exists within cooldownDays.
   * Auto-generates id and createdAt if not provided.
   * Serializes writes through an internal queue to prevent race conditions.
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
  append(overlay, cooldownDays = 7) {
    if (!overlay?.targetMemoryId || !overlay?.shiftType || !overlay?.triggerContext) {
      throw new TypeError("overlay must include targetMemoryId, shiftType, and triggerContext");
    }

    // Serialize all appends through a promise chain to prevent races.
    // Catch previous failures so one rejected append does not stall all future writes.
    this._writeQueue = this._writeQueue
      .catch(() => {})
      .then(() => this._doAppend(overlay, cooldownDays));
    return this._writeQueue;
  }

  /**
   * Internal method that performs the actual append logic.
   * Called serially via the _writeQueue to ensure atomicity of dedupe-check + write.
   *
   * @private
   * @param {object} overlay
   * @param {number} cooldownDays
   * @returns {Promise<boolean>}
   */
  async _doAppend(overlay, cooldownDays) {
    const dedupeKey = overlay.dedupeKey ?? this.computeDedupeKey(
      overlay.targetMemoryId,
      overlay.shiftType,
      overlay.triggerContext
    );

    // Check for existing duplicate within cooldown window.
    // Only live (non-superseded, non-provisional, non-forgotten) records block a new append.
    const existing = await this.loadFor([overlay.targetMemoryId], cooldownDays);
    const live = existing.filter(
      (r) => !r.supersededBy && r.status !== "provisional" && r.status !== "forgotten",
    );
    const legacyDedupeKey = this._computeLegacyDedupeKey(
      overlay.targetMemoryId,
      overlay.shiftType,
      overlay.triggerContext,
    );
    if (live.some((r) => r.dedupeKey === dedupeKey || r.dedupeKey === legacyDedupeKey)) {
      return false; // duplicate, skip
    }

    // Finalize record with auto-generated fields
    const record = {
      ...overlay,
      dedupeKey,
      id: overlay.id ?? randomUUID(),
      createdAt: overlay.createdAt ?? new Date().toISOString(),
    };

    // Append to file
    await appendFile(this.filePath, JSON.stringify(record) + "\n");
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

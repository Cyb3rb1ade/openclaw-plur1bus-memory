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
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
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
   * Load overlays for given memoryIds, filtering by maxAgeDays unless null.
   * Returns [] if file doesn't exist. Skips malformed JSON lines.
   *
   * @param {string[]} memoryIds
   * @param {number|null} [maxAgeDays=30]
   * @returns {Promise<Array<object>>}
   */
  async loadFor(memoryIds, maxAgeDays = 30) {
    const raw = await this._loadRaw(maxAgeDays, memoryIds);
    return raw.filter((rec) => rec.status !== "forgotten");
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
   * @param {number|null} [maxAgeDays=30]
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
   * `maxAgeDays` when provided), which is the audit path used by `plur1bus memory overlays`.
   *
   * @param {string[]} memoryIds
   * @param {{includeProvisional?: boolean, includeSuperseded?: boolean, includeDisabled?: boolean, maxAgeDays?: number|null}} [options={}]
   * @returns {Promise<Array<object>>}
   */
  async loadAllOverlays(memoryIds, { includeProvisional = false, includeSuperseded = false, includeDisabled = false, maxAgeDays = 30 } = {}) {
    const scoped = await this._loadRaw(maxAgeDays, memoryIds?.length ? memoryIds : null);

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
   * Load records in the overlay JSONL file, filtered by maxAgeDays when set and
   * optionally by target memory IDs. Targeted loads stream the JSONL and skip
   * obvious non-matching lines before JSON parsing.
   * Skips malformed JSON lines after logging a warning.
   * @private
   * @param {number|null} maxAgeDays
   * @param {string[]|null} [targetMemoryIds=null]
   * @returns {Promise<Array<object>>}
   */
  async _loadRaw(maxAgeDays = 30, targetMemoryIds = null) {
    if (!existsSync(this.filePath)) return [];
    const cutoff = maxAgeDays === null ? null : Date.now() - maxAgeDays * 24 * 3600 * 1000;
    const results = [];
    const targetIdSet = targetMemoryIds?.length ? new Set(targetMemoryIds) : null;

    if (targetIdSet) {
      let lineIndex = 0;
      const stream = createReadStream(this.filePath, { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line) {
          lineIndex++;
          continue;
        }
        let couldMatch = false;
        for (const id of targetIdSet) {
          if (line.includes(id)) {
            couldMatch = true;
            break;
          }
        }
        if (!couldMatch) {
          lineIndex++;
          continue;
        }
        try {
          const rec = JSON.parse(line);
          const createdTime = rec.createdAt ? new Date(rec.createdAt).getTime() : Date.now();
          if (targetIdSet.has(rec.targetMemoryId) && (cutoff === null || createdTime >= cutoff)) results.push(rec);
        } catch (err) {
          safeWarn(console, "InterpretationOverlayStore._loadRaw", err, { lineIndex });
        }
        lineIndex++;
      }
      return results;
    }

    const content = await readFile(this.filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      try {
        const rec = JSON.parse(line);
        const createdTime = rec.createdAt ? new Date(rec.createdAt).getTime() : Date.now();
        if (cutoff === null || createdTime >= cutoff) results.push(rec);
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
   * @param {number|null} [maxAgeDays=30]
   * @returns {Promise<{current: object|null, predecessors: Array<object>, successors: Array<object>}>}
   */
  async getLineage(overlayId, maxAgeDays = 30) {
    if (!existsSync(this.filePath)) {
      return { current: null, predecessors: [], successors: [] };
    }
    const content = await readFile(this.filePath, "utf8");
    const byId = new Map();
    const cutoff = maxAgeDays === null ? null : Date.now() - maxAgeDays * 24 * 3600 * 1000;
    const lines = content.split("\n").filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      try {
        const rec = JSON.parse(line);
        const createdTime = rec.createdAt ? new Date(rec.createdAt).getTime() : Date.now();
        if (cutoff === null || createdTime >= cutoff) byId.set(rec.id, rec);
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
   * Explicitly supersede an existing overlay with a new operator-resolved
   * interpretation. The old overlay remains in the append-only log; a new
   * overlay record is appended that links back via `supersedes`.
   *
   * @param {string} oldId — id of the overlay to supersede
   * @param {string} newDescription — description of the replacement interpretation
   * @param {string} [reason] — why the overlay is being superseded
   * @returns {Promise<boolean>} — result of the append
   */
  async supersedeOverlay(oldId, newDescription, reason) {
    if (!oldId) throw new TypeError("oldId is required");
    if (!newDescription || !String(newDescription).trim()) {
      throw new TypeError("newDescription is required");
    }
    const lineage = await this.getLineage(oldId, 365 * 100);
    const current = lineage.current;
    if (!current) return false;

    return this.append({
      targetMemoryId: current.targetMemoryId,
      shiftType: current.shiftType || "meaning",
      shiftDescription: newDescription,
      triggerContext: reason || "operator superseded",
      supersedes: oldId,
      dedupeKey: `supersede:${oldId}:${randomUUID()}`,
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

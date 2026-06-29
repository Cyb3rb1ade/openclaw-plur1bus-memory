// Phase 8A — Safe Reconsolidation: Non-destructive memory updates with versioning.
// ESM-only. Pure builders are separated from the side-effect orchestrator.

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { cosineSimilarityVec } from "./text-utils.js";
import { resolveHalfLifeDays } from "./memory-dynamics.js";

// ─── Pure builders ─────────────────────────────────────────────────────────

/**
 * Validates that a patch intended for a text/summary update has required evidence fields.
 * Pure function.
 */
export function validateUpdatePatch(patch, evidence) {
  const changesContent =
    patch.text !== undefined || patch.summary !== undefined;
  if (changesContent) {
    if (!evidence?.updateSource || typeof evidence.updateSource !== "string") {
      throw new Error(
        "safeUpdate: evidence.updateSource is required for text/summary changes"
      );
    }
    if (
      !evidence?.updateEvidence ||
      typeof evidence.updateEvidence !== "string"
    ) {
      throw new Error(
        "safeUpdate: evidence.updateEvidence is required for text/summary changes"
      );
    }
  }
}

/**
 * Computes a stable idempotency key for a proposed update.
 * Pure function.
 */
export function computeIdempotencyKey(oldRow, patch, evidence) {
  const payload = [
    oldRow.id,
    evidence?.updateSource || "",
    evidence?.updateEvidence || "",
    patch.text || "",
    patch.summary || "",
    patch.importance !== undefined ? String(patch.importance) : "",
    patch.category !== undefined ? String(patch.category) : "",
  ].join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Computes semantic drift between old and new vector.
 * Pure function.
 */
export function computeSemanticDrift(oldVector, newVector) {
  if (!oldVector || !newVector) return 0;
  if (oldVector.length !== newVector.length) return 1;
  const similarity = cosineSimilarityVec(oldVector, newVector);
  return 1 - similarity;
}

/**
 * Builds a new memory entry for a safe content update.
 * Pure function.
 */
export function buildUpdateEntry(oldRow, patch, evidence, opts = {}) {
  const newId = randomUUID();
  const now = Date.now();

  const newText = patch.text !== undefined ? patch.text : oldRow.text;
  const newSummary =
    patch.summary !== undefined ? patch.summary : oldRow.summary || "";
  const newVector = patch.vector !== undefined ? patch.vector : oldRow.vector;
  const newImportance =
    patch.importance !== undefined ? patch.importance : oldRow.importance ?? 0.5;
  const newCategory =
    patch.category !== undefined ? patch.category : oldRow.category || "other";

  return {
    id: newId,
    type: oldRow.type || "memory",
    confirmed: oldRow.confirmed === true,
    text: newText,
    summary: newSummary,
    origin: oldRow.origin || "dm",
    vector: newVector,
    importance: newImportance,
    category: newCategory,
    createdAt: oldRow.createdAt || now,
    mergedFrom: oldRow.mergedFrom || "[]",
    expiresAt: oldRow.expiresAt || 0,
    storedBy: oldRow.storedBy || "",
    sourceTurnId: oldRow.sourceTurnId || "",
    sourceMessageRole: oldRow.sourceMessageRole || "",
    sourceTimestamp: oldRow.sourceTimestamp || now,
    sourceUrl: oldRow.sourceUrl || "",
    evidenceQuote: oldRow.evidenceQuote || "",
    scope: oldRow.scope || "agent-private",
    ownerUserId: oldRow.ownerUserId || "",
    emotionalValence: oldRow.emotionalValence || "",
    emotionalIntensity: oldRow.emotionalIntensity ?? 0,
    emotionalDominant: oldRow.emotionalDominant || "neutral",
    moodContextAtCapture: oldRow.moodContextAtCapture || "",
    replayCount: oldRow.replayCount ?? 0,
    lastReplayed: oldRow.lastReplayed ?? 0,
    retrievalCount: oldRow.retrievalCount ?? 0,
    lastRetrievedAt: oldRow.lastRetrievedAt ?? 0,
    memoryStrength: oldRow.memoryStrength ?? 1.0,
    halfLifeDays: oldRow.halfLifeDays ?? resolveHalfLifeDays(oldRow.category, oldRow.memoryClass),
    lastStrengthenedAt: oldRow.lastStrengthenedAt ?? 0,
    lastDynamicsAt: oldRow.lastDynamicsAt ?? 0,
    memoryClass: oldRow.memoryClass || "standard",
    neverForget: oldRow.neverForget ?? 0,
    coreMemoryScore: oldRow.coreMemoryScore ?? 0.0,
    coreMemoryReason: oldRow.coreMemoryReason || "",
    // Versioning
    versionNumber: (oldRow.versionNumber ?? 1) + 1,
    previousVersion: oldRow.id,
    supersededBy: "",
    updateSource: evidence?.updateSource || oldRow.updateSource || "",
    updateEvidence: evidence?.updateEvidence || oldRow.updateEvidence || "",
    reconsolidationConfidence:
      evidence?.confidence ?? oldRow.reconsolidationConfidence ?? 0.0,
    status: "active",
    versionCreatedAt: now,
    updatedAt: now,
  };
}

/**
 * Builds the patch to supersede the old row.
 * Pure function.
 */
export function buildSupersedePatch(oldRow, newId, _opts = {}) {
  return {
    status: "superseded",
    supersededBy: newId,
    updatedAt: Date.now(),
  };
}

// ─── Side-effect orchestrator ──────────────────────────────────────────────

/**
 * Rewrites graph edges in the neo-store when a memory gets a new ID.
 * Replaces oldId with newId in all edges where source or target matches.
 */
export async function rewriteGraphEdges(neoStore, oldId, newId, opts = {}) {
  if (!neoStore || typeof neoStore.readGraphEdges !== "function") {
    opts.logger?.warn?.(
      `[safe-update] NeoStore unavailable for graph edge rewrite ${oldId} -> ${newId}`
    );
    return { rewritten: 0 };
  }

  try {
    const edges = await neoStore.readGraphEdges(10_000);
    const rewritten = [];

    for (const edge of edges) {
      const needsRewrite = edge.source === oldId || edge.target === oldId;
      if (needsRewrite) {
        rewritten.push({
          ...edge,
          source: edge.source === oldId ? newId : edge.source,
          target: edge.target === oldId ? newId : edge.target,
        });
      }
    }

    if (rewritten.length > 0) {
      await neoStore.appendGraphEdges(rewritten);
    }

    return { rewritten: rewritten.length };
  } catch (err) {
    opts.logger?.warn?.(
      `[safe-update] Graph edge rewrite failed: ${err.message}`
    );
    return { rewritten: 0, error: err.message };
  }
}

/**
 * Checks if a reconsolidation event with the given idempotency key already exists.
 */
export async function isIdempotent(neoStore, idempotencyKey, _opts = {}) {
  if (!neoStore || typeof neoStore.readReconsolidationEvents !== "function") {
    return false;
  }
  try {
    const events = await neoStore.readReconsolidationEvents(1000);
    return events.some((e) => e.idempotencyKey === idempotencyKey);
  } catch {
    return false;
  }
}

/**
 * Appends a reconsolidation event to the event log.
 */
export async function logReconsolidationEvent(neoStore, event, _opts = {}) {
  if (!neoStore || typeof neoStore.appendReconsolidationEvents !== "function") {
    return;
  }
  try {
    await neoStore.appendReconsolidationEvents([event]);
  } catch (err) {
    _opts.logger?.warn?.(
      `[safe-update] Failed to log reconsolidation event: ${err.message}`
    );
  }
}

/**
 * Performs a safe, non-destructive update of a memory.
 *
 * @param {Object} db — MemoryDB instance with .getById(), .update(), .store()
 * @param {string} id — ID of the memory to update
 * @param {Object} patch — { text?, summary?, importance?, vector?, category? }
 * @param {Object} evidence — { updateSource, updateEvidence, confidence? }
 * @param {Object} opts — { neoStore?, logger?, skipDriftGate? }
 * @returns {{ oldId, newId, versionNumber, inline: boolean }}
 */
export async function safeUpdate(db, id, patch, evidence, opts = {}) {
  // 1. Fetch existing row
  const oldRow = await db.getById(id);
  if (!oldRow) {
    throw new Error(`safeUpdate: Memory not found: ${id}`);
  }

  // 2. Guard: only active memories can be updated
  const status = oldRow.status || "active";
  if (status !== "active") {
    throw new Error(
      `safeUpdate: Cannot update non-active memory ${id} (status: ${status})`
    );
  }

  // 3. Validate evidence for content changes
  validateUpdatePatch(patch, evidence);

  // 4. Idempotency check
  const idempotencyKey = computeIdempotencyKey(oldRow, patch, evidence);
  if (opts.neoStore && (await isIdempotent(opts.neoStore, idempotencyKey, opts))) {
    opts.logger?.info?.(
      `[safe-update] Skipping idempotent update for ${id}`
    );
    return { oldId: id, newId: id, versionNumber: oldRow.versionNumber ?? 1, inline: true, skipped: true };
  }

  // 5. Determine update type
  const changesSemanticContent =
    patch.text !== undefined || patch.summary !== undefined;

  // Guard: text/summary changes require a new vector (semantic consistency)
  if (changesSemanticContent && patch.vector === undefined) {
    throw new Error(
      "safeUpdate: text/summary changes require patch.vector to be provided. " +
        "The embedding must reflect the new content."
    );
  }

  const changesOnlyVector =
    patch.vector !== undefined && !changesSemanticContent;
  const changesOnlyMetadata =
    !changesSemanticContent &&
    !changesOnlyVector &&
    (patch.importance !== undefined || patch.category !== undefined);

  // 6. Metadata-only or vector-only → inline update
  if (changesOnlyMetadata || changesOnlyVector) {
    const inlinePatch = {
      updatedAt: Date.now(),
    };
    if (patch.importance !== undefined) inlinePatch.importance = patch.importance;
    if (patch.category !== undefined) inlinePatch.category = patch.category;
    if (patch.vector !== undefined) inlinePatch.vector = patch.vector;
    if (evidence?.updateSource !== undefined)
      inlinePatch.updateSource = evidence.updateSource;
    if (evidence?.updateEvidence !== undefined)
      inlinePatch.updateEvidence = evidence.updateEvidence;
    if (evidence?.confidence !== undefined)
      inlinePatch.reconsolidationConfidence = evidence.confidence;

    await db.update(id, inlinePatch);

    // Log inline event
    if (opts.neoStore) {
      await logReconsolidationEvent(
        opts.neoStore,
        {
          id: randomUUID(),
          idempotencyKey,
          oldMemoryId: id,
          newMemoryId: id,
          action: "metadata_update",
          updateSource: evidence?.updateSource || "",
          updateEvidence: evidence?.updateEvidence || "",
          confidence: evidence?.confidence ?? 0,
          semanticDrift: 0,
          createdAt: Date.now(),
        },
        opts
      );
    }

    return {
      oldId: id,
      newId: id,
      versionNumber: oldRow.versionNumber ?? 1,
      inline: true,
    };
  }

  // 7. Semantic content change → new version
  // 7a. Semantic drift gate
  if (!opts.skipDriftGate && patch.vector !== undefined) {
    const drift = computeSemanticDrift(oldRow.vector, patch.vector);
    if (drift > 0.45) {
      throw new Error(
        `safeUpdate: Semantic drift too high (${drift.toFixed(2)} > 0.45). ` +
          `Rejecting update to prevent content corruption.`
      );
    }
  }

  // 7b. Build new entry
  const newEntry = buildUpdateEntry(oldRow, patch, evidence, opts);

  // 7c. Store new entry FIRST, so the replacement is durable before the old row
  // is hidden. Order is critical: if db.store throws (or the process dies)
  // after the supersede, the old row would be marked superseded-by an id that
  // was never created → the memory vanishes from active reads. Storing first
  // means a failure leaves both versions active (a recoverable fork), never a loss.
  await db.store(newEntry);

  // 7d. Mark old row as superseded (new version now exists durably).
  const supersedePatch = buildSupersedePatch(oldRow, newEntry.id, opts);
  await db.update(id, supersedePatch);

  // 7e. Rewrite graph edges
  if (opts.neoStore) {
    await rewriteGraphEdges(opts.neoStore, id, newEntry.id, opts);
  }

  // 7f. Log event
  if (opts.neoStore) {
    const drift =
      patch.vector !== undefined
        ? computeSemanticDrift(oldRow.vector, patch.vector)
        : 0;
    await logReconsolidationEvent(
      opts.neoStore,
      {
        id: randomUUID(),
        idempotencyKey,
        oldMemoryId: id,
        newMemoryId: newEntry.id,
        action: "version",
        updateSource: evidence?.updateSource || "",
        updateEvidence: evidence?.updateEvidence || "",
        confidence: evidence?.confidence ?? 0,
        semanticDrift: drift,
        createdAt: Date.now(),
      },
      opts
    );
  }

  return {
    oldId: id,
    newId: newEntry.id,
    versionNumber: newEntry.versionNumber,
    inline: false,
  };
}

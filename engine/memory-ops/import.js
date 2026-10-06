/**
 * engine/memory-ops/import.js — `MemoryOps.import` (contract 1.11.0).
 *
 * Finished-card ingest for M7: deterministic store id, no LLM merge, origin
 * `internal` on the card, operator origin `system`. Batch ≤ 500. Embeddings
 * are batched outside the write lock. Errors and logs never carry card text.
 */

import { MEMORY_CATEGORIES, MEMORY_SCOPES, categorizeMemoryWithReason } from "../../lib/categorize.js";
import { validateMemoryText } from "../../lib/input-limits.js";
import { computeMemoryImportance } from "../../lib/memory-fact-quality.js";
import { applyDynamicsDefaults } from "../../lib/memory-dynamics.js";
import { decideEpistemicStatusForCapture } from "../../lib/epistemic-capture.js";
import { generateSummary } from "../../lib/text-utils.js";
import { findBlockingTombstoneForCapture } from "../../lib/tombstone.js";
import { memoryOpError } from "./errors.js";
import { importCardId } from "./import-id.js";
import { createImportLedger } from "./import-ledger.js";
import { withImportLock } from "./import-lock.js";

export const IMPORT_CARD_BATCH_LIMIT = 500;
export const IMPORT_SOURCE_REF_MAX = 500;
export const IMPORT_IDEMPOTENCY_KEY_MAX = 256;

const LIVE_STATUS = new Set(["active", "", null, undefined]);

function isLiveStatus(status) {
  return LIVE_STATUS.has(status) || status == null;
}

function truncateSourceRef(value) {
  if (typeof value !== "string" || !value) return "";
  return value.length <= IMPORT_SOURCE_REF_MAX ? value : value.slice(0, IMPORT_SOURCE_REF_MAX);
}

function logSafe(logger, message) {
  logger?.debug?.(message);
}

function isAbortError(err, signal) {
  return signal?.aborted === true
    || err?.name === "AbortError"
    || err?.code === "ABORT_ERR";
}

/**
 * @param {object} deps
 * @returns {{importCards: Function, ledger: object}}
 */
export function createMemoryImport({
  opsContext,
  pool,
  embeddings,
  baseDbPath,
  logger,
  clock = Date.now,
  halfLifeOverrides = {},
  flashbulbEncodingEnabled = false,
  summaryMaxWords = 150,
  importLock = {},
} = {}) {
  const ledger = createImportLedger({ baseDbPath, logger });

  async function embedPassages(texts, agentId, signal) {
    if (texts.length === 0) return [];
    if (typeof embeddings.embedBatch === "function") {
      return embeddings.embedBatch(texts, 8, { agentId, signal });
    }
    const out = [];
    for (const text of texts) {
      if (signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      if (typeof embeddings.embedPassage === "function") {
        out.push(await embeddings.embedPassage(text, { agentId, signal }));
      } else {
        out.push(await embeddings.embed(text, { agentId, signal }));
      }
    }
    return out;
  }

  async function lookupById(db, cardId, agentId) {
    if (!db) return null;
    try {
      const initialized = await db.init();
      if (initialized === false || !db.table) return null;
      return await db.getById(cardId);
    } catch (err) {
      logger?.warn?.(`memory-ops.import: lookup failed for agent '${agentId}' id='${cardId}': ${err?.code || "error"}`);
      const wrapped = memoryOpError("storage", "import lookup failed");
      wrapped.cause = err;
      throw wrapped;
    }
  }

  async function importCards(req, p, a) {
    if (!a || a.origin !== "system" || a.background !== false) {
      throw memoryOpError("denied", "import requires origin \"system\" and background false");
    }
    const resolved = await opsContext.resolve(p, a);
    if (!req || typeof req !== "object") {
      throw memoryOpError("invalid-input", "import request is required");
    }
    if (typeof req.agentId !== "string" || req.agentId !== p.agentId || req.agentId !== resolved.agentId) {
      throw memoryOpError("invalid-input", "agentId does not match the operator");
    }
    if (!req.principal || req.principal.agentId !== req.agentId) {
      throw memoryOpError("invalid-input", "binding principal.agentId does not match agentId");
    }
    if (p.agentId !== req.principal.agentId) {
      throw memoryOpError("invalid-input", "operator and binding agentId must match");
    }
    if (!Array.isArray(req.cards)) {
      throw memoryOpError("invalid-input", "cards must be an array");
    }
    if (req.cards.length > IMPORT_CARD_BATCH_LIMIT) {
      throw memoryOpError("invalid-input", `cards exceeds maximum of ${IMPORT_CARD_BATCH_LIMIT} per call`);
    }

    const binding = await opsContext.resolve(req.principal, a);
    const agentId = binding.agentId;
    const memoryCtx = binding.memoryCtx;
    const dryRun = req.dryRun === true;
    const signal = req.signal;
    const importedAt = clock();

    const cardResults = req.cards.map((card, index) => ({ index, card, result: null, plan: null, backfill: null }));

    function reject(entry, reason) {
      const key = typeof entry.card?.idempotencyKey === "string" ? entry.card.idempotencyKey : "";
      entry.result = { idempotencyKey: key, outcome: "rejected", reason };
      entry.plan = null;
    }

    async function classify(db, index, seenKeys) {
      for (const entry of cardResults) {
        if (entry.result) continue;
        if (signal?.aborted) {
          reject(entry, "aborted");
          continue;
        }
        const card = entry.card;
        if (!card || typeof card !== "object") {
          reject(entry, "invalid-input");
          continue;
        }
        const key = typeof card.idempotencyKey === "string" ? card.idempotencyKey.trim() : "";
        if (!key || key.length > IMPORT_IDEMPOTENCY_KEY_MAX) {
          reject(entry, "invalid-input");
          continue;
        }
        entry.card = { ...card, idempotencyKey: key };

        const priorInBatch = seenKeys.get(key);
        if (priorInBatch) {
          entry.result = {
            idempotencyKey: key,
            outcome: "matched-existing",
            id: priorInBatch.id,
            reason: "duplicate-in-batch",
          };
          entry.plan = null;
          continue;
        }

        if (card.provenance !== "imported") {
          reject(entry, "provenance-not-imported");
          continue;
        }
        const textCheck = validateMemoryText(card.text);
        if (!textCheck.ok) {
          const empty = typeof card.text !== "string" || !String(card.text).trim();
          reject(entry, empty ? "empty-text" : "invalid-input");
          continue;
        }
        const text = String(card.text).trim();
        if (!text) {
          reject(entry, "empty-text");
          continue;
        }
        if (card.kind != null && card.kind !== "") {
          if (typeof card.kind !== "string" || !MEMORY_CATEGORIES.includes(card.kind)) {
            reject(entry, "invalid-input");
            continue;
          }
        }
        const scope = MEMORY_SCOPES.includes(card.scope) ? card.scope : "agent-private";
        if (scope === "user" && (memoryCtx.trust !== "proved" || !memoryCtx.userPrincipal)) {
          reject(entry, "principal-unresolved");
          continue;
        }
        if (scope === "workspace" && !memoryCtx.workspaceIdentity) {
          reject(entry, "principal-unresolved");
          continue;
        }

        const cardId = importCardId(agentId, key);
        let existing = null;
        try {
          existing = await lookupById(db, cardId, agentId);
        } catch {
          reject(entry, "storage");
          continue;
        }

        if (existing) {
          if (isLiveStatus(existing.status)) {
            const sourceRef = truncateSourceRef(card.sourceRef)
              || (typeof existing.sourceUrl === "string" ? existing.sourceUrl : "");
            entry.result = { idempotencyKey: key, outcome: "matched-existing", id: cardId, reason: "already-imported" };
            entry.plan = null;
            seenKeys.set(key, { id: cardId });
            if (!index.byCardId.has(cardId)) {
              entry.backfill = { cardId, key, sourceRef };
            }
            continue;
          }
          reject(entry, "previously-imported-deleted");
          continue;
        }

        const prior = index.byKey.get(key);
        if (prior) {
          reject(entry, "previously-imported-deleted");
          continue;
        }

        const ownerUserId = scope === "user" ? memoryCtx.userPrincipal : "";
        const workspaceIdentity = scope === "workspace" ? memoryCtx.workspaceIdentity : "";
        const blocking = findBlockingTombstoneForCapture(baseDbPath, {
          agentId,
          text,
          scope,
          workspaceIdentity,
          ownerUserId,
        });
        if (blocking) {
          reject(entry, "tombstone-blocked");
          continue;
        }

        const sourceRef = truncateSourceRef(card.sourceRef);
        const createdAt = Number.isFinite(card.createdAt) ? Math.floor(card.createdAt) : importedAt;
        const category = card.kind
          ? card.kind
          : categorizeMemoryWithReason(text).category;
        seenKeys.set(key, { id: cardId });
        entry.plan = { cardId, key, text, scope, ownerUserId, workspaceIdentity, sourceRef, createdAt, category };
      }
    }

    function backfillLedger(index, entry, now) {
      const row = entry.backfill;
      if (!row || index.byCardId.has(row.cardId)) return;
      try {
        ledger.append(agentId, {
          idempotencyKey: row.key,
          cardId: row.cardId,
          importedAt: now,
          sourceRef: row.sourceRef,
        });
        index.byKey.set(row.key, { cardId: row.cardId });
        index.byCardId.set(row.cardId, { idempotencyKey: row.key, sourceRef: row.sourceRef });
      } catch (err) {
        logger?.warn?.(`memory-ops.import: ledger backfill failed for agent '${agentId}' id='${row.cardId}': ${err?.code || "error"}`);
      }
    }

    if (dryRun) {
      await pool.withReadOnlyReadDbs(agentId, async (dbs) => {
        const db = dbs[0]?.db ?? null;
        const index = ledger.load(agentId);
        await classify(db, index, new Map());
      });
      for (const entry of cardResults) {
        if (entry.plan && !entry.result) {
          entry.result = { idempotencyKey: entry.plan.key, outcome: "created" };
        }
      }
    } else {
      const seenKeys = new Map();
      await pool.withReadOnlyReadDbs(agentId, async (dbs) => {
        const db = dbs[0]?.db ?? null;
        const index = ledger.load(agentId);
        await classify(db, index, seenKeys);
      });

      const pending = cardResults.filter((entry) => entry.plan && !entry.result);
      const vectorsByEntry = new Map();
      if (pending.length > 0) {
        if (signal?.aborted) {
          for (const entry of pending) reject(entry, "aborted");
        } else {
          try {
            const vectors = await embedPassages(pending.map((entry) => entry.plan.text), agentId, signal);
            if (signal?.aborted) {
              for (const entry of pending) reject(entry, "aborted");
            } else if (!Array.isArray(vectors) || vectors.length !== pending.length) {
              logger?.warn?.(`memory-ops.import: embed batch size mismatch for agent '${agentId}'`);
              for (const entry of pending) reject(entry, "storage");
            } else {
              for (let i = 0; i < pending.length; i++) vectorsByEntry.set(pending[i], vectors[i]);
            }
          } catch (err) {
            if (isAbortError(err, signal)) {
              for (const entry of pending) reject(entry, "aborted");
            } else {
              logger?.warn?.(`memory-ops.import: embed failed for agent '${agentId}': ${err?.code || "error"}`);
              for (const entry of pending) reject(entry, "storage");
            }
          }
        }
      }

      // K1: re-check → store → ledger runs under the per-agent import lock.
      // `withWriteDb` alone is a shared lease; without the lock two concurrent
      // imports of one key both re-check "absent" and both store the same id.
      let heartbeat = () => {};
      let entered = false;
      const writePhase = () => pool.withWriteDb(agentId, async (db) => {
        const index = ledger.load(agentId);
        const nowForBackfill = clock();
        for (const entry of cardResults) {
          if (entry.backfill) backfillLedger(index, entry, nowForBackfill);
        }

        for (const entry of pending) {
          heartbeat();
          if (entry.result) continue;
          if (signal?.aborted) {
            reject(entry, "aborted");
            continue;
          }
          const plan = entry.plan;
          let existing = null;
          try {
            existing = await lookupById(db, plan.cardId, agentId);
          } catch {
            reject(entry, "storage");
            continue;
          }
          if (existing) {
            if (isLiveStatus(existing.status)) {
              entry.result = {
                idempotencyKey: plan.key,
                outcome: "matched-existing",
                id: plan.cardId,
                reason: "already-imported",
              };
              entry.plan = null;
              if (!index.byCardId.has(plan.cardId)) {
                entry.backfill = {
                  cardId: plan.cardId,
                  key: plan.key,
                  sourceRef: plan.sourceRef || (typeof existing.sourceUrl === "string" ? existing.sourceUrl : ""),
                };
                backfillLedger(index, entry, clock());
              }
              continue;
            }
            reject(entry, "previously-imported-deleted");
            continue;
          }
          if (index.byKey.get(plan.key)) {
            reject(entry, "previously-imported-deleted");
            continue;
          }

          const vector = vectorsByEntry.get(entry);
          if (!vector) {
            reject(entry, "storage");
            continue;
          }

          const categoryResult = entry.card.kind
            ? { category: plan.category, reason: "caller-provided" }
            : categorizeMemoryWithReason(plan.text);
          const importanceResult = computeMemoryImportance({
            text: plan.text,
            category: categoryResult.category,
            categoryReason: categoryResult.reason,
            origin: "internal",
          });
          const now = clock();
          const entryRow = applyDynamicsDefaults({
            id: plan.cardId,
            text: plan.text,
            summary: generateSummary(plan.text, summaryMaxWords),
            origin: "internal",
            vector,
            importance: importanceResult.importance,
            category: categoryResult.category,
            createdAt: plan.createdAt,
            mergedFrom: "[]",
            expiresAt: 0,
            agentId,
            storedBy: agentId,
            workspaceId: plan.workspaceIdentity,
            workspaceKey: plan.workspaceIdentity,
            ownerUserId: plan.ownerUserId,
            sourceTurnId: "",
            sourceMessageRole: "",
            sourceTimestamp: now,
            sourceUrl: plan.sourceRef,
            evidenceQuote: "",
            scope: plan.scope,
            validFrom: 0,
            validUntil: 0,
            epistemicStatus: decideEpistemicStatusForCapture({
              text: plan.text,
              sourceMessageRole: "",
              origin: "internal",
            }),
          }, now, halfLifeOverrides, { flashbulbEncodingEnabled });

          try {
            await db.store(entryRow);
          } catch (err) {
            if (err?.action === "tombstone_blocked" || err?.reason === "tombstone_blocked") {
              reject(entry, "tombstone-blocked");
              continue;
            }
            logger?.warn?.(`memory-ops.import: store failed for agent '${agentId}' id='${plan.cardId}': ${err?.code || "error"}`);
            reject(entry, "storage");
            continue;
          }

          try {
            ledger.append(agentId, {
              idempotencyKey: plan.key,
              cardId: plan.cardId,
              importedAt: now,
              sourceRef: plan.sourceRef,
            });
            index.byKey.set(plan.key, { cardId: plan.cardId });
            index.byCardId.set(plan.cardId, { idempotencyKey: plan.key, sourceRef: plan.sourceRef });
          } catch (err) {
            logger?.warn?.(`memory-ops.import: ledger append failed for agent '${agentId}' id='${plan.cardId}': ${err?.code || "error"}`);
          }
          entry.result = { idempotencyKey: plan.key, outcome: "created", id: plan.cardId };
          logSafe(logger, `memory-ops.import: created agent='${agentId}' id='${plan.cardId}'`);
        }
      });

      try {
        await withImportLock(baseDbPath, agentId, (ctx) => {
          entered = true;
          heartbeat = ctx.heartbeat;
          return writePhase();
        }, { ...importLock, signal });
      } catch (err) {
        if (entered) throw err;
        // Lock not acquired: nothing was written. Per-card semantics as for a store failure.
        const aborted = isAbortError(err, signal);
        if (!aborted) {
          logger?.warn?.(`memory-ops.import: import lock unavailable for agent '${agentId}': ${err?.code || "error"}`);
        }
        for (const entry of pending) {
          if (!entry.result) reject(entry, aborted ? "aborted" : "storage");
        }
      }
    }

    const cards = cardResults.map((entry) => {
      if (entry.result) return entry.result;
      const key = typeof entry.card?.idempotencyKey === "string" ? entry.card.idempotencyKey : "";
      return { idempotencyKey: key, outcome: "rejected", reason: "invalid-input" };
    });
    let created = 0;
    let matchedExisting = 0;
    let rejected = 0;
    for (const row of cards) {
      if (row.outcome === "created") created += 1;
      else if (row.outcome === "matched-existing") matchedExisting += 1;
      else rejected += 1;
    }
    return { agentId, dryRun, created, matchedExisting, rejected, cards };
  }

  return { importCards, ledger };
}

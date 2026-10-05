/**
 * engine/memory-ops/import.js — `MemoryOps.import` (contract 1.11.0).
 *
 * Finished-card ingest for M7: deterministic store id, no LLM merge, origin
 * `internal` on the card, operator origin `system`. Batch ≤ 500. Embeddings
 * are batched. Errors and logs never carry card text.
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

/**
 * @param {object} deps
 * @returns {{import: Function, ledger: object}}
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
} = {}) {
  const ledger = createImportLedger({ baseDbPath, logger });

  async function embedPassages(texts, agentId, signal) {
    if (texts.length === 0) return [];
    if (typeof embeddings.embedBatch === "function") {
      return embeddings.embedBatch(texts, 8, { agentId, signal });
    }
    const out = [];
    for (const text of texts) {
      if (typeof embeddings.embedPassage === "function") {
        out.push(await embeddings.embedPassage(text, { agentId, signal }));
      } else {
        out.push(await embeddings.embed(text, { agentId, signal }));
      }
    }
    return out;
  }

  async function importCards(req, p, a) {
    const resolved = await opsContext.resolve(p, a);
    if (!a || a.origin !== "system" || a.background !== false) {
      throw memoryOpError("denied", "import requires origin \"system\" and background false");
    }
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

    const cardResults = req.cards.map((card, index) => ({ index, card, result: null, plan: null }));

    function reject(entry, reason) {
      const key = typeof entry.card?.idempotencyKey === "string" ? entry.card.idempotencyKey : "";
      entry.result = { idempotencyKey: key, outcome: "rejected", reason };
      entry.plan = null;
    }

    const index = ledger.load(agentId);

    const classify = async (db) => {
      for (const entry of cardResults) {
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
        if (db) {
          try {
            const initialized = await db.init();
            if (initialized !== false && db.table) {
              existing = await db.getById(cardId);
            }
          } catch (err) {
            logger?.warn?.(`memory-ops.import: lookup failed for agent '${agentId}' id='${cardId}': ${err?.code || "error"}`);
            throw memoryOpError("storage", "import lookup failed");
          }
        }

        if (existing) {
          if (isLiveStatus(existing.status)) {
            entry.result = { idempotencyKey: key, outcome: "matched-existing", id: cardId, reason: "already-imported" };
            entry.plan = null;
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
        entry.plan = { cardId, key, text, scope, ownerUserId, workspaceIdentity, sourceRef, createdAt, category };
      }
    };

    if (dryRun) {
      await pool.withReadOnlyReadDbs(agentId, async (dbs) => {
        const db = dbs[0]?.db ?? null;
        await classify(db);
      });
      for (const entry of cardResults) {
        if (entry.plan && !entry.result) {
          entry.result = { idempotencyKey: entry.plan.key, outcome: "created" };
        }
      }
    } else {
      await pool.withWriteDb(agentId, async (db) => {
        await classify(db);
        const pending = cardResults.filter((entry) => entry.plan && !entry.result);
        if (pending.length === 0) return;

      const vectors = await embedPassages(pending.map((entry) => entry.plan.text), agentId, signal);
      if (vectors.length !== pending.length) {
        throw memoryOpError("storage", "import embedding batch failed");
      }

      for (let i = 0; i < pending.length; i++) {
        const entry = pending[i];
        if (signal?.aborted) {
          reject(entry, "aborted");
          continue;
        }
        const plan = entry.plan;
        const vector = vectors[i];
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
          throw memoryOpError("storage", "import store failed");
        }

        ledger.append(agentId, {
          idempotencyKey: plan.key,
          cardId: plan.cardId,
          importedAt: now,
          sourceRef: plan.sourceRef,
        });
        index.byKey.set(plan.key, { cardId: plan.cardId });
        index.byCardId.set(plan.cardId, { idempotencyKey: plan.key, sourceRef: plan.sourceRef });
        entry.result = { idempotencyKey: plan.key, outcome: "created", id: plan.cardId };
        logSafe(logger, `memory-ops.import: created agent='${agentId}' id='${plan.cardId}'`);
      }
      });
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

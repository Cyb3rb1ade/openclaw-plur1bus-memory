/**
 * engine/memory-ops/unimport.js — `MemoryOps.unimport` (contract 1.13.0).
 *
 * Rolls back the cards one `memory.import` run created for one agent. The
 * engine decides "created by this run" from its own `_imports/` ledger lines
 * (`importRunId`), never from caller keys alone. A card is undone only while
 * it is unmodified since import; otherwise it is kept and reported with a
 * machine reason. Undo is archive-first plus the store's soft delete
 * (`status "deleted"`, as forget does) WITHOUT a registry tombstone, and an
 * `unimported` ledger line frees the idempotency key, so a later import of
 * the same key creates the card again (owner ruling a). A card the user
 * forgot stays forgotten.
 *
 * Apply runs under the per-agent import lock (no import and unimport of one
 * agent concurrently). Before every store write and every ledger write the
 * holder re-checks the lock nonce; a mismatch is `lock-lost` and the call
 * stops at once. A write-ahead sidecar (`_unimports/<agentId>/<runId>.jsonl`)
 * makes every crash point resumable; a rerun converges. dryRun takes no lock
 * and writes nothing. Results, logs and the sidecar carry ids, keys, counters
 * and reason codes only — never card text or sourceRef.
 */

import { archiveCard } from "../../lib/telegram-commands/memory-edit.js";
import { readTombstonesFromRegistry } from "../../lib/tombstone.js";
import { appendDestructiveOpLog, safeAgentId, safeUuid } from "../../lib/sql-safety.js";
import { createJobLedger } from "../jobs/job-ledger.js";
import { memoryOpError } from "./errors.js";
import { importCardId } from "./import-id.js";
import { importRowDigest, isImportDigest } from "./import-digest.js";
import { IMPORT_IDEMPOTENCY_KEY_MAX, IMPORT_RUN_ID_RE, ledgerLineRunId } from "./import.js";
import { withImportLock } from "./import-lock.js";
import { createRebindLedger } from "./rebind-ledger.js";
import { createUnimportLedger } from "./unimport-ledger.js";
import { createLinkLedger } from "./link-ledger.js";

export const UNIMPORT_KEY_FILTER_MAX = 500;

/** Jobs that can copy card content into derived artifacts (dreams, promotions, episodes). */
export const UNIMPORT_DERIVATION_JOBS = Object.freeze([
  "consolidate-daily", "rem-dream", "light-dream", "meta-reflect", "episodes-rebuild", "skill-miner",
]);

/**
 * Kept reasons `force` overrides (owner ruling b): edits to the card's own
 * content or metadata. Never `superseded` (a newer version exists that this
 * run did not create), `shared` / `rebound` / `binding-changed` (cross-user or
 * cross-agent), never `other-run` (the key's latest import belongs to another
 * run), and never forgotten or missing cards.
 */
export const UNIMPORT_FORCEABLE_REASONS = Object.freeze(["content-changed", "metadata-changed", "edited"]);

const LIVE_STATUS = new Set(["active", "", null, undefined]);

function isLiveStatus(status) {
  return LIVE_STATUS.has(status) || status == null;
}

function logSafe(logger, message) {
  logger?.debug?.(message);
}

function isAbortError(err, signal) {
  return signal?.aborted === true
    || err?.name === "AbortError"
    || err?.code === "ABORT_ERR";
}

/** Errors that end the whole call (never a per-card `failed`). */
function isFatal(err) {
  return err?.code === "lock-lost" || err?.code === "ledger-corrupt" || err?.code === "IMPORT_LOCK_LOST";
}

function sameNumber(a, b) {
  return (Number(a) || 0) === (Number(b) || 0);
}

/**
 * @param {object} deps
 * @param {object} deps.importLedger the `memory.import` ledger instance (shared with import)
 * @param {object} [deps.linkLedger] 1.16.0: the `memory.link` ledger instance (shared with link);
 *   links recorded under the run are unlinked, the linked cards stay untouched.
 * @param {Function} [deps.derivedCleanup] 1.15.0: `({agentId, workspaceDir, archiveDir, ids}) =>
 *   {graphEdgesRemoved, mirrorsArchived, cleanupErrors}` — drops graph edges and archives
 *   Obsidian mirrors of the undone cards; best-effort, never throws into the call.
 * @param {object} [deps.hooks] test seam: `afterIntent(cardId)`, `afterTombstone(cardId)`,
 *   `afterLedger(cardId)`; a throw there simulates a crash at that point.
 */
export function createMemoryUnimport({
  opsContext,
  pool,
  sharedMemoryPool,
  baseDbPath,
  jobsRoot,
  logger,
  clock = Date.now,
  importLedger,
  importLock = {},
  hooks = {},
  derivedCleanup = null,
  linkLedger = null,
} = {}) {
  const sidecar = createUnimportLedger({ baseDbPath, logger, clock });
  const links = linkLedger ?? createLinkLedger({ baseDbPath, logger });
  // Read-only use: `listApplied()` for the `rebound` reason.
  const rebindLedger = createRebindLedger({ baseDbPath, logger });

  function validateKeys(keys) {
    if (keys == null) return null;
    if (!Array.isArray(keys) || keys.length > UNIMPORT_KEY_FILTER_MAX) {
      throw memoryOpError("invalid-input", `idempotencyKeys must be an array of at most ${UNIMPORT_KEY_FILTER_MAX}`);
    }
    const out = new Set();
    for (const key of keys) {
      if (typeof key !== "string") throw memoryOpError("invalid-input", "idempotencyKeys must be strings");
      const trimmed = key.trim();
      if (!trimmed || trimmed.length > IMPORT_IDEMPOTENCY_KEY_MAX) {
        throw memoryOpError("invalid-input", "an idempotencyKey is empty or too long");
      }
      out.add(trimmed);
    }
    return out;
  }

  /**
   * The ledger lines this run wrote, one per card (the last one wins, so a
   * re-import under the same run id is the line that counts). A line belongs
   * to the run of its `importRunId`, else (1.15.0) to the run its `sourceRef`
   * names (`;run=<id>`); a line with neither is never selected. A line whose
   * card id is not the deterministic id of (agentId, key) is ignored.
   */
  function select(agentId, importRunId, keyFilter) {
    const byCard = new Map();
    for (const row of importLedger.readLines(agentId)) {
      if (row.kind != null) continue;
      if (ledgerLineRunId(row) !== importRunId) continue;
      if (keyFilter && !keyFilter.has(row.idempotencyKey)) continue;
      let expected;
      try {
        expected = importCardId(agentId, row.idempotencyKey);
      } catch {
        continue;
      }
      if (row.cardId !== expected) continue;
      byCard.delete(row.cardId);
      byCard.set(row.cardId, {
        cardId: row.cardId,
        idempotencyKey: row.idempotencyKey,
        importedAt: Number(row.importedAt) || 0,
        digest: isImportDigest(row.digest) ? row.digest : null,
        backfilled: row.backfilled === true,
      });
    }
    return [...byCard.values()];
  }

  /**
   * 1.16.0: the links this run made. Per link id the last line counts: a
   * `linked` line of this run is to be unlinked; an `unlinked` line of this
   * run after a `linked` line of this run is already undone. A link whose
   * latest `linked` line belongs to another run (re-linked after our
   * rollback) is never ours. The key filter narrows to links recorded with
   * one of the keys; links without a key are then not selected.
   * @returns {Array<{linkId: string, cardId: string, done: boolean}>}
   */
  function selectLinks(agentId, importRunId, keyFilter) {
    const state = new Map();
    for (const row of links.readLines(agentId)) {
      if (row.kind === "linked") {
        const ours = ledgerLineRunId(row) === importRunId
          && (!keyFilter || (typeof row.idempotencyKey === "string" && keyFilter.has(row.idempotencyKey)));
        state.delete(row.linkId);
        if (ours) state.set(row.linkId, { linkId: row.linkId, cardId: row.cardId, done: false });
        continue;
      }
      const current = state.get(row.linkId);
      if (current && row.importRunId === importRunId) current.done = true;
    }
    return [...state.values()];
  }

  function derivedJobsSince(agentId, since) {
    if (!jobsRoot || !Number.isFinite(since)) return [];
    try {
      const { rows } = createJobLedger({ root: jobsRoot, agentId, logger: logger ?? { warn() {} } }).snapshot();
      const out = new Set();
      for (const row of rows) {
        if (!UNIMPORT_DERIVATION_JOBS.includes(row?.job)) continue;
        if (row.outcome !== "completed" && row.outcome !== "incomplete") continue;
        if (Number.isFinite(row.finishedAt) && row.finishedAt > since) out.add(row.job);
      }
      return UNIMPORT_DERIVATION_JOBS.filter((job) => out.has(job));
    } catch (err) {
      logger?.warn?.(`memory-ops.unimport: job ledger unreadable for agent '${agentId}': ${err?.code || "error"}`);
      return [];
    }
  }

  /** Committed registry tombstone ids for this agent (fail closed on a read error). */
  function committedTombstoneIds(agentId, { readOnly }) {
    let list;
    try {
      list = readTombstonesFromRegistry(baseDbPath, agentId, readOnly ? { repairTornTail: false } : {});
    } catch (err) {
      logger?.warn?.(`memory-ops.unimport: tombstone registry unreadable for agent '${agentId}': ${err?.code || "error"}`);
      throw memoryOpError("storage", "tombstone registry unreadable");
    }
    const ids = new Set();
    for (const t of list) {
      if (t?.status !== "committed") continue;
      if (typeof t.memoryId === "string") ids.add(t.memoryId);
      if (typeof t.canonicalOriginId === "string") ids.add(t.canonicalOriginId);
    }
    return ids;
  }

  function reboundCardIds(agentId) {
    const ids = new Set();
    for (const rec of rebindLedger.listApplied()) {
      if (rec.header?.agentId !== agentId) continue;
      for (const card of rec.cards || []) if (typeof card.cardId === "string") ids.add(card.cardId);
    }
    return ids;
  }

  function loadContext(agentId, importRunId, { readOnly }) {
    return {
      sidecar: sidecar.load(agentId, importRunId),
      index: importLedger.load(agentId),
      tombIds: committedTombstoneIds(agentId, { readOnly }),
      rebound: reboundCardIds(agentId),
    };
  }

  /**
   * A live workspace/user copy shared from this card, in the pools the
   * operator (and the optional binding principal) can reach. A failed lookup
   * throws (the caller keeps the card as `failed`, never deletes on doubt).
   */
  async function hasLiveSharedCopy(cardId, agentId, ctxs) {
    if (!sharedMemoryPool) return false;
    const safe = safeUuid(cardId);
    const agent = safeAgentId(agentId);
    for (const memoryCtx of ctxs) {
      for (const lease of ["withWorkspaceReadDb", "withUserReadDb"]) {
        if (typeof sharedMemoryPool[lease] !== "function") continue;
        const found = await sharedMemoryPool[lease](memoryCtx, async (db) => {
          if (!db) return false;
          const ok = await db.init();
          if (ok === false || !db.table) return false;
          // A pool no share ever wrote to may lack the share columns: no copy there.
          const fields = db.schemaFieldNames;
          if (fields instanceof Set && fields.size > 0 && !fields.has("sourceMemoryId")) return false;
          const rows = await db.table.query()
            .where(`sourceMemoryId = "${safe}" AND sourceAgentId = "${agent}"`)
            .limit(16)
            .toArray();
          return rows.some((row) => isLiveStatus(row.status));
        });
        if (found) return true;
      }
    }
    return false;
  }

  async function readRow(db, cardId) {
    if (!db) return null;
    const ok = await db.init();
    if (ok === false || !db.table) return null;
    return db.getById(cardId);
  }

  /**
   * Decides one card. Pure apart from the shared-copy lookup; the row is read
   * by the caller inside the same critical section that acts on the answer.
   * @returns {Promise<{kind: "done"|"finish"|"eligible"|"kept"|"forgotten"|"missing", reason?: string}>}
   */
  async function decide(card, row, ctx, { agentId, importRunId, sharedCtxs, force }) {
    const marker = sidecar.markerKey(card.cardId, card.importedAt);
    if (ctx.sidecar.done.has(marker)) return { kind: "done" };
    // The card's latest ledger line belongs to another run (e.g. run B
    // re-imported the key after a crashed unimport of this run freed it):
    // the live row is B's card, never ours to delete — not even with force.
    const latest = ctx.index.byCardId.get(card.cardId);
    if (latest && ledgerLineRunId(latest) !== importRunId) return { kind: "kept", reason: "other-run" };
    const intent = ctx.sidecar.intents.has(marker);
    const unimportedLine = ctx.index.unimportedByCardId.get(card.cardId);
    const ourLedgerLine = unimportedLine && unimportedLine.importRunId === importRunId;

    if (!row) return intent ? { kind: "finish" } : { kind: "missing" };

    if (String(row.status || "") === "deleted") {
      if (ctx.tombIds.has(card.cardId)) return { kind: "forgotten" };
      if (intent || ourLedgerLine) return { kind: "finish" };
      return { kind: "forgotten" };
    }
    if (ctx.tombIds.has(card.cardId)) return { kind: "forgotten" };

    let reason = null;
    if (row.status === "superseded" || (typeof row.supersededBy === "string" && row.supersededBy !== "")) {
      reason = "superseded";
    } else if (!isLiveStatus(row.status)) {
      reason = "metadata-changed";
    } else if (typeof row.agentId === "string" && row.agentId !== "" && row.agentId !== agentId) {
      reason = "binding-changed";
    } else if (ctx.rebound.has(card.cardId)) {
      reason = "rebound";
    } else if (await hasLiveSharedCopy(card.cardId, agentId, sharedCtxs)) {
      reason = "shared";
    } else if (card.digest) {
      const now = importRowDigest(row);
      if (now.binding !== card.digest.binding) reason = "binding-changed";
      else if (now.content !== card.digest.content) reason = "content-changed";
      else if (now.meta !== card.digest.meta) reason = "metadata-changed";
    } else if (!sameNumber(row.updatedAt, card.importedAt)) {
      reason = "edited";
    }
    if (!reason) return { kind: "eligible" };
    if (force && UNIMPORT_FORCEABLE_REASONS.includes(reason)) return { kind: "eligible", forced: reason };
    return { kind: "kept", reason };
  }

  async function unimport(req, p, a) {
    if (!a || a.origin !== "system" || a.background !== false) {
      throw memoryOpError("denied", "unimport requires origin \"system\" and background false");
    }
    const resolved = await opsContext.resolve(p, a);
    if (!req || typeof req !== "object") {
      throw memoryOpError("invalid-input", "unimport request is required");
    }
    if (typeof req.agentId !== "string" || req.agentId !== p.agentId || req.agentId !== resolved.agentId) {
      throw memoryOpError("invalid-input", "agentId does not match the operator");
    }
    if (typeof req.importRunId !== "string" || !IMPORT_RUN_ID_RE.test(req.importRunId)) {
      throw memoryOpError("invalid-input", "importRunId is invalid");
    }
    const keyFilter = validateKeys(req.idempotencyKeys);
    const sharedCtxs = [resolved.memoryCtx];
    if (req.principal != null) {
      if (typeof req.principal !== "object" || req.principal.agentId !== req.agentId) {
        throw memoryOpError("invalid-input", "binding principal.agentId does not match agentId");
      }
      sharedCtxs.push((await opsContext.resolve(req.principal, a)).memoryCtx);
    }
    const agentId = resolved.agentId;
    const importRunId = req.importRunId;
    const dryRun = req.dryRun !== false;
    const force = req.force === true;
    const signal = req.signal;
    const { workspaceDir, archiveDir } = resolved;

    const selected = select(agentId, importRunId, keyFilter);
    const since = selected.reduce((min, c) => Math.min(min, c.importedAt), Number.POSITIVE_INFINITY);
    const result = {
      agentId,
      importRunId,
      dryRun,
      selected: selected.length,
      unimported: 0,
      keptModified: 0,
      alreadyForgotten: 0,
      alreadyUnimported: 0,
      missing: 0,
      failed: 0,
      remaining: selected.length,
      cards: [],
      derived: { jobsSinceImport: selected.length > 0 ? derivedJobsSince(agentId, since) : [] },
    };
    // 1.16.0: links this run made (memory.link); unlinking never touches the card.
    const linkSel = selectLinks(agentId, importRunId, keyFilter);
    if (linkSel.length > 0) {
      result.links = { selected: linkSel.length, unlinked: 0, alreadyUnlinked: 0, items: [] };
    }
    const pushLink = (entry, outcome) => {
      result.links.items.push({ linkId: entry.linkId, id: entry.cardId, outcome });
      if (outcome === "unlinked") result.links.unlinked += 1;
      else result.links.alreadyUnlinked += 1;
    };
    if (selected.length === 0 && linkSel.length === 0) {
      logSafe(logger, `memory-ops.unimport: agent='${agentId}' run='${importRunId}' selected=0 dryRun=${dryRun}`);
      return result;
    }

    const push = (card, outcome, reason) => {
      const row = { idempotencyKey: card.idempotencyKey, id: card.cardId, outcome };
      if (reason) row.reason = reason;
      result.cards.push(row);
      result.remaining -= 1;
      if (outcome === "unimported") result.unimported += 1;
      else if (outcome === "kept-modified") result.keptModified += 1;
      else if (outcome === "already-forgotten") result.alreadyForgotten += 1;
      else if (outcome === "already-unimported") result.alreadyUnimported += 1;
      else if (outcome === "missing") result.missing += 1;
      else result.failed += 1;
    };

    const decideOpts = { agentId, importRunId, sharedCtxs, force };

    if (dryRun) {
      const ctx = loadContext(agentId, importRunId, { readOnly: true });
      const readWriteNamespace = typeof pool.withAuthoritativeReadDb === "function"
        ? (fn) => pool.withAuthoritativeReadDb(agentId, fn)
        : (fn) => pool.withWriteDb(agentId, fn);
      if (selected.length > 0) await readWriteNamespace(async (db) => {
        for (const card of selected) {
          if (signal?.aborted) break;
          let decision;
          try {
            decision = await decide(card, await readRow(db, card.cardId), ctx, decideOpts);
          } catch (err) {
            logger?.warn?.(`memory-ops.unimport: dry-run check failed for agent '${agentId}' id='${card.cardId}': ${err?.code || "error"}`);
            push(card, "failed", isAbortError(err, signal) ? "aborted" : "storage");
            continue;
          }
          recordDecision(card, decision, push);
        }
      });
      for (const entry of linkSel) pushLink(entry, entry.done ? "already-unlinked" : "unlinked");
      logSafe(logger, summaryLine(result));
      return result;
    }

    // 1.15.0: cards whose derived data (graph edges, Obsidian mirrors) is
    // cleaned after the loop: the ones undone now, and ones an earlier call
    // undid whose row is still soft-deleted (a crash between store write and
    // cleanup converges on the rerun).
    const cleanupIds = [];
    let entered = false;
    try {
      await withImportLock(baseDbPath, agentId, async ({ heartbeat, assertHeld }) => {
        entered = true;
        const fence = () => {
          try {
            assertHeld();
          } catch (err) {
            if (err?.code === "IMPORT_LOCK_LOST") throw memoryOpError("lock-lost", "import lock was lost");
            throw err;
          }
          opsContext.assertOpen?.();
        };
        fence();
        sidecar.prepare(agentId, importRunId);
        const ctx = loadContext(agentId, importRunId, { readOnly: false });
        let headerWritten = ctx.sidecar.exists && ctx.sidecar.header != null;

        if (selected.length > 0) await pool.withWriteDb(agentId, async (db) => {
          for (const card of selected) {
            heartbeat();
            if (signal?.aborted) break;
            let decision;
            let row;
            try {
              row = await readRow(db, card.cardId);
              decision = await decide(card, row, ctx, decideOpts);
            } catch (err) {
              if (isFatal(err)) throw err;
              logger?.warn?.(`memory-ops.unimport: check failed for agent '${agentId}' id='${card.cardId}': ${err?.code || "error"}`);
              push(card, "failed", isAbortError(err, signal) ? "aborted" : "storage");
              continue;
            }
            if (decision.kind !== "eligible" && decision.kind !== "finish") {
              if (decision.kind === "done" && String(row?.status || "") === "deleted") cleanupIds.push(card.cardId);
              recordDecision(card, decision, push);
              continue;
            }

            if (decision.kind === "eligible") {
              let archivePath = "";
              try {
                fence();
                archivePath = archiveCard(row, agentId, archiveDir);
              } catch (err) {
                if (isFatal(err) || err?.name === "MemoryOpError") throw err;
                logger?.warn?.(`memory-ops.unimport: archive failed for agent '${agentId}' id='${card.cardId}': ${err?.code || "error"}`);
                push(card, "failed", "storage");
                continue;
              }
              if (!headerWritten) {
                sidecar.ensureHeader(agentId, importRunId, fence);
                headerWritten = true;
              }
              sidecar.appendIntent(agentId, importRunId, card, fence);
              ctx.sidecar.intents.add(sidecar.markerKey(card.cardId, card.importedAt));
              hooks.afterIntent?.(card.cardId);

              try {
                fence();
                await db.tombstone(card.cardId);
              } catch (err) {
                if (isFatal(err) || err?.name === "MemoryOpError") throw err;
                logger?.warn?.(`memory-ops.unimport: soft delete failed for agent '${agentId}' id='${card.cardId}': ${err?.code || "error"}`);
                push(card, "failed", isAbortError(err, signal) ? "aborted" : "storage");
                continue;
              }
              hooks.afterTombstone?.(card.cardId);
              const audited = appendDestructiveOpLog(workspaceDir, {
                event: "memory.unimported",
                source: "memory_unimport",
                agentId,
                memoryId: card.cardId,
                importRunId,
                archivePath,
                forced: decision.forced || "",
                result: "committed",
                timestamp: new Date(clock()).toISOString(),
              });
              if (!audited && workspaceDir) {
                logger?.warn?.(`memory-ops.unimport: audit line not written for agent '${agentId}' id='${card.cardId}'`);
              }
            }

            // finish: free the key (unless an earlier crashed call already did), then mark done.
            const prior = ctx.index.unimportedByCardId.get(card.cardId);
            if (!(prior && prior.importRunId === importRunId)) {
              fence();
              importLedger.append(agentId, {
                kind: "unimported",
                idempotencyKey: card.idempotencyKey,
                cardId: card.cardId,
                importRunId,
                at: clock(),
              });
              ctx.index.unimportedByCardId.set(card.cardId, { importRunId, cardId: card.cardId });
              ctx.index.byCardId.delete(card.cardId);
            }
            hooks.afterLedger?.(card.cardId);
            if (!headerWritten) {
              sidecar.ensureHeader(agentId, importRunId, fence);
              headerWritten = true;
            }
            sidecar.appendDone(agentId, importRunId, card, fence);
            logSafe(logger, `memory-ops.unimport: unimported agent='${agentId}' run='${importRunId}' id='${card.cardId}'${decision.forced ? ` forced=${decision.forced}` : ""}`);
            push(card, "unimported");
            cleanupIds.push(card.cardId);
          }
        });
        // 1.16.0: unlink this run's links (re-read under the lock). The card
        // itself is never written here: it existed before the run.
        if (linkSel.length > 0 && !signal?.aborted) {
          const current = new Map(selectLinks(agentId, importRunId, keyFilter).map((e) => [e.linkId, e]));
          for (const sel of linkSel) {
            heartbeat();
            const entry = current.get(sel.linkId);
            if (!entry || entry.done) {
              pushLink(sel, "already-unlinked");
              continue;
            }
            const at = clock();
            fence();
            links.append(agentId, { kind: "unlinked", linkId: entry.linkId, cardId: entry.cardId, importRunId, at });
            const audited = appendDestructiveOpLog(workspaceDir, {
              event: "memory.unlinked",
              source: "memory_unimport",
              agentId,
              memoryId: entry.cardId,
              linkId: entry.linkId,
              importRunId,
              result: "committed",
              timestamp: new Date(at).toISOString(),
            });
            if (!audited && workspaceDir) {
              logger?.warn?.(`memory-ops.unimport: audit line not written for agent '${agentId}' link='${entry.linkId}'`);
            }
            pushLink(entry, "unlinked");
          }
        }
        if (cleanupIds.length > 0 && typeof derivedCleanup === "function") {
          fence();
          let cleaned = null;
          try {
            cleaned = await derivedCleanup({ agentId, workspaceDir, archiveDir, ids: [...cleanupIds] });
          } catch (err) {
            logger?.warn?.(`memory-ops.unimport: derived cleanup failed for agent '${agentId}': ${err?.code || "error"}`);
            cleaned = { graphEdgesRemoved: 0, mirrorsArchived: 0, cleanupErrors: 1 };
          }
          result.derived.graphEdgesRemoved = Number(cleaned?.graphEdgesRemoved) || 0;
          result.derived.mirrorsArchived = Number(cleaned?.mirrorsArchived) || 0;
          result.derived.cleanupErrors = Number(cleaned?.cleanupErrors) || 0;
        }
      }, { ...importLock, signal });
    } catch (err) {
      if (entered) {
        if (err?.name === "MemoryOpError") throw err;
        if (err?.code === "IMPORT_LOCK_LOST") throw memoryOpError("lock-lost", "import lock was lost");
        logger?.warn?.(`memory-ops.unimport: apply failed for agent '${agentId}': ${err?.code || "error"}`);
        throw memoryOpError("storage", "unimport failed");
      }
      if (isAbortError(err, signal)) {
        logSafe(logger, `memory-ops.unimport: agent='${agentId}' run='${importRunId}' aborted before the lock`);
        return result;
      }
      if (err?.code === "IMPORT_LOCK_BUSY") {
        throw memoryOpError("lock-busy", "an import or unimport of this agent is running");
      }
      logger?.warn?.(`memory-ops.unimport: import lock unavailable for agent '${agentId}': ${err?.code || "error"}`);
      throw memoryOpError("storage", "unimport lock unavailable");
    }
    logSafe(logger, summaryLine(result));
    return result;
  }

  function recordDecision(card, decision, push) {
    switch (decision.kind) {
      case "done": push(card, "already-unimported"); break;
      case "forgotten": push(card, "already-forgotten"); break;
      case "missing": push(card, "missing"); break;
      case "kept": push(card, "kept-modified", decision.reason); break;
      // dryRun: what apply would do
      case "eligible":
      case "finish": push(card, "unimported"); break;
      default: push(card, "failed", "storage");
    }
  }

  function summaryLine(r) {
    const linkPart = r.links ? ` links=${r.links.selected} unlinked=${r.links.unlinked} alreadyUnlinked=${r.links.alreadyUnlinked}` : "";
    return `memory-ops.unimport: agent='${r.agentId}' run='${r.importRunId}' selected=${r.selected} unimported=${r.unimported} kept=${r.keptModified} forgotten=${r.alreadyForgotten} already=${r.alreadyUnimported} missing=${r.missing} failed=${r.failed} remaining=${r.remaining}${linkPart} dryRun=${r.dryRun}`;
  }

  // `hooks` and `importLock` are returned by reference as test seams.
  return { unimport, sidecar, hooks, importLock, links };
}

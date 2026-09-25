/**
 * engine/memory-ops/read.js — E1 Task 4: typed MemoryOps `list` and `show`.
 *
 * Both members are non-destructive lookups over the same ACL-filtered access
 * pools the legacy `/memory` command uses (`lib/telegram-commands/memory-query.js`),
 * reshaped into the typed `MemoryCard`/`MemoryListResult` contract (contract 1.5.0).
 */

import { queryMemoryAcrossAccessPools, projectMemoryQueryCard } from "../../lib/telegram-commands/memory-query.js";
import { isRecallEntryLive } from "../../lib/recall-pipeline.js";
import { safeUuid } from "../../lib/sql-safety.js";
import { readTombstonesFromRegistry } from "../../lib/tombstone.js";
import { memoryOpError } from "./errors.js";

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const MAX_TOPIC_LENGTH = 2_000;

const KNOWN_SCOPES = new Set(["agent-private", "workspace", "user"]);

function toEpochMsOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Maps a projected card (memory-query.js/recall-pipeline.js shape) onto the typed MemoryCard. */
function toMemoryCard(card, { includeScore }) {
  const scope = KNOWN_SCOPES.has(card?.scope) ? card.scope : "agent-private";
  const out = {
    id: card.id,
    scope,
    text: card.text || "",
    summary: card.summary || card.text || "",
    createdAt: toEpochMsOrNull(card.createdAt),
    origin: card.origin || null,
    epistemicStatus: card.epistemicStatus || null,
  };
  if (includeScore && typeof card.score === "number") out.score = card.score;
  return out;
}

// Same live-card lifecycle predicate memory-query.js's queryMemoryDbCandidates
// pushes into LanceDB (contract 1.5.0 Task 7): a forgotten/archived/superseded
// row's non-"active", non-null status drops it, and an expired TTL drops it —
// pushed into countRows() itself so state() never materializes the rows.
function lifecycleFilterSql(now) {
  return `(status = 'active' OR status IS NULL) AND (expiresAt IS NULL OR expiresAt = 0 OR expiresAt > ${now})`;
}

/**
 * Counts live rows in one already-open MemoryDB. Returns 0 for an
 * uninitialized/tableless DB (nothing captured yet), never throws — callers
 * decide null-vs-0 based on pool reachability, not on this helper.
 */
async function countLiveRows(db, now) {
  const initialized = await db.init();
  if (initialized === false || !db.table) return 0;
  // Same stale-reader guard queryMemoryDbCandidates applies: rejoin the live
  // head before counting so a just-completed forget/correct is reflected.
  if (typeof db.table.checkoutLatest === "function") {
    await db.table.checkoutLatest();
  }
  return db.table.countRows(lifecycleFilterSql(now));
}

/**
 * Sums live-card counts across every namespace the private pool leases for
 * this agent (normally exactly one). Never throws: a pool that fails to open
 * for this principal reports `null`, matching the shared-pool contract below.
 */
async function countPrivateLiveCards(privatePool, agentId, now, logger) {
  try {
    return await privatePool.withReadDbs(agentId, async (dbs) => {
      let total = 0;
      for (const { db } of dbs) total += await countLiveRows(db, now);
      return total;
    });
  } catch (err) {
    logger?.warn?.(`memory-ops.state: agent-private count failed for agent '${agentId}': ${err?.message || err}`);
    return null;
  }
}

/**
 * Counts live cards in one shared pool (workspace or user) via the given
 * lease function. The lease itself hands back `db: null` when this principal
 * has no claim on that scope (no workspaceIdentity / no userPrincipal) — that
 * is "not reachable", reported as `null`, distinct from a reachable-but-empty
 * pool (which counts as 0). A lease/open failure also reports `null`, never throws.
 */
async function countSharedLiveCards(leaseFn, memoryCtx, now, scope, agentId, logger) {
  try {
    return await leaseFn(memoryCtx, async (db) => (db ? countLiveRows(db, now) : null));
  } catch (err) {
    logger?.warn?.(`memory-ops.state: ${scope} count failed for agent '${agentId}': ${err?.message || err}`);
    return null;
  }
}

/**
 * @param {{opsContext: object, pool: object, sharedMemoryPool: object, embeddings: object, memoryDbAdapter: object, baseDbPath: string, logger?: object}} deps
 * @returns {{list: Function, show: Function, state: Function}}
 */
export function createMemoryRead({ opsContext, pool, sharedMemoryPool, embeddings, memoryDbAdapter, baseDbPath, logger }) {
  async function list(q, p, a) {
    const { agentId, memoryCtx } = await opsContext.resolve(p, a);

    const hasTopic = typeof q?.topic === "string";
    const hasSince = typeof q?.since === "number" && Number.isFinite(q.since);
    if (hasTopic === hasSince) {
      throw memoryOpError("invalid-input", "exactly one of topic and since must be set");
    }
    if (hasTopic && (q.topic.length < 1 || q.topic.length > MAX_TOPIC_LENGTH)) {
      throw memoryOpError("invalid-input", `topic must be between 1 and ${MAX_TOPIC_LENGTH} characters`);
    }

    const rawLimit = Number.isFinite(q?.limit) ? Math.floor(q.limit) : DEFAULT_LIMIT;
    const limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, rawLimit));

    const now = Date.now();
    // computeCutoff (lib/db-adapter.js) accepts an explicit { from, to }
    // epoch-ms range additively alongside its named ranges (E1 Task 4 fix
    // round 1): MemoryListQuery.since/.until are arbitrary epoch ms, not the
    // legacy vocabulary's named windows, so this passes the caller's real
    // bound straight through instead of laundering it through one of those.
    const parsed = hasTopic
      ? { mode: "topic", topic: q.topic, filters: undefined, explain: false }
      : { mode: "time", range: { from: q.since, to: typeof q.until === "number" && Number.isFinite(q.until) ? q.until : now }, explain: false };

    let items;
    try {
      items = await queryMemoryAcrossAccessPools({
        privatePool: pool,
        sharedPool: sharedMemoryPool,
        embeddings,
        agent: agentId,
        parsed,
        ctx: memoryCtx,
        now,
      });
    } catch (err) {
      logger?.warn?.(`memory-ops.list: query failed for agent '${agentId}': ${err?.message || err}`);
      throw memoryOpError("storage", "memory read failed");
    }

    const truncated = items.length > limit;
    const sliced = items.slice(0, limit);
    return { agentId, items: sliced.map((card) => toMemoryCard(card, { includeScore: hasTopic })), truncated };
  }

  async function show(id, p, a) {
    const { agentId, memoryCtx } = await opsContext.resolve(p, a);

    let safeId;
    try {
      safeId = safeUuid(id);
    } catch {
      throw memoryOpError("invalid-input", "id must be a valid memory id");
    }

    let card;
    try {
      // getCard(..., { ctx }) already runs checkAccess internally and
      // returns null for a denied card (lib/db-adapter.js) — no second,
      // redundant ACL check here.
      card = await memoryDbAdapter.getCard(agentId, safeId, { ctx: memoryCtx });
    } catch (err) {
      logger?.warn?.(`memory-ops.show: getCard failed for agent '${agentId}'/'${safeId}': ${err?.message || err}`);
      throw memoryOpError("storage", "memory read failed");
    }

    if (!card) {
      throw memoryOpError("not-found", "memory not found");
    }
    const projected = projectMemoryQueryCard(card);
    // Same liveness test list() applies to every candidate row (fix round 1,
    // anti-oracle): a non-"active" status (archived, superseded, deleted, …),
    // an invalidated epistemic status, an expired TTL, or a Valid-Time window
    // that excludes "now" are all indistinguishable "not-found" — never a
    // different code or message per reason.
    if (!isRecallEntryLive(projected, Date.now())) {
      throw memoryOpError("not-found", "memory not found");
    }

    return toMemoryCard(projected, { includeScore: false });
  }

  async function state(p, a) {
    const { agentId, memoryCtx, archiveDir } = await opsContext.resolve(p, a);
    const now = Date.now();

    const [agentPrivate, workspace, user] = await Promise.all([
      countPrivateLiveCards(pool, agentId, now, logger),
      countSharedLiveCards(
        (ctx, fn) => sharedMemoryPool.withWorkspaceReadDb(ctx, fn),
        memoryCtx, now, "workspace", agentId, logger,
      ),
      countSharedLiveCards(
        (ctx, fn) => sharedMemoryPool.withUserReadDb(ctx, fn),
        memoryCtx, now, "user", agentId, logger,
      ),
    ]);

    let tombstones = 0;
    try {
      tombstones = readTombstonesFromRegistry(baseDbPath, agentId)
        .filter((t) => t.status === "committed").length;
    } catch (err) {
      logger?.warn?.(`memory-ops.state: tombstone registry read failed for agent '${agentId}': ${err?.message || err}`);
      tombstones = 0;
    }

    return { agentId, cards: { agentPrivate, workspace, user }, tombstones, archiveDir };
  }

  return { list, show, state };
}

/**
 * engine/memory-ops/read.js — E1 Task 4: typed MemoryOps `list` and `show`.
 *
 * Both members are non-destructive lookups over the same ACL-filtered access
 * pools the legacy `/memory` command uses (`lib/telegram-commands/memory-query.js`),
 * reshaped into the typed `MemoryCard`/`MemoryListResult` contract (contract 1.5.0).
 */

import { queryMemoryAcrossAccessPools, findMemoryAcrossAccessPools } from "../../lib/telegram-commands/memory-query.js";
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

// state()'s live-card predicate must agree with list()/show(), i.e. with
// isRecallEntryLive() (lib/recall-pipeline.js), not just with the lifecycle
// SQL memory-query.js's queryMemoryDbCandidates pushes into LanceDB (fix
// round 1, E1-R11). isRecallEntryLive checks four things:
//   1. status is "active" or null/absent           — lifecycle SQL below
//   2. epistemicStatus is not "invalidated"         — lifecycle SQL below
//   3. expiresAt (TTL) has not passed               — lifecycle SQL below
//   4. isEntryValidAt(entry, validAt)                — deliberately NOT mirrored
// (4) is a real check in the function, but neither list() nor show() ever
// pass a validAt to isRecallEntryLive (both call sites use the 2-arg form,
// `isRecallEntryLive(card, now)`), so isEntryValidAt's own `validAt == null
// -> return true` short-circuit makes it a no-op at every call site state()
// must agree with: a row with a future validFrom or a past validUntil is
// still "live" to list()/show() today. Filtering it out here would make
// state()'s count disagree with what list() actually returns for the same
// agent — the one thing this function must never do. If list()/show() ever
// start threading a real validAt through, this predicate must grow the same
// `(validFrom = 0 OR validFrom <= now) AND (validUntil = 0 OR validUntil > now)`
// clause they would then push (see validTimeVectorPredicate in
// lib/recall-pipeline.js), not before.
//
// `epistemicStatus IS NULL OR epistemicStatus != 'invalidated'` mirrors
// normalizeEpistemicStatus()'s NULL-safety (lib/epistemic-status.js): only a
// literal stored "invalidated" excludes a row, never an absent/unset value.
// `!= 'invalidated'` alone is three-valued in SQL and would silently drop
// every row with no epistemicStatus set — the same NULL-safety hazard
// engine/store/memory-db.js's `_buildRecentGraphWhere` (:929) documents and
// guards against. The column itself is optional on older tables (documented
// at the same site), so it is included in the filter only when this table's
// live schema actually has it.
function lifecycleFilterSql(db, now) {
  const fields = db.schemaFieldNames;
  const hasColumn = (name) => !fields || fields.size === 0 || fields.has(name);
  const parts = [
    "(status = 'active' OR status IS NULL)",
    `(expiresAt IS NULL OR expiresAt = 0 OR expiresAt > ${now})`,
  ];
  if (hasColumn("epistemicStatus")) {
    parts.push("(epistemicStatus IS NULL OR epistemicStatus != 'invalidated')");
  }
  return parts.join(" AND ");
}

/**
 * Counts live rows in one already-open MemoryDB. Returns 0 for an
 * uninitialized/tableless DB (nothing captured yet), never throws — callers
 * decide null-vs-0 based on pool reachability, not on this helper. Every
 * condition here is pushed into LanceDB's own countRows(filter) — none of
 * isRecallEntryLive's checks need a projected-query/JS-predicate fallback,
 * since all of them (or their no-op equivalent, see lifecycleFilterSql above)
 * are expressible as SQL.
 */
async function countLiveRows(db, now) {
  const initialized = await db.init();
  if (initialized === false || !db.table) return 0;
  // Same stale-reader guard queryMemoryDbCandidates applies: rejoin the live
  // head before counting so a just-completed forget/correct is reflected.
  if (typeof db.table.checkoutLatest === "function") {
    await db.table.checkoutLatest();
  }
  // Not routed through MemoryDB's own `_read(promise, label)` timeout/label
  // wrapper (engine/store/memory-db.js): that method is a class-internal
  // convention with no external caller today (queryMemoryDbCandidates calls
  // `db.table.countRows`/`vectorSearch` directly too, same as here), and
  // reaching for it from outside the class would mean exposing a
  // currently-private method rather than a small local wrap — left as-is.
  return db.table.countRows(lifecycleFilterSql(db, now));
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
    if (hasTopic && (q.topic.trim().length < 1 || q.topic.length > MAX_TOPIC_LENGTH)) {
      throw memoryOpError("invalid-input", `topic must be between 1 and ${MAX_TOPIC_LENGTH} characters`);
    }
    const hasUntil = typeof q?.until === "number" && Number.isFinite(q.until);
    if (hasTopic && hasUntil) throw memoryOpError("invalid-input", "until is only valid with since");
    if (hasSince && hasUntil && q.until < q.since) throw memoryOpError("invalid-input", "until must not be before since");

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
      : { mode: "time", range: { from: q.since, to: hasUntil ? q.until : now }, explain: false };

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
        // limit + 1 per pool (E1 final review I4): each pool returns its own
        // newest (or best-scoring) limit + 1 rows, the merge orders them
        // globally, and a limit + 1st survivor means more cards matched.
        hardLimit: limit + 1,
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

    let found;
    try {
      // The same pools, ACL and liveness test list() applies (E1 final review
      // I3): every id list() hands out resolves here, whether it lives in the
      // agent's private pool or in a workspace/user pool the principal can
      // reach. A non-"active" status (archived, superseded, deleted, …), an
      // invalidated epistemic status, an expired TTL, an ACL denial or a pool
      // the principal cannot reach are all the same "not-found" (anti-oracle).
      found = await findMemoryAcrossAccessPools({
        privatePool: pool,
        sharedPool: sharedMemoryPool,
        agent: agentId,
        id: safeId,
        ctx: memoryCtx,
        now: Date.now(),
      });
    } catch (err) {
      logger?.warn?.(`memory-ops.show: lookup failed for agent '${agentId}'/'${safeId}': ${err?.message || err}`);
      throw memoryOpError("storage", "memory read failed");
    }

    if (!found) {
      throw memoryOpError("not-found", "memory not found");
    }
    return toMemoryCard(found.card, { includeScore: false });
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

    // MemoryState.tombstones is `number | null` (fix round 1): `null` means
    // the registry was unreadable (corrupt/torn/inaccessible), never
    // laundered into "zero tombstones" — a state()-only cue to the caller.
    let tombstones = null;
    try {
      tombstones = readTombstonesFromRegistry(baseDbPath, agentId)
        .filter((t) => t.status === "committed").length;
    } catch (err) {
      logger?.warn?.(`memory-ops.state: tombstone registry read failed for agent '${agentId}': ${err?.message || err}`);
      tombstones = null;
    }

    return { agentId, cards: { agentPrivate, workspace, user }, tombstones, archiveDir };
  }

  return { list, show, state };
}

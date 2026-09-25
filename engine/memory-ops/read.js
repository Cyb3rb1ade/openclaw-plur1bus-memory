/**
 * engine/memory-ops/read.js — E1 Task 4: typed MemoryOps `list` and `show`.
 *
 * Both members are non-destructive lookups over the same ACL-filtered access
 * pools the legacy `/memory` command uses (`lib/telegram-commands/memory-query.js`),
 * reshaped into the typed `MemoryCard`/`MemoryListResult` contract (contract 1.5.0).
 */

import { queryMemoryAcrossAccessPools, projectMemoryQueryCard } from "../../lib/telegram-commands/memory-query.js";
import { checkAccess } from "../../lib/acl-middleware.js";
import { safeUuid } from "../../lib/sql-safety.js";
import { memoryOpError } from "./errors.js";

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const MAX_TOPIC_LENGTH = 2_000;

// computeCutoff (lib/db-adapter.js) only understands a small fixed vocabulary
// of named ranges ("today" | "yesterday" | "this_week" | "this_month" |
// "month:<name>"); it has no notion of an arbitrary epoch-ms lower bound.
// `this_month` is the widest of those named windows (30 rolling days), so a
// `since` query asks the legacy time path for that widest window and this
// module re-applies the caller's real `since`/`until` bound in JS afterwards.
// A `since` older than 30 days will not surface memories the legacy query
// never fetched in the first place — a known limitation of the existing
// time-range vocabulary, out of scope for this task's file list.
const SINCE_QUERY_RANGE = "this_month";

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

/**
 * @param {{opsContext: object, pool: object, sharedMemoryPool: object, embeddings: object, memoryDbAdapter: object, logger?: object}} deps
 * @returns {{list: Function, show: Function}}
 */
export function createMemoryRead({ opsContext, pool, sharedMemoryPool, embeddings, memoryDbAdapter, logger }) {
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

    const parsed = hasTopic
      ? { mode: "topic", topic: q.topic, filters: undefined, explain: false }
      : { mode: "time", range: SINCE_QUERY_RANGE, explain: false };

    let items;
    try {
      items = await queryMemoryAcrossAccessPools({
        privatePool: pool,
        sharedPool: sharedMemoryPool,
        embeddings,
        agent: agentId,
        parsed,
        ctx: memoryCtx,
        now: Date.now(),
      });
    } catch (err) {
      logger?.warn?.(`memory-ops.list: query failed for agent '${agentId}': ${err?.message || err}`);
      throw memoryOpError("storage", "memory read failed");
    }

    if (hasSince) {
      const until = typeof q.until === "number" && Number.isFinite(q.until) ? q.until : null;
      items = items.filter((card) => {
        const created = toEpochMsOrNull(card.createdAt);
        if (created === null || created < q.since) return false;
        if (until !== null && created > until) return false;
        return true;
      });
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
      card = await memoryDbAdapter.getCard(agentId, safeId, { ctx: memoryCtx });
    } catch (err) {
      logger?.warn?.(`memory-ops.show: getCard failed for agent '${agentId}'/'${safeId}': ${err?.message || err}`);
      throw memoryOpError("storage", "memory read failed");
    }

    if (!card || card.status === "deleted") {
      throw memoryOpError("not-found", "memory not found");
    }
    if (!checkAccess(memoryCtx, card).allowed) {
      throw memoryOpError("not-found", "memory not found");
    }

    return toMemoryCard(projectMemoryQueryCard(card), { includeScore: false });
  }

  return { list, show };
}

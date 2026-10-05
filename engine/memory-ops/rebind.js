/**
 * engine/memory-ops/rebind.js — `MemoryOps.rebind` / `unbind` (contract 1.12.0).
 *
 * Manual N:1 channel-identity link. Only scope `user` owner metadata moves.
 * Sidecar `{baseDbPath}/_rebinds/<rebindId>.jsonl` is the source of truth.
 * Logs and results never carry card text or raw identity keys.
 */

import { randomUUID } from "node:crypto";
import { INPUT_LIMITS } from "../../lib/input-limits.js";
import {
  channelIdentityUserPrincipal,
  harnessUserPrincipal,
  USER_PRINCIPAL_PATTERN,
  validatedIdentity,
} from "../../lib/memory-request-context.js";
import { safeAgentId, safeUuid } from "../../lib/sql-safety.js";
import { memoryOpError } from "./errors.js";
import { createRebindLedger } from "./rebind-ledger.js";

export const REBIND_BATCH_SIZE = 64;

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

function requireSystemOrigin(a, op) {
  if (!a || a.origin !== "system" || a.background !== false) {
    throw memoryOpError("denied", `${op} requires origin "system" and background false`);
  }
}

function parseFromIdentity(fromIdentity) {
  if (!fromIdentity || typeof fromIdentity !== "object") {
    throw memoryOpError("invalid-input", "fromIdentity is required");
  }
  let channel;
  let identityKey;
  let accountId;
  try {
    channel = validatedIdentity(fromIdentity.channel, INPUT_LIMITS.CHANNEL_ID, "fromIdentity.channel", { required: true });
    identityKey = validatedIdentity(fromIdentity.identityKey, INPUT_LIMITS.USER_ID, "fromIdentity.identityKey", { required: true });
    accountId = fromIdentity.accountId == null || fromIdentity.accountId === ""
      ? "default"
      : validatedIdentity(fromIdentity.accountId, INPUT_LIMITS.ACCOUNT_ID, "fromIdentity.accountId");
  } catch {
    throw memoryOpError("invalid-input", "fromIdentity is invalid");
  }
  return { channel, identityKey, accountId };
}

function parseToUser(toUser) {
  let value;
  try {
    value = validatedIdentity(toUser, INPUT_LIMITS.USER_ID, "toUser", { required: true });
  } catch {
    throw memoryOpError("invalid-input", "toUser is invalid");
  }
  return value;
}

/**
 * @param {object} deps
 */
export function createMemoryRebind({
  opsContext,
  pool,
  baseDbPath,
  logger,
  clock = Date.now,
} = {}) {
  const ledger = createRebindLedger({ baseDbPath, logger });

  async function collectMatches(db, fromOwner) {
    const matches = [];
    if (!db) return matches;
    const initialized = await db.init();
    if (initialized === false || !db.table) return matches;
    for await (const batch of db.scanActiveBatches({ batchSize: REBIND_BATCH_SIZE })) {
      for (const row of batch) {
        if (row.scope !== "user") continue;
        if ((row.ownerUserId || "") !== fromOwner) continue;
        if (!isLiveStatus(row.status)) continue;
        try { safeUuid(row.id); } catch { continue; }
        matches.push(row);
      }
    }
    return matches;
  }

  async function patchOwner(db, cardId, ownerUserId, now) {
    await db.update(cardId, { ownerUserId, updatedAt: now });
  }

  async function rebind(req, p, a) {
    requireSystemOrigin(a, "rebind");
    const resolved = await opsContext.resolve(p, a);
    if (!req || typeof req !== "object") {
      throw memoryOpError("invalid-input", "rebind request is required");
    }
    if (typeof req.agentId !== "string" || req.agentId !== p.agentId || req.agentId !== resolved.agentId) {
      throw memoryOpError("invalid-input", "agentId does not match the operator");
    }
    const agentId = safeAgentId(req.agentId);
    const from = parseFromIdentity(req.fromIdentity);
    const toUser = parseToUser(req.toUser);
    const fromOwner = channelIdentityUserPrincipal(from.channel, from.identityKey, from.accountId);
    const toOwner = harnessUserPrincipal(toUser);
    if (!USER_PRINCIPAL_PATTERN.test(fromOwner) || !USER_PRINCIPAL_PATTERN.test(toOwner)) {
      throw memoryOpError("invalid-input", "rebind principals are invalid");
    }
    if (fromOwner === toOwner) {
      throw memoryOpError("invalid-input", "fromIdentity and toUser hash to the same principal");
    }
    const dryRun = req.dryRun !== false;
    const signal = req.signal;

    const applied = ledger.listApplied().filter((rec) => rec.header.agentId === agentId);
    const sameIdentity = applied.filter((rec) => rec.header.fromOwner === fromOwner);
    const otherUser = sameIdentity.find((rec) => rec.header.toOwner !== toOwner);
    if (otherUser) {
      throw memoryOpError("identity-already-bound", "identity already bound");
    }
    const existing = sameIdentity.find((rec) => rec.header.toOwner === toOwner);

    if (dryRun) {
      let matched = 0;
      await pool.withReadOnlyReadDbs(agentId, async (dbs) => {
        const db = dbs[0]?.db ?? null;
        matched = (await collectMatches(db, fromOwner)).length;
      });
      logSafe(logger, `memory-ops.rebind: agent='${agentId}' matched=${matched} rebound=0 skipped=0 dryRun=true`);
      return { rebindId: "", matched, rebound: 0, skipped: 0, dryRun: true };
    }

    const rebindId = existing?.rebindId || randomUUID();
    let matched = 0;
    let rebound = 0;
    let skipped = 0;

    await pool.withWriteDb(agentId, async (db) => {
      if (signal?.aborted) {
        throw memoryOpError("storage", "rebind aborted");
      }
      if (!existing) {
        ledger.writeHeader(rebindId, {
          agentId,
          fromOwner,
          toOwner,
          createdAt: clock(),
        });
      }
      const rec = ledger.load(rebindId);
      const already = new Set((rec.cards || []).map((c) => c.cardId));
      const matches = await collectMatches(db, fromOwner);
      matched = matches.length;

      // Resume: sidecar cards still sitting on fromOwner (append happened, patch did not).
      for (const card of rec.cards || []) {
        if (signal?.aborted) throw memoryOpError("storage", "rebind aborted");
        let row;
        try {
          row = await db.getById(card.cardId);
        } catch (err) {
          logger?.warn?.(`memory-ops.rebind: lookup failed for agent '${agentId}': ${err?.code || "error"}`);
          throw memoryOpError("storage", "rebind lookup failed");
        }
        if (row && (row.ownerUserId || "") === fromOwner && isLiveStatus(row.status) && row.scope === "user") {
          try {
            await patchOwner(db, card.cardId, toOwner, clock());
            rebound += 1;
          } catch (err) {
            if (isAbortError(err, signal)) throw memoryOpError("storage", "rebind aborted");
            logger?.warn?.(`memory-ops.rebind: update failed for agent '${agentId}': ${err?.code || "error"}`);
            throw memoryOpError("storage", "rebind update failed");
          }
        }
      }

      for (let i = 0; i < matches.length; i++) {
        if (signal?.aborted) throw memoryOpError("storage", "rebind aborted");
        const row = matches[i];
        if (already.has(row.id)) continue;
        try {
          ledger.appendCard(rebindId, {
            cardId: row.id,
            fromOwner,
            toOwner,
            fromUpdatedAt: Number(row.updatedAt) || 0,
          });
          already.add(row.id);
          await patchOwner(db, row.id, toOwner, clock());
          rebound += 1;
        } catch (err) {
          if (err?.name === "MemoryOpError") throw err;
          if (isAbortError(err, signal)) throw memoryOpError("storage", "rebind aborted");
          logger?.warn?.(`memory-ops.rebind: apply failed for agent '${agentId}': ${err?.code || "error"}`);
          throw memoryOpError("storage", "rebind update failed");
        }
        if ((i + 1) % REBIND_BATCH_SIZE === 0 && signal?.aborted) {
          throw memoryOpError("storage", "rebind aborted");
        }
      }
    });

    skipped = Math.max(0, matched - rebound);
    logSafe(logger, `memory-ops.rebind: agent='${agentId}' rebindId='${rebindId}' matched=${matched} rebound=${rebound} skipped=${skipped} dryRun=false`);
    return { rebindId, matched, rebound, skipped, dryRun: false };
  }

  async function unbind(req, p, a) {
    requireSystemOrigin(a, "unbind");
    const resolved = await opsContext.resolve(p, a);
    if (!req || typeof req !== "object") {
      throw memoryOpError("invalid-input", "unbind request is required");
    }
    let rebindId;
    try {
      rebindId = safeUuid(req.rebindId);
    } catch {
      throw memoryOpError("invalid-input", "rebindId is invalid");
    }
    const rec = ledger.load(rebindId);
    if (!rec.header) {
      throw memoryOpError("not-found", "rebind not found");
    }
    if (rec.header.agentId !== resolved.agentId || rec.header.agentId !== p.agentId) {
      throw memoryOpError("invalid-input", "agentId does not match the operator");
    }
    const dryRun = req.dryRun === true;
    const signal = req.signal;
    const fromOwner = rec.header.fromOwner;
    const toOwner = rec.header.toOwner;
    const agentId = rec.header.agentId;
    const matched = rec.cards.length;
    let unbound = 0;
    let skipped = 0;
    let skippedModified = 0;

    if (rec.reversed) {
      logSafe(logger, `memory-ops.unbind: rebindId='${rebindId}' matched=${matched} unbound=0 skipped=${matched} dryRun=${dryRun}`);
      return { rebindId, matched, unbound: 0, skipped: matched, skippedModified: 0, dryRun };
    }

    async function restoreOne(db, card) {
      let row;
      try {
        row = await db.getById(card.cardId);
      } catch (err) {
        logger?.warn?.(`memory-ops.unbind: lookup failed: ${err?.code || "error"}`);
        throw memoryOpError("storage", "unbind lookup failed");
      }
      if (!row) {
        skipped += 1;
        return;
      }
      if ((row.ownerUserId || "") === fromOwner) {
        skipped += 1;
        return;
      }
      if ((row.ownerUserId || "") !== toOwner) {
        skipped += 1;
        skippedModified += 1;
        return;
      }
      if (dryRun) {
        unbound += 1;
        return;
      }
      try {
        await patchOwner(db, card.cardId, fromOwner, clock());
        unbound += 1;
      } catch (err) {
        if (isAbortError(err, signal)) throw memoryOpError("storage", "unbind aborted");
        logger?.warn?.(`memory-ops.unbind: update failed: ${err?.code || "error"}`);
        throw memoryOpError("storage", "unbind update failed");
      }
    }

    if (dryRun) {
      await pool.withReadOnlyReadDbs(agentId, async (dbs) => {
        const db = dbs[0]?.db ?? null;
        if (!db) {
          skipped = matched;
          unbound = 0;
          return;
        }
        await db.init();
        for (const card of rec.cards) {
          if (signal?.aborted) throw memoryOpError("storage", "unbind aborted");
          await restoreOne(db, card);
        }
      });
    } else {
      await pool.withWriteDb(agentId, async (db) => {
        for (let i = 0; i < rec.cards.length; i++) {
          if (signal?.aborted) throw memoryOpError("storage", "unbind aborted");
          await restoreOne(db, rec.cards[i]);
        }
        ledger.appendReversed(rebindId, clock());
      });
    }

    logSafe(logger, `memory-ops.unbind: rebindId='${rebindId}' matched=${matched} unbound=${unbound} skipped=${skipped} dryRun=${dryRun}`);
    return { rebindId, matched, unbound, skipped, skippedModified, dryRun };
  }

  return { rebind, unbind, ledger };
}

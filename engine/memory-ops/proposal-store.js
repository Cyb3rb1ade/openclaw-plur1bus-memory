/**
 * engine/memory-ops/proposal-store.js — E2 Task 5 (spec decision D31): the
 * durable, per-proposal JSON file store behind `MemoryOps.propose`/`.proposals`.
 *
 * A proposal is filed by an agent who can read a shared (workspace/user) copy
 * but is not the agent that shared it (only the sharer may `correct` a shared
 * copy directly; every other reader files a proposal instead). Proposals live
 * one-file-per-proposal under `<dirname(baseDbPath)>/_proposals/<sharerAgentId>/<id>.json`
 * — a sibling of the LanceDB root, like `_tombstones` (lib/tombstone.js) —
 * so a sharer's proposals are all in one directory (`listFor` reads it in
 * full) while a proposer's filed proposals are scattered across every
 * sharer's directory (`listFor` scans those, filtered by `proposerAgentId`).
 *
 * Writes are atomic (temp file opened with the exclusive "wx" flag, fsynced,
 * then renamed onto the final path — the same pattern
 * lib/reembedding/state-store.js uses for its own durable JSON state) so a
 * crash mid-write never leaves a torn proposal file. A corrupt file is never
 * fatal to a listing: `listFor` counts and warns about it and returns every
 * proposal it could still read (anti-oracle: one bad neighbor must not hide
 * the rest).
 */

import { basename, dirname, join } from "node:path";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { safeAgentId, safeUuid, resolveInside } from "../../lib/sql-safety.js";
import { memoryOpError } from "./errors.js";

/**
 * @param {string} baseDbPath The engine's LanceDB root (e.g. `.../lancedb-namespaced`).
 * @returns {string} `<dirname(baseDbPath)>/_proposals`.
 */
export function proposalsRoot(baseDbPath) {
  return join(dirname(baseDbPath), "_proposals");
}

/**
 * @param {{baseDbPath: string, logger?: object, clock?: () => number}} deps
 *   `clock` is a test seam for `createdAt`/`resolvedAt`; unused by the store
 *   itself today (callers stamp those), kept for the shape the brief names.
 * @returns {{create: Function, get: Function, update: Function, listFor: Function, findPending: Function}}
 */
export function createProposalStore({ baseDbPath, logger, clock = Date.now } = {}) {
  void clock; // reserved for a future store-level timestamp; callers stamp createdAt/resolvedAt today.
  const root = proposalsRoot(baseDbPath);

  function ensureRoot() {
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    return root;
  }

  /** The sharer's directory, created on demand. Throws on an invalid agent id. */
  function agentDir(agentId) {
    const safeAgent = safeAgentId(agentId);
    ensureRoot();
    const dir = join(root, safeAgent);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return resolveInside(root, safeAgent);
  }

  /** Throws on an invalid agent id or proposal id (never silently coerces one). */
  function filePathFor(sharerAgentId, proposalId) {
    const dir = agentDir(sharerAgentId);
    const safeId = safeUuid(proposalId);
    return resolveInside(dir, `${safeId}.json`);
  }

  /** Temp-file-then-rename, mirroring lib/reembedding/state-store.js's writeStateAtomic. */
  function writeAtomic(path, data) {
    const dir = dirname(path);
    const tmpPath = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    let fd;
    try {
      fd = openSync(tmpPath, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(data), "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmpPath, path);
    } catch (err) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
      throw err;
    }
  }

  function readProposalFile(path) {
    return JSON.parse(readFileSync(path, "utf8"));
  }

  /** @returns {object} the same proposal, for chaining. */
  function create(proposal) {
    const path = filePathFor(proposal.sharerAgentId, proposal.id);
    try {
      writeAtomic(path, proposal);
    } catch (err) {
      logger?.warn?.(`memory-ops.proposals.store: create failed for '${proposal.sharerAgentId}'/'${proposal.id}': ${err?.message || err}`);
      throw memoryOpError("storage", "proposal write failed");
    }
    return proposal;
  }

  /** @returns {object|null} null on a missing file; throws `storage` on a corrupt one. */
  function get(sharerAgentId, proposalId) {
    let path;
    try {
      path = filePathFor(sharerAgentId, proposalId);
    } catch {
      return null;
    }
    if (!existsSync(path)) return null;
    try {
      return readProposalFile(path);
    } catch (err) {
      logger?.warn?.(`memory-ops.proposals.store: unreadable proposal file '${path}': ${err?.message || err}`);
      throw memoryOpError("storage", "proposal unreadable");
    }
  }

  /** Atomic rewrite of the same file (proposal.id/proposal.sharerAgentId are unchanged by any caller). */
  function update(proposal) {
    const path = filePathFor(proposal.sharerAgentId, proposal.id);
    try {
      writeAtomic(path, proposal);
    } catch (err) {
      logger?.warn?.(`memory-ops.proposals.store: update failed for '${proposal.sharerAgentId}'/'${proposal.id}': ${err?.message || err}`);
      throw memoryOpError("storage", "proposal write failed");
    }
    return proposal;
  }

  /**
   * Every proposal the agent filed or received: its own directory (as
   * sharer) in full, plus every other sharer's directory filtered to
   * proposals this agent filed (as proposer). Newest first; corrupt files
   * are skipped and counted, never thrown for a listing.
   * @param {string} agentId
   * @param {{status?: string|null, limit: number}} opts
   * @returns {{items: object[], truncated: boolean, unreadable: number}}
   */
  function listFor(agentId, { status = null, limit } = {}) {
    ensureRoot();
    const safeAgent = safeAgentId(agentId);
    let unreadable = 0;
    const collected = [];

    let dirNames;
    try {
      dirNames = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      logger?.warn?.(`memory-ops.proposals.store: listing root failed: ${err?.message || err}`);
      dirNames = [];
    }

    function collectDir(dirName, roleFilter) {
      let dirPath;
      try {
        dirPath = resolveInside(root, dirName);
      } catch {
        return; // an unsafe directory name is not ours to read
      }
      let entries;
      try {
        entries = readdirSync(dirPath);
      } catch (err) {
        logger?.warn?.(`memory-ops.proposals.store: listing '${dirPath}' failed: ${err?.message || err}`);
        return;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const filePath = join(dirPath, entry);
        let proposal;
        try {
          proposal = readProposalFile(filePath);
        } catch (err) {
          unreadable += 1;
          logger?.warn?.(`memory-ops.proposals.store: corrupt proposal file '${filePath}': ${err?.message || err}`);
          continue;
        }
        if (!roleFilter(proposal)) continue;
        if (status && proposal.status !== status) continue;
        collected.push(proposal);
      }
    }

    if (dirNames.includes(safeAgent)) collectDir(safeAgent, () => true);
    for (const dirName of dirNames) {
      if (dirName === safeAgent) continue;
      collectDir(dirName, (proposal) => proposal.proposerAgentId === safeAgent);
    }

    collected.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const truncated = collected.length > limit;
    const items = collected.slice(0, limit);
    return { items, truncated, unreadable };
  }

  /**
   * The one pending proposal (if any) this proposer already has open against
   * this shared copy — `propose`'s duplicate-filing guard.
   * @returns {object|null}
   */
  function findPending({ sharerAgentId, sharedId, proposerAgentId }) {
    let dir;
    try {
      dir = agentDir(sharerAgentId);
    } catch {
      return null;
    }
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      let proposal;
      try {
        proposal = readProposalFile(join(dir, entry));
      } catch (err) {
        logger?.warn?.(`memory-ops.proposals.store: corrupt proposal file '${join(dir, entry)}': ${err?.message || err}`);
        continue;
      }
      if (proposal.status === "pending" && proposal.sharedId === sharedId && proposal.proposerAgentId === proposerAgentId) {
        return proposal;
      }
    }
    return null;
  }

  return { create, get, update, listFor, findPending };
}

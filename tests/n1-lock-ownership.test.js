/**
 * tests/n1-lock-ownership.test.js — N1 lock audit.
 *
 * Every file lock that used to release by unconditional delete or reap a
 * live holder by age alone now follows the lib/registry-lock.js protocol.
 * For each one, the same three directions must hold:
 *   - a foreign lock survives our release (ours was taken over meanwhile);
 *   - a live holder older than staleMs is NOT reaped;
 *   - a dead holder older than staleMs IS reaped.
 * Races are made deterministic by patching node:fs (syncBuiltinESMExports),
 * so the competing write lands exactly between judging and acting.
 */

import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { acquireJobLock, releaseJobLock } from "../lib/job-lock.js";
import { acquireGovernorLock, releaseGovernorLock } from "../lib/proactive-governor.js";
import { createNeoStore } from "../lib/neo-arch.js";
import { tryAcquireOwnedLock } from "../lib/registry-lock.js";
import { readKnowledgePending, trackKnowledgePending } from "../engine/knowledge/knowledge-pending.js";
import { createMemoryTools } from "../engine/tools/memory-tools.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function tempDir(t) {
  const dir = makeTempDir("n1-lock-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A pid that certainly does not exist. */
function deadPid() {
  for (let pid = 4_000_000; pid > 100_000; pid -= 7919) {
    try { process.kill(pid, 0); } catch (error) {
      if (error?.code === "ESRCH") return pid;
    }
  }
  throw new Error("no dead pid found");
}

/** Another live process on this host: the test runner that spawned this file. */
const LIVE_PID = process.ppid;

function age(p, ms) {
  const when = new Date(Date.now() - ms);
  utimesSync(p, when, when);
}

function holderLock(pid, nonce = "foreign-nonce") {
  return JSON.stringify({ nonce, pid, host: hostname(), acquiredAt: "2026-10-05T00:00:00.000Z" });
}

/** Runs `fn` with fs.renameSync wrapped; `before(src, dst)` runs ahead of the real rename. */
function withRenameHook(before, fn) {
  const real = fs.renameSync;
  fs.renameSync = (src, dst) => { before(String(src), String(dst)); return real(src, dst); };
  syncBuiltinESMExports();
  const restore = () => { fs.renameSync = real; syncBuiltinESMExports(); };
  try {
    const out = fn();
    if (out && typeof out.then === "function") return out.finally(restore);
    restore();
    return out;
  } catch (error) {
    restore();
    throw error;
  }
}

function leftovers(dir, base) {
  return readdirSync(dir).filter((n) => n.startsWith(`${base}.`));
}

describe("tryAcquireOwnedLock (lib/registry-lock.js)", () => {
  it("release leaves a foreign lock in place", (t) => {
    const lock = join(tempDir(t), "x.lock");
    const h = tryAcquireOwnedLock(lock, { staleMs: 1000 });
    assert.ok(h);
    writeFileSync(lock, holderLock(LIVE_PID));
    h.release();
    assert.equal(readFileSync(lock, "utf8"), holderLock(LIVE_PID));
    h.release(); // idempotent
    assert.equal(readFileSync(lock, "utf8"), holderLock(LIVE_PID));
  });

  it("does not reap a live holder older than staleMs, reaps it past the 10x ceiling", (t) => {
    const lock = join(tempDir(t), "x.lock");
    writeFileSync(lock, holderLock(LIVE_PID));
    age(lock, 5_000);
    assert.equal(tryAcquireOwnedLock(lock, { staleMs: 1000 }), null);
    assert.equal(readFileSync(lock, "utf8"), holderLock(LIVE_PID));
    age(lock, 11_000);
    const h = tryAcquireOwnedLock(lock, { staleMs: 1000 });
    assert.ok(h);
    h.release();
    assert.equal(existsSync(lock), false);
  });

  it("reaps a dead holder older than staleMs, but not a fresh one", (t) => {
    const dir = tempDir(t);
    const lock = join(dir, "x.lock");
    writeFileSync(lock, holderLock(deadPid()));
    assert.equal(tryAcquireOwnedLock(lock, { staleMs: 1000 }), null, "fresh: within staleMs");
    age(lock, 5_000);
    const h = tryAcquireOwnedLock(lock, { staleMs: 1000 });
    assert.ok(h);
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).nonce, h.nonce);
    h.release();
    assert.deepEqual(leftovers(dir, "x.lock"), []);
  });
});

describe("job-lock (acquireJobLock / releaseJobLock)", () => {
  it("release leaves a lock that was taken over meanwhile", (t) => {
    const lock = join(tempDir(t), "locks", "job.lock");
    assert.equal(acquireJobLock(lock, { staleMs: 1000 }), lock);
    writeFileSync(lock, holderLock(LIVE_PID));
    releaseJobLock(lock);
    assert.equal(readFileSync(lock, "utf8"), holderLock(LIVE_PID));
  });

  it("release of a never-acquired path does not touch a foreign lock", (t) => {
    const lock = join(tempDir(t), "job.lock");
    writeFileSync(lock, holderLock(LIVE_PID));
    releaseJobLock(lock);
    assert.equal(readFileSync(lock, "utf8"), holderLock(LIVE_PID));
  });

  it("does not reap a live holder older than staleMs", (t) => {
    const lock = join(tempDir(t), "job.lock");
    writeFileSync(lock, holderLock(LIVE_PID));
    age(lock, 5_000);
    assert.throws(() => acquireJobLock(lock, { staleMs: 1000 }), /lock held/);
    assert.equal(readFileSync(lock, "utf8"), holderLock(LIVE_PID));
  });

  it("reaps a dead holder older than staleMs (also the pre-N1 {pid, createdAt} format)", (t) => {
    const lock = join(tempDir(t), "job.lock");
    writeFileSync(lock, JSON.stringify({ pid: deadPid(), createdAt: "2026-10-05T00:00:00.000Z" }));
    age(lock, 5_000);
    assert.equal(acquireJobLock(lock, { staleMs: 1000 }), lock);
    releaseJobLock(lock);
    assert.equal(existsSync(lock), false);
  });
});

describe("knowledge-pending lock", () => {
  const lockOf = (ws) => join(ws, ".adaptive-learning", "knowledge-pending.lock");
  const memory = { sourceAgent: "main", memoryId: "11111111-1111-4111-8111-111111111111" };

  it("does not reap a live holder older than 60 s (the update is skipped, the lock untouched)", (t) => {
    const ws = tempDir(t);
    mkdirSync(join(ws, ".adaptive-learning"), { recursive: true });
    writeFileSync(lockOf(ws), holderLock(LIVE_PID));
    age(lockOf(ws), 5 * 60_000);
    trackKnowledgePending(ws, memory);
    assert.equal(readFileSync(lockOf(ws), "utf8"), holderLock(LIVE_PID));
    assert.equal(existsSync(join(ws, ".adaptive-learning", "knowledge-pending.json")), false);
  });

  it("reaps a dead holder older than 60 s (also the pre-N1 bare-timestamp format)", (t) => {
    const ws = tempDir(t);
    mkdirSync(join(ws, ".adaptive-learning"), { recursive: true });
    for (const content of [holderLock(deadPid()), new Date().toISOString()]) {
      writeFileSync(lockOf(ws), content);
      age(lockOf(ws), 2 * 60_000);
      trackKnowledgePending(ws, memory);
      assert.equal(existsSync(lockOf(ws)), false);
      assert.equal(readKnowledgePending(ws).pending.length, 1);
    }
  });
});

describe("knowledge_update lock (engine/tools/memory-tools.js)", () => {
  function knowledgeUpdateTool(ws) {
    const factory = createMemoryTools({
      KNOWLEDGE_LOCK_FILE: "knowledge-update.lock",
      cfg: { security: {} },
      schicht15Enabled: true,
      schicht15LlmCfg: {},
      host: { logger: { warn() {}, info() {}, debug() {} } },
      dbg() {},
      pool: { withWriteDb: async (_agent, fn) => fn({}) },
      readKnowledgePendingSnapshot: () => ({ pending: [] }),
      workspacePolicyGuard: { decision: () => ({ allowed: true }) },
    });
    return factory({ agentId: "main", workspaceDir: ws }).find((x) => x.name === "knowledge_update");
  }

  it("a refused acquire leaves the live holder's lock in place, even past 5 min", async (t) => {
    const ws = tempDir(t);
    const lock = join(ws, ".adaptive-learning", "knowledge-update.lock");
    mkdirSync(join(ws, ".adaptive-learning"), { recursive: true });
    writeFileSync(lock, holderLock(LIVE_PID));
    age(lock, 10 * 60_000);
    const out = await knowledgeUpdateTool(ws).execute("call-1", {});
    assert.match(out.content[0].text, /another update is already running/);
    assert.equal(readFileSync(lock, "utf8"), holderLock(LIVE_PID));
  });
});

describe("proactive-governor lock races", () => {
  const T0 = 1_700_000_000_000;
  const lockOf = (dir) => join(dir, ".proactive-governor.lock");

  it("release does not delete a lock reclaimed between its token check and its delete", (t) => {
    const dir = tempDir(t);
    const token = acquireGovernorLock(dir, { now: T0 });
    assert.ok(token);
    const reclaimed = `${T0 + 200_000}:other-token`;
    withRenameHook((src) => {
      if (src === lockOf(dir)) writeFileSync(lockOf(dir), reclaimed);
    }, () => releaseGovernorLock(dir, token));
    assert.equal(readFileSync(lockOf(dir), "utf8"), reclaimed);
    assert.deepEqual(leftovers(dir, ".proactive-governor.lock"), []);
  });

  it("a stale reclaim does not delete a fresh lock another reclaimer created meanwhile", (t) => {
    const dir = tempDir(t);
    writeFileSync(lockOf(dir), `${T0}:dead-holder`);
    const fresh = `${T0 + 200_000}:fresh-holder`;
    const got = withRenameHook((src) => {
      if (src === lockOf(dir)) writeFileSync(lockOf(dir), fresh);
    }, () => acquireGovernorLock(dir, { now: T0 + 200_000, staleMs: 120_000 }));
    assert.equal(got, null);
    assert.equal(readFileSync(lockOf(dir), "utf8"), fresh);
    assert.deepEqual(leftovers(dir, ".proactive-governor.lock"), []);
  });
});

describe("neo workspace write lock (lib/neo-arch.js)", () => {
  function freshStore(t) {
    const root = tempDir(t);
    const store = createNeoStore(root, "workspace");
    mkdirSync(store.paths.workspaceDir, { recursive: true });
    return { store, dir: store.paths.workspaceDir, lockPath: join(store.paths.workspaceDir, ".neo-write.lock") };
  }
  const ownerOf = (lockPath) => join(lockPath, "owner.json");

  it("release leaves a lock that was taken over meanwhile", async (t) => {
    const { store, dir, lockPath } = freshStore(t);
    const foreign = holderLock(LIVE_PID);
    await withRenameHook((src, dst) => {
      if (src === lockPath && dst.includes(".neo-write.lock.rel-")) writeFileSync(ownerOf(lockPath), foreign);
    }, () => store.appendEpisodesAsync([{ id: "ep_n1_release", agentId: "main" }], undefined, { timeoutMs: 500 }));
    assert.match(readFileSync(store.paths.episodes, "utf8"), /ep_n1_release/);
    assert.equal(readFileSync(ownerOf(lockPath), "utf8"), foreign, "foreign lock must be put back");
    assert.deepEqual(leftovers(dir, ".neo-write.lock"), []);
  });

  it("does not reap a live holder older than NEO_LOCK_STALE_MS (5 min)", async (t) => {
    const { store, lockPath } = freshStore(t);
    mkdirSync(lockPath);
    writeFileSync(ownerOf(lockPath), holderLock(LIVE_PID));
    age(lockPath, 10 * 60_000);
    await assert.rejects(
      () => store.appendEpisodesAsync([{ id: "ep_n1_live", agentId: "main" }], undefined, { timeoutMs: 100 }),
      (error) => error?.code === "NEO_WRITE_BACKPRESSURE",
    );
    assert.equal(readFileSync(ownerOf(lockPath), "utf8"), holderLock(LIVE_PID));
    assert.equal(existsSync(store.paths.episodes), false);
  });

  it("reaps a dead holder", async (t) => {
    const { store, dir, lockPath } = freshStore(t);
    mkdirSync(lockPath);
    writeFileSync(ownerOf(lockPath), holderLock(deadPid()));
    await store.appendEpisodesAsync([{ id: "ep_n1_dead", agentId: "main" }], undefined, { timeoutMs: 500 });
    assert.match(readFileSync(store.paths.episodes, "utf8"), /ep_n1_dead/);
    assert.equal(existsSync(lockPath), false);
    assert.deepEqual(leftovers(dir, ".neo-write.lock"), []);
  });

  it("a takeover does not delete a fresh lock that replaced the judged one", async (t) => {
    const { store, dir, lockPath } = freshStore(t);
    mkdirSync(lockPath);
    writeFileSync(ownerOf(lockPath), holderLock(deadPid()));
    const fresh = holderLock(LIVE_PID, "fresh-nonce");
    let swapped = false;
    await withRenameHook((src, dst) => {
      if (!swapped && src === lockPath && dst.includes(".neo-write.lock.break-")) {
        swapped = true; // another taker removed the dead lock and created its own
        rmSync(lockPath, { recursive: true, force: true });
        mkdirSync(lockPath);
        writeFileSync(ownerOf(lockPath), fresh);
      }
    }, () => assert.rejects(
      () => store.appendEpisodesAsync([{ id: "ep_n1_race", agentId: "main" }], undefined, { timeoutMs: 100 }),
      (error) => error?.code === "NEO_WRITE_BACKPRESSURE",
    ));
    assert.equal(swapped, true);
    assert.equal(readFileSync(ownerOf(lockPath), "utf8"), fresh);
    assert.equal(existsSync(store.paths.episodes), false);
    assert.deepEqual(leftovers(dir, ".neo-write.lock"), []);
  });
});

/**
 * tests/n1-lock-ownership.test.js — N1 lock audit.
 *
 * Every file lock that used to release by unconditional delete or reap a
 * live holder by age alone now follows the lib/registry-lock.js protocol.
 * For each one, the same directions must hold:
 *   - a foreign lock survives our release, also when it replaces ours in the
 *     middle of the release (race tests marked [race]);
 *   - a live holder older than staleMs is NOT reaped;
 *   - a dead holder older than staleMs IS reaped — including a lock with OUR
 *     pid left by an earlier process (container gateway as PID 1, I1).
 * Races are deterministic: node:fs is patched (syncBuiltinESMExports) so the
 * competing write lands exactly between judging and acting. The [race] hooks
 * fire on whichever call touches the lock first during release — rename (this
 * code) or unlink/rm (the pre-N1 code) — so they fail on f2160c3c for the
 * defect itself, not for a missing API.
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
import { processIncarnation, tryAcquireOwnedLock } from "../lib/registry-lock.js";
import { readKnowledgePending, trackKnowledgePending } from "../engine/knowledge/knowledge-pending.js";
import { createMemoryTools } from "../engine/tools/memory-tools.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const T = { timeout: 15_000 };

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

function holderLock(pid, nonce = "foreign-nonce", extra = {}) {
  return JSON.stringify({ nonce, pid, host: hostname(), acquiredAt: "2026-10-05T00:00:00.000Z", ...extra });
}

/** Our pid, written by an earlier process with the same pid (procStart one minute before ours). */
function earlierIncarnationLock() {
  const own = processIncarnation();
  return holderLock(process.pid, "previous-incarnation", { procStart: { mono: own.mono - 60_000, boot: own.boot } });
}

/**
 * Runs `fn` with node:fs functions wrapped. `hooks[name]` is `{ before?, after?, impl? }`:
 * before/after are called with the stringified arguments around the real call;
 * `impl(real, ...args)` replaces the call.
 */
function withFsHooks(hooks, fn) {
  const real = {};
  for (const [name, h] of Object.entries(hooks)) {
    real[name] = fs[name];
    fs[name] = (...args) => {
      const strs = args.map((a) => (typeof a === "string" || a instanceof URL ? String(a) : a));
      h.before?.(...strs);
      const out = h.impl ? h.impl(real[name], ...args) : real[name](...args);
      h.after?.(out, ...strs);
      return out;
    };
  }
  syncBuiltinESMExports();
  const restore = () => {
    for (const [name, f] of Object.entries(real)) fs[name] = f;
    syncBuiltinESMExports();
  };
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

/**
 * [race] hook: the first rename/unlink/rm of `path` (whichever the code under
 * test uses to release) is preceded by `swap()` — another process took the
 * lock over in between.
 */
function swapBeforeFirstRemoval(path, swap) {
  let fired = false;
  const before = (p) => {
    if (!fired && p === path) {
      fired = true;
      swap();
    }
  };
  const state = { get fired() { return fired; } };
  return { hooks: { renameSync: { before }, unlinkSync: { before }, rmSync: { before } }, state };
}

function leftovers(dir, base) {
  return readdirSync(dir).filter((n) => n.startsWith(`${base}.`));
}

describe("tryAcquireOwnedLock (lib/registry-lock.js)", T, () => {
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

  it("stamps the process incarnation into the lock", (t) => {
    const lock = join(tempDir(t), "x.lock");
    const h = tryAcquireOwnedLock(lock, { staleMs: 1000 });
    const body = JSON.parse(readFileSync(lock, "utf8"));
    const own = processIncarnation();
    assert.equal(body.procStart.boot, own.boot);
    assert.ok(Math.abs(body.procStart.mono - own.mono) <= 5, "same process: same monotonic start (±ms)");
    h.release();
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

  it("I1: reaps our own pid from an earlier process past staleMs, keeps our current incarnation's", (t) => {
    const lock = join(tempDir(t), "x.lock");
    const own = processIncarnation();
    writeFileSync(lock, holderLock(process.pid, "current", { procStart: own }));
    age(lock, 5_000);
    assert.equal(tryAcquireOwnedLock(lock, { staleMs: 1000 }), null, "current incarnation is alive");
    writeFileSync(lock, holderLock(process.pid, "legacy")); // no procStart: pre-I1 lock, treated as alive
    age(lock, 5_000);
    assert.equal(tryAcquireOwnedLock(lock, { staleMs: 1000 }), null);
    writeFileSync(lock, earlierIncarnationLock());
    assert.equal(tryAcquireOwnedLock(lock, { staleMs: 1000 }), null, "fresh: within staleMs");
    age(lock, 5_000);
    const h = tryAcquireOwnedLock(lock, { staleMs: 1000 });
    assert.ok(h, "earlier incarnation is dead");
    h.release();
  });

  it("I1: a different boot id marks an earlier incarnation even with the same monotonic start", (t) => {
    const own = processIncarnation();
    if (own.boot === null) return t.skip("no boot id on this platform");
    const lock = join(tempDir(t), "x.lock");
    writeFileSync(lock, holderLock(process.pid, "other-boot", { procStart: { mono: own.mono, boot: "other-boot" } }));
    age(lock, 5_000);
    const h = tryAcquireOwnedLock(lock, { staleMs: 1000 });
    assert.ok(h);
    h.release();
  });

  it("M4: a lock that vanished between the failed create and the check is retried, not reported held", (t) => {
    const lock = join(tempDir(t), "x.lock");
    let calls = 0;
    const openSync = (p, flags) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" }); // the holder released right after
      return fs.openSync(p, flags);
    };
    const h = tryAcquireOwnedLock(lock, { staleMs: 1000, openSync });
    assert.ok(h);
    assert.equal(calls, 2);
    h.release();
  });

  it("M4: Windows delete-pending (EPERM) is retried twice, then reported busy", (t) => {
    const lock = join(tempDir(t), "x.lock");
    const failing = (n) => {
      let calls = 0;
      return (p, flags) => {
        calls += 1;
        if (calls <= n) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        return fs.openSync(p, flags);
      };
    };
    const h = tryAcquireOwnedLock(lock, { staleMs: 1000, platform: "win32", openSync: failing(2) });
    assert.ok(h);
    h.release();
    assert.equal(tryAcquireOwnedLock(lock, { staleMs: 1000, platform: "win32", openSync: failing(3) }), null);
  });
});

describe("job-lock (acquireJobLock / releaseJobLock)", T, () => {
  it("release leaves a lock that was taken over meanwhile", (t) => {
    const lock = join(tempDir(t), "locks", "job.lock");
    assert.equal(acquireJobLock(lock, { staleMs: 1000 }), lock);
    writeFileSync(lock, holderLock(LIVE_PID));
    releaseJobLock(lock);
    assert.equal(readFileSync(lock, "utf8"), holderLock(LIVE_PID));
  });

  it("[race] release does not delete a lock taken over between its check and its delete", (t) => {
    const lock = join(tempDir(t), "locks", "job.lock");
    acquireJobLock(lock, { staleMs: 1000 });
    const race = swapBeforeFirstRemoval(lock, () => writeFileSync(lock, holderLock(LIVE_PID)));
    withFsHooks(race.hooks, () => releaseJobLock(lock));
    assert.equal(race.state.fired, true);
    assert.equal(readFileSync(lock, "utf8"), holderLock(LIVE_PID));
  });

  it("release of a never-acquired path does not touch a foreign lock", (t) => {
    const lock = join(tempDir(t), "job.lock");
    writeFileSync(lock, holderLock(LIVE_PID));
    releaseJobLock(lock);
    assert.equal(readFileSync(lock, "utf8"), holderLock(LIVE_PID));
  });

  it("M2: a path this process still holds is refused, also past the ceiling", (t) => {
    const lock = join(tempDir(t), "job.lock");
    acquireJobLock(lock, { staleMs: 1000 });
    age(lock, 60_000); // far past 10 x staleMs
    assert.throws(() => acquireJobLock(lock, { staleMs: 1000 }), /held by this process/);
    releaseJobLock(lock);
    assert.equal(existsSync(lock), false);
    acquireJobLock(lock, { staleMs: 1000 });
    releaseJobLock(lock);
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

  it("I1: reaps a lock our pid left from an earlier process once older than staleMs", (t) => {
    const lock = join(tempDir(t), "job.lock");
    writeFileSync(lock, earlierIncarnationLock());
    age(lock, 5_000);
    assert.equal(acquireJobLock(lock, { staleMs: 1000 }), lock);
    releaseJobLock(lock);
  });
});

describe("knowledge-pending lock", T, () => {
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

  it("[race] release does not delete a lock taken over between its check and its delete", (t) => {
    const ws = tempDir(t);
    mkdirSync(join(ws, ".adaptive-learning"), { recursive: true });
    const race = swapBeforeFirstRemoval(lockOf(ws), () => writeFileSync(lockOf(ws), holderLock(LIVE_PID)));
    withFsHooks(race.hooks, () => trackKnowledgePending(ws, memory));
    assert.equal(race.state.fired, true);
    assert.equal(readFileSync(lockOf(ws), "utf8"), holderLock(LIVE_PID));
  });
});

describe("knowledge_update lock (engine/tools/memory-tools.js)", T, () => {
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

  it("[race] a lock that appears after the pre-check is never deleted by the refused call", async (t) => {
    // Pre-N1: the first existsSync said "free", all five opens hit EEXIST, the
    // `return` inside `try` ran the `finally`, and that unlinked the holder's lock.
    const ws = tempDir(t);
    const lock = join(ws, ".adaptive-learning", "knowledge-update.lock");
    mkdirSync(join(ws, ".adaptive-learning"), { recursive: true });
    writeFileSync(lock, holderLock(LIVE_PID));
    let first = true;
    const out = await withFsHooks({
      existsSync: {
        impl: (real, p) => {
          if (first && String(p) === lock) { first = false; return false; } // the holder created it just after
          return real(p);
        },
      },
    }, () => knowledgeUpdateTool(ws).execute("call-2", {}));
    assert.match(out.content[0].text, /another update is already running|could not acquire lock/);
    assert.equal(readFileSync(lock, "utf8"), holderLock(LIVE_PID));
  });
});

describe("proactive-governor lock races", T, () => {
  const T0 = 1_700_000_000_000;
  const lockOf = (dir) => join(dir, ".proactive-governor.lock");

  it("[race] release does not delete a lock reclaimed between its token check and its delete", (t) => {
    const dir = tempDir(t);
    const token = acquireGovernorLock(dir, { now: T0 });
    assert.ok(token);
    const reclaimed = `${T0 + 200_000}:other-token`;
    const race = swapBeforeFirstRemoval(lockOf(dir), () => writeFileSync(lockOf(dir), reclaimed));
    withFsHooks(race.hooks, () => releaseGovernorLock(dir, token));
    assert.equal(race.state.fired, true);
    assert.equal(readFileSync(lockOf(dir), "utf8"), reclaimed);
    assert.deepEqual(leftovers(dir, ".proactive-governor.lock"), []);
  });

  it("[race] a stale reclaim does not delete a fresh lock another reclaimer created meanwhile", (t) => {
    const dir = tempDir(t);
    writeFileSync(lockOf(dir), `${T0}:dead-holder`);
    const fresh = `${T0 + 200_000}:fresh-holder`;
    const race = swapBeforeFirstRemoval(lockOf(dir), () => writeFileSync(lockOf(dir), fresh));
    const got = withFsHooks(race.hooks, () => acquireGovernorLock(dir, { now: T0 + 200_000, staleMs: 120_000 }));
    assert.equal(race.state.fired, true);
    assert.equal(got, null);
    assert.equal(readFileSync(lockOf(dir), "utf8"), fresh);
    assert.deepEqual(leftovers(dir, ".proactive-governor.lock"), []);
  });
});

describe("neo workspace write lock (lib/neo-arch.js)", T, () => {
  function freshStore(t) {
    const root = tempDir(t);
    const store = createNeoStore(root, "workspace");
    mkdirSync(store.paths.workspaceDir, { recursive: true });
    return { store, dir: store.paths.workspaceDir, lockPath: join(store.paths.workspaceDir, ".neo-write.lock") };
  }
  const ownerOf = (lockPath) => join(lockPath, "owner.json");

  it("[race] release leaves a lock that was taken over meanwhile", async (t) => {
    const { store, dir, lockPath } = freshStore(t);
    const foreign = holderLock(LIVE_PID);
    let fired = false;
    const before = (p) => {
      if (fired || !(p === lockPath || p === ownerOf(lockPath))) return;
      if (!existsSync(ownerOf(lockPath))) return; // not yet held (acquire's mkdir path)
      fired = true;
      writeFileSync(ownerOf(lockPath), foreign); // our lock was taken over and re-created
    };
    await withFsHooks({ renameSync: { before }, unlinkSync: { before }, rmdirSync: { before } },
      () => store.appendEpisodesAsync([{ id: "ep_n1_release", agentId: "main" }], undefined, { timeoutMs: 500 }));
    assert.equal(fired, true);
    assert.match(readFileSync(store.paths.episodes, "utf8"), /ep_n1_release/);
    assert.equal(readFileSync(ownerOf(lockPath), "utf8"), foreign, "foreign lock must be put back");
    assert.deepEqual(leftovers(dir, ".neo-write.lock"), []);
  });

  it("M3: a put-back never replaces a fresh holder's lock that appeared meanwhile", async (t) => {
    const { store, dir, lockPath } = freshStore(t);
    const foreign = holderLock(LIVE_PID);
    let phase = "idle";
    const makeFresh = () => {
      if (phase !== "moved") return;
      phase = "fresh";
      mkdirSync(lockPath); // a new holder between its mkdir and its owner.json
    };
    await withFsHooks({
      renameSync: {
        before: (src, dst) => {
          if (phase === "idle" && src === lockPath && String(dst).includes(".rel-")) writeFileSync(ownerOf(lockPath), foreign);
        },
        after: (_out, src, dst) => {
          if (phase === "idle" && src === lockPath && String(dst).includes(".rel-")) phase = "moved";
        },
      },
      // whichever the put-back touches first: existsSync (pre-fix) or mkdirSync (now)
      existsSync: { after: (out, p) => { if (p === lockPath && out === false) makeFresh(); } },
      mkdirSync: { before: (p) => { if (p === lockPath) makeFresh(); } },
    }, () => store.appendEpisodesAsync([{ id: "ep_n1_putback", agentId: "main" }], undefined, { timeoutMs: 500 }));
    assert.equal(phase, "fresh");
    assert.equal(existsSync(lockPath), true);
    assert.equal(existsSync(ownerOf(lockPath)), false, "the fresh holder's lock must stay its own (no foreign owner.json)");
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

  it("I1: reaps our own pid from an earlier process at once, keeps our current incarnation's", async (t) => {
    const { store, lockPath } = freshStore(t);
    mkdirSync(lockPath);
    writeFileSync(ownerOf(lockPath), holderLock(process.pid, "current", { procStart: processIncarnation() }));
    await assert.rejects(
      () => store.appendEpisodesAsync([{ id: "ep_n1_own", agentId: "main" }], undefined, { timeoutMs: 100 }),
      (error) => error?.code === "NEO_WRITE_BACKPRESSURE",
    );
    writeFileSync(ownerOf(lockPath), earlierIncarnationLock());
    await store.appendEpisodesAsync([{ id: "ep_n1_prev", agentId: "main" }], undefined, { timeoutMs: 500 });
    assert.match(readFileSync(store.paths.episodes, "utf8"), /ep_n1_prev/);
    assert.equal(existsSync(lockPath), false);
  });

  it("[race] a takeover does not delete a fresh lock that replaced the judged one", async (t) => {
    const { store, dir, lockPath } = freshStore(t);
    mkdirSync(lockPath);
    writeFileSync(ownerOf(lockPath), holderLock(deadPid()));
    const fresh = holderLock(LIVE_PID, "fresh-nonce");
    let swapped = false;
    const before = (p) => {
      if (swapped || !(p === lockPath || p === ownerOf(lockPath))) return;
      if (!existsSync(ownerOf(lockPath))) return;
      swapped = true; // another taker removed the dead lock and created its own
      rmSync(lockPath, { recursive: true, force: true });
      mkdirSync(lockPath);
      writeFileSync(ownerOf(lockPath), fresh);
    };
    await withFsHooks({ renameSync: { before }, unlinkSync: { before } }, () => assert.rejects(
      () => store.appendEpisodesAsync([{ id: "ep_n1_race", agentId: "main" }], undefined, { timeoutMs: 100 }),
      (error) => error?.code === "NEO_WRITE_BACKPRESSURE",
    ));
    assert.equal(swapped, true);
    assert.equal(readFileSync(ownerOf(lockPath), "utf8"), fresh);
    assert.equal(existsSync(store.paths.episodes), false);
    assert.deepEqual(leftovers(dir, ".neo-write.lock"), []);
  });
});
